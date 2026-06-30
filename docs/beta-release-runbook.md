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
- Keep the live daemon scoped to the current active config until the allowlist
  issue and App-install gates pass.
- Do not let launchd run an unrecorded or stale checkout after a merge.

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

## Required Gates

- GitHub PR merged to `main` with checks green and no current-head actionable
  review threads.
- Release checkout is clean and exactly at the intended source SHA.
- `npm test` and `npm run build` pass from the release checkout.
- `release:status` records exact source SHA, branch, config path, launchd job,
  launchd dry-run mode, state DB row count, and error count.
- launchd emits a fresh heartbeat after restart.
- live DB has no unexpected error rows.
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
- `release:status` JSON before and after restart.
- `npm test` and `npm run build` result.
- launchd stdout heartbeat lines after restart.
- live DB row/error count.
- rollback SHA and command.
- next monitoring action or heartbeat.

Keep raw evidence under `/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/`
or session notes. Do not paste secrets, private keys, tokens, cookies, raw
customer data, or long logs into GitHub comments.
