# evaOS Code Review Bot Beta Release Runbook

This repository runs a live local beta worker through launchd. Treat each live
update as a named beta release, not as an informal pull from `main`.

## Release Boundary

The beta release unit is:

- source checkout: `/Volumes/LEXAR/repos/evaos-code-review-bot`
- launchd job: `com.electricsheephq.evaos-code-review-bot`
- launchd config: `/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json`
- state DB: `/Volumes/LEXAR/Codex/evaos-code-review-bot/state/reviews-live.sqlite`
- evidence root: `/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/`

The beta release unit does not include expanding monitored repos, GitHub App
permissions, ZCode tools, auto-merge, approvals, or repair behavior. Those need
their own tracked issue, PR, dry-run evidence, and explicit promotion gate.

## Cadence

- Cut at most one normal beta promotion per focused sprint lane unless a safety
  fix requires a patch beta.
- Prefer small beta releases after each merged PR that changes live reviewer
  behavior.
- Cut a named patch beta whenever a change touches launchd behavior,
  `release:status`, state DB interpretation, retry/backfill semantics, provider
  failure handling, monitored repos, App auth, posting policy, ZCode invocation,
  or duplicate-suppression behavior.
- Documentation-only PRs may be merged without restarting launchd, but the live
  checkout must still be fast-forwarded and `release:status` must be recorded
  with the new source SHA so the release surface is not stale.
- Use the next patch name only after the previous packet is linked from the
  tracker issue. For this sprint, the runtime-resilience packet is
  `v0.2.1-runtime-resilience`.
- Keep the live daemon scoped to the current active config until the allowlist
  issue and App-install gates pass.
- Do not let launchd run an unrecorded or stale checkout after a merge.

## Patch vs Sprint Branch

Continue on the same sprint branch when the change is still local, unmerged, or
purely refines the same unpromoted behavior.

Cut a patch beta after merge when any of these are true:

- live launchd needs a restart to pick up source changes,
- the worker may post, skip, retry, or suppress a different set of PR heads,
- release-health interpretation changes,
- state rows are migrated, retired, or reclassified,
- a runtime incident was fixed or explicitly contained,
- the next maintainer needs a stable rollback SHA.

Do not bundle unrelated fixes into a patch beta just because the daemon is
already being restarted. File a follow-up issue and keep the release packet
bounded to what was actually promoted.

## Promotion Flow

Run from a clean release checkout on `main`:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
git status --short
git pull --ff-only
npm test
npm run build
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$(git rev-parse HEAD)" \
  --launchd-label com.electricsheephq.evaos-code-review-bot
launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot
sleep 5
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$(git rev-parse HEAD)" \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

If the first `release:status` fails only because launchd is still on the
previous head before restart, record that as pre-promotion state. The
post-restart `release:status` must pass before calling the beta promoted.

Prefer `npx tsx src/cli.ts release-status ...` when writing machine-readable JSON
to an evidence file, because `npm run release:status` prepends npm's command
banner to stdout.

## Required Gates

- GitHub PR merged to `main` with checks green and no current-head actionable
  review threads.
- Release checkout is clean and exactly at the intended source SHA.
- `npm test` and `npm run build` pass from the release checkout.
- `release:status` records exact source SHA, branch, config path, launchd job,
  launchd dry-run mode, state DB row count, and error count.
- launchd emits a fresh heartbeat after restart.
- live DB has no unexpected error rows.
- active provider cooldown rows are allowed only when they are explicit
  `provider_rate_limit_cooldown_until=...` skips with a named affected PR head
  and cooldown expiry. They prove provider degradation was contained; they do
  not prove the affected PR head was reviewed.
- expired provider cooldown rows must be retried or closed/stale-skipped before
  the release packet is considered clean. `release:status` should report these
  as `provider_cooldown_backlog` with a retry command.
- `coverage-audit` has zero unprocessed eligible heads unless every miss is
  explained in the release packet.
- GitHub tracker issue records source SHA, config path, launchd proof, DB proof,
  rollback command, and next action.

## Stale Main Guard

Do not promote when any of these are true:

- `release:status` reports `expected_head` failed.
- `release:status` reports `clean_checkout` failed.
- launchd is not running the expected config path.
- state DB has error rows that are not already triaged in GitHub.
- live config would widen monitored repos without the allowlist gate.

