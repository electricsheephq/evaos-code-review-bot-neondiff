# evaOS Code Review Bot

Pilot local worker for ZCode/GLM-5.2 pull request reviews.

## Safety Defaults

- Reviews only the allowlisted pilot repos in `config.example.json`.
- Skips draft PRs by default.
- Posts at most one review per `{repo, pr, head_sha}`.
- Never submits `APPROVE`.
- Uses `REQUEST_CHANGES` only for validated P0/P1 findings.
- Drops findings that cannot be placed on current RIGHT-side diff lines.
- Drops secret-looking findings instead of redacting and posting them.
- Re-fetches PR state before command-triggered review, before planning comments, and before live posting; stale-head output is recorded and skipped.
- Redacts secret-looking material from local evidence logs before writing them.
- Verifies the ZCode worktree is clean, including untracked files, after every review run.
- Caps ZCode prompt patch bytes and kills long ZCode runs with `zcode.timeoutMs`.
- Installs a temporary per-worktree ZCode policy that allows read-only file tools, disables Bash/mutation/subagents, then restores/removes it before the clean check.
- Sets `ZCODE_MODEL_RETRY_MAX_RETRIES=0` by default so provider rate limits fail fast instead of multiplying requests.
- Resolves repo profiles before review; once profiles are configured, unknown or disabled repos skip closed before GitHub PR fetches.
- Schema-validates repo policy, allowlist, canary, pre-merge check, and finishing-touch config before runtime use.
- Keeps maintainer PR-comment commands disabled by default; when enabled, only configured trusted authors can steer read-only reviews.

## Commands

```bash
npm run doctor
npm run release:status -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expected-head "$(git rev-parse HEAD)"
npm run run-once -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-dry-run.json --dry-run true --repo electricsheephq/WorldOS --pr 1161
npm run daemon -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-dry-run.json --dry-run true
```

Posting reviews requires a GitHub App installed on the pilot repos:

```bash
export EVAOS_REVIEW_BOT_APP_ID=...
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/path/to/private-key.pem
npm run run-once -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json --dry-run false
```

The worker derives transient ZCode CLI model environment from the existing ZCode app config at `/Volumes/LEXAR/zcode/.zcode/v2/config.json`; it does not copy the Z.ai API key into this repository.

## Live Beta Releases

The live launchd worker is a local beta release surface, not just whatever
`main` happens to contain. Before promoting a merged PR to the live worker,
follow [docs/beta-release-runbook.md](docs/beta-release-runbook.md).

## Repo Profiles

Use [docs/repo-profiles.md](docs/repo-profiles.md) to add repo-specific review
guidance, risky paths, proof expectations, and path filters. Profiles are
prompt/config metadata only; they do not expand GitHub permissions, live
monitoring, ZCode tools, approvals, or repair behavior by themselves.

## Maintainer Commands

Use [docs/maintainer-commands.md](docs/maintainer-commands.md) for the dormant
trusted command surface. Commands are PR comments such as
`@evaos-code-review-bot review`, `re-review`, `explain`, and `stop`; they stay
behind `commands.enabled` and cannot repair, merge, approve, push branches, or
expand monitoring.
