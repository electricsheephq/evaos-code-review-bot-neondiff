# Changelog

All notable changes to NeonDiff are recorded here, in
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, newest first.

Each entry links to its full operational release packet under
[`docs/releases/`](docs/releases/), which carries the source SHA, live config
path, evidence paths, validation commands, and rollback command for that
release. This file is the concise developer-facing summary; the release
runbook ([`docs/beta-release-runbook.md`](docs/beta-release-runbook.md))
appends a new dated section here as part of every release. See
[`docs/release-governance.md`](docs/release-governance.md#versioning-and-ga-line)
for the semver/GA-line and npm dist-tag policy.

## [Unreleased]

No unreleased changes tracked yet.

## [0.4.38-beta.1] - docs/releases/v0.4.38-beta.1.md

### Added
- Add human-gated calibration promotion proof, setup/vision/operator documentation refreshes, CLI version/help coverage, hermetic QA-lab timing fixtures, and the license-service admin status contract slice
- Add license entitlement metadata, private-repo gate, cache redaction, and keychain-cache fallback coverage while holding the public npm package at `neondiff@0.4.30-beta.1`

## [0.4.37-beta.1] - docs/releases/v0.4.37-beta.1.md

### Added
- Add the private-repo entitlement proof matrix and worker-level license-gate coverage so missing or non-active private/commercial entitlements fail closed before checkout, file listing, provider calls, or review posting

## [0.4.36-beta.1] - docs/releases/v0.4.36-beta.1.md

### Fixed
- Add source-only prerelease publish classification so local-worker beta tags listed in the public manifest skip npm publishing cleanly instead of producing failed publish runs

## [0.4.35-beta.1] - docs/releases/v0.4.35-beta.1.md

### Added
- Add GitHub App install-scope proof fields and fail-closed `doctor github` readiness checks for repository visibility, metadata access, pull-request access, and App-vs-token read provenance

## [0.4.34-beta.1] - docs/releases/v0.4.34-beta.1.md

### Added
- Add root changelog and release-governance documentation for the beta/GA versioning line, source-only releases, and npm dist-tag policy

## [0.4.33-beta.1] - docs/releases/v0.4.33-beta.1.md

### Added
- Add the post-0.4.32 runtime-safety batch: atomic per-head review claims, retry-degraded provenance, self-consistency re-check support, outcome observer storage, calibration aggregation, scoring docs, and hosted BYOK smoke-gate hardening

## [0.4.32-beta.1] - docs/releases/v0.4.32-beta.1.md

### Added
- Add an issue-enrichment planning packet: summarizes related context, issue shape, product fit, build/borrow/buy framing, source taxonomy, and acceptance prompts for enrichment comments, with conservative gating on when external research is allowed and a hard non-goal against bulk enrichment or uncited research
- Add documentation for provider compatibility resources and GitNexus read-only adapter research/eval plans

## [0.4.31-beta.1] - docs/releases/v0.4.31-beta.1.md

### Added
- Add a fixture-only OpenAI-compatible review adapter (local-loopback safety checks, abort handling for slow responses, bounded JSON extraction from noisy local-model output) with same-prompt fixture proof comparing it against ZCode GLM — proof/fixture surface only, not yet wired into live review posting
- Add preferred issue-enrichment advisory gate name aliases while preserving the legacy gate names for existing dashboards/scripts

## [0.4.30-beta.1] - docs/releases/v0.4.30-beta.1.md

### Changed
- Harden GitHub and license API URL construction so configured API bases can't embed credentials or downgrade to non-loopback HTTP, while still preserving GitHub Enterprise-style API base paths
- Replace host-substring dependency checks and the public-version SemVer check with proper URL/host-token and bounded deterministic parsing
- Redact GitHub/API/model-derived evidence before writing local evidence artifacts, and use creation-only/atomic writes for public `init` config and temporary ZCode policy files

### Fixed
- Public npm package and installer now pin to `0.4.30-beta.1` instead of an unbounded `latest`, making the public install path reproducible

## [0.4.29-beta.1] - docs/releases/v0.4.29-beta.1.md

### Fixed
- Fix a durable-queue poisoning bug where a leased review returning `skipped_draft` (i.e. the PR became a draft) was recorded as a failed queue job; draft skips are now a non-failed terminal outcome, and a later non-draft review of the same head can still proceed
- Add the required `--tag beta` flag to the npm prerelease publish workflow

## [0.4.28-beta.1] - docs/releases/v0.4.28-beta.1.md

### Added
- Add risk-weighted review-queue priority (default off via `riskWeightedQueue.enabled`): when enabled, changed-surface risk scoring lets required-validation surfaces lease ahead of docs-only work; falls back to flat priority on fetch failure and skips changed-file fetching during an active repo cooldown

## [0.4.27-beta.1] - docs/releases/v0.4.27-beta.1.md

### Changed
- Harden Wilson confidence math so calibration summaries can no longer overstate reliability from small samples, and require explicit negative-control metadata before calibration credit is granted
- Enforce redaction at the review-gate module boundary so findings can no longer bypass the deterministic redaction layer before comments/evidence are produced

### Fixed
- Repair stale or empty review runtime worktree paths (recover via `git worktree remove --force` for owned worktrees) without deleting unrelated repositories, symlink targets, or non-benign leftovers

## [0.4.26-beta.1] - docs/releases/v0.4.26-beta.1.md

### Changed
- Treat retryable issue-enrichment deferrals as advisory to PR runtime health instead of making `runtime-inventory` report red when PR review work is otherwise clear, while preserving blocking status for actual PR queue failures, stale leases, and provider cooldown backlogs

### Fixed
- Suppress same-run near-duplicate findings in the deterministic review gate so live comments no longer repeat equivalent issues within one model run

## [0.4.25-beta.1] - docs/releases/v0.4.25-beta.1.md

### Fixed
- Fix issue-enrichment self-trigger loop: the bot's own sticky comment was advancing GitHub's `issue.updated_at`, causing repeated reruns to re-post/update the same comment unnecessarily. Enrichment now stores a structured body hash and skips unchanged records regardless of noisy `updated_at` changes, while still re-posting when content genuinely changes.

## [1.0.0-beta.1] - docs/releases/v1.0.0-beta.1.md

This tag was an early mislabel from the first public npm/site release pass (incorrectly implying a jump to v1.0); it was corrected and superseded by `0.4.24-beta.1`, which the 0.4.x beta train continues from.

## [0.4.24-beta.1] - docs/releases/v0.4.24-beta.1.md

### Fixed
- Correct the public npm package version line: the first public release was mistakenly published as `neondiff@1.0.0-beta.1`; this release restores the public beta train to `0.4.24-beta.1` and repoints the `beta`/`latest` npm dist-tags, install script, and website accordingly. `neondiff@1.0.0-beta.1` is deprecated in favor of this version.

## [0.4.23-beta.1] - docs/releases/v0.4.23-beta.1.md

### Added
- Add provider/model provenance metadata to PR walkthrough comments so operators can see which configured provider produced a given App-authored review; unregistered/stale provider entries are labeled `Unregistered provider id`

### Changed
- Keep `unknown`, `dependency`, and `flaky_test_risk` P0/P1 findings eligible for `REQUEST_CHANGES`, while `proof_gap` and `docs_only` P0/P1 findings remain advisory unless taxonomy inference validates a genuinely blocking category

## [0.4.22-beta.1] - docs/releases/v0.4.22-beta.1.md

### Added
- Add an operator-gated `issue-enrichment-run --repo --issue` command for selected-issue dry-run/live enrichment, duplicate-checking, and force-upsert, supporting a scoped two-repo pilot without enabling bulk historical issue enrichment
- Add duplicate suppression (skip unchanged issues by default) and `--force true` for explicit re-upsert of the sticky marker comment

## [0.4.21-beta.1] - docs/releases/v0.4.21-beta.1.md

### Added
- Add deterministic pre-merge metadata checks with configurable section headings and placeholder/min-detail guidance
- Add supported-addon dry-run packet contracts for OpenWiki-style repo wiki packets and GitNexus context packets
- Add public release-readiness workflows, install script, and packlist/claim/secret checks, plus npm publish workflow wiring

### Changed
- Make GitNexus packet redaction status honest: packets now report `unknown` unless an explicit redaction status is supplied, instead of assuming redaction occurred

## [0.4.20-beta.1] - docs/releases/v0.4.20-beta.1.md

### Added
- Ship the public confidence calibration policy: confidence percentages are now allowed in public comments only when a calibration report proves dataset, labeled findings, P0/P1 labels, negative controls, and Wilson lower-bound thresholds; malformed threshold config fails closed with an explicit `blockedReason` instead of silently weakening the gate

## [0.4.19-beta.1] - docs/releases/v0.4.19-beta.1.md

### Added
- Add a `gitnexus-refresh-preflight` command that fails closed on embedding refreshes unless current embedding dimensions can be explicitly proven, falling back to an explicit `--index-only` commit-freshness refresh otherwise

## [0.4.18-beta.1] - docs/releases/v0.4.18-beta.1.md

### Added
- Add structured ZCode hard-timeout failure classification (retryable vs. exhausted) with retry counts and redacted context, surfaced in release-status/operator status so timeouts no longer become anonymous failed rows
- Add issue-enrichment GitHub Issues API read checks to `doctor` and `doctor github`

### Fixed
- Filter PR-shaped records out of issue-enrichment scans and preserve watermark safety when a scan is truncated

## [0.4.17-beta.1] - docs/releases/v0.4.17-beta.1.md

### Added
- Add repo-profile scheduler controls (`maxActiveHeads`, `maxQueuedHeads`, `overflowAction`) to stop bursty repositories from saturating the durable review queue, with a default `defer` overflow behavior and durable queue oldest-waiting diagnostics

## [0.4.16-beta.1] - docs/releases/v0.4.16-beta.1.md

### Added
- Add a dedicated public confidence policy and sanitizer that hides percentage-like confidence claims from inline comments, walkthroughs, enrichment comments, and status surfaces unless calibration thresholds pass; public comments default to `uncalibrated`

## [0.4.15-beta.1] - docs/releases/v0.4.15-beta.1.md

### Added
- Add a provider registry with operator commands to list configured providers, explain readiness, and run explicit local-only smoke checks, covering ZCode/GLM, OpenAI-compatible, OpenAI, Anthropic, Gemini, and Ollama-style providers
- Restrict OpenAI-compatible smoke checks to local loopback endpoints for this beta, failing closed on remote checks until DNS pinning exists

## [0.4.14-beta.1] - docs/releases/v0.4.14-beta.1.md

### Added
- Add `neondiff doctor github`, a GitHub-only readiness command that verifies App credentials, installation visibility, and enabled-repo read access without running any review or posting any comment
- Rework `docs/github-app-setup.md` into the canonical public install/onboarding guide (selected-repo install, uninstall, troubleshooting, license boundary)

## [0.4.13-beta.1] - docs/releases/v0.4.13-beta.1.md

### Added
- Add `neondiff pricing`, a network-free JSON command describing the decided support tiers: public open-source repo review is free; paid support is $1/month, $10/year, or $100 lifetime (canonical reference: `docs/pricing.md`)

### Changed
- Align README, setup docs, and license-boundary wording with the pricing doc, and lock in tests that NeonDiff pricing does not include hosted model credits or bundled provider tokens (bring-your-own-key boundary)

## [0.4.12-beta.1] - docs/releases/v0.4.12-beta.1.md

### Added
- Add NeonDiff Desktop custom local-first macOS chrome, dark operator theme, and native monospaced typography
- Add a dormant Sparkle update scaffold (no production appcast or updater key shipped; requires explicit feed URL + public key to activate)

## [0.4.11-beta.1] - docs/releases/v0.4.11-beta.1.md

### Added
- Add the public NeonDiff license-key client: `neondiff license activate/status/deactivate --json`, with local entitlement caching (status, expiry, repo-visibility scope, plan metadata) and a private-repo worker gate that fails closed before any review work when license enforcement is enabled and no active entitlement exists
- Add offline entitlement grace capped at 15 minutes, and treat internal repos as entitlement-required

### Changed
- Require license API URLs to use HTTPS except for loopback test endpoints

## [0.4.10-beta.1] - docs/releases/v0.4.10-beta.1.md

### Added
- Add a machine-readable public release manifest gate (`docs/public-release-manifest.json`) so public source-beta promotion is checked against setup docs, release notes, license API state, and update-channel readiness before it can drift out of sync
- Add the first public source-beta dry-run packet (`docs/releases/v1.0.0-beta.1.md`), kept separate from internal v0.x live-beta releases

## [0.4.9-beta.1] - docs/releases/v0.4.9-beta.1.md

### Added
- Add a measure-only `provider-throttle-report` command that separates provider request-rate limits, overloads, quota exhaustion, GitHub/network failures, and unknown provider errors, with repo/provider/hourly/peak-window breakdowns (advisory only, `recommendedPolicy=measure_only`)

### Fixed
- Preserve provider-deferred retry metadata when a queued job later posts, including fallback provider-code recovery from processed-review history

## [0.4.8-beta.2] - docs/releases/v0.4.8-beta.2.md

### Changed
- Governance correction only: re-publish the v0.4.8-beta.1 release notes/evidence to accurately reflect that PR #187 (Desktop theme) was included in the tagged source alongside PR #186; no additional runtime behavior beyond v0.4.8-beta.1

## [0.4.8-beta.1] - docs/releases/v0.4.8-beta.1.md

### Added
- Apply a Saiba-inspired black/neon-green theme to the NeonDiff Desktop MVP (shared tokens, angular panels, scanline/grid surfaces, themed sidebar/detail views, status badges)

### Fixed
- Harden Desktop CLI resolution so directories can't be accepted as executables, and restrict the desktop subprocess environment to a small allowlist plus a controlled PATH instead of inheriting the full environment
- Fix config secret redaction to also redact present-but-empty string values while preserving `undefined`/`null` shape

## [0.4.7-beta.1] - docs/releases/v0.4.7-beta.1.md

### Added
- Add the NeonDiff Desktop MVP scaffold (SwiftPM/SwiftUI): daemon status, monitored-repo visibility, provider/model settings, license-key UI, and a local smoke target
- Add `review-head-gate`, a read-only exact-head pre-merge gate for self-repo and release-critical PRs, closing a race where a final PR head could merge before its review status settled

## [0.4.6-beta.7] - docs/releases/v0.4.6-beta.7.md

### Fixed
- Make `retire-failed` default to dry-run unless `--dry-run false` is explicitly passed, and expand its dry-run evidence output
- Let `retry-failed` repair failed durable queue jobs when the review was already posted, without rerunning the provider or duplicating the review
- Fix retry status comments syncing against the live PR head instead of the requested retry head, which could make other agents wait on the wrong marker

## [0.4.6-beta.6] - docs/releases/v0.4.6-beta.6.md

### Fixed
- Fix the live daemon running without macOS system trust store support, which caused GitHub App fetches to silently fail from launchd while interactive CLI commands worked; `release:status` now verifies `NODE_OPTIONS=--use-system-ca` is present in the loaded launchd environment

## [0.4.6-beta.5] - docs/releases/v0.4.6-beta.5.md

### Added
- Add a dry-run-first `clear-review-queue-leases` operator command for stale run leases and orphaned active queue leases after restarts

### Fixed
- Align `queue`, `provider-cooldowns`, `coverage-audit`, `budget-status`, and `release:status` so they agree on what's blocking (provider-deferred vs. stale-lease vs. daemon death), with recommended cleanup actions
- Fix nested command help (e.g. `run-once --help`) executing worker paths instead of just printing help

## [0.4.6-beta.4] - docs/releases/v0.4.6-beta.4.md

### Fixed
- Fix already-queued self-repo release PR jobs retaining low background priority instead of picking up the v0.4.6-beta.3 priority escalation — existing queue rows are now reprioritized on every scheduler cycle

## [0.4.6-beta.3] - docs/releases/v0.4.6-beta.3.md

### Fixed
- Fix a runtime loop where repeated provider-overload responses could keep the daemon unhealthy during peak windows: add bounded exponential cooldown backoff for repeated overload failures on the same PR head, and stop spending further provider work in the same scheduler cycle once a cooldown is hit

### Changed
- Escalate automatic self-repo (`evaos-code-review-bot`) PR jobs to top scheduler priority

## [0.4.6-beta.2] - docs/releases/v0.4.6-beta.2.md

### Fixed
- Fix `release:status` and runtime inventory going red on provider-deferred queue rows whose retry window had expired even when the scheduler couldn't safely act yet because provider capacity was full — health now reflects whether a retry is actually ready, not just whether the timestamp expired

## [0.4.6-beta.1] - docs/releases/v0.4.6-beta.1.md

### Added
- Add the packaged public `neondiff` / `evaos-review-bot` source-checkout CLI flow for operators

### Changed
- Require `review-pr --dry-run false` to include `--confirm true`, require an explicit `--config` path (no silent default fallback), and require an approved head SHA via `--head-sha`/`--expected-head` that's verified against the freshly fetched PR head before any posting can proceed

## [0.4.5-beta.2] - docs/releases/v0.4.5-beta.2.md

### Fixed
- Fix `retire-failed` to also retire the matching failed durable queue job (not just the processed-review row), and make it idempotent for already-retired rows, completing the v0.4.5-beta.1 health-gate fix

## [0.4.5-beta.1] - docs/releases/v0.4.5-beta.1.md

### Added
- Add issue-enrichment global caps (max issues/comments per cycle) and a SQLite-backed single-worker lease with TTL, plus a `clear-issue-enrichment-leases` operator command requiring explicit `--force-active true` to clear non-expired leases

### Fixed
- Fix a ZCode cleanup bug where the temporary `.zcode` directory being removed during a provider-overload failure could mask the real provider error as a local `ENOENT`

## [0.4.4-beta.1] - docs/releases/v0.4.4-beta.1.md

### Added
- Add `eval-sticky-vs-cold`, a paired cold/sticky review-packet comparison runner with comparison gates, summary JSON, and markdown reports (results remain advisory, no public quality claims)

### Fixed
- Fix scheduler jobs being marked `posted` without a real review URL when a processed-review row was missing; queue jobs now stay retryable in that case

## [0.4.3-beta.1] - docs/releases/v0.4.3-beta.1.md

### Added
- Add opt-in finishing-touch commands (`generate tests`, `generate docs`, `generate docstrings`, `simplify suggestion`, `changelog draft`, `explain risk`, `make review-ready`) that produce draft-only proposals — the bot never pushes branches, commits, approves, merges, or applies labels for these commands (`finishing-touch-dry-run` CLI support)

## [0.4.2-beta.2] - docs/releases/v0.4.2-beta.2.md

### Changed
- Move the live review work root outside the source checkout, with protected-checkout root detection so review worktrees/mirrors can never resolve back into (or contain) the operator's source checkout, including through symlinks

## [0.4.2-beta.1] - docs/releases/v0.4.2-beta.1.md

### Added
- Add the first eval/calibration substrate: offline eval scorecards, calibration reports with reliability bins and Wilson lower bounds, and a release-level promotion decision (`promotion-decision.md`) that keeps public confidence percentages disabled until evidence thresholds (Wilson LB ≥0.95, ≥100 labeled findings, ≥30 P0/P1 labels, ≥10 negative controls) are actually met

### Fixed
- Guard `eval-suite --output-root` so eval outputs can no longer be written inside the repository checkout

## [0.4.1-beta.10] - docs/releases/v0.4.1-beta.10.md

### Added
- Add per-repo issue-enrichment activation watermarks so newly allowlisted repos baseline on first activation instead of sweeping the entire historical open-issue backlog by default (explicit `processExistingOpenIssuesOnActivation=true` opts into backfill)

## [0.4.1-beta.9] - docs/releases/v0.4.1-beta.9.md

### Added
- Add the scheduler/runtime half of issue enrichment: a default-off daemon lane that can dry-run/defer/skip/post per the issue-enrichment allowlist, with durable state and separate runtime health reporting from the PR queue

### Fixed
- Fail closed before scanning or posting when live issue comments would require App posting credentials that aren't available

## [0.4.1-beta.8] - docs/releases/v0.4.1-beta.8.md

### Added
- Add the first safe issue-enrichment foundation: a separate allowlist, throttle model, and dry-run scan command (`issue-enrichment-scan`) independent from the PR review allowlist, with live posting still fully disabled

## [0.4.1-beta.7] - docs/releases/v0.4.1-beta.7.md

### Added
- Print structured JSON summaries for `run-once` dry-run and live invocations, including scoped PR metadata, skip buckets, and failed-review counts

### Changed
- Return exit code `1` when a `run-once` run records one or more failed reviews (documented as possibly reflecting partial per-PR failures, not just total command failure)

## [0.4.1-beta.6] - docs/releases/v0.4.1-beta.6.md

### Added
- Add an explicit new-only repo activation-policy helper so a repo with a large historical PR backlog (e.g. `lossless-claw`) can be safely re-added without sweeping its historical open PRs, while preserving a trusted-command escape hatch to review pre-activation heads on request

## [0.4.1-beta.5] - docs/releases/v0.4.1-beta.5.md

### Added
- Add the first issue-enrichment implementation as a dry-run-only operator surface, kept fully separate from PR monitoring (no live issue polling or comments yet)
- Add an activation-baseline audit so newly-added repos with a large backlog of old open PRs don't get retroactively swept by coverage audit or command lookups

### Fixed
- Fix a release-blocking state-store compatibility issue found during full-suite validation

## [0.4.1-beta.4] - docs/releases/v0.4.1-beta.4.md

### Fixed
- Hide `closed_retired` and `stale_retired` queue rows from the default dashboard view unless explicit history filters are requested (completes the v0.4.1-beta.2/beta.3 dashboard current-health cleanup)

## [0.4.1-beta.3] - docs/releases/v0.4.1-beta.3.md

### Fixed
- Fix stale superseded dashboard rows with terminal `posted` queue metadata still appearing as current-health blockers in the default dashboard view (follow-up to v0.4.1-beta.2)

## [0.4.1-beta.2] - docs/releases/v0.4.1-beta.2.md

### Fixed
- Fix a review-yield incident where recent reviews were walkthrough-only despite actionable bugs existing nearby: WorldOS `servers/**` and LCO `packages/**` implementation paths had been filtered out before prompt construction and are now reviewable
- Reconcile reviewer sessions at scheduler-cycle boundaries and exclude sessions with dead worker PIDs from active release-status counts

### Changed
- Make the operator `dashboard` default to current-health semantics, hiding stale-only historical rows unless `--include-history true` is passed

## [0.4.1-beta.1] - docs/releases/v0.4.1-beta.1.md

### Added
- Add default-off read-only skill-pack prompt context with allowlisted files, byte/token caps, and symlink/path-escape protection (`skillPacks` config, `build-skill-pack` CLI command)
- Add a PR enrichment MVP: sticky, suggestion-only PR enrichment comments (labels/reviewers suggestions, validation suggestions, triage-gap hints), disabled by default (`enrichment` config, `build-enrichment-comment` CLI command)

## [0.4.0-beta.6] - docs/releases/v0.4.0-beta.6.md

### Added
- Add default-off GitHub related-context packets: reviewer prompts can include explicitly linked issue/PR context (quoted as untrusted data) without it becoming review truth (`githubRelatedContext` config, `build-github-related-context-packet` CLI command)

## [0.4.0-beta.5] - docs/releases/v0.4.0-beta.5.md

### Added
- Add a `queued` coverage-audit bucket so eligible PR heads already covered by durable queue work (queued/leased/running/provider-deferred) are no longer misreported as unprocessed

### Fixed
- Require queue coverage to match the exact `{repo, pull_number, head_sha}` and require `leased`/`running` rows to be non-expired before they count as covering a head

## [0.4.0-beta.4] - docs/releases/v0.4.0-beta.4.md

### Fixed
- Fix `release:status` incorrectly staying red on an expired per-head provider cooldown row even when the same PR head already had an active queue retry in flight

## [0.4.0-beta.3] - docs/releases/v0.4.0-beta.3.md

### Fixed
- Fix provider cooldown timestamps being stamped from scheduler cycle-start time instead of failure-handling time, which could record a `provider_deferred` row as already-expired as soon as a slow overload failure was handled

## [0.4.0-beta.2] - docs/releases/v0.4.0-beta.2.md

### Added
- Add a default-off GitNexus advisory context packet provider: bounded, redacted, freshness-aware related-code context can be attached to review prompts without indexing during review runs (`gitnexusContext` config, `build-gitnexus-context-packet` CLI command)

## [0.4.0-beta.1] - docs/releases/v0.4.0-beta.1.md

### Added
- Add bounded durable per-repo memory packets (disabled by default): repository-specific notes and false-positive fingerprints can be injected into review prompts, with byte/note limits, TTL validation, and secret-fail-closed redaction
- Add `build-memory-packet` operator CLI command for dry-run/read-only packet inspection

### Fixed
- Harden scheduler handling so provider-cooldown skips and historical skipped rows no longer become false "failed" durable queue jobs

## [0.3.12-beta.1] - docs/releases/v0.3.12-beta.1.md

### Added
- Add a read-only operator `dashboard` command (JSON and human output) that merges coverage-audit, durable queue, and review-readiness rows into one per-head view with filters for `--repo`, `--status`, `--priority`, `--stale-head-reason`, `--limit`, and `--job-limit` (docs: `docs/operator-cli.md`)

### Changed
- Keep healthy queued/running/reviewing work visible without failing the dashboard health gate, while failed, stale, provider-deferred, proof-blocked, and needs-fix rows remain blocking states

## [0.3.11-beta.1] - docs/releases/v0.3.11-beta.1.md

### Added
- Add a durable `review_readiness` state machine (queued, reviewing, provider-deferred, needs-fix, ready-for-human, stale, closed, skipped, failed, manual-command) keyed by repo/PR/head, so future dashboards can read review status without scraping sticky comments (docs: `docs/review-status-comments.md`)

### Fixed
- Mark older superseded head rows stale without mutating already-terminal rows
- Align impossible `skipped_policy` leased results with queue-job failure state so readiness and queue truth no longer diverge

## [0.3.10-beta.1] - docs/releases/v0.3.10-beta.1.md

### Changed
- Replace the free-form walkthrough marker with a stable, versioned, PR-scoped marker that records schema version, reviewed head SHA, review verdict, and a SHA-256 hash of the redacted walkthrough body, enabling one sticky walkthrough surface per PR

### Fixed
- Strip user-authored HTML comments from PR title text before it enters the walkthrough body, closing a marker-injection vector through PR metadata

## [0.3.9-beta.1] - docs/releases/v0.3.9-beta.1.md

### Added
- Add sticky, marker-backed, App-authored PR status comments that update as a review moves through queued, in-progress, completed, provider-deferred, stale, closed, skipped, and failed states, giving humans and agents live visibility into review status per PR head (docs: `docs/review-status-comments.md`)

### Fixed
- Map duplicate processed-head status from the stored outcome instead of assuming every processed head completed successfully
- Add regression coverage so an already-failed terminal status can no longer be resurrected to `in_progress` on a retry

## [0.3.8-beta.1] - docs/releases/v0.3.8-beta.1.md

### Added
- Add deterministic operator-facing review-budget projection across global, provider, org, repo, and manual-reserve capacity, exposed via a new `budget-status` command plus compact summaries in scheduler/status/`release:status` output

### Fixed
- Keep queue visibility resilient by reporting budget read failures separately instead of failing the whole `queue` command
- Preserve active leased/running rows before applying pending-row caps so capacity math stays accurate under large queue backlogs

## [0.3.7-beta.1] - docs/releases/v0.3.7-beta.1.md

### Added
- Add a deterministic regression taxonomy (data loss, auth, security boundary, CI/build, migration, API compatibility, release regression, proof gap, docs-only, dependency, runtime correctness, unknown) so findings are categorized consistently instead of relying solely on model-supplied labels
- Centralize review gating in `applyDeterministicReviewGate`, covering diff coordinate validation, secret/cap drops, category counts, and final event selection
- Add changed-surface validation and proof recommendations to walkthrough comments for docs, TypeScript/web, CI/release, and Unity surfaces

### Changed
- Keep `severity` authoritative for `REQUEST_CHANGES`: any surviving P0/P1 finding remains eligible to block regardless of category
- Treat model-supplied `category` as an optional hint; unsupported categories are now inferred deterministically instead of being dropped

## [0.3.6-beta.1] - docs/releases/v0.3.6-beta.1.md

### Added
- Add maintainer command-triggered review control for trusted authors: `review`/`re-review` comments enqueue manual review jobs, `stop` suppresses further automatic review of the current PR head, and `explain` requests routed through the manual queue without being misreported as failed jobs
- Wire repo-sticky reviewer session accounting into scheduler jobs when `reviewerSessions.enabled` is true
- Surface scheduler comment-fetch failures as `commandFetchErrors` in cycle logs instead of crashing the worker

### Changed
- Treat command comments as single-use per PR so an old `stop` or `review` comment can't replay onto a later head SHA

## [0.3.5-beta.1] - docs/releases/v0.3.5-beta.1.md

### Changed
- Enable the provider-aware review scheduler in live config (previously built but dormant), capped at one active job per provider/org/repo with a 10-job per-repo queue limit

## [0.3.4-beta.1] - docs/releases/v0.3.4-beta.1.md

### Added
- Add a provider-aware bounded review scheduler with a durable review queue (`review_queue_jobs`) and per-provider/org/repo/manual-command capacity controls, so one stalled or rate-limited review no longer hides eligible work in other monitored repos
- Add release-status/operator visibility for durable queue failures, retryable provider-deferred jobs, and active daemon cycles

### Changed
- Preserve provider cooldown windows on thrown provider errors and retry provider-deferred jobs using the existing failed-head retry policy
- Keep dry-run queue jobs non-terminal so dry-run evidence can never masquerade as a posted review

## [0.3.3-beta.1] - docs/releases/v0.3.3-beta.1.md

### Added
- Add a first-class operator CLI with `status`, `agents`, `queue`, `coverage`, `cooldowns`, and `why` commands, plus `docs/operator-cli.md`, so operators can answer "why did/didn't this PR get reviewed" without querying SQLite directly

### Fixed
- Harden `why` so provider-deferred and stale-head states are no longer hidden behind generic "processed" rows
- Preserve lease diagnostics for old state databases predating `owner_pid`, and prefer dead-owner lease diagnostics over generic expiry when both apply
- Add stale-head status gating so aggregate operator health can no longer report green while coverage found stale heads

## [0.3.2-beta.1] - docs/releases/v0.3.2-beta.1.md

### Added
- Add a disabled-by-default RepoSticky reviewer-session state layer (TTL, head-count limits) with transaction-safe session assignment, exact-head job dedupe, and dead-worker session avoidance, laying the groundwork for later queue/memory/GitNexus features
- Add `doctor` and `release:status` visibility for repo-scoped reviewer session counts

## [0.3.1-beta.1] - docs/releases/v0.3.1-beta.1.md

### Added
- Add global provider cooldown awareness to `release:status` so an active Z.ai throttle no longer flaps release health red
- Add a bounded daemon drain for expired provider cooldown rows after normal review cycles
- Report eligible open PR heads as provider-deferred during an active cooldown instead of misreporting them as unprocessed misses

### Fixed
- Harden coverage audit against legacy read-only databases that lack provider cooldown tables

## [0.3.0-beta.1] - docs/releases/v0.3.0-beta.1.md

### Added
- Add an `eval-suite` batch harness that scores bot findings against CodeRabbit comments, human labels, CI evidence, merged-fix evidence, seeded defects, duplicate suppression, and safety redaction fixtures across five required suites, writing scorecards, calibration reports, and manifests
- Require all five eval suites to pass before a batch run can report `ok: true`

### Changed
- Treat duplicate `runId` values as structured per-scenario failures instead of silently overwriting evidence

### Fixed
- Prevent eval suite packet output from being written inside a git checkout, including via symlinked parent paths

## [0.2.5-restart-lease-hygiene] - docs/releases/v0.2.5-restart-lease-hygiene.md

### Fixed
- Prevent controlled restarts from stranding a capacity lease for the full lease TTL after the old worker process is killed, by storing an owner PID on each lease row and pruning expired, dead-owner, and legacy ownerless leases before capacity checks

## [0.2.4-provider-cooldown-tuning] - docs/releases/v0.2.4-provider-cooldown-tuning.md

### Changed
- Increase transient provider retry attempts from 2 to 4, with a wider jittered retry window (2s base, capped at 20s)
- Shorten the `1302` request-rate cooldown from 5 minutes to 90 seconds while keeping overload (2 min) and true quota exhaustion (30 min) cooldowns unchanged
- Keep review concurrency at one active ZCode review

## [0.2.2-provider-retry] - docs/releases/v0.2.2-provider-retry.md

### Added
- Classify Z.ai provider error codes into `provider_request_rate_limit`, `provider_overloaded`, and `provider_quota_exhaustion` buckets instead of treating all 429s the same
- Retry transient provider throttle/overload failures automatically before recording a hard cooldown
- Record `provider-retry.json` evidence with attempt count, provider code, request id, and chosen delay

### Changed
- Default ZCode review concurrency to one in-flight review
- Use shorter cooldown defaults for request throttling and overload than for true quota/package exhaustion

## [0.2.1-runtime-resilience] - docs/releases/v0.2.1-runtime-resilience.md

### Added
- Add repo-level ZCode provider cooldown handling: rate-limit failures are now recorded as explicit provider-cooldown skips instead of blocking failed rows (#51)
- Add a heartbeat-backed release-status gate so `release:status` now fails when the daemon heartbeat is missing or stale (#50)

### Changed
- Retire historical failed review heads with exact coverage evidence instead of leaving them stuck (#48)
- Release-status now reports provider cooldown rows separately from blocking errors

### Fixed
- One PR failure can no longer kill the daemon loop without leaving a heartbeat trail
