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

Packaged or non-source deployments must set
`NEONDIFF_PROTECTED_CHECKOUT_ROOT` to the live operator checkout so
review mirrors and worktrees cannot be planned inside or above that checkout.

The beta release unit does not include expanding monitored repos, GitHub App
permissions, ZCode tools, auto-merge, approvals, or repair behavior. Those need
their own tracked issue, PR, dry-run evidence, and explicit promotion gate.

Public source-beta releases also include a compact manifest at
`docs/public-release-manifest.json`. That manifest is the release-status input
for docs version alignment, license API readiness or explicit deferral, and
update-channel readiness for CLI, daemon, website, and desktop surfaces.

The 1.0 cut line is intentionally narrower than full desktop maturity:
`1.0 is a usable local HTML installer/dashboard plus minimal Mac launcher, not
full signed desktop maturity.` Keep release notes aligned to these public
surface stages:

| Stage | Required For 1.0 | Allowed Claims | Forbidden Claims |
| --- | --- | --- | --- |
| CLI/dashboard GA | Yes | `npm install -g neondiff`; `neondiff dashboard` starts and opens a local HTML dashboard; dashboard supports first-run setup/status and redacted provider API-key verification. | Signed desktop artifacts, Sparkle appcast/auto-update readiness, native Swift desktop maturity. |
| Minimal Mac launcher GA | Yes | A minimal Mac icon/app launcher opens the same local HTML dashboard. | Full native app maturity, signing/notarization, appcast, auto-update, or TCC readiness. |
| Signed/appcast desktop | Post-launch unless owner-promoted | Signed/notarized desktop, Sparkle/appcast, updater, and native Swift polish only after #449/#116 proof. | Treating browser preview or unsigned launcher smoke as signed desktop release proof. |

Represent browser dashboard readiness separately from desktop readiness in
`docs/public-release-manifest.json` when the distinction matters. The dashboard
may be ready while signed desktop/appcast remains explicitly post-launch.

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

Before running the flow below, append the release's entries to the root
`CHANGELOG.md` (Keep a Changelog format): move the relevant `[Unreleased]`
bullets into a new dated `[<version>]` section, or add one if this release's
changes were not already tracked under `[Unreleased]`. Link the new section
to its `docs/releases/<version>.md` packet the same way existing entries do.
Commit this alongside the release packet PR so `CHANGELOG.md` never lags the
tagged version.

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
  --launchd-label com.electricsheephq.evaos-code-review-bot \
  --require-coverage true
```

For public source-beta releases, run the same gate with manifest checks:

```bash
PUBLIC_BETA_TAG=v0.4.24-beta.1
npx tsx src/cli.ts release-status \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$(git rev-parse HEAD)" \
  --public-release-manifest docs/public-release-manifest.json \
  --expected-public-version "$PUBLIC_BETA_TAG" \
  --launchd-label com.electricsheephq.evaos-code-review-bot \
  --require-coverage true
```

Set `PUBLIC_BETA_TAG` to the actual public beta tag before running the command.

By default this public manifest gate validates rollback command shape only, so
fresh or shallow checkouts are not blocked by missing local tags. After
`git fetch origin --tags`, operators can add
`--verify-public-rollback-refs true` for the stricter local ref-existence check;
that failure is reported as a missing rollback target rather than a malformed
rollback command.

Public promotion evidence should include the strict variant after tags are
fetched:

```bash
git fetch origin --tags
npx tsx src/cli.ts release-status \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$(git rev-parse HEAD)" \
  --public-release-manifest docs/public-release-manifest.json \
  --expected-public-version "$PUBLIC_BETA_TAG" \
  --verify-public-rollback-refs true \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

If the first `release:status` fails only because launchd is still on the
previous head before restart, record that as pre-promotion state. The
post-restart `release:status` must pass before calling the beta promoted.

Prefer `npx tsx src/cli.ts release-status ...` when writing machine-readable JSON
to an evidence file, because `npm run release:status` prepends npm's command
banner to stdout.

### Post-Merge GitNexus Refresh Preflight

