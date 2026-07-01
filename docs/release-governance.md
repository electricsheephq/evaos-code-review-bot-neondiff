# Release Governance Runbook

This bot is a live beta agent. A live promotion is not complete until the
source SHA is tied to an immutable Git tag, a GitHub Release, runtime evidence,
and a rollback path.

## Release Levels

- `beta`: local launchd worker on the operator Mac, posting as the GitHub App
  on the active allowlist. Beta releases are prereleases.
- `stable`: future multi-operator or production rollout. Stable releases are
  blocked until beta evidence proves low-noise behavior over labeled PRs.

## Version Names

Use semver prerelease tags for live beta promotions:

```text
v0.2.5-beta.1
v0.2.5-beta.2
v0.3.0-beta.1
```

Patch beta tags are for runtime/reliability fixes. Minor beta tags are for new
reviewer behavior, policy shape, eval/capability expansion, or operator-facing
workflow changes.

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
6. `git status --short` is clean in the live checkout.

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
export EVAOS_REVIEW_BOT_APP_ID=4184532
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/Volumes/LEXAR/Codex/evaos-code-review-bot/secrets/evaos-code-review-bot.private-key.pem
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head <source-sha> \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

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
