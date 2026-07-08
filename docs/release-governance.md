# Release Governance Runbook

This bot is a live beta agent. A live promotion is not complete until the
source SHA is tied to an immutable Git tag, a GitHub Release, runtime evidence,
and a rollback path.

## Release Levels

- `beta`: local launchd worker on the operator Mac, posting as the GitHub App
  on the active allowlist. Beta releases are prereleases.
- `source-beta`: public source-checkout release. The CLI and daemon are
  installable from git and npm-linkable locally, but package publishing,
  license activation, website download/version sync, and desktop auto-update may
  still be explicitly deferred in `docs/public-release-manifest.json`.
- `stable`: future multi-operator or production rollout. Stable releases are
  blocked until beta evidence proves low-noise behavior over labeled PRs.

## Version Names

Use semver prerelease tags for live beta promotions:

```text
v0.2.5-beta.1
v0.2.5-beta.2
v0.3.0-beta.1
v0.4.24-beta.1
```

Patch beta tags are for runtime/reliability fixes. Minor beta tags are for new
reviewer behavior, policy shape, eval/capability expansion, or operator-facing
workflow changes.

## Versioning And GA Line

This is the owner-decided policy for the GA cutover. It records a decision,
not a proposal; do not re-litigate it in a future release packet without a
new explicit owner decision.

### Semver Policy

- The GA version line target is `v1.0.0`.
- Prereleases continue as `v0.4.x-beta.N` until the GA cutover. Do not jump
  the tag train to `1.0.0-beta.N` or any other `1.x` prerelease shape before
  GA; `docs/releases/v1.0.0-beta.1.md` is the historical example of exactly
  that mistake (see the annotation at the top of that file), and
  `v0.4.24-beta.1` is the release that corrected it.
