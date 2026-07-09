# GitHub App Install And Onboarding

NeonDiff reviews pull requests through a GitHub App, while the reviewer worker
runs on your own machine or server. The App identity is what authors review
comments in GitHub; your local worker holds the App ID, private key, provider
configuration, state database, and evidence files.

## Install URL

Use the public NeonDiff GitHub App install URL from the release notes or website
for the beta you are testing. Until the public App registration is finalized,
operators can create an equivalent App with the permission set below and record
the generated install URL in the issue or release evidence packet.

Install only on selected repositories. NeonDiff does not need organization-wide
discovery for the v1.0 MVP, and the worker only reviews repos present in your
local config allowlist.

## Repository Permissions

Required repository permissions for pull-request review:

- Metadata: read
- Contents: read
- Pull requests: read/write
- Checks: read
- Actions: read

Why these permissions are needed:

- `Metadata: read` lets the App identify installed repositories.
- `Contents: read` lets the worker fetch and inspect the target head.
- `Pull requests: read/write` lets the App read PR metadata and submit reviews.
- `Checks: read` and `Actions: read` let review summaries include CI context
  without creating or modifying workflow runs.

Optional issue-enrichment permissions are separate from PR review:

- Issues: read, only for dry-run/operator issue enrichment reads.
- Issues: write, only after a tracked rollout explicitly enables App-authored
  sticky issue enrichment comments on an `issueEnrichment.allowlist` repo.

Do not add Issues permissions merely because a repository is in the PR review
monitor list. Issue enrichment has a separate allowlist and per-repo throttles
because milestone or planning days can create large issue bursts.

## Selected-Repo Install Path

1. Open the NeonDiff GitHub App install URL.
2. Choose the user or organization that owns the repositories.
3. Select `Only select repositories`.
4. Pick the repos you want NeonDiff to review.
5. Confirm the permissions above.
6. Save the generated private key outside this repository.
7. Add the same repos to `pilotRepos` in your local `config.local.json`.

Keep the private key and local config out of git. A typical shell setup is:

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_CLIENT_ID="<github-app-client-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
```

`NEONDIFF_GITHUB_APP_CLIENT_ID` is public metadata used by the desktop/device
authorization flow. Do not put user access tokens or refresh tokens in config;
desktop user tokens belong in Keychain.

## Verify Installation

Run the GitHub-only doctor before provider or daemon checks:

```bash
neondiff doctor github --config config.local.json --json
```

The command verifies App credential presence, App installation visibility, and
repo read access for the enabled repos in your local config. It does not run
ZCode, call a model provider, post comments, print tokens, or print the private
key path.

Expected signs of a usable install:

- `ok: true`
- `github.readMode: "app_installation"`
- `github.canPostAsApp: true`
- each enabled repo has `ok: true`
- `activeRepoChecks` is greater than zero
- each enabled repo read check includes:
  - `repo_full_name`
  - `visibility_result`: `public`, `private`, `internal`, or `unknown`
  - `visibility_source`: `repository_api`, `private_flag`, or `unavailable`
  - `installation_id_present: true`
  - `app_can_read_metadata: true`
  - `app_can_read_pull_requests: true`
  - `license_gate_decision`
  - `pre_checkout_gate_result`

If a repo is disabled by repo policy, the doctor reports it as
`skippedByPolicy`; that is useful config evidence, but it is not proof that the
App can read or review that repo.

Treat `visibility_result: "unknown"` or any `app_can_read_*: false` as a
pre-checkout blocker. Unknown or unreadable visibility is never public-free
evidence; confirm the App installation scope, selected repositories, and
permissions before widening provider/model settings.

For public/private entitlement proof, keep the GitHub doctor JSON and the review
evidence path together. The proof packet should show `visibility_result`,
`visibility_source`, `license_gate_decision`, and `pre_checkout_gate_result`.
Public repos with no license may pass this gate, then fail later if no provider
is configured. Private repos without an active private entitlement, expired or
revoked entitlements, and unknown visibility must block before checkout,
provider calls, or GitHub review posting. A provider API key alone is not
private-repo entitlement evidence.

## First Review Path

Start with a dry run on a known PR:

```bash
neondiff review-pr \
  --config config.local.json \
  --repo owner/name \
  --pr 123 \
  --dry-run true \
  --zcode false
```

Only move to live review after the dry-run output and evidence are inspected and
the exact repo, PR, head SHA, config path, and posting intent are recorded in
the relevant issue.

When live posting is approved, the review author in GitHub must be the NeonDiff
GitHub App bot, not the human user token. If the author is a user account, stop
and fix App credentials before continuing.

## License Boundary

Public open-source repositories are free when `license.publicReposFree` is true.
Private and commercial repositories require a paid NeonDiff support license when
`license.privateReposRequireEntitlement` is true.

Private repo data stays local to the worker and GitHub App installation. Do not
send private repository names, diffs, logs, private keys, provider keys, license
keys, or customer data to a website form or public issue.

## Uninstall

To remove NeonDiff from a user or organization:

1. Open GitHub Settings for the user or organization.
2. Go to `GitHub Apps` or `Installed GitHub Apps`.
3. Select the NeonDiff App installation.
4. Remove individual repositories or uninstall the App entirely.
5. Stop the local worker and remove the repo from `pilotRepos`.
6. Delete local App private keys only after confirming no worker still needs
   them.

## Troubleshooting

- `doctor github` reports `readMode: "unconfigured"`: set
  `NEONDIFF_GITHUB_APP_ID` and `NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH`, or set
  `github.appId` and `github.privateKeyPath` in an untracked local config.
  Legacy `EVAOS_REVIEW_BOT_*` aliases remain supported for existing internal
  deployments, but new public setup should use the NeonDiff names.
- `doctor github` reports `fallback_token`: the worker can use a token for
  local reads, but it cannot prove App-authored review posting.
- A repo read fails with 404 or "Resource not accessible by integration":
  confirm the App is installed on that selected repo and has the permissions
  listed above.
- `doctor github` reports `github_api_error_class: "suspended_installation"`:
  unsuspend or reinstall the App before running reviews.
- `doctor github` reports `github_api_error_class: "renamed_or_transferred"`:
  update the repo name in the local config and rerun the doctor.
- `doctor github` reports `github_api_error_class: "rate_limited"`:
  wait for the GitHub API window to recover, then rerun the doctor before
  treating the repo as install-proven.
- `activeRepoChecks` is zero: the config has no enabled repo to prove; add a
  selected installed repo to `pilotRepos`.
- Private repo review fails before provider calls: check license status before
  widening GitHub permissions or changing provider settings.
- App-authored comments do not appear: verify the live command used App
  credentials, not only `GITHUB_TOKEN`.

## Evidence To Save

For public App install acceptance, save a redacted evidence packet containing:

- the App permissions snapshot
- `neondiff doctor github --json` output
- public test-repo dry-run output
- private repo missing-license fail-closed output when applicable
- the first App-authored review URL and target head SHA

This setup guide proves the local onboarding path only. It does not by itself
prove Marketplace readiness, package publishing, calibrated review accuracy, or
all-org rollout safety.
