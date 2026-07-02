# GitHub App Setup

Create a GitHub App named `evaOS Code Review Bot` with slug `evaos-code-review-bot`.

GitHub does not provide a direct noninteractive `gh app create` command for this. Use the GitHub App manifest handshake or the GitHub web UI. The manifest flow requires a signed-in user to open the organization app-registration URL, approve the manifest, then exchange GitHub's temporary `code` for the app ID and PEM within one hour.

Required repository permissions:

- Contents: read
- Pull requests: read/write
- Checks: read
- Actions: read
- Metadata: read

Optional issue-enrichment permissions, gated by `issueEnrichment`:

- Issues: read, only for dry-run/operator issue enrichment reads.
- Issues: write, only after a tracked rollout explicitly enables App-authored
  sticky issue enrichment comments on an `issueEnrichment.allowlist` repo.

Do not add Issues permissions merely because a repository is in the PR review
monitor list. Issue enrichment has a separate allowlist and per-repo throttles
because milestone or planning days can create large issue bursts.

Install the app only on:

- `electricsheephq/WorldOS`
- `100yenadmin/evaOS-GUI`

After installation, save the generated private key outside the repository and launch the worker with:

```bash
export EVAOS_REVIEW_BOT_APP_ID=...
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/absolute/path/to/evaos-code-review-bot.private-key.pem
npm run doctor
npm run run-once -- --dry-run true
```

Do not run with `--dry-run false` until dry-run evidence exists for both pilot repos and `npm test` plus `npm run build` pass.
