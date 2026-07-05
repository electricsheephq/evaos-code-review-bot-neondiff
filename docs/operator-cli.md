# Operator CLI

The bot has a JSON-first operator CLI for humans, manager agents, and reviewer
agents. It is the preferred way to answer runtime questions before touching
launchd, SQLite, or GitHub state by hand.

Run commands from the repository checkout:

```bash
npx tsx src/cli.ts status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

After `npm run build` and `npm link`, the package exposes both the public beta
binary and the legacy internal binary:

```bash
neondiff status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
evaos-review-bot status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

## Commands

- `status`: aggregated operator health. Includes release gates, launchd,
  heartbeat, DB error/cooldown counts, coverage buckets, active/stale leases,
  durable queue counts, and recommended actions.
- `runtime-inventory`: read-only runtime classifier for release operators. It
  includes release status, coverage, durable queue work, provider cooldowns,
  budget status, leases, heartbeat, and bot-owned process rows. It can classify
  the worker as `healthy_active` when open PR heads are already covered by
  active queue work, even if the stricter `status` command is nonzero because
  live PR churn exists. JSON is the default; use `--human` for a compact
  operator summary.
- `agents`: launchd, heartbeat, and review-run lease inventory. This is
  read-only; it does not restart, kill, prune, or retire anything.
- `queue`: open PR-head coverage grouped into processed, provider-deferred,
  pending review, skipped, stale-head, and read-failure buckets. Also includes
  durable `review_queue_jobs` rows and budget delay reasons when the state DB
  has the scheduler table. The command reports both `coverageOk` and
  `runtimeOk`; `coverageOk: true` can still pair with `runtimeOk: false` when
  every PR head is covered but a durable queue row is failed or ready to retry.
  Durable queue summaries include the oldest waiting repo/head age so burst
  backlogs can be diagnosed without hand-querying SQLite.
- `dashboard`: read-only PR review dashboard over coverage, durable queue,
  readiness lifecycle rows, GitHub PR links, and local evidence-path hints.
  Filter with `--repo`, `--status`, `--priority`, `--stale-head-reason`, and
  `--limit`. By default the dashboard hides stale-only historical rows so the
  operator gate reflects current-head health; use `--include-history true` or an
  explicit stale status filter when investigating historical rows. Use
  `--job-limit` to cap durable-queue/readiness rows read from SQLite before
  merging; `--limit` caps the final merged item list. JSON is the default; use
  `--human` for a compact operator view. The command exits nonzero when visible
  rows are blocked; healthy active rows are counted but do not fail the gate by
  themselves.
- `budget-status`: read-only scheduler budget projection. Shows active counts,
  queued counts, would-lease jobs, delayed jobs, and deterministic delay reasons
  such as `provider_cooldown`, `provider_capacity`, `org_capacity`,
  `repo_capacity`, `manual_reserve`, and `lease_limit`. Broad status commands
  include only compact budget counts and reason histograms; use this command for
  capped row-level details. Repo profiles may lower effective active/queued
  scheduler caps for bursty repositories without changing global capacity.
- `review-head-gate --repo <owner/name> --pr <number> --head-sha <sha>`:
  read-only pre-merge guard for self-repo and release-critical PRs. It checks
  the exact `{repo, pr, head_sha}` against processed reviews, durable queue
  state, and readiness state. It exits zero only when the exact head has a live
  recorded, non-blocking evaOS review; missing, queued, provider-deferred,
  skipped, failed, stale, closed, or dry-run-only heads exit nonzero with a next
  action. The gate does not independently prove GitHub App authorship; pair it
  with `release-status` to verify the live App-backed launchd configuration.
- `coverage`: raw coverage-audit report with the shorter operator command name.
- `cooldowns`: provider cooldown review rows plus repo/global cooldown rows.
- `clear-review-queue-leases`: dry-run-first recovery command for stale
  review-run leases and leased/running durable PR review queue rows. Use it
  instead of manual SQLite edits after launchd restarts leave orphaned review
  work. Mutation requires `--dry-run false --confirm true`; active/non-expired
  rows additionally require `--expired-only false --force-active true`.