Post-merge GitNexus refreshes are release hygiene only. They must not change
live `gitnexusContext` behavior, runtime config, launchd state, monitored repos,
or review posting behavior. Preserve the existing index embedding dimensions
unless a separate tracked issue and release gate intentionally changes them.

Before running `gitnexus analyze --embeddings`, bootstrap the intended embedding
provider explicitly in the shell that will run the refresh. For the current
Voyage-backed Electric Sheep indexes, that means setting the HTTP endpoint,
model, and the dimension count that matches the existing index. Do not guess the
dimension count: use only a GitNexus field that explicitly names embedding
dimensions, such as `embeddingDimensions` or `Embedding dimensions`, or the
preflight output's `current.dimensions` field after it has parsed that explicit
GitNexus evidence.

```bash
export GITNEXUS_EMBEDDING_URL=https://api.voyageai.com/v1
export GITNEXUS_EMBEDDING_MODEL=voyage-code-3
export GITNEXUS_EMBEDDING_DIMS=<current-index-dimensions>
```

Then run the preflight from the clean release checkout:

```bash
npx tsx src/cli.ts gitnexus-refresh-preflight \
  --repo-path . \
  --repo-alias evaos-code-review-bot-neondiff
```

The preflight prints the current index dimensions only when GitNexus exposes an
explicit embedding-dimension field, the intended provider/model/dimensions from
the environment, and the exact recommended command. If provider configuration is
missing, the current index dimensions cannot be proven, or the intended
dimensions differ from the current index, do not run
`gitnexus analyze --embeddings`. Either fix the provider bootstrap/index
dimension evidence and rerun the preflight, or use the explicit fallback when the
release only needs commit freshness:

```bash
npx tsx src/cli.ts gitnexus-refresh-preflight \
  --repo-path . \
  --repo-alias evaos-code-review-bot-neondiff \
  --index-only-fallback true

gitnexus analyze . --name evaos-code-review-bot-neondiff --index-only
```

Do not use `--allow-dimension-change true` during routine post-merge refreshes;
that flag is only for a separate embedding migration issue with its own evidence
packet.

## Fast Iteration And Batched Release Validation

Do not spend a Swift release-gate cycle on every review-fix commit. Batch as much
validation as possible before the first push, then let one remote CI cycle prove
the current head.

Recommended local order:

1. For docs, TypeScript release tooling, manifest, license-service, or review
   wording changes, run the focused Node tests/build/scans that cover the changed
   surface once before push.
2. For browser, website, renderer, or config flows, use a preview server/browser
   smoke first and record the URL, route, screenshots, and settled behavior in
   the evidence packet. Browser proof is fast product evidence; it is not a
   substitute for desktop signing, appcast, or Swift release gates.
   For the built-in local dashboard, use the one-shot smoke command before the
   first push:

   ```bash
   npx tsx src/cli.ts dashboard \
     --config config.local.json \
     --preview-smoke true \
     --output-dir runtime/dashboard-preview-smoke
   ```

   The packet writes `dashboard.html`, `dashboard-status.json`,
   `provider-verify.json`, and `preview-smoke.json` with the route, source SHA,
   settled UI-state booleans, redacted provider output, and optional
   `--screenshot-path` when a Browser/Playwright screenshot is captured in the
   same loop.
3. For NeonDiff Desktop Swift changes, run
   `swift run NeonDiffDesktopCoreSmoke`, then `swift build`, then
   `script/build_and_run.sh build` plus `script/build_and_run.sh bundle-check`
   from `apps/neondiff-desktop/` before the first PR push.
4. For signed desktop release candidates, use the Mac release runbook after the
   desktop smoke passes. Do not use notarization, appcast generation, or Swift
   CodeQL to debug product behavior.

### Visible Desktop UI Smoke

Desktop onboarding, provider, daemon, license, and update-channel UI changes
need a visible local app smoke before anyone claims the flow works. CI artifact
smoke proves the hosted runner built an unsigned bundle; it does not prove a
human-visible window opened or that the changed control works.

