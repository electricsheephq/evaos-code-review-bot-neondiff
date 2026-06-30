# Launchd Pilot

Launchd should stay disabled until GitHub App installation is complete and a real ZCode dry-run succeeds without rate limiting.

Recommended first live command:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
GITHUB_TOKEN="$(gh auth token)" npm run run-once -- --dry-run true --repo electricsheephq/WorldOS --pr 1205
```

After the GitHub App is installed, use app credentials and keep `--dry-run true` for the first 24-hour observation window:

```bash
export EVAOS_REVIEW_BOT_APP_ID=...
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/absolute/path/to/private-key.pem
npm run daemon -- --dry-run true
```

Only switch to `--dry-run false` after:

- current-head duplicate reruns post nothing,
- review-plan JSON contains only valid current-diff lines,
- no secret-like text appears in comments or logs,
- ZCode worktrees stay clean after runs,
- GLM/Z.ai rate limits are not firing.