- `why --repo <owner/name> --pr <number>`: scoped explanation for why one PR
  head is processed, pending, provider-deferred, skipped, blocked by a read
  failure, or unknown.
- `build-memory-packet --repo <owner/name>`: compiles a durable repo-memory
  packet from `<configured repoMemory.memoryRoot>/<owner>/<repo>/repo-memory.md`
  plus safe SQLite memory notes. It emits JSON with an embedded Markdown
  packet, SHA-256, byte/token estimates, source IDs, dropped-source reasons,
  and a redaction report. Use `--output-dir <path>` to write
  `repo-memory-packet.json` and `repo-memory-packet.md` evidence. This command
  does not call GitHub or ZCode and does not enable prompt memory by itself.
- `build-gitnexus-context-packet --repo <owner/name> --pr <number>`: compiles
  a read-only GitNexus advisory context packet for one PR. It reads GitHub PR
  metadata/files, probes `gitnexus list`, optionally runs bounded `gitnexus
  query` calls when a fresh matching alias is found, and emits JSON/Markdown
  with the packet SHA, byte/token estimates, changed files, omitted context,
  index freshness, degraded-mode reason, and redaction report. Use
  `--output-dir <path>` to write `gitnexus-context-packet.json` and
  `gitnexus-context-packet.md` evidence. This command never posts comments,
  calls ZCode, runs tests, or indexes repositories.
- `build-github-related-context-packet --repo <owner/name> --pr <number>`:
  compiles a read-only GitHub related-context packet for one PR. It extracts
  explicit issue/PR references from the PR title/body, fetches capped issue/PR
  metadata with App read credentials, and emits JSON/Markdown with packet SHA,
  byte/token estimates, omitted references, and a redaction report. Use
  `--output-dir <path>` to write `github-related-context-packet.json` and
  `github-related-context-packet.md` evidence. This command never posts
  comments, calls ZCode, auto-applies labels/reviewers, or searches GitHub
  beyond explicit references.
- `build-skill-pack`: compiles configured read-only skill-pack files into an
  advisory prompt packet. It emits JSON/Markdown with packet SHA, byte/token
  estimates, source provenance, omitted-source reasons, and a redaction report.
  Use `--output-dir <path>` to write `skill-pack-context-packet.json` and
  `skill-pack-context-packet.md` evidence. This command never enables native
  ZCode skills, MCP, tools, shell, web, memory, agents, or writes.
- `build-enrichment-comment --repo <owner/name> --pr <number>` or
  `--issue <number>`: builds the sticky PR or issue enrichment comment body for
  dry-run inspection. PR mode reads GitHub PR metadata/files, current policy,
  changed-surface validation, and proof requirements. Issue mode reads GitHub
  issue metadata, skips closed issues as `stale_issue_closed`, and skips
  PR-shaped issue records as `issue_is_pull_request`. Both modes emit
  JSON/Markdown with the bot-owned marker and rendered comment when not skipped.
  This command never posts comments, auto-applies labels, assigns reviewers,
  calls ZCode, or mutates GitHub state.
- `issue-enrichment-scan`: dry-run scans only `issueEnrichment.allowlist`, not
  the PR monitor allowlist. It lists recently updated issues by default, skips
  closed issues and PR-shaped issue records, applies per-repo throttles, and
  reports would-comment/deferred rows without posting comments. Use
  `--include-existing true` only for an explicit scoped audit; do not use it as
  the default live posture for repos with large historic issue backlogs.