Run the local smoke once per logical batch, not after every tiny review-fix
commit:

1. Build and launch the current app bundle with
   `apps/neondiff-desktop/script/build_and_run.sh run`.
2. Inspect the exact `dist/NeonDiffDesktop.app` path with Computer Use or
   equivalent accessibility/UI evidence.
3. Record `Welcome visible`: the Welcome screen is present in the launched app.
4. Navigate to the changed step.
5. Record `changed button/action clicked`: click the changed button/action and
   capture the observed disabled, error, or success state.
6. Call out `credential-gated steps` that were not tested because keys,
   licenses, signing credentials, or owner approvals were absent.
7. Post the visible smoke evidence on the PR or linked issue before merge,
   including the source SHA, exact built app path, clicked control labels, and
   the settled UI state.

Keep the proof boundary explicit: local visible UI smoke is product-behavior
evidence for the named local build only. It is not signed/notarized release
proof, TCC proof, appcast proof, customer readiness, or final installed-app
behavior.

A build-only Swift pass is not visible UI proof. If no Computer Use screenshot,
accessibility tree, or equivalent opened-app evidence exists for a desktop UI
change, the product-behavior proof is missing even when `swift build`,
`bundle-check`, and remote CI all pass.

Remote CI should keep a stable, always-reporting `Swift desktop gate` check.
That check passes quickly with an explicit `not affected` result on non-desktop
changes, and compiles `NeonDiffDesktopCoreChecks`, runs `swift build`, app
bundle build, and bundle check only when Swift desktop paths changed or when
manually dispatched. Keep `NeonDiffDesktopCoreChecks` execution,
`NeonDiffDesktopCoreSmoke`, and visible UI clicks in the local/release-smoke
lane because hosted macOS runners can kill smoke executables after a successful
build unless the runner has a known-good interactive session.

Swift CodeQL is a release/security gate, not the PR iteration loop. The durable
policy lives in `docs/swift-codeql-policy.md`: the checked-in path-aware Swift
CodeQL workflow runs only by `workflow_dispatch` and weekly schedule, keeps SARIF
upload disabled while default setup is enabled, and must be recorded in the
release packet before signed desktop release or GA.

Verify the setting after merge with:

```bash
gh api repos/electricsheephq/evaos-code-review-bot-neondiff/code-scanning/default-setup \
  --jq '.languages'
```

The returned languages must not contain `swift`. For this repo, the intended
read-only verification output currently includes `actions`, `javascript`,
`javascript-typescript`, and `typescript`; Swift is owned by
`.github/workflows/codeql-swift-path-aware.yml` as scheduled/manual advisory
release-security evidence. This is a GET verification check, not a PATCH payload
for changing GitHub default setup.

Every public release packet should state which proof loop was used:

- `preview/browser`: URL or local route, command, screenshots or DOM assertion,
  and why it covers the changed behavior.
- `node/source`: focused tests/build/scans, command log, and source SHA.
- `desktop-smoke`: Swift core smoke, Swift build, app bundle build, bundle
  check, source SHA, and app bundle path.
- `desktop-release`: signed/notarized/stapled artifact, appcast, Gatekeeper, and
  installed-app visual/UI proof from the exact candidate.

## Required Gates

- GitHub PR merged to `main` with checks green and no current-head actionable
  review threads.
- For self-repo or release-critical PRs, run the exact-head evaOS gate before
  merge. It must pass for the current PR head:

```bash
CURRENT_HEAD="$(gh pr view <pr-number> --repo electricsheephq/evaos-code-review-bot --json headRefOid --jq .headRefOid)"
npx tsx src/cli.ts review-head-gate \
  --config <path-to-active-installed-live.json> \
  --repo electricsheephq/evaos-code-review-bot \
  --pr <pr-number> \
  --head-sha "$CURRENT_HEAD"
```

  A green `coverage-audit` does not replace this gate: coverage only checks
  currently open eligible heads, so a final head pushed and merged between
  daemon cycles can otherwise leave no terminal evaOS marker for agents.
  This exact-head gate checks the bot's recorded review state for the current
  head; it does not independently prove GitHub App authorship. Pair it with
  `release-status`, which verifies the live App-backed launchd configuration.
