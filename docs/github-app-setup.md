# GitHub App Install And Onboarding

NeonDiff reviews pull requests through a GitHub App, while the reviewer worker
runs on your own machine or server. The App identity is what authors review
comments in GitHub; your local worker holds the App ID, private key, provider
configuration, state database, and evidence files.

On macOS the native app (`apps/neondiff-desktop`) is the human first-run surface.
The public paid B0 BYO build accepts the customer's own App ID and private key,
one selected repository, and runs the explicit installation check from the
wizard. No invitation is required when the versioned public GitHub prerelease is
published and the neondiff.com purchase/download path is live. The managed B1
path uses the official NeonDiff App and broker under #613; it is separate from
B0. This document remains the operator/CLI reference for both paths' App
identity, permission set, and install boundary. Matching public website
onboarding copy lives in the website repo under neon-diff-agent-website#52.

## Install URL

For B0, create a customer-owned GitHub App in the customer's GitHub account or
organization, then use that App's install link. Record its numeric App ID,
generate one private key, and keep the downloaded PEM outside git. The public,
organization-owned NeonDiff App is the separate managed B1 path; do not use it
to describe or prove B0.

### Register the direct B0 App

Open GitHub's [New GitHub App](https://github.com/settings/apps/new) page while
signed in to the account that should own the App. For an organization-owned App,
open that organization's **Settings → Developer settings → GitHub Apps → New
GitHub App** page instead. GitHub's canonical field reference is
[Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app).

Use these direct local-worker values:

1. **GitHub App name:** choose a unique customer-owned name.
2. **Homepage URL:** use `https://www.neondiff.com` or the customer's own
   project homepage.
3. **Request user authorization (OAuth) during installation: off.** B0 does not
   request or store a GitHub user token.
4. **Callback URL:** blank.
5. **Setup URL:** blank, with **Redirect on update** off.
6. **Webhook:** disabled—deselect **Active** and leave the webhook URL blank.
   The local worker polls; B0 has no webhook receiver.
7. **Device Flow:** off. It is not used by the direct B0 App path.
8. Set the repository permissions in the next section and leave all
   organization and account permissions at **No access**.
9. Under **Where can this GitHub App be installed?**, choose **Only on this
   account**.
10. Create the App, generate one private key, record the numeric App ID, and use
    the App's public-page install link to install it on selected repositories.

Do not copy the managed-B1 OAuth/callback settings from
`docs/security/github-app-staging-registration.md`; that registration belongs to
the broker path and is incompatible with the B0 private-key flow.

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
7. In native NeonDiff first run, store the App ID and private key. On a clean
   Mac, choose **Install / Update Local Worker** and complete the checksum-bound
   `first-install` with Node.js 26 or newer through `/opt/homebrew/bin/node` or
   `/usr/local/bin/node`. Return to NeonDiff, choose **Install / Update Local
   Worker** once more to refresh discovery, then choose **Initialize Local
   Config**. Enter the same `owner/repo`, then choose **Add Repository**,
   **Apply Repository**, and **Verify App Access**.
   Initialization never uses `--force`; the app updates `pilotRepos` and the
   selected repository's enabled policy profile through `config patch`, and no
   operator edits the customer's config file. Existing policy fields for that
   repository are preserved. If verification reports a missing or disabled
   repository policy profile, apply the repository again before retrying
   verification; that
   message does not mean the App installation is missing. Each new
   bot config receives isolated runtime, state, evidence, and license paths
   beside that config rather than the packaged worker's placeholder paths. An
   account with no bot gets this isolated plan before the initialization action
   appears; the app never initializes the `_unselected` placeholder.
   If NeonDiff is quit mid-setup, relaunch restores that exact pending bot and
   config path and reopens onboarding. It does not silently fall back to an
   existing local bot on the same account or allocate another numbered config
   directory; the customer can explicitly choose another account or bot to end
   the pending flow.
   If one exact checksum-managed worker exists, these isolated config commands
   and the bounded private-key-stdin GitHub doctor reuse that worker instead of
   resolving through a global `neondiff` command. On a clean Mac, the bundle's
   confirmed `first-install` command creates only a private versioned CLI and
   credential-free 0600 marker; it creates or loads no LaunchAgent and starts
   no daemon. The new bot receives no inherited credential environment. Zero
   or ambiguous managed-worker discovery does not select this reuse path.
   If the configured local worker command is unavailable, the CLI-backed
   controls remain disabled and **Install / Update Local Worker** opens the
   version-matched release guide. Continue only with its checksum-bound
   manifest/tarball and dry-run-default, confirm-required `first-install`
   command. Source support does not prove that immutable release publication,
   signing, clean-Mac execution, review, or daemon readiness has passed.

8. After App access, provider, repository, and activation are verified, use the
   native daemon step's **Preview Start** and **Install & Start** actions. The
   signed app writes a secret-free LaunchAgent that points back to
   `/Applications/NeonDiff.app` with only the public App ID, exact selected
   config, launchd label, and non-secret activation device ID. Its headless mode
   re-derives that device ID from the existing broker identity in the app-owned
   Keychain, rejects any mismatch before reading credentials, validates the
   checksum-managed worker, and hands the private key plus API-backed activation
   credential to the local worker only through one bounded JSON stdin envelope.
   It never exports either secret, writes a PEM or license file, places a secret
   in the plist or environment, or uses a generic `security -w` wrapper. Any
   bot coordinate, device identity, or Keychain-item mismatch fails closed
   before the worker starts.