- `issue-enrichment-run --repo <owner/name> --issue <number>`: runs selected
  issue enrichment through the same sticky comment and SQLite record path used
  by daemon cycles. The repo must be in `issueEnrichment.allowlist`, the feature
  must be enabled in config, and live posting requires `--dry-run false
  --confirm true` plus GitHub App credentials. Repeat `--issue` to process a
  small selected batch. Closed issues and PR-shaped issue records fail before
  posting. Unchanged live reruns skip already processed issues; use `--force
  true` only when deliberately re-upserting the existing bot-owned marker
  comment; `--force true` requires `--dry-run false`. Selected live runs reject
  batches that exceed the effective repo/global issue or comment cap before
  fetching or posting. Dry runs do not post comments, but they still plan
  against live issue/comment caps and may report deferred rows. A confirmed live
  run that cannot acquire the shared issue-enrichment worker lease exits
  nonzero and reports `workerSkipped: 1` in JSON. Use `--output-dir <path>`
  under the configured `evidenceDir` to write redacted
  `issue-enrichment-run.json` plus one redacted `issue-<number>.md` preview per
  issue. This command never applies labels, owners, reviewers, or roadmap
  fields.
- `doctor`: auth/config readiness. Use this for GitHub App/ZCode readiness, not
  runtime health.
- `init --config <path>`: copy `config.example.json` to a local config path
  without embedding credentials. Refuses to overwrite unless `--force true` is
  supplied.
- `review-pr --repo <owner/name> --pr <number> --dry-run true`: public alias for
  the existing scoped `run-once` review command. Live posting through this
  public alias requires `--dry-run false --confirm true` after the exact repo,
  PR, head SHA, and config path are approved.
- `daemon start|stop|status`: JSON-first launchd controls. All daemon
  subcommands require `--launchd-label`; `start` and `stop` default to dry-run planning; live mutation
  requires both `--dry-run false` and `--confirm true`.
  When `start` uses `--plist <path>`, `stop` can either pass the same `--plist`
  to boot out by domain/plist or omit `--plist` to boot out by service label.
  `start` without `--plist` restarts an already loaded LaunchAgent; first-time
  installation must pass `--plist`. Use only operator-owned plist paths. Live
  mutation with a `--plist` outside the NeonDiff package root requires
  `--allow-external-plist true`; dry-run still reports the warning and planned
  commands without mutating launchd. The external-plist warning is a lexical
  path check, not a realpath/symlink containment proof.
  If a live `bootstrap` fails because the LaunchAgent is already loaded, rerun
  `daemon start` without `--plist` to use the kickstart-only restart path.
- `daemon --config <config.json> --dry-run true --once true`: runs one legacy
  daemon cycle and exits. This is intended for deterministic local smoke tests
  and operator diagnostics; omit `--once true` for the normal long-running
  worker loop.

## Common Operator Flows

Check whether the live bot is healthy:

```bash
npx tsx src/cli.ts status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

Classify whether the bot is idle, healthy-active, or blocked:

```bash
npx tsx src/cli.ts runtime-inventory --json --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

Show the same runtime inventory as a short human summary:

```bash
npx tsx src/cli.ts runtime-inventory --human --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

See whether review agents are active, idle, or stale:

```bash
npx tsx src/cli.ts agents --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

Find open PR heads that still need review work:

