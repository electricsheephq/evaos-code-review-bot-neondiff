# GitHub App Install And Onboarding

NeonDiff reviews pull requests through a GitHub App, while the reviewer worker
runs on your own machine or server. The App identity is what authors review
comments in GitHub; your local worker holds the App ID, private key, provider
configuration, state database, and evidence files.

On macOS the native app (`apps/neondiff-desktop`) is the human first-run surface.
The invite-only B0 build accepts the invited customer's own App ID and private
key, one selected repository, and runs the explicit installation check from the
wizard. The managed B1 path uses the official NeonDiff App and broker under
#613; it is separate from B0. This document remains the operator/CLI reference
for both paths' App identity, permission set, and install boundary. Matching
public website onboarding copy lives in the website repo under
neon-diff-agent-website#52.

## Install URL

For B0, create a customer-owned GitHub App in the invited customer's GitHub
account or organization, then use that App's install link. Record its numeric
App ID, generate one private key, and keep the downloaded PEM outside git. The
public, organization-owned NeonDiff App is the separate managed B1 path; do not
use it to describe or prove B0.

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

> This page covers the shipped **local-worker direct install**, where the worker
> holds the App private key itself and no OAuth-during-install step is needed. The
> separate **managed authorization broker** (official App registered, source
> composition present, rollout kill switch still off)
> instead requires the App to enable "Request user authorization (OAuth) during
> installation" and set the `/github/connect/callback` URL; that
> registration is documented in `docs/security/github-app-staging-registration.md`.
> Do not enable OAuth-during-install for the local direct-install path below.

The managed broker contract is intentionally narrower than the local-worker
path. A Keychain-backed P-256 device identity establishes the installation
binding. Native activation sends that non-secret device ID plus the exact
GitHub-selected repository to the license API. A later private
`/github/token` request carries the Keychain-owned Activation Key only in the
fixed-origin HTTPS body; the broker performs an in-memory lookup against the
same device/repository activation and never logs, reflects, or persists the raw
key. Public requests omit the key and never consult the license authority.
The production kill switch remains off until the paid-beta integration and
canary gates pass, so this source contract is not production-wiring proof.
When an exact release-bundle contract enables the managed source path, the
native app creates its P-256 identity only on explicit Connect, opens the
broker-issued GitHub install URL, polls the device-bound completion endpoint,
and accepts repository names/visibility only from the broker readback. The app
continues polling completion while any existing-install Device Flow prompt is
pending, so a fresh OAuth-during-install callback wins without a second user
authorization. If GitHub routes a pre-existing installation to configuration
without a callback, the verified build uses its compiled official public App
client ID for Device Flow. The resulting user token is transient proof for the
exact selected installation only; it stays in process memory until an explicit
installation choice, is then cleared, and is never used to post a review. A
saved installation id is a routing hint only and cannot unlock onboarding until
a fresh server repository read succeeds. Manual repository names and the legacy
user-token discovery path are disabled in managed mode. Generic CLI
status/deactivate and daemon-admission validation still require exact-candidate
integration proof under #630.

1. Open the customer-owned GitHub App's install URL.
2. Choose the user or organization that owns the repositories.
3. Select `Only select repositories`.
4. Pick one repository for the B0 onboarding run.
5. Confirm the permissions above.
6. Save the generated private key outside this repository.
7. In native NeonDiff first run, store the App ID and private key, enter the same
   `owner/repo`, choose **Add Repository**, **Apply Repository**, and then
   **Verify App Access**. The app updates `pilotRepos` through `config patch`; no
   operator edits the customer's config file.

Keep the private key and local config out of git. A typical shell setup is:

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_CLIENT_ID="<github-app-client-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
```

`NEONDIFF_GITHUB_APP_CLIENT_ID` is public metadata used by the desktop/device
authorization flow. Do not put user access tokens or refresh tokens in config;
desktop user tokens belong in Keychain.

Device Flow is not part of the B0 customer-owned App path. The managed B1 path
tracks browser OAuth for existing installations under #613; Device Flow remains
only an optional CLI/headless fallback and is not GitHub approval of the public
App.

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

GitHub App credentials and provider BYOK are separate lanes. The desktop stores
provider BYOK in Keychain and verifies only an already applied saved provider
registry target; it never puts that key in GitHub App settings or config.

For public/private entitlement proof, keep the GitHub doctor JSON and the review
evidence path together. The proof packet should show `visibility_result`,
`visibility_source`, `license_gate_decision`, and `pre_checkout_gate_result`.
Public repos with no license fail this gate, as do private repos without an
active private entitlement, expired or revoked entitlements, and unknown
visibility. Every denial must happen before checkout, provider calls, or GitHub
review posting. A provider API key alone is not repository entitlement evidence.

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

The supported distribution requires live API-backed activation before public,
private, internal, or unknown repository work. Legacy `publicReposFree` and
`privateReposRequireEntitlement` values are migration inputs only and cannot
weaken the production policy — a local visibility flag would trust the client's
own claim.

Coming with the native app: public open-source repository review will be free
with no NeonDiff Activation Key, while private/commercial review will require an
active entitlement. This managed public-free/private-paid model ships with the
native NeonDiff app and the server-side GitHub App broker (#614), which verifies
repository visibility; it is not enforced by the current CLI.

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
- A managed first run shows `GitHub App client ID unavailable`: the bundle is
  missing the verified paid-beta production boundary. Install the exact signed
  beta artifact; do not paste a user token or private key into the app.
- A pre-existing App installation remains pending: confirm Device Flow is
  enabled on the official App, then use the native code prompt. Fresh installs
  should complete through the broker callback without a second authorization.
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