GitHub setup and paid activation remain separate gates. After Checkout returns
the one-shot NeonDiff Activation Key, the customer pastes it in the native
**License** pane. The **Buy an Activation Key** control opens the public pricing
page without replacing or hiding existing-key entry, and the app clears the
plaintext field after storing the key through its Keychain-only activation
path.

If account linking finds a server-verified bot whose exact App identity and
GitHub account match a local launchd/config candidate on this Mac, NeonDiff
shows that existing connection instead of presenting clean-install credential
entry. While the launch check is running, the app shows a restoring state rather
than empty setup cards or a false first-run wizard. It does not copy, rotate, or
migrate the worker private key. This
reconciliation proves account/bot/config setup only: current App access and
repository-scoped entitlement must still pass before a new dry or live review.
Local config alone never establishes membership, installation authority, or
review authorization.

The single **Verify existing access** action first runs `doctor github` for the
exact selected repository. A legacy credential-bearing matched worker then runs
credential-free `license status --refresh true --json` through that exact
worker and config. A secret-free Keychain-backed worker instead revalidates the
app-owned Activation Key through the signed sealed worker's idempotent API path.
The app reads that Keychain item noninteractively and sends it only over bounded
stdin; it never places the key in argv, environment, config, logs, or evidence,
and the CLI writes no local key state. Only a live API-sourced entitlement
covering GitHub's reported visibility unlocks review work. An unavailable
Keychain item, expired or revoked access, malformed output, offline proof, or a
stale result remains retryable and fails closed.

An existing worker may already monitor several GitHub App-authorized
repositories. NeonDiff preserves that allowlist and requires one explicit
**Review Target** in the native repository table. The Activation Key request
binds to that target only. The target selection is scoped to the exact local
config path and does not edit, remove, or disable the worker's other
repositories. For an exact matched LaunchAgent, the app may pass the existing
App ID and private-key file coordinate only to the child CLI process for that
config; it does not read, copy, print, or store the key. Overview runs one
provider-backed repository/PR-scoped dry review, records the config revision and
returned head SHA, and requires explicit confirmation before a live post pinned
to both. Any transport failure revokes approval and requires a new dry review.
Daemon-wide start stays blocked for a multi-repository worker.

If this matched local worker reports **Worker update required**, choose
**Install / Update Local Worker** and use only the checksum-bound B0 bundle
named in the same immutable GitHub prerelease and release manifest as the app.
Verify the outer bundle ZIP against the prerelease notes before extraction.
Then verify the release manifest against its SHA-256 in the prerelease notes,
and verify the inner `.tgz` tarball against the SHA-256 in both the release
manifest and prerelease notes before following the Node.js 26+, absolute-path,
dry-run, and confirmed-mutation steps in
[SETUP.md](./SETUP.md#update-an-existing-local-worker). The label-isolated
installer preserves the existing App environment, config, provider state,
repository allowlist, and private-key file coordinate. Preview rollback before
confirmed rollback; neither path reads or copies key bytes. When a stable
Homebrew Node command resolves to the same binary as `process.execPath`, the
installer keeps the stable command instead of pinning a versioned Cellar path.

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
tracks broker-hosted browser OAuth with state/PKCE for existing installations
under #613; fresh installs retain install-time OAuth. The unshipped managed
source still contains a Device Flow fallback, but it is not the B1 release
architecture. Device Flow remains only an optional CLI/headless fallback and is
not GitHub approval of the public App.

## Verify Installation

Run the GitHub-only doctor before provider or daemon checks. For the native B0
app, use the config created in the app's user-writable Application Support
directory:

```bash
NATIVE_CONFIG="$HOME/Library/Application Support/NeonDiffDesktop/config.local.json"
neondiff doctor github --config "$NATIVE_CONFIG" --repo owner/repo --json
```

CLI-first and non-Mac setups may instead use the checkout-local path documented
in [SETUP.md](SETUP.md):

```bash
neondiff doctor github --config config.local.json --json
```

The scoped command verifies App credential presence, App installation
visibility, and repo read access for that exact configured repository. The
native app uses this form when a reconciled existing worker has a larger
allowlist, so current-access proof remains bounded to the selected Review Target
without rewriting the worker. Omit `--repo` for the CLI-first full-allowlist
doctor. Neither form runs ZCode, calls a model provider, posts comments, prints
tokens, or prints the private key path.

Before starting a long-running daemon, also follow the worktree-cleanup setup in
[SETUP.md](SETUP.md): install the full `lsof` utility, and keep the configured
work root owned and used by the same dedicated daemon account. Cleanup is not a
cross-user shared-worktree feature; if open-handle visibility cannot be proven,
disable `worktreeCleanup` until the host boundary is corrected.

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
  --expected-config-revision <verified-config-revision> \
  --dry-run true \
  --zcode true
```

Use the exact `configRevision` returned by the successful provider verification.
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