```bash
npx tsx src/cli.ts queue --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

Run one scoped review pass and inspect the structured result:

```bash
npx tsx src/cli.ts run-once --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --repo electricsheephq/evaos-code-review-bot --pr 142 --dry-run true --zcode false
```

`run-once` always prints a JSON report on stdout before returning. Treat that
report as the operator source of truth for `reviewed`, `failed`,
`skippedProcessed`, `skippedCapacity`, `skippedProviderCooldown`,
`skippedStaleHead`, and scoped PR metadata such as `headSha` and `url`.
A nonzero exit means one or more review attempts failed, including partial
per-PR failures; it does not by itself mean the command failed to scan or that
all other reviews failed. Check the JSON `result` and evidence paths before
promoting, retrying, or treating the run as a total outage.

Inspect only durable provider-deferred jobs:

```bash
npx tsx src/cli.ts queue --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --state provider_deferred
```

If `queue` returns `coverageOk: true` and `runtimeOk: false`, coverage has found
every eligible head but the durable queue still has actionable runtime debt.
Inspect `failedGates`, `recommendedActions`, and `actionableRows` before
restarting launchd or retrying provider work.

Show the review dashboard:

```bash
npx tsx src/cli.ts dashboard --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
```

Show dashboard rows blocked on proof:

```bash
npx tsx src/cli.ts dashboard --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --status blocked_on_proof
```

Include stale-only historical rows when diagnosing old heads:

```bash
npx tsx src/cli.ts dashboard --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --include-history true
```

Show one repo as a short human dashboard:

```bash
npx tsx src/cli.ts dashboard --human --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --repo electricsheephq/evaos-code-review-bot
```

Inspect only the scheduler budget projection:

```bash
npx tsx src/cli.ts budget-status --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --launchd-label com.electricsheephq.evaos-code-review-bot
```

Use `--limit <n>` to cap returned `wouldLease`/`delayed` rows and
`--job-limit <n>` to cap the queue rows read for projection. The output includes
truncation metadata when either cap is hit.

Explain one PR:

```bash
npx tsx src/cli.ts why --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --repo 100yenadmin/Lossless-Codex-Orchestrator-LCO --pr 253
```

Inspect provider cooldowns:

```bash
npx tsx src/cli.ts provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true
```

The provider-cooldown output includes `runtimeOk`, `healthState`, `failedGates`,
and a compact summary of expired cooldown rows plus durable queue provider
backpressure. `provider_cooldowns_backpressured` means retryable
provider-deferred jobs exist, but provider capacity is currently occupied by an
active run; wait for that run to finish before retrying.

Dry-run stale review queue lease cleanup:

```bash
npx tsx src/cli.ts clear-review-queue-leases --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --dry-run true --expired-only true
```

Apply expired-only cleanup after inspecting the dry-run output:

```bash
npx tsx src/cli.ts clear-review-queue-leases --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --dry-run false --confirm true --expired-only true
```

`--force-active true` only applies to queue jobs matched by the explicit filters.
It does not clear healthy global run leases; stale/dead run leases are removed
only when they are independently expired or owned by a dead worker.

Build a repo-memory packet for dry-run evidence:

```bash
npx tsx src/cli.ts build-memory-packet --config <config.json> --repo electricsheephq/evaos-code-review-bot --output-dir <configured-evidence-dir>/repo-memory-packets/evaos-code-review-bot
```

Use `--fingerprint <finding-fingerprint>` to include exact-match false-positive
notes, `--format markdown` for Markdown-only output, or `--record-build true`
when the packet SHA should be recorded in SQLite provenance.

Build a GitNexus context packet for dry-run evidence:

```bash
npx tsx src/cli.ts build-gitnexus-context-packet --config <config.json> --repo electricsheephq/evaos-code-review-bot --pr 102 --output-dir <configured-evidence-dir>/gitnexus-context/evaos-code-review-bot-pr-102
```

Missing or stale GitNexus indexes produce `degradedMode: true` packets and do
not block baseline review. Secret-like GitNexus output fails closed and writes a
redacted `gitnexus-context-packet-error.json` evidence file.

Build a GitHub related-context packet for dry-run evidence:

```bash
npx tsx src/cli.ts build-github-related-context-packet --config <config.json> --repo electricsheephq/evaos-code-review-bot --pr 102 --output-dir <configured-evidence-dir>/github-related-context/evaos-code-review-bot-pr-102
```

The packet is advisory only. It cannot justify posted findings without
current-diff RIGHT-side evidence, and cross-repo references stay disabled unless
explicitly enabled for that dry run or config.

Build a read-only skill-pack packet for dry-run evidence:

```bash
npx tsx src/cli.ts build-skill-pack --config <config.json> --output-dir <configured-evidence-dir>/skill-packs/default-config
```

The packet is advisory prompt context only. Native ZCode `skill: true`, MCP,
tools, shell, web, memory, agents, and writes remain disabled even when the
packet is enabled by config.

Build a sticky enrichment comment for dry-run evidence:

```bash
npx tsx src/cli.ts build-enrichment-comment --config <config.json> --repo electricsheephq/evaos-code-review-bot --pr 102 --output-dir <configured-evidence-dir>/enrichment/evaos-code-review-bot-pr-102
```

The dry-run output includes the hidden sticky marker used for future update
behavior, but it does not post the comment or apply suggested labels/reviewers.

Build a sticky issue enrichment comment for dry-run evidence:

```bash
npx tsx src/cli.ts build-enrichment-comment --config <config.json> --repo electricsheephq/evaos-code-review-bot --issue 10 --output-dir <configured-evidence-dir>/enrichment/evaos-code-review-bot-issue-10
```

Closed issues are reported as `skipped: true` with reason
`stale_issue_closed`. PR-shaped issue records are reported as `skipped: true`
with reason `issue_is_pull_request`. No Markdown body is written for skipped
issues.

Issue mode requires an authenticated token or GitHub App installation with
Issues read access. Live App-authored issue comments require Issues write
permission and must not be enabled until that permission expansion is tracked.

Dry-run scan issue enrichment against the separate issue allowlist:

```bash
npx tsx src/cli.ts issue-enrichment-scan --config <config.json> --dry-run true --output-dir <configured-evidence-dir>/issue-enrichment/scan
```

The scan does not use `pilotRepos`, does not post comments, and defaults to the
larger of the configured recent-update lookback and burst window. Deferred rows
include `nextEligibleAt` based on the configured cooldown. Per-repo throttles live under
`issueEnrichment.repos.<owner/name>` and can cap `maxIssuesPerCycle`,
`maxCommentsPerCycle`, burst thresholds, cooldown, and backlog behavior.
Issue label and reviewer/owner allowlists come only from
`issueEnrichment.allowedLabels` / `issueEnrichment.allowedReviewers` or the
matching per-repo override. They constrain inferred issue suggestions; they do
not create suggestions by themselves, and they intentionally do not use
`repoProfiles.suggestedLabels` or `repoProfiles.suggestedReviewers`, which belong
to PR review enrichment. Empty global allowlists mean no allowlist restriction.
An empty per-repo allowlist override falls back to the global allowlist, so
copying the example block cannot accidentally erase a non-empty global cap.

When the daemon first sees a newly allowlisted issue-enrichment repo with
`processExistingOpenIssuesOnActivation: false`, it records a per-repo activation
watermark and does not scan existing open issues on that cycle. Later cycles use
that watermark as the repo-specific `since` boundary and advance it only after a
successful non-truncated scan with no deferred or failed issue-enrichment rows.
Explicit dry-run/backfill commands can still opt into existing issues with
`includeExisting` / `--include-existing` style controls.

## Safety Boundaries

Default operator commands are read-only. They can return nonzero when a gate is
unhealthy, but they do not mutate GitHub, launchd, config files, worktrees, or
SQLite rows.

`runtime-inventory` process rows are bounded to the bot launchd PID, commands
containing the current bot repo path or launchd label, and children of those
matched bot processes. It redacts token-like strings and does not inspect or
print process environments.

Mutating commands remain explicit:

- `retry-provider-cooldowns --dry-run false`
- `retry-failed --dry-run false`
- `retire-failed --dry-run false`
- `build-memory-packet --record-build true`
- `run-once --dry-run false`
- `daemon --dry-run false`
- `daemon start|stop --dry-run false --confirm true`

`retire-failed` defaults to dry-run and prints the normalized retirement reason
plus any failed queue jobs that a live run would reconcile. If the processed row
is already a retired failed head, dry-run returns `alreadyRetired`; rerunning
with `--dry-run false` is idempotent for the processed row and can still retire
matching failed queue jobs.

`build-skill-pack` and `build-enrichment-comment` are dry-run/evidence builders.
They remain read-only. Live `run-once` and `daemon` can consume skill-pack
prompt packets only when `skillPacks.enabled` is true, and can post enrichment
comments only when `enrichment.enabled`, `enrichment.postIssueComment`, App
credentials, and non-dry-run mode are all present.

The CLI intentionally does not implement a global pause-all policy,
one-at-a-time global queue policy, process killing, or Z.ai peak-hour blackout.
Those belong to scheduler/session work and documented operator decisions, not
hidden CLI side effects.
