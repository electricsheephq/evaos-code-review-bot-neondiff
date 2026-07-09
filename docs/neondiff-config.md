# NeonDiff Config Schema Draft

This document defines the public draft contract for a future repo-owned `.neondiff.yml`.
It supports issue [#109](https://github.com/electricsheephq/evaos-code-review-bot/issues/109), but this slice is schema, examples, fixtures, and tests only. It is not yet wired into runtime config loading, `neondiff init`, `neondiff config validate`, `neondiff config explain`, review posting, or dry-run filtering, so it must not be treated as completing the full #109 acceptance criteria.

The machine-readable draft schema lives at [`docs/schema/neondiff-config.schema.json`](schema/neondiff-config.schema.json). Example fixtures live under [`tests/fixtures/neondiff-config`](../tests/fixtures/neondiff-config).

## Contract Goals

- Give maintainers and coding agents a deterministic shape for `.neondiff.yml`.
- Keep unsafe behavior explicit and default-off.
- Keep provider credentials out of committed repo config.
- Keep issue enrichment separate from PR review policy.
- Keep public confidence uncalibrated until evaluation evidence exists; no percentages are displayed in this draft.
- Preserve the current NeonDiff public boundary: source-available beta, public open-source repositories are free, and private or commercial repositories require the applicable NeonDiff license.

## Top-Level Fields

| Field | Purpose |
| --- | --- |
| `version` | Schema version. The current draft is `1`. |
| `review` | Review profile, max comments, severity threshold, and path-specific instructions. |
| `paths` | Include and exclude globs. Exclusions win over inclusions. |
| `providers` | Provider selection plus BYOK/local-provider hints. Secrets are referenced by environment variable name only. |
| `safetyGates` | Fail-closed controls for mutation, secret-like text, current-diff-line coverage, and comment caps. |
| `finishingTouches` | Future post-review commands. `enabled` is `false` in this draft. |
| `issueEnrichment` | Future issue enrichment policy. It is separate from PR review and defaults off with explicit allowlist and throttles. |
| `confidence` | Public confidence display policy. It remains `uncalibrated` with percentages disabled. |
| `repo` | Repository visibility and repo-level review settings. |

## Minimal Example

```yaml
$schema: docs/schema/neondiff-config.schema.json
version: 1
review:
  profile: conservative
  maxComments: 12
  severityThreshold: medium
  pathInstructions: []
paths:
  include:
    - "**/*"
  exclude:
    - "dist/**"
    - "coverage/**"
    - "node_modules/**"
providers:
  default: openai-compatible
  allowed:
    - openai-compatible
  byok:
    required: true
    apiKeyEnv: NEONDIFF_PROVIDER_API_KEY
  local:
    enabled: false
    provider: none
    baseUrl: http://localhost:11434/v1
    model: ""
safetyGates:
  mutation:
    enabled: false
  secrets:
    blockSecretLikeText: true
  lineCoverage:
    requireCurrentDiffLine: true
  commentCaps:
    maxPerPullRequest: 12
    maxPerFile: 4
finishingTouches:
  enabled: false
  allowedCommands: []
issueEnrichment:
  enabled: false
  allowlist: []
  throttles:
    maxIssuesPerHour: 0
    cooldownMinutes: 60
confidence:
  mode: uncalibrated
  displayPercentages: false
  calibrationEvidence: none
repo:
  visibility: public
  reviewDraftPullRequests: false
  publicRepoMode: free-source-available-beta
  privateRepoMode: requires-license
```

## Provider Notes

`providers.byok.apiKeyEnv` names an environment variable; it is not a value slot for a raw key. Local provider hints are limited to HTTP loopback version roots such as `http://localhost:11434/v1`; HTTPS loopback and arbitrary path suffixes are intentionally rejected in this draft. Committed config should still avoid machine-specific secrets and credentials. Machine-specific provider settings belong in local overrides once runtime support exists.

The live `BotConfig.providers.providers.<provider-id>.structuredOutputMode`
field is separate from the public `.neondiff.yml` draft above. It is a
machine/operator config knob for provider adapters, not a repo-owned policy
field. Supported values are:

| Value | Behavior |
| --- | --- |
| `none` | No provider-side JSON/structured-output field; NeonDiff uses its recovery parser only. |
| `json-object` | Legacy `response_format: { "type": "json_object" }`; valid JSON object hint, not schema-constrained findings. |
| `openai-json-schema` | OpenAI/LM Studio style `response_format` with the canonical findings JSON Schema. |
| `llama-cpp-json-schema` | llama.cpp-compatible `response_format` with a direct `schema` field. |
| `vllm-structured-outputs` | Current vLLM `structured_outputs: { "json": ... }` shape. |
| `vllm-guided-json` | Legacy vLLM `guided_json` shape for older deployments. |
| `ollama-format-json-schema` | Ollama-style `format` field with the findings schema. |
| `sglang-json-schema` | SGLang OpenAI-compatible `response_format: { "type": "json_schema", ... }` shape. |

Unknown values fail config validation rather than silently downgrading. Schema
mode evidence is stamped as `constrained:<mode>`; `none` and plain
`json-object` remain the recovery path because they do not enforce the findings
schema.

OpenAI-compatible provider entries may also set `retrySchemaFeedbackMax`
(`integer`, `0..3`, default `2`). When a provider returns malformed review JSON
or JSON that fails the canonical findings schema, NeonDiff can reprompt the same
chat-completions conversation with only the exact schema error and the canonical
findings schema. The retry loop uses the same provider timeout as the original
review call as one total wall-clock budget across all attempts, records
`schemaRetries` and redacted `schemaRetryErrors` in adapter evidence, and falls
back to the existing model-output/provider-deferred path after the bounded
attempts are exhausted. Set the value to `0` to disable this adapter-level
recovery behavior. Truncated review output, including `finish_reason: "length"`
or JSON-looking findings output with unclosed delimiters, is excluded from
schema-feedback retries and fails immediately as a truncation model-output error;
that failure usually needs a smaller prompt, larger output budget, or stronger
provider-side structured output rather than another identical reprompt.

The live `BotConfig.contextBudget` field is a machine/operator preflight guard
for provider context windows (#401). It is not part of the public repo-owned
`.neondiff.yml` draft. Before a review calls the provider, NeonDiff estimates the
full review prompt using `charsPerToken` and `providerFudgeFactor`, compares it
with `providers.providers.<provider-id>.contextWindowTokens` minus
`reservedOutputTokens`, and writes `context-budget.json` into the evidence
packet.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `true` | Enables pre-send context-window checks when the selected provider declares `contextWindowTokens`. Providers without a configured window write `mode: "unknown_window"` evidence and continue with the legacy single-prompt path. |
| `overflow` | `"skip" \| "chunk"` | `"skip"` | `skip` records the processed head as `failed` with reason `context_budget_overflow` before any provider call, so operators can retry after tuning the budget or after the PR shrinks. `chunk` deterministically groups changed files into budget-sized prompts along file boundaries and runs each chunk through the same review/gate path. |
| `reservedOutputTokens` | `integer` (`>= 1`) | `4096` | Output-token reserve subtracted from the provider context window before input budgeting. |
| `charsPerToken` | `integer` (`>= 1`) | `4` | Conservative tokenizer-free estimator denominator. |
| `providerFudgeFactor` | `number` (`> 0`) | `1.15` | Multiplier applied after character/token estimation to leave provider-specific slack. |
| `maxChunks` | `integer` (`>= 1`) | `8` | Fail-closed cap for chunk mode. If deterministic file-boundary chunking would exceed this count, the head is skipped instead of silently issuing unbounded provider calls. |

Chunk mode preserves the posting invariants: ZCode still runs read-only, findings
from all chunks are merged only before the existing deterministic gate, duplicate
suppression remains per `{repo, pull, head_sha}`, and inline comments still post
only on current RIGHT-side diff lines. A single changed file that cannot fit in
the configured budget is skipped with reason
`context_budget_single_file_overflow`; NeonDiff never splits a hunk or sends a
known-over-budget chunk.

Chunk mode is a provider-window safety fallback, not a full-context substitute:
each provider call receives only that deterministic file-boundary chunk in the
`Files` and `Diff` sections, but advisory context packets such as GitNexus,
repo memory, related GitHub references, and read-only skill packs remain
PR-scoped when enabled. That fixed packet overhead is included in every chunk's
budget estimate. Cross-file findings that require diff files from different
chunks can be missed. To avoid comments on files the model did not inspect,
NeonDiff accepts findings from a chunk only when their `path` is one of that
chunk's filenames; any cross-chunk coordinates are discarded before the
deterministic review gate.

Context-budget skip reasons are operator-facing:

- `context_budget_overflow`: the full prompt is too large and `overflow` is `skip`.
- `context_budget_no_available_input_tokens`: `reservedOutputTokens` leaves no input budget; evidence preserves the raw `budgetTokens` value, which can be zero or negative when the reserve is too large for the provider window.
- `context_budget_single_file_overflow`: chunk mode cannot fit one changed file in the available budget.
- `context_budget_chunk_count_exceeded`: chunk mode would exceed `maxChunks`.

All four are recorded as retryable `failed` processed rows, not terminal
`skipped` rows. After changing the provider window, reserve, overflow mode, or
PR contents, retry the head through the normal failed-head retry path.

## Safety Defaults

Mutation, finishing touches, issue enrichment, and public confidence percentages are default-off in this draft. A future runtime loader should fail before review starts when a repo config tries to enable unsupported unsafe behavior.

`review.maxComments` and `safetyGates.commentCaps.maxPerPullRequest` both have a nonzero floor. `review.maxComments` is a soft review budget, while `safetyGates.commentCaps.maxPerPullRequest` is the hard safety cap; if they differ, the stricter lower value wins.

## Proof Boundary

The current proof is limited to schema structure, docs, and fixtures. Runtime behavior remains future work for #109:

- no `.neondiff.yml` discovery
- no CLI generation or validation command
- no review filtering from config
- no dry-run evidence proving config controls posted versus dropped findings

## Ranking And Scoring Config Surface (Program #278)

The sections below document the live `BotConfig` ranking/scoring surface shipped by the #278
program. Unlike the `.neondiff.yml` draft above, these keys are wired into runtime config loading
today (`src/config.ts`) and take effect on every review. Every key in this surface is either
default-off or quieter-only: leaving it unset reproduces the exact behavior that shipped before
the #278 program started.

### `reviewGate`

`config.reviewGate` controls the deterministic post-model gate that ranks findings, caps inline
comments, and decides `REQUEST_CHANGES` vs `COMMENT` (`src/review-gate.ts`, `src/findings.ts`).

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `maxInlineComments` | `integer` | `25` | Hard cap on inline comments posted per review. Findings are sorted severity-first, then by `confidence` descending (ties broken by path, line, title), so when the cap trims the list it always keeps the highest-confidence findings within each severity tier. |
| `requestChangesConfidenceFloors` | `{ P0?: number, P1?: number }` | unset (no floors) | Optional per-severity confidence floor, each `0..1`, for counting a P0/P1 finding toward `REQUEST_CHANGES` eligibility. |
| `retryDegradedConfidencePenalty` | `number` (`0..1`) | unset (no penalty) | Optional confidence subtracted (floored at 0) from findings recovered via the strict-JSON retry path (#304) before the gate runs. |
| `selfConsistency` | `SelfConsistencyConfig` | unset (disabled) | Opt-in second-draw re-check for high-severity findings (#303). See below. |
| `categoryPrecisionFloors` | `{ [category]: number }` | unset (no floors) | Optional per-category confidence floor, each `0..1`, curated from the calibration aggregate report (#286). A finding whose category is listed loses `REQUEST_CHANGES` eligibility when its confidence is below the floor; it still posts as a comment. See [calibration-loop.md](calibration-loop.md). |

**Safety invariants:**

- **`maxInlineComments` default matches the pre-#287 hardcoded literal.** Setting it explicitly only changes *which* findings survive the cap (confidence-ranked instead of alphabetical-by-path); it does not change default behavior.
- **`requestChangesConfidenceFloors` is quieter-only and unknown keys are rejected.** The object accepts only the literal keys `P0` and `P1` — any other key (including lowercase `p0`, or a typo) throws a config validation error rather than being silently ignored. A configured floor can only *demote* a finding out of `REQUEST_CHANGES` eligibility; a below-floor P0/P1 still posts as an inline comment, it just no longer forces the stricter review event. Leaving both floors unset is byte-identical to the pre-#287 gate.
- **`retryDegradedConfidencePenalty` is quieter-only and default-off.** It only ever lowers a degraded finding's confidence (floored at 0), which can only remove it from ranking/cap contention or push it below a `requestChangesConfidenceFloors` floor — never raise confidence or add a finding. Unset means retry-recovered findings are scored identically to clean first-pass findings.
- **`categoryPrecisionFloors` is quieter-only and unknown categories are rejected.** Keys must be valid regression-taxonomy categories — anything else throws a config validation error. A floor can only demote a finding out of `REQUEST_CHANGES` eligibility (the finding still posts); a floor of `0` never demotes. Nothing reads the calibration aggregate at review time — the config file remains the single inspectable source of gate behavior.

#### `selfConsistency`

`config.reviewGate.selfConsistency` adds an opt-in second model draw that verifies or refutes each
gate-accepted P0/P1 finding before the review posts (#303, `src/self-consistency.ts`).

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | When `false` (the default), no second draw runs at all — zero extra provider calls, byte-identical output to a config with `selfConsistency` omitted entirely. |
| `severities` | `Array<"P0" \| "P1">` | `["P0", "P1"]` | Which severities get re-checked. Only `P0` and `P1` are accepted; any other value fails config validation. |
| `provider` | `string` | unset (same provider as the main review) | Provider-registry id to use for the second draw. Absent means the second draw runs on the same provider/model as the primary review call. |
| `maxFindingsPerReview` | `integer` (`>= 1`) | `5` | Cost bound: at most this many findings (in the gate's ranked, highest-confidence-first order) are re-checked per review. This is the knob that bounds the extra provider spend `selfConsistency` adds — each re-checked finding is one additional model call. |

**Safety invariants:**

- **Default-off, zero-cost when disabled.** `enabled: false` (or omitting `selfConsistency` entirely) means `runSelfConsistencyRecheck` returns the original comments and event untouched, with no second-draw calls issued.
- **Quieter-only merge semantics.** Agreement between the first and second draw keeps the *original* confidence (the second draw can never raise it). Refutation sets confidence to `min(original, second)` and strips that finding's `REQUEST_CHANGES` eligibility for this review — but the finding still posts as a comment; self-consistency never drops a finding outright. The review event (`REQUEST_CHANGES` vs `COMMENT`) is re-derived only from findings that still carry eligibility after the recheck.
- **Fail-closed on failure, not fail-open.** Any error from the second-draw call (timeout, malformed response, provider failure) leaves that finding completely untouched — the recheck can only ever make a review quieter, never block, delay, or drop it.
- **Cost note.** Because each configured severity/cap combination issues one additional model call per re-checked finding, `selfConsistency` is the only key in this surface with a direct, ongoing provider-cost implication proportional to `maxFindingsPerReview`. Keep the cap conservative on high-volume repos.

### `riskWeightedQueue`

`config.riskWeightedQueue` lets the review scheduler tier its enqueue priority by the risk of a
PR's changed surface instead of a flat FIFO priority (#301, `src/scheduler.ts`).

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | When `false` (the default), enqueue priority stays the flat `reviewScheduler.backgroundPriority` for every PR — byte-identical to pre-#301 behavior. |
| `elevatedPriority` | `integer` (`>= 0`) | `min(backgroundPriority, 10)` | Priority assigned to PRs whose changed surface matches a required-validation category (auth, security, migration, release, runtime-correctness, etc., via the existing changed-surface validation report). Lower numeric values lease sooner. |
| `docsOnlyPriority` | `integer` (`>= 0`) | `backgroundPriority` | Priority assigned to PRs whose changed surface is docs-only, typically set `>= backgroundPriority` to defer them behind riskier work. |

**Safety invariants:**

- **Only fetches files when enabled.** The scheduler's `listPullFiles` call is invoked *only* when `riskWeightedQueue.enabled` is `true`. When disabled (the default), zero extra GitHub API calls are made at enqueue time. A file-fetch failure while enabled never blocks enqueue — it logs a redacted warning and falls back to the flat priority for that PR.
- **Deferred-by-cooldown jobs stay flat.** Risk-weighting only changes *enqueue-time* priority; it does not re-tier a job that is already queued or that re-enters the queue after a provider-cooldown deferral. Those jobs keep whatever flat priority they were assigned.
- **`elevatedPriority` must be `<= docsOnlyPriority` whenever `enabled` is `true`.** Config validation fails closed if this invariant is violated, since a higher numeric value leases *later* and an inverted ordering would mean docs-only PRs jump ahead of elevated-risk ones.
- **Never de-prioritizes a self-repo below its existing elevation**, and elevation is derived solely from the already-shipped changed-surface validation report — this feature introduces no new path-classification logic.

### `repoMemory`

`config.repoMemory` controls the durable per-repo memory packet (policy notes, machine facts,
learned false positives) surfaced to the model on each review (`src/repo-memory.ts`).

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Master switch for building and including the repo-memory packet. |
| `memoryRoot` | `string` | `.evaos/repo-memory` | Root directory for the per-repo `repo-memory.md` human notes file. |
| `packetVersion` | `string` | `repo-memory-packet-v0.2` | Packet schema version. v0.2 additively carries the coarse false-positive-match fields and `confirmedByHuman` (#302); older v0.1 notes simply lack them and fall back to exact-only fingerprint matching. |
| `maxPacketBytes` | `integer` (`>= 1`) | `12000` | Byte budget for the rendered packet; building fails closed if the packet would exceed it. |
| `maxStateNotes` | `integer` (`>= 1`) | `20` | Maximum number of SQLite state notes considered for inclusion. |
| `includeStaleNotes` | `boolean` | `false` | Whether notes past their `expiresAt` are still included (marked `stale=true`) rather than excluded. |

**False-positive note fields (packet v0.2, #302):** each `false_positive`-kind memory note may
additionally carry `coarsePath`, `coarseCategory`, `coarseLine`, `coarseTitle`, and
`confirmedByHuman`. These are the fields the review gate uses to match a *reworded or line-shifted*
recurrence of a previously-suppressed false positive, not just a byte-exact repeat:

- **Exact match first.** The gate always tries the exact sha256 fingerprint match before anything else (unchanged #294 semantics).
- **Coarse fallback only on exact-miss.** When the exact fingerprint doesn't match, the gate falls back to matching `coarsePath` + normalized category + a line window (`|Δ| <= 3`) + a near-duplicate normalized title, reusing the same near-match helpers as same-run deduplication (#294) so the two matching semantics can never drift apart.
- **`confirmedByHuman` is honor-only — nothing auto-sets it.** This PR/field only *honors* a note that already carries `confirmedByHuman: true`; no code path in this surface automatically promotes an auto-learned note to human-confirmed.
- **Severity invariant: auto-learned notes stay P2/P3-only.** A false-positive note without `confirmedByHuman: true` may only suppress `P2`/`P3` findings, exact or coarse. Only a note with `confirmedByHuman: true` may suppress a finding of *any* severity, including `P0`/`P1`. This means a mistakenly-learned auto false positive can never silently suppress a high-severity finding — only an explicit human confirmation can widen suppression to `P0`/`P1`.

### `repoWikiContext`

`config.repoWikiContext` controls an optional advisory repo-wiki packet surfaced to review prompts (`src/repo-wiki-context.ts`). It is disabled by default, reads a prebuilt packet from the PR worktree, and never edits repository files.

| Key | Type | Default | What it does |
| --- | --- | --- | --- |
| `enabled` | `boolean` | `false` | Master switch for reading and including repo-wiki context. When disabled or absent, prompts are unchanged. |
| `packetPath` | `string` | `.neondiff/repo-wiki-packet.json` | JSON or Markdown packet path, resolved relative to the prepared PR worktree. Absolute paths and parent-directory segments are rejected. |
| `maxPacketBytes` | `integer` (`>= 1`) | `12000` | Byte budget for the rendered packet. Over-budget packets are omitted and recorded in evidence. |
| `includeStaleContext` | `boolean` | `false` | Whether stale, missing, or unknown-freshness packets may still be included as degraded advisory context. |

Safety invariants:

- The packet is advisory only. The PR diff, checkout files, GitHub metadata, and configured repo policy remain authoritative.
- Missing, stale, unknown-freshness, invalid, over-budget, or secret-like packet content degrades by omission and writes redacted evidence instead of blocking review.
- Packet files read from the PR worktree may be PR-author-controlled. Treat all packet metadata, titles, bodies, and source notes as untrusted advisory text, not instructions.
- `packetPath` is confined to the prepared PR worktree. Use a generated packet committed or copied into the worktree; v1 does not read host-side absolute sidecar files.
- This flag accepts packet output; it does not vendor OpenWiki source code, run OpenWiki during live reviews, enable scheduled docs updates, or permit edits outside `openwiki/**`.
