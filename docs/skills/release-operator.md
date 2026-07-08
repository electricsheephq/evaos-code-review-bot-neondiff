# evaOS Code Review Bot Release Operator Skill

Use this skill when promoting, rolling back, auditing, or documenting a live
beta release of `electricsheephq/evaos-code-review-bot`.

## Operating Rule

Do not call a live promotion complete unless it has:

- a semver beta Git tag
- a GitHub prerelease
- a named source SHA
- validation evidence
- post-promotion `release:status`
- rollback instructions

If an emergency requires promoting before the tag/release layer, record the
exception in the tracker issue and open a backfill issue before ending.

## Default Release Flow

1. Confirm the implementation PR is merged and checks are green.
2. Sync the live checkout:
   `git fetch origin main --tags && git checkout main && git pull --ff-only origin main`.
3. Create or verify `docs/releases/<tag>.md`.
4. Create an annotated tag at the merged SHA.
5. Push the tag.
6. Create a GitHub prerelease with the release packet as notes.
7. Restart launchd.
8. Run `release:status`, `coverage-audit`, and expired provider cooldown audit.
9. Update the tracker issue and PR/release notes with the status result.

## Required Commands

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"

git fetch origin main --tags
git checkout main
git pull --ff-only origin main
git tag -a <tag> <source-sha> -m "<tag>"
git push origin <tag>
gh release create <tag> \
  --repo electricsheephq/evaos-code-review-bot \
  --title "<tag>" \
  --notes-file docs/releases/<tag>.md \
  --prerelease \
  --target <source-sha>

launchctl kickstart -k gui/$(id -u)/com.electricsheephq.evaos-code-review-bot
npm run release:status -- \
  --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json \
  --expected-head <source-sha> \
  --launchd-label com.electricsheephq.evaos-code-review-bot
```

## Failure Handling

- If GitHub checks are pending, wait or set a short follow-up monitor.
- If CodeRabbit or Codex posts actionable review, fix or explicitly reject it
  before merge.
- If launchd is stopped, restart and prove heartbeat.
- If expired provider cooldown rows exist, run `retry-provider-cooldowns`.
- If coverage audit reports unprocessed heads, do not call the release green.
- If the provider is degraded but all affected heads are active deferrals,
  call the release yellow and name the follow-up time.

## Confidence Claim

Use these words exactly:

- `green`: tag/release exists, live status passes, coverage clean.
- `yellow`: tag/release exists, daemon healthy, only active provider deferrals
  or external provider degradation remain.
- `red`: missing tag/release, stopped daemon, stale heartbeat, expired provider
  backlog, unprocessed eligible heads, or blocking DB errors.
