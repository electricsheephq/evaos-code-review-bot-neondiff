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
      - uses: actions/checkout@08c6903cd8c0fde910a37f88322edcfb5dd907a8 # v5.0.0
      - uses: actions/setup-node@a0853c24544627f65ddf259abe73b1d18a591444 # v5
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

## Private repositories

For `review-pr --ci` (1.1.0+), one license covers one GitHub organization or
user account in CI, across all its repositories. Store the key in the Action
secret `NEONDIFF_LICENSE_KEY`. Write it in a separate step with these two shell
lines; only the file path is passed to NeonDiff:

```yaml
- name: Write NeonDiff license file
  env:
    ACTION_LICENSE_KEY: ${{ secrets.NEONDIFF_LICENSE_KEY }}
  run: |
    install -m 600 /dev/null "$RUNNER_TEMP/neondiff-license-key"
    printf '%s' "$ACTION_LICENSE_KEY" > "$RUNNER_TEMP/neondiff-license-key"
- run: neondiff review-pr --ci
  env:
    NEONDIFF_LICENSE_KEY_FILE: ${{ runner.temp }}/neondiff-license-key
```

These steps supplement the Action's normal GitHub token and provider setup.
The key file must be owned by the runner user with mode 0600; symlinks and
group/world-readable files are refused. Do not pass the key in NeonDiff argv
or environment variables. Private and internal repositories require activation
then live validation; unknown visibility fails closed. A missing key file
fails closed and names `NEONDIFF_LICENSE_KEY_FILE`. Public repositories make
no license call.

CI binds the seat to the stable numeric `GITHUB_REPOSITORY_OWNER_ID`, so owner
renames and fresh runners retain the same identity. HTTP 409 reports:
"this license is active for a different GitHub organization or account;
deactivate it there or use another license".
To free the seat, use a trusted secret-safe client to POST to the license API's
`/v1/license/deactivate` with the key and the **old owner's** machine ID:
base64url (without padding) of SHA-256 of `neondiff-ci:owner:` followed by that
numeric owner ID. License support can assist with this operation. Deleting the
Action secret or running local `license deactivate` does not free the CI owner
identity. Alternatively, use another license.

## Generic CI

The generic shape is:

```bash
node --version
npm install -g neondiff
cp config.example.json "$RUNNER_TEMP/config.local.json"
neondiff doctor github --config "$RUNNER_TEMP/config.local.json" --json
neondiff providers list --config "$RUNNER_TEMP/config.local.json" --json
neondiff review-pr \
  --config "$RUNNER_TEMP/config.local.json" \
  --repo owner/name \
  --pr "$PR_NUMBER" \
  --expected-config-revision "<verified-config-revision>" \
  --zcode true \
  --dry-run true
```

Use CI for one-shot checks. Use [docs/systemd.md](systemd.md) or
[docs/docker.md](docker.md) for a supervised long-running Linux worker.