- Release checkout is clean and exactly at the intended source SHA.
- Root `CHANGELOG.md` has a dated section for this version (moved out of
  `[Unreleased]` if it was tracked there) linking to
  `docs/releases/<version>.md`. Public source-beta `release:status` checks this
  head changelog entry against the manifest version and release notes path.
- `npm test` and `npm run build` pass from the release checkout.
- `release:status` records exact source SHA, branch, config path, launchd job,
  launchd dry-run mode, state DB row count, and error count.
- `release:status` verifies the loaded LaunchAgent includes
  `NODE_OPTIONS=--use-system-ca` so Node uses the macOS system trust store for
  GitHub App installation fetches.
- Release promotions run `release:status --require-coverage true` so the same
  packet fails when an active PR-review repo is configured but unreadable by
  the GitHub App, or when eligible heads are unprocessed/stale.
  `release:status --coverage true` is advisory-only and keeps top-level gates
  runtime-scoped; both coverage flags still perform live GitHub App reads
  across active repos, so do not use advisory mode as an offline or promotion
  gate.
- Public source-beta promotions pass `release:status` with
  `--public-release-manifest docs/public-release-manifest.json` and the release
  tag as `--expected-public-version`.
- Public release manifests may mark license API, website, or desktop channels
  as pending only when `requiredForThisRelease` is `false`; required channels
  must not be pending.
- The license API health gate proves only `GET /healthz`. When checkout
  issuance is part of the release, the manifest must also require
  `checkoutIssuanceRequiredForThisRelease` and point at an evidence file showing
  an unauthenticated `POST /v1/admin/licenses/issue` returned `401` with
  `{"status":"unauthorized"}`. Stable/GA releases require this checkout
  issuance proof by default. Public beta and source-beta releases also require
  this proof by default; source-beta releases may defer it explicitly only with a
  tracking issue, a deferred `checkoutIssuanceState` (`deferred` or
  `pending_secret_and_website_publish`), and
  `checkoutIssuanceRequiredForThisRelease: false`. When checkout issuance proof
  is required and a state is declared, `checkoutIssuanceState` must be `ready`.
  This manifest proof is a negative fail-closed boundary only; it proves the
  public endpoint rejects unauthenticated callers. It does not prove a valid
  owner-held checkout secret can issue a license, write the DB, or complete the
  paid/trial fulfillment path. Authenticated issuance success must be captured
  in the deploy runbook's redacted owner-held evidence lane before claiming
  checkout issuance works end to end; the first-class release-status smoke gate
  for that positive path is tracked in
  `https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/456`.
  In `release:status` output, `checkoutIssuanceRequiredForThisRelease` is the
  computed effective gate; `checkoutIssuanceRequiredDeclaredForThisRelease`
  preserves the raw manifest declaration when present.
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
- Post-merge GitNexus refreshes record the `gitnexus-refresh-preflight` output
  before any `gitnexus analyze --embeddings` command; missing provider config
  or missing/mismatched dimension evidence must block vector rebuilds or use the
  explicit `--index-only` fallback.

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
  --reason closed_or_stale_after_coverage_audit \
  --dry-run true
```

Inspect the dry-run output first. To perform the retirement against the current
SQLite state, rerun the same command with `--dry-run false`; the live command
re-checks state and may refuse or retire a different queue-job set if the row
changed after the preview.

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
- public release manifest state for docs, license API, CLI update channel,
  daemon update channel, website/download channel, and desktop update channel.
- checkout issuance evidence or the explicit deferred state and tracking issue
  when the paid/trial purchase path is not in scope for the beta.
- rollback SHA and command.
- rollback note for provider config, GitHub App settings, website deploy, and
  desktop update channel when those surfaces are in scope; otherwise record the
  tracking issue or `not in this release`.
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
- Public manifest:
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
- public manifest:

## Notes

- What changed:
- What did not change:
- Open follow-ups:
```