- Patch and minor beta tags keep following the existing convention in
  [Version Names](#version-names) above: patch for runtime/reliability fixes,
  minor for new reviewer behavior, policy shape, eval/capability expansion, or
  operator-facing workflow changes.
- The first stable tag after the GA cut is `v1.0.0`. Normal semver applies
  from that point forward (`v1.0.1` patches, `v1.1.0` minors, and so on);
  this runbook does not need a separate post-GA numbering scheme.

### Dist-Tag Policy

NeonDiff publishes to npm under two dist-tags:

- `beta`: tracks the active `0.4.x-beta.N` prerelease train. This is the
  correct install target for anyone testing pre-GA builds.
- `latest`: today, before GA, `latest` still points at a beta package
  version. This is expected pre-GA state, not a packaging bug — document any
  release packet that publishes a new beta as leaving `latest` on the prior
  beta unless the packet explicitly repoints it. Do not assume `latest`
  means stable while the project is pre-GA.

At GA cutover, `latest` is repointed to the stable GA release so that a
plain `npm install -g neondiff` (no tag suffix) installs GA, and `beta`
keeps tracking whatever prerelease train is active after GA (for example, a
`v1.1.0-beta.N` line preparing the next minor). The cutover step is a single
explicit command run once the GA package version is published:

```bash
npm dist-tag add neondiff@<ga> latest
```

Replace `<ga>` with the exact published GA package version, e.g.
`neondiff@1.0.0`. Run this only after the GA package itself is on the
registry (`npm view neondiff versions` includes `<ga>`) and after the GA
release has passed the same gates as any other release in this runbook.
Do not repoint `latest` speculatively ahead of the GA package existing.

### What Qualifies A GA Cut

A GA cut is not a new gate system. It is the existing [Pre-Release
Gate](#pre-release-gate) and [Post-Release Gate](#post-release-gate) machinery
in this runbook, plus the existing `docs/public-release-manifest.json` and
`release-status --public-release-manifest` surface, applied to a release that
is tagged `v1.0.0` instead of a beta tag. Concretely, a GA cut requires:

- Every condition in [Pre-Release Gate](#pre-release-gate) passes for the
  candidate GA source SHA, including a `docs/releases/v1.0.0.md` packet with
  source SHA, issue/PR links, validation commands, live config path, rollback
  command, and known caveats.
- `docs/public-release-manifest.json` is updated for the GA version and
  passes `release-status --public-release-manifest
  docs/public-release-manifest.json --expected-public-version v1.0.0`, with
  every `requiredForThisRelease: true` channel healthy, not pending.
- Every condition in [Post-Release Gate](#post-release-gate) is green against
  the GA release, including coverage-audit, provider cooldowns, and durable
  queue health.
- The npm dist-tag cutover step above has run and `npm view neondiff
  dist-tags` shows `latest` pointing at the GA version.
- The CHANGELOG.md `[Unreleased]` section for the GA cut has been folded into
  a dated `[1.0.0]` entry.

This section intentionally does not invent new promotion gates beyond the
existing release-status/public-release-manifest machinery; it only names the
version string and dist-tag step that make a promotion a GA promotion instead
of another beta promotion.

## Cadence

- Batch normal improvements into a daily beta promotion window when practical.
- Ship urgent runtime safety fixes immediately as a patch beta.
- Do not promote more than one live beta without updating the GitHub Release
  surface.
- Keep the launchd worker on a single promoted SHA. Do not describe rolling
  `main` as a release.

## Pre-Release Gate

Before tagging:

1. The implementation PR is merged to `main`.
2. Required GitHub checks are green or the PR records a justified admin merge.
3. Current-head review threads are resolved or explicitly non-actionable.
4. Local focused validation named in the PR has passed.
5. `docs/releases/<version>.md` exists and names:
   - source SHA
   - issue and PR links
   - validation commands
   - live config path
   - rollback command
   - known provider cooldown or runtime caveats
6. For public source-beta or public beta releases,
   `docs/public-release-manifest.json` exists and declares:
   - docs version and release-notes path
   - license API state and whether it is required for this release
   - license API health proof, plus checkout issuance proof unless a source-beta
     release explicitly defers it with a tracking issue
   - computed checkout issuance status and, when present, the raw manifest
     declaration that produced it
   - CLI, daemon, website, and desktop update-channel state
   - rollback command or tracking issue for each required channel
   - required-channel rollback fields with one source revert command such as
     `git reset --hard refs/tags/<tag>` or `git revert <sha>`
7. `git status --short` is clean in the live checkout.

The manifest `rollback` field is intentionally only the source-revert step.
Full operator rollback runbooks may restart launchd after that source revert,
but restart commands live outside the manifest rollback field. `launchctl
kickstart` alone is a restart, not a rollback. `git checkout` detaches HEAD or
resets the working tree; it is not accepted as a release rollback for this
manifest gate.

## Tag And Release

Create an annotated tag from the merged source SHA:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
git fetch origin main --tags
git checkout main
git pull --ff-only origin main
git tag -a vX.Y.Z-beta.N <source-sha> -m "vX.Y.Z-beta.N"
git push origin vX.Y.Z-beta.N
```

Create the GitHub prerelease from the release packet:

```bash
gh release create vX.Y.Z-beta.N \
  --repo electricsheephq/evaos-code-review-bot \
  --title "vX.Y.Z-beta.N" \
  --notes-file docs/releases/vX.Y.Z-beta.N.md \
  --prerelease \
  --target <source-sha>
```

If the release packet uses an internal filename such as
`v0.2.5-restart-lease-hygiene.md`, either copy it to the exact tag filename or
pass that file as `--notes-file` and include the tag name at the top.

## Promote Live

After the GitHub Release exists:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
git fetch origin main --tags
git checkout main
git pull --ff-only origin main
test "$(git rev-parse HEAD)" = "<source-sha>"
launchctl bootout gui/$(id -u) /Users/lume/Library/LaunchAgents/com.electricsheephq.evaos-code-review-bot.plist 2>/dev/null || true
launchctl bootstrap gui/$(id -u) /Users/lume/Library/LaunchAgents/com.electricsheephq.evaos-code-review-bot.plist
launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot
```

## Post-Release Gate

Run the status gate with App credentials set in the shell:

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head <source-sha> \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

For public source-beta or public beta releases, include the public manifest gate:

```bash
SOURCE_SHA=replace-with-release-source-sha
PUBLIC_BETA_TAG=vX.Y.Z-beta.N
npx tsx src/cli.ts release-status \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$SOURCE_SHA" \
  --public-release-manifest docs/public-release-manifest.json \
  --expected-public-version "$PUBLIC_BETA_TAG" \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

Set `SOURCE_SHA` and `PUBLIC_BETA_TAG` before running the command.

The public manifest gate validates rollback command syntax by default. Use
`git fetch origin --tags` and append `--verify-public-rollback-refs true` only
when you want the operator machine to prove that rollback refs are present in
that checkout; absent refs are reported as a missing rollback target.

Also run:

```bash
npx tsx src/cli.ts coverage-audit \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json
npx tsx src/cli.ts provider-cooldowns \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expired-only true
```

The release is green only when:

- expected head matches the release tag target SHA
- live checkout is clean
- launchd is running with the active live config
- daemon heartbeat is fresh
- no blocking DB error rows exist
- public docs, license API state, checkout issuance state, and update channels
  are either healthy/proven or explicitly deferred as non-required for the release in
  `docs/public-release-manifest.json`
- coverage audit has zero unprocessed eligible heads
- provider cooldowns are either absent or active and named in release notes
- durable queue jobs have zero failed rows and zero retryable provider-deferred
  backlog

Expired provider cooldown rows are backlog. Retry or retire stale/closed heads
before calling the release green.

## Rollback

Rollback is tag-first:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
git fetch origin --tags
git checkout main
git reset --hard <previous-release-tag>
launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head "$(git rev-parse HEAD)" \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

Record the rollback in the GitHub Release, the tracker issue, and any active
incident issue.

## Backfill Required

Because early beta releases were promoted without tags, create a backfill issue
for the current live SHA. The backfill must create the first prerelease tag and
GitHub Release without rewriting history.
