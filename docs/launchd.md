# Launchd Pilot

Launchd should stay disabled until GitHub App installation is complete and a real ZCode dry-run succeeds without rate limiting.

Recommended first live command:

```bash
cd /Volumes/LEXAR/repos/evaos-code-review-bot
export EVAOS_REVIEW_BOT_APP_ID=4184532
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/Volumes/LEXAR/Codex/evaos-code-review-bot/secrets/evaos-code-review-bot.private-key.pem
npm run run-once -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-dry-run.json --dry-run true --repo electricsheephq/WorldOS --pr 1161
```

After the GitHub App is installed, use app credentials and keep `--dry-run true` for the first observation window:

```bash
export EVAOS_REVIEW_BOT_APP_ID=4184532
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/Volumes/LEXAR/Codex/evaos-code-review-bot/secrets/evaos-code-review-bot.private-key.pem
npm run daemon -- --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-dry-run.json --dry-run true
```

Only switch to `--dry-run false` after:

- current-head duplicate reruns post nothing,
- review-plan JSON contains only valid current-diff lines,
- no secret-like text appears in comments or logs,
- ZCode worktrees stay clean after runs,
- GLM/Z.ai rate limits are not firing,
- `npm run doctor` reports `readMode: "app_installation"` and successful read checks for every pilot repo.
