# CI Runner Guide

NeonDiff can run one-shot dry-run checks on Linux CI runners when you want PR
review evidence without a long-lived daemon. This guide covers GitHub Actions
and generic CI hosts. It does not grant extra GitHub permissions or bypass the
normal current-head checks.

## GitHub Actions

Use an Ubuntu runner, install Node.js 26, and run a dry-run review or setup
smoke with credentials supplied by the repository or organization secret store.

```yaml
name: NeonDiff dry-run
on:
  pull_request:

permissions:
  contents: read
  pull-requests: read
  checks: read

jobs:
  neondiff:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 26
          cache: npm
      - run: npm install -g neondiff
      - name: Prepare dry-run config
        run: cp config.example.json "$RUNNER_TEMP/config.local.json"
      - name: Write GitHub App key
        run: |
          install -m 600 /dev/null "$RUNNER_TEMP/neondiff.private-key.pem"
          printf '%s' "${NEONDIFF_GITHUB_APP_PRIVATE_KEY}" > "$RUNNER_TEMP/neondiff.private-key.pem"
        env:
          NEONDIFF_GITHUB_APP_PRIVATE_KEY: ${{ secrets.NEONDIFF_GITHUB_APP_PRIVATE_KEY }}
      - run: neondiff doctor github --config "$RUNNER_TEMP/config.local.json" --json
        env:
          NEONDIFF_GITHUB_APP_ID: ${{ secrets.NEONDIFF_GITHUB_APP_ID }}
          NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: ${{ runner.temp }}/neondiff.private-key.pem
```

For CI-hosted dry-run review, write the App private key to
`$RUNNER_TEMP/neondiff.private-key.pem` with restricted permissions as shown
above, run `neondiff review-pr --dry-run true`, and upload only redacted
evidence.

`--dry-run true` never posts GitHub comments. Live CI posting still inherits the
normal NeonDiff gates: the target head must be current, duplicate suppression
must allow the head, and the public alias must be invoked with
`--dry-run false --confirm true` after the repo, PR, head SHA, and config path
are approved.

## Generic CI

The generic shape is:

```bash
node --version
npm install -g neondiff
cp config.example.json "$RUNNER_TEMP/config.local.json"
neondiff doctor github --config "$RUNNER_TEMP/config.local.json" --json
neondiff providers list --config "$RUNNER_TEMP/config.local.json" --json
neondiff review-pr --config "$RUNNER_TEMP/config.local.json" --repo owner/name --pr "$PR_NUMBER" --dry-run true
```

Use CI for one-shot checks. Use [docs/systemd.md](systemd.md) or
[docs/docker.md](docker.md) for a supervised long-running Linux worker.
