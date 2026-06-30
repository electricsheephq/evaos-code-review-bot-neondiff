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
- Verifies the ZCode worktree is clean after every review run.
- Caps ZCode prompt patch bytes and kills long ZCode runs with `zcode.timeoutMs`.

## Commands

```bash
npm run doctor
npm run run-once -- --dry-run true --repo electricsheephq/WorldOS --pr 1205
npm run daemon -- --dry-run true
```

Posting reviews requires a GitHub App installed on the pilot repos:

```bash
export EVAOS_REVIEW_BOT_APP_ID=...
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/path/to/private-key.pem
npm run run-once -- --dry-run false
```

The worker derives transient ZCode CLI model environment from the existing ZCode app config at `/Volumes/LEXAR/zcode/.zcode/v2/config.json`; it does not copy the Z.ai API key into this repository.