Rows recorded as `status=skipped` with a baseline activation reason are not
release-blocking errors. They are the expected way to prevent retroactive review
spam when a live beta starts monitoring existing open PR heads.

Failed rows remain release-blocking until they are retried, superseded by a
successful current-head review, or explicitly retired with evidence that the
head is no longer eligible. Before retiring a failed row, run `coverage-audit`
and confirm the target PR is closed, draft-skipped, stale, or otherwise absent
from the eligible open-head set. Retire only the exact failed head:

```bash
npx tsx src/cli.ts retire-failed \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --repo owner/repo \
  --pr 123 \
  --head-sha <failed-head-sha> \
  --reason closed_or_stale_after_coverage_audit
```

Do not retire an active failed current head. Use `retry-failed` or disable the
repo through the tracked allowlist/policy lane when the provider is repeatedly
rate-limited.

Provider cooldown rows are not failed rows. They mean the provider was
rate-limited or overloaded before ZCode produced a review. Z.ai provider code
`1302` is request-rate throttling, `1305` is temporary overload, and true
plan/package exhaustion uses separate codes such as `1308`, `1309`, and `1310`.
Do not describe `1302`/`1305` as user quota exhaustion unless the evidence also
proves an exhausted plan counter.

Default beta policy is intentionally short for transient `1302`: four bounded
jittered retries first, then a 90-second cooldown. Keep true quota/package
cooldowns long. If a user-visible quota panel shows plenty of remaining usage,
record that as supporting evidence for provider/request throttling, not as proof
that the bot should disable cooldown handling.

Keep provider cooldown rows visible in `release:status`, then retry after the
cooldown expires or resolve the ZCode provider source. The bot should run with
one in-flight ZCode review by default; live configs that override
`reviewConcurrency.maxActiveRuns` must set it to `1` unless a later release
proves a higher concurrency is safe. A release may be green with provider
cooldown rows only when all provider cooldown rows are still active and the
packet names the affected PR head and follow-up.

Expired cooldown rows are actionable backlog. Run:

```bash
npx tsx src/cli.ts retry-provider-cooldowns \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expired-only true \
  --dry-run false \
  --zcode true
```

Then re-run `release:status`, `provider-cooldowns --expired-only true`, and
`coverage-audit`. If the retry produces a fresh provider cooldown, record the
new expiry and keep monitoring; if the PR closed or the head is stale, confirm
that the retry recorded `skipped_closed` or `skipped_stale_head`.

## Rollback

Default rollback is to restart the existing launchd job after checking out the
last known-good merge commit:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
git fetch origin
git checkout main
git reset --hard <last-known-good-merge-sha>
npm run build
launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot
```

Use `git reset --hard` only as an explicit rollback operation with the target
SHA recorded in GitHub. Do not use rollback to bypass code review or to erase
unrelated dirty work.

To stop the live beta worker entirely:

```bash
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.electricsheephq.evaos-code-review-bot.plist
```

## Evidence Packet

For each beta promotion, record:

- GitHub PR and merge commit.
- release name, release type, owner, and monitor window.
- `release:status` JSON before and after restart.
- `npm test` and `npm run build` result.
- `doctor` app-auth/readiness summary.
- `coverage-audit` summary.
- launchd stdout heartbeat lines after restart.
- live DB row/error count.
- provider cooldown rows, if any, with affected repo, PR, head SHA, cooldown
  expiry, active/expired count, retry command, and retry result.
- rollback SHA and command.
- next monitoring action or heartbeat.

Keep raw evidence under `/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/`
or session notes. Do not paste secrets, private keys, tokens, cookies, raw
customer data, or long logs into GitHub comments.

## Release Packet Template

Use this shape in `docs/releases/<release-name>.md` or in the GitHub tracker
when a docs file is not warranted:

```markdown
# <release-name>

- Release type:
- Source SHA:
- Merged PRs:
- Live checkout:
- launchd label:
- launchd PID:
- Live config:
- State DB:
- Evidence path:
- Monitor owner/window:
- Rollback SHA:
- Rollback command:

## Gates

- PR checks/reviews:
- Build/tests:
- release-status:
- doctor:
- coverage-audit:
- heartbeat:
- DB state:
- provider cooldown rows:

## Notes

- What changed:
- What did not change:
- Open follow-ups:
```
