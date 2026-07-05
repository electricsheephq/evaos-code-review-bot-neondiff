# Read-Only GitNexus Adapter Research

Issue: [#271](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/271)

## Recommendation

Keep the current packet-only GitNexus architecture as the live/default behavior.
Open a follow-up implementation issue only for a shadow/offline, NeonDiff-owned
read-only adapter evaluation. Do not give ZCode direct raw GitNexus CLI, MCP,
shell, web, memory, skill, or agent access.

The recommended next architecture is:

1. NeonDiff remains the only component that calls GitNexus.
2. ZCode remains a headless reviewer with read-only checkout inspection only.
3. A future adapter, if implemented, exposes a narrow request/response contract
   owned by NeonDiff, not arbitrary GitNexus commands.
4. Every adapter request, command, result, omission, redaction report, timeout,
   freshness decision, and budget decision is written to review evidence.
5. Live rollout stays blocked until offline/shadow evals prove quality or
   runtime wins without any index, repo, config, or policy mutation.

Raw ZCode GitNexus access is not recommended. It conflicts with the current
review policy and makes reproducibility, command allowlisting, stale-index
handling, redaction, and local resource control harder than the packet-only or
wrapper-owned designs.

## Current Source Behavior

This research is based on local source inspection at `origin/main` commit
`0f5be870ce303259f1ba6d7227b98704ecf5a81b`.

Current GitNexus behavior is packet-only:

- `config.example.json` sets `gitnexusContext.enabled` to `false`.
- When enabled, `src/gitnexus-context.ts` builds an advisory packet using
  bounded `gitnexus list` and `gitnexus query` calls.
- The packet records alias, freshness, changed files, related context, omitted
  context, byte/token estimates, SHA-256, and a redaction-report hash.
- Stale or missing indexes degrade into omitted context unless
  `includeStaleContext` is explicitly configured.
- Generated/build paths are omitted from query selection.
- Secret-like GitNexus output blocks packet generation fail-closed.

Current ZCode behavior is intentionally narrower than a tool-using agent:

- `src/zcode.ts` prompts ZCode not to modify files, run tests, run package
  scripts, run builds, run app commands, execute arbitrary PR code, or call
  Bash/shell commands.
- `withTemporaryZCodeReviewPolicy` writes a temporary project policy for the
  review run.
- The policy allows only `Read`, `Grep`, `Glob`, and `LS`.
- The policy disallows `Bash`, `Shell`, `Edit`, `Write`, `MultiEdit`,
  `NotebookEdit`, `WebFetch`, `WebSearch`, `Task`, `Agent`, `Workflow`, and
  `SendMessage`.
- The policy disables subagents, MCP, memory, and skills.
- Tool concurrency is capped at `1`.
- ZCode receives GitNexus only as advisory prompt text through
  `buildGitNexusContextPromptSection`.

Release notes for the GitNexus packet feature preserve the same boundary:
GitNexus context stayed disabled in live config by default, and the release did
not enable native ZCode skills, MCP, shell, web, auto-merge, approvals, GitHub
App permission changes, or repo mutation.

## Architecture Options

### Option A: Packet-Only

NeonDiff calls GitNexus before ZCode runs, builds a deterministic bounded packet,
writes evidence, and injects the packet into the review prompt.

This is the recommended live/default architecture.

Strengths:

- Deterministic and replayable.
- Smallest policy surface.
- Existing implementation already has budget, freshness, generated-path, and
  redaction gates.
- No live tool access inside ZCode.
- Easy to keep disabled by default and roll out per repo.

Weaknesses:

- Wrapper heuristics must predict useful context before review.
- Packets can miss follow-up questions the reviewer discovers while reading.
- Packets can waste prompt budget when the selected context is too broad.

### Option B: Direct Raw ZCode GitNexus Access

ZCode can call GitNexus itself during review.

This is not recommended.

The current ZCode policy explicitly disables the tool families this would need.
Granting raw access would require proving subcommand-level enforcement across
CLI/MCP boundaries, blocking index writes and config mutation, logging every
query/result, redacting every output, and keeping the review reproducible.

### Option C: NeonDiff-Owned Read-Only Adapter

ZCode still does not receive raw GitNexus. NeonDiff owns a bounded adapter and
either performs controlled request/response turns or precomputes additional
packets from explicit reviewer requests.

This is the recommended follow-up evaluation path, not a live default.

Adapter constraints:

- Repo scope is the current PR repo only.
- Inputs are structured, not free-form shell commands.
- Results are capped by query count, token/byte budget, wall-clock timeout, and
  per-command output size.
- Every request/result is redacted and persisted in evidence before it can
  influence a posted review.
- Missing/stale indexes degrade to advisory omitted context.
- Adapter failure cannot block review unless a later rollout deliberately makes
  the feature required for a specific eval lane.

## Safe GitNexus Operations

Allowed only through NeonDiff-owned code, with fixed arguments, per-review
budgets, redaction, and evidence logging:

| Operation | Allowed use | Notes |
| --- | --- | --- |
| `gitnexus list` | Resolve the target repo alias and index metadata. | Already used by the packet builder. |
| `gitnexus status` | Read freshness for the current repo checkout. | Safe as evidence, but status alone must not trigger refresh. |
| `gitnexus query --repo <alias> <query>` | Retrieve bounded related context for changed files or symbols. | Already used by the packet builder; cap `--limit` and `--max-tokens`. |
| `gitnexus context --repo <alias> <symbol>` | Retrieve callers/callees for a known symbol. | Adapter should require a symbol or file disambiguator from changed files. |
| `gitnexus impact --repo <alias> <symbol> --summary-only` | Estimate affected symbols for a known changed symbol. | Prefer summary mode first; full output needs stricter budgets. |
| `gitnexus detect-changes --repo <alias> --scope compare --base-ref <base>` | Map a bounded diff to indexed symbols. | Only if run in the isolated PR checkout and logged as evidence. |
| `gitnexus doctor` | Diagnostic evidence for GitNexus capability/config state. | Do not include raw env/secrets in prompts or comments. |

Adapter output should include command identity and sanitized previews, not raw
unbounded terminal output.

## Forbidden GitNexus Operations

These are forbidden for #271 and should stay forbidden inside any review-time
adapter:

- `gitnexus analyze`
- `gitnexus analyze --embeddings`
- index refresh, rebuild, or embedding writes
- `gitnexus index`
- `gitnexus clean`
- `gitnexus remove`
- `gitnexus setup`
- `gitnexus uninstall`
- `gitnexus publish`
- `gitnexus serve`
- `gitnexus mcp` as a review-time tool server exposed to ZCode
- `gitnexus eval-server`
- `gitnexus wiki` when it writes generated artifacts
- arbitrary `gitnexus cypher`
- shell passthrough or any command string assembled by ZCode
- writes to GitNexus config, registry, allowlists, launchd, live config, tags,
  releases, GitHub App permissions, or target repositories

Post-merge index refresh remains release hygiene only and belongs to a separate
approved issue/release lane.

## Eval Plan

Use `docs/evals/gitnexus-readonly-adapter-eval-plan.md` for the detailed plan.
The short version is a three-way shadow comparison:

1. Baseline current review prompt without GitNexus context.
2. Packet mode with the existing precomputed GitNexus packet.
3. Adapter candidate mode with a simulated or prototype NeonDiff-owned
   read-only adapter.

Sample set:

- At least 20 historical PRs across NeonDiff, WorldOS, LCO, evaOS-GUI, and one
  negative-control docs-only set.
- Include at least 8 complex multi-file implementation PRs.
- Include at least 5 docs-only or generated-file-heavy negative controls.
- Include at least 5 PRs with known human, CodeRabbit, CI, or merged-fix labels.

Minimum promotion thresholds for a follow-up implementation PR:

- Index mutation count: `0`.
- Target repo mutation count: `0`.
- Live config, launchd, GitHub App permission, tag, and release mutation count:
  `0`.
- Secret redaction failures: `0`.
- Invalid current-diff-line findings: `0`.
- Duplicate finding rate no worse than packet mode.
- False-positive rate no worse than packet mode.
- Valid P0/P1/P2 recall at least 10% better than packet mode, or median
  wall-clock review duration at least 15% lower with no quality regression.
- Evidence packet completeness: 100% of adapter requests and results logged.
- Stale/missing index behavior: 100% degraded without blocking or mutation.

## Complexity And Rollout Risk

Packet-only maintenance:

- Complexity: low.
- Rollout risk: low.
- Best for current live/default behavior.

NeonDiff-owned adapter:

- Complexity: medium to high.
- Rollout risk: medium.
- Main work: structured adapter contract, query planner, strict command
  allowlist, evidence schema, redaction and budget gates, ZCode request/response
  orchestration, offline/shadow eval harness integration, and operator docs.
- Main risks: accidental command widening, stale-index confusion,
  non-reproducible review context, local latency/resource regressions, and false
  confidence from too-small eval samples.

Raw ZCode GitNexus access:

- Complexity: high.
- Rollout risk: high.
- Main risk: breaks the current safety model by moving command choice into the
  headless reviewer.

## Follow-Up Recommendation

Open one follow-up implementation issue only if the team wants to evaluate
Option C. The issue should be scoped to an offline/shadow adapter prototype and
must not enable live config, ZCode policy expansion, GitHub App permission
changes, launchd changes, index refresh/rebuild, or runtime tool access.

Recommended follow-up title:

`Evaluate NeonDiff-owned read-only GitNexus adapter in shadow mode`

The issue should require:

- The eval plan in `docs/evals/gitnexus-readonly-adapter-eval-plan.md`.
- No live config change.
- No raw ZCode GitNexus access.
- No index writes.
- Evidence packets under `/Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/`.
- A promotion decision that can still choose packet-only.
