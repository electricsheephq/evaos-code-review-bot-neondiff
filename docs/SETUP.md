# NeonDiff Setup

This guide is the CLI/operator setup path for npm CLI 1.0.4 and non-Mac first
run. The current product is the public paid B0 BYO beta. The planned signed
Desktop 1.1.0 journey at `/Applications/NeonDiff.app` becomes primary only after
its immutable GA artifact, `/mac` surface, and promotion gates are live. See the
[Mac GA architecture and release contract](architecture/mac-ga-release-contract.md)
and [Desktop Mac release runbook](../apps/neondiff-desktop/docs/mac-release-runbook.md).
The recommended path installs the `neondiff` npm package; source checkout remains
a fallback for contributors and reviewers who want to inspect or build locally. See
[LICENSE.md](../LICENSE.md) and [docs/license-boundary.md](license-boundary.md)
for the public/private repo license boundary, and [docs/pricing.md](pricing.md)
for the support-tier pricing contract.

> **v1.0.4 verification notice:** v1.0.4 is the first package intended to enforce
> mandatory API-backed activation. Verify `npm view neondiff version` and the
> matching non-prerelease GitHub Release before relying on it; v1.0.3 and
> earlier do not enforce this boundary.

## Requirements

- Node.js 26 or newer
- npm
- GitHub App credentials for the repos you want to review
- a provider/model path available on the machine running the worker
- NeonDiff license key for repository review (the current CLI requires
  activation for every repository; public open-source review will be free in the
  native app)

The current CLI (v1.0.x) requires API-backed activation for every repository
(public, private, internal, and unknown); unknown visibility fails closed, and
GitHub-authoritative visibility (public, private, internal, and unknown) decides
the tier. Coming with the native app: public open-source repositories will be
free with no NeonDiff Activation Key, while private, internal, and commercial
repositories will require an active entitlement (managed GitHub App broker #614;
not enforced by the current CLI). Support
licenses cost $1/month or $10/year for
individuals, or $100/year for organizations. Individual plans include a 7-day
trial, organization plans include a 30-day trial, and legacy lifetime licenses
remain honored for existing holders but are no longer sold. Provider/model costs
remain external through your own provider key or local model; NeonDiff does not
include hosted model credits, unlimited SaaS inference, or bundled provider tokens.

## 1. Install NeonDiff

Recommended package install after v1.0.4 is published and verified:

```bash
npm install -g neondiff
```

Installer script:

```bash
curl -fsSL https://www.neondiff.com/install | sh
```

Preview the installer without changing your machine:

```bash
curl -fsSL https://www.neondiff.com/install | sh -s -- --dry-run
```

Use a temp npm prefix for isolated install proof:

```bash
tmp_prefix="$(mktemp -d)"
curl -fsSL https://www.neondiff.com/install | sh -s -- --prefix "$tmp_prefix"
"$tmp_prefix/bin/neondiff" help
```

Source checkout fallback:

```bash
git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git neondiff
cd neondiff
npm install
npm run build
```

If you intentionally use the source checkout without the global package,
substitute `./dist/src/cli.js` for `neondiff`.

## 2. Create And Install A Customer-Owned GitHub App

For the public paid B0 BYO beta, create a customer-owned GitHub App in your
GitHub account or organization and use that App's install URL. The public
organization-owned NeonDiff App belongs to the later managed B1 path and does
not replace the B0 private key flow. See
[docs/github-app-setup.md](github-app-setup.md) for the selected-repo install
path, uninstall path, evidence packet, and troubleshooting details.

Install the App only on repos you intend to review, then put the same repos in
your local `pilotRepos` allowlist.

Required repository permissions:

- Contents: read
- Pull requests: read/write
- Checks: read
- Actions: read
- Metadata: read

Optional issue-enrichment permissions are separate from PR review and should not
be enabled just because a repo is monitored:

- Issues: read, only for dry-run/operator issue enrichment reads
- Issues: write, only after a tracked rollout enables sticky issue comments

Save the generated private key outside the repository.

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_CLIENT_ID="<github-app-client-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
```

For legacy/direct Mac desktop builds, copy the GitHub App client ID into
`github.clientId` or `NEONDIFF_GITHUB_APP_CLIENT_ID`. A verified managed beta
build instead carries the official App's public client ID in its production
boundary, so first-run does not depend on loading CLI config. Enable Device Flow
in the official App settings: when GitHub does not rerun OAuth-during-install
for an existing installation, the native app uses Device Flow only as transient
installation-access proof. It continues polling the broker during that window,
so a fresh-install callback wins without a second authorization. If Device Flow
is disabled, GitHub returns `device_flow_disabled` and the existing-install path
fails closed.

## 3. Configure Provider And License

Create a local config from the example, then edit it for your local repo
allowlist, provider path, state path, and evidence path:

```bash
neondiff init --config config.local.json
```

For the current internal provider path, the worker derives transient ZCode/GLM
environment from the local app config referenced by `config.local.json`. Do not
copy provider API keys into this repository.

Use [docs/providers.md](providers.md) for GLM/Z.ai, Ollama, and
OpenAI-compatible endpoint examples. The provider registry stores metadata such
as provider id, base URL, model id, timeout, retry policy, and an API-key
environment variable name; it must not store the API key itself.

Every supported repository review requires a live NeonDiff entitlement. The
supported distribution pins `https://neondiff-license.fly.dev`, enables
enforcement, disables the public-free path, and grants no offline cache
authority. Legacy v1.0.3 fields still load for upgrade recovery but cannot
weaken this effective policy.

Use the `file` storage backend and pipe one `nd_live_...` key through bounded
stdin. Do not place license keys in environment variables, argv, tracked config,
shell history, logs, screenshots, or evidence. The file backend writes the key
with 0600 permissions under `license.keyPath`, which defaults next to
`statePath` when omitted.

```bash
security find-generic-password -s YOUR_APPROVED_SOURCE -w \
  | neondiff license activate \
      --config config.local.json \
      --license-key-stdin true \
      --json
```

Check entitlement cache state:

```bash
neondiff license status --config config.local.json --json
```

Inspect the canonical support-tier pricing without making a network call:

```bash
neondiff pricing
```

Remove the local key and cache:

```bash
neondiff license deactivate --config config.local.json --json
```

Public, private, internal, and unknown repository work all fail closed before
worktree prep, model/provider calls, or GitHub review posting unless live API
validation returns an active entitlement covering that operation and visibility.
Cached entitlement metadata is diagnostic only.

Use this matrix when reading doctor or review evidence:

| Repo visibility | License state | Provider state | Expected setup result |
| --- | --- | --- | --- |
| public | no license | provider present | license blocks before checkout/provider/post |
| public | no license | provider absent | license blocks before checkout/provider/post |
| public | active covering entitlement | provider present | license allows; provider output decides review success |
| private | no license | provider present | license blocks before checkout/provider/post |
| private | active private entitlement | provider present | license allows; provider output decides review success |
| private | expired or revoked entitlement | provider present | license blocks before checkout/provider/post |
| unknown | any state | provider present | fail closed before checkout/provider/post |

Provider API keys are BYOK model credentials only. They do not unlock private
repo review and should not be used as proof of a NeonDiff paid entitlement.
For `review-pr` license blocks, the gate writes its local proof under the
configured `evidenceDir` as
`<date>/<owner__repo>/pr-<number>/<head-sha>/license-gate.json`.

The `keychain` backend remains reserved for a separately proven native broker.
Headless CLI activation currently rejects Keychain writes rather than passing
license keys through process arguments. v1.0.4 supports the approved file
backend; signed Desktop 1.1.0 keeps activation in its app-owned Keychain path.
The local `machineId` sent to the license API is advisory beta metadata derived
from host name and platform, not hardware attestation or a durable seat-binding
primitive.

The managed native beta path replaces that advisory host hash with the
Keychain-backed GitHub broker device ID and binds activation to the exact
GitHub-selected `owner/repo`. The Activation Key stays Keychain-owned and
crosses only two bounded channels: stdin to `license activate`, then the
fixed-origin broker HTTPS request body when a private token is requested. The
broker uses it for an in-memory license lookup and never logs, reflects, or
persists it. Public-repository token requests omit the key and do not call the
license authority. This path is still rollout-disabled; these contracts do not
prove production enablement or customer readiness.

The native source composition is also default-off. A release bundle must carry
all three exact public Info.plist values before the app constructs the managed
client:

- `NeonDiffPaidBetaContract = paid-mac-beta-v1`
- `NeonDiffManagedGitHubBrokerEnabled = true`
- `NeonDiffGitHubBrokerOrigin = https://neondiff-license.fly.dev`

After that exact bundle contract passes, the managed production boundary also
supplies the compiled official GitHub App public client ID. It is public
metadata, not a secret, and it is unavailable to quarantined/debug composition.
This lets native first-run authorize an already-installed App without requiring
a prior CLI `config inspect`; it does not enable the server kill switch.

`apps/neondiff-desktop/script/build_and_run.sh` accepts those values only for a
release build and only through the exact matching
`NEONDIFF_DESKTOP_PAID_BETA_CONTRACT`,
`NEONDIFF_DESKTOP_MANAGED_GITHUB_BROKER_ENABLED`, and
`NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN` inputs. When all three inputs are
omitted, the bundle remains quarantined. Any non-empty but incomplete,
mismatched, or non-release combination fails the build with exit 2. These are
public configuration values, not secrets, and do not override the server-side
kill switch. Generic CLI status/deactivate and daemon-admission validation still
require exact-candidate integration proof under #630.

The public paid B0 BYO beta has a separate, mutually exclusive release
bundle contract:

- `NeonDiffPaidBetaContract = paid-mac-beta-byo-v1`
- `NeonDiffBYOGitHubEnabled = true`
- no managed-broker enable marker or broker origin

The build inputs are `NEONDIFF_DESKTOP_PAID_BETA_CONTRACT` and
`NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED`. That exact release-only contract enables
the existing direct/BYO GitHub path and API-backed native activation without a
manual UserDefaults rollout mutation. It does not make the managed App path
available and is not proof that GitHub private-key custody, the compatible CLI
package, billing, signing, or customer canaries have passed.

For the planned signed Desktop 1.1.0 GA journey, once the immutable artifact and `/mac` promotion gates are live, move the app to `/Applications/NeonDiff.app` and follow its UI:

1. Create and install a customer-owned GitHub App with the permissions in
   [`github-app-setup.md`](github-app-setup.md), selecting one repository.
2. Move the app to `/Applications/NeonDiff.app`; enter the App ID/private key
   in its UI and choose **Store in Keychain**.
3. Choose **Initialize Local Config**, add/apply the selected `owner/repo`, and
   let the app write the allowlist without an operator config edit.
4. Choose **Verify App Access** for a new App or **Verify Existing Access** for
   a compatible agent; both checks bind the exact target.
5. Configure provider/Codex, activate, then use **Preview Start**, **Install & Start**,
   and **Run Dry Review** before any confirmed live post.

If verification reports a missing or disabled repository policy profile,
choose **Apply Repository** again before retrying **Verify App Access**. This is a local
configuration recovery step, not evidence that the GitHub App installation is
missing.

For a verified account with no bot yet, the app allocates the isolated new-bot
plan before showing **Initialize Local Config**. It never initializes the
`Accounts/_unselected` placeholder.

If the customer quits before setup is complete, relaunch NeonDiff and continue
the same pending bot. The app restores the exact account-scoped config path and
reopens onboarding rather than creating a second `new-neondiff-bot-*`
directory. If an older build or manual rollback changed the saved selection to
a verified existing bot under the same account, relaunch keeps that
authoritative bot selected and preserves only a structurally valid,
account-scoped pending plan. Choose **NEW BOT** to resume that preserved setup;
the app rejects it if any authorized bot now owns the same config identity.
Choosing another account or explicitly choosing an existing bot ends the
pending setup.

For that promoted GA journey, the LaunchAgent `Program` is the signed
`/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop` wrapper. It dispatches
`--neondiff-worker-daemon` to the sealed helper
`/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker`; it is not a direct
helper LaunchAgent. Legacy recovery below is operator-only, not native first-run
setup.

This first-run step proves only current App installation and repository access.
Provider verification, activation, dry run, and live review remain separate
gates. No invitation is required when the versioned public GitHub prerelease is
published and the neondiff.com purchase/download path is live. Until both are
true, the candidate and its GitHub prerelease assets remain held.

After App access, provider, repository, and activation are verified, the native
daemon step offers **Preview Start** followed by **Install & Start** when no
supported LaunchAgent exists. Preview validates the exact signed
`/Applications/NeonDiff.app`, account-scoped config, customer-owned App ID, and
the worker sealed inside the signed app. Confirmed install writes one 0600 secret-free plist in
`~/Library/LaunchAgents` and starts it through the current user's launchd
domain. The plist invokes the signed app's bounded headless mode and contains no
private-key value or file path. It includes the non-secret broker device ID
already used for native activation. That mode revalidates the same public
coordinates, re-derives the device ID from NeonDiff's own Keychain identity,
rejects a mismatched plist, reads the App key from Keychain without user
interaction, reads the API-backed activation credential from the same app-owned
Keychain service, validates the running sealed worker process, and only then
pipes both secret values plus that non-secret device ID once in a bounded JSON
envelope to its stdin. License validation then uses the same machine binding as
native activation instead of the CLI's legacy host hash. A conflicting plist,
unsafe app/config/worker path, unavailable Keychain item, device mismatch, or
launchd failure fails closed. Do not replace this with a `security -w` wrapper,
export the key to disk, or weaken its Keychain access control.

After Checkout displays the one-shot NeonDiff Activation Key, return to the
native **License** pane, paste the key, and choose **Continue with this key**,
then **Activate**. **Buy an Activation Key** opens the public pricing page but
keeps the existing-key field available when the customer returns. The key is
stored only through the app's Keychain activation path and the plaintext field
is cleared; do not paste it into Terminal, config, logs, screenshots, or
evidence.

### Existing bot on this Mac

After account linking, the native app may find a server-verified bot whose App
identity and GitHub account intersect an existing launchd/config candidate on
the same Mac. In that exact case it opens a reconciliation path:

- on launch, it keeps the empty onboarding path hidden while account authority
  and the local config are being restored, then shows onboarding only if no
  authorized local bot exists;
- it loads the existing config and repository allowlist without overwriting it;
- it does not ask the user to paste or migrate the worker's existing GitHub App
  private key;
- it reports the server-authoritative account entitlement separately from
  current-launch review authorization;
- when the inspected config enables `codexRuntime`, it reports the exact Codex
  CLI path, model, and reasoning effort as the active review runtime without
  reading or storing the CLI's OAuth material; otherwise it treats
  `zcode-app-config` and `none` provider auth modes as config-backed, not as
  missing NeonDiff Keychain API keys;
- if the worker allowlist contains multiple repositories, it keeps every entry
  unchanged and requires one explicit **Review Target** for native activation;
  that target is restored only for the same config path;
- it can reverify and invoke the exact matched LaunchAgent configuration without
  copying its private key. The key file must be a current-user-owned regular
  file with no group/other permissions. Only its file path—not its key bytes—is
  supplied as a child-process environment coordinate for the exact config;
- its single **Verify Existing Access** action first proves the exact App and
  Review Target with `doctor github --repo`. A legacy credential-bearing
  matched worker then runs credential-free
  `license status --refresh true` through that exact worker and config. A
  secret-free Keychain-backed worker instead reads the app-owned Activation Key
  noninteractively and revalidates it through the signed sealed worker's
  idempotent API path, with the key crossing only bounded stdin and no local
  CLI-state write. Neither path places the key in argv, environment, config,
  logs, or evidence. GitHub-reported repository visibility and an active live
  API entitlement covering that visibility are both required; an unavailable
  Keychain item, unknown visibility, expired or revoked access, malformed
  output, or offline proof fails closed;
- Overview runs one provider-backed repository/PR-scoped dry review first. A
  live review is enabled only for that config revision and the returned
  40-character head SHA, and requires explicit confirmation (see
  [Run A Dry-Run Review](#5-run-a-dry-run-review)); a transport failure revokes
  the approval and requires a new dry review;
  daemon-wide start stays blocked for multi-repository workers;
- it keeps new work blocked until the exact current GitHub/repository and
  entitlement checks required by the release path pass.

A local config path, launchd label, App ID, or repository name by itself is not
authority. Suspended, revoked, pending, mismatched, or server-unrecognized bots
remain in setup/recovery and fail closed.

### Update an existing local worker

The Mac app checks the exact discovered worker's `review-pr` help contract
before enabling **Run Dry Review**. A package version alone is not sufficient:
older and compatible technical-beta workers may both report `1.0.4`.

If Overview shows **Worker update required**:

1. Do not run or retry a live review from another terminal. The dry-to-live
   approval contract is not proven for that worker.
2. Choose **Install / Update Local Worker**. Use only the outer worker bundle
   ZIP named in the same immutable GitHub prerelease and release manifest as the
   installed app. Before extracting it, compare the bundle ZIP SHA-256 with the
   prerelease notes. After extraction, compare the release manifest SHA-256 with
   the prerelease notes, then compare the inner `.tgz` tarball SHA-256 with both
   the release manifest and the prerelease notes. Do not use an unpinned `main`
   checkout or trust the ambiguous `1.0.4` version string.
3. Confirm `node --version` reports Node.js 26 or newer. From the extracted
   directory, preview the checksum-bound migration using the exact LaunchAgent
   label shown in NeonDiff Settings. The installer requires absolute artifact
   paths:

   ```bash
   BUNDLE_DIR="$(pwd -P)"
   node install-b0-worker-candidate.mjs update \
     --manifest "$BUNDLE_DIR/neondiff-1.1.0-beta.N-b0-candidate-manifest.json" \
     --manifest-sha256 <manifest-sha256-from-release> \
     --tarball "$BUNDLE_DIR/neondiff-1.1.0-beta.N.tgz" \
     --launchd-label <existing-label> \
     --dry-run true
   ```

4. Inspect the public-safe preview, then repeat it with
   `--dry-run false --confirm true`. The installer verifies the tarball before
   mutation, freshly reinstalls an unreferenced leftover from that exact
   artifact instead of executing it, and installs into a versioned user-owned
   Application Support prefix,
   preserves the existing config, LaunchAgent label/environment, GitHub App key
   file, Keychain entries, provider state, and repository allowlist, and
   restarts the same LaunchAgent only when it was already loaded. It never reads
   or copies private-key bytes. Each LaunchAgent label has an isolated worker
   version, rollback state, and install lock. A lock owned by a process that no
   longer exists is recovered automatically; a lock with missing or invalid
   owner metadata fails closed and must be handled with NeonDiff support. When
   `/opt/homebrew/bin/node` or `/usr/local/bin/node` resolves to the Node runtime
   executing the installer, that stable command is retained in the LaunchAgent
   rather than its versioned package-manager target.
5. Return to Overview and choose **Retry Worker Check**. Dry review stays
   disabled until the exact installed worker advertises both config-revision
   approval and the matching ZCode provider path.

The first checksum-managed migration has no trusted prior candidate, so it
fails closed instead of restoring the unbound original LaunchAgent invocation.
Retain every verified worker bundle. After installing a later candidate,
preview rollback from the complete prior bundle:

```bash
BUNDLE_DIR="$(pwd -P)"
node install-b0-worker-candidate.mjs rollback \
  --manifest "$BUNDLE_DIR/neondiff-1.1.0-beta.PRIOR-b0-candidate-manifest.json" \
  --manifest-sha256 <prior-manifest-sha256-from-release> \
  --tarball "$BUNDLE_DIR/neondiff-1.1.0-beta.PRIOR.tgz" \
  --launchd-label <existing-label> \
  --dry-run true
```

Rollback also requires `--dry-run false --confirm true`. It verifies that the
supplied prior artifacts match the recorded prior candidate, installs them
through fresh staging, and then switches atomically without executing or
overwriting either pre-existing candidate tree or touching customer secrets.

Until an immutable GitHub prerelease and release manifest name a compatible
worker artifact, this state is a release blocker rather than a prompt to repair
source files manually.
The app's own Sparkle update does not update an external local worker.

## 4. Check Readiness

For the promoted signed Desktop 1.1.0 journey, use **Verify App Access** or **Verify Existing Access**
in the UI; before promotion, use the CLI/operator diagnostic below. Credentials go only to
the sealed helper, and the shell command verifies App/repo access without provider or posting side effects:

```bash
neondiff doctor github --config config.local.json --json
```

The CLI/operator contract uses the local `config.local.json` file for non-secret
configuration and may reference a customer-owned PEM through
`github.privateKeyPath` (or `NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH`). Keep that
file outside the repository, current-user-owned, and protected by restrictive
permissions; never put its key bytes in config, arguments, environment values,
logs, or evidence. The signed Desktop/LaunchAgent path is different: its private
key remains app-owned Keychain material, and the plist, arguments, and
environment contain neither the key nor a private-key path. The equivalent CLI
contract is:

```bash
CLI_CONFIG="config.local.json"
neondiff doctor github --config "$CLI_CONFIG" \
  --github-app-id "<numeric-app-id>" \
  --github-app-private-key-stdin true --json < "/path/to/app-private-key.pem"
```

The relative `config.local.json` examples elsewhere in this guide remain the
separate CLI-first/operator path; they do not inspect the native app's config.

The private key must be one unencrypted RSA PKCS#1 or PKCS#8 PEM no larger than
64 KiB. A CLI/operator config may contain only its file path, never the key
bytes. The reconciled-existing-worker path may supply only the already-configured
private-key file path to the exact child process; keep that file current-user-owned
with no group/other permissions. A passing doctor proves only current
installation/repository read access for the configured allowlist; it does not
execute or post a review.

The signed Mac app uses the same bounded stdin credential contract for
`review-pr` and the raw long-running daemon. It routes every credential-bearing
CLI operation to the single executable worker sealed inside the Developer
ID-signed app and validates the live process before writing stdin.
`daemon start|stop|status` control subcommands never accept secret stdin.
Runtime-only private-key material is
non-enumerable in the in-memory config object, overrides file/token credentials
for that operation, and is never accepted from JSON config. Runtime-only
activation material remains outside the config object and is available only to
the current async review or daemon operation.

Check:

- `ok`
- `github.readMode` is `app_installation`
- `github.canPostAsApp`
- each enabled repo in `github.readChecks[]`
- `activeRepoChecks` is greater than zero

Then run full doctor with the config you intend to use:

```bash
neondiff dashboard --config config.local.json
neondiff providers list --config config.local.json --json
neondiff providers doctor --config config.local.json --json
neondiff doctor --config config.local.json --json
```

This SETUP guide is the operator/advanced CLI-first path, and the first-run path
on non-Mac platforms. The local HTML dashboard is the operator/diagnostic surface
it drives. On Mac, the native macOS app is the human first-run product surface.
The exact B0 bundle lets the customer store the customer-owned App key in
Keychain, select and apply one repository, and verify that installation without
an operator editing local files. For a reconciled existing worker with a
multi-repository allowlist, choose one **Review Target** in the repository
table; this binds activation without changing the worker's other configured
repositories. Current-access verification uses `doctor github --repo` for that
one selected target, while the default CLI command without `--repo` continues
to inspect the complete configured allowlist. The native app can run one scoped
dry review through the exact matched local agent, then offer a confirmed live
post pinned to that dry-run head. It still does not start the multi-repository
daemon or rewrite its allowlist. The managed B1 broker remains a separate path.
The dashboard shows license status, GitHub App status, daemon status, and
provider readiness with redacted output. Use the provider card's `Verify API Key` button before launch/use; the
button checks the selected provider path and reports pass/fail without printing
the submitted key.

In the native Mac pane, an enabled and valid `codexRuntime` is the active review
execution backend. The app displays its exact CLI path, model, and reasoning
effort from `config inspect`; it does not read or store the Codex OAuth session.
When Codex runtime is disabled, the selected
`providers.defaultProviderId` registry entry is the source of truth.
Endpoint/model edits are dirty until a successful Preview and confirmed
Apply/readback. Verify stays disabled until that saved state is current, then
invokes the exact provider ID and config revision. The Keychain value crosses
only bounded stdin; it is never added to the registry patch, argv, environment,
logs, or evidence. That Keychain flow applies only to `api-key-env` providers.
`zcode-app-config` and `none` providers use their declared app/config path and
must not prompt for an unrelated NeonDiff API key.

The full doctor output is JSON. Check:

- `ok`
- `github.readMode`
- each `github.readChecks[]`
- provider readiness
- provider registry readiness from `providers doctor`
- repo policy allow/skip state

## 5. Run A Dry-Run Review

Use a known repo, PR number, and current head. A dry-run review should produce
structured output and evidence without posting comments. Substitute
`--repo owner/name` with one of the repos you added to `pilotRepos` in step 3
and `--pr 123` with an open PR number on that repo — `review-pr` fails with
"repo must be present in configured repos" for any repo not in `pilotRepos`:

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
Do not run with `--dry-run false` until dry-run evidence, focused tests, and
the relevant issue explicitly approve the exact repo, PR, head SHA, and config
path.

## 6. Inspect Daemon And Status

Before touching launchd, use JSON status commands:

```bash
neondiff status --json --config config.local.json
neondiff queue --config config.local.json
neondiff dashboard --operator true --config config.local.json --limit 10
```

Launchd controls are explicit and JSON-first. Dry-run them before changing a
loaded LaunchAgent:

```bash
neondiff daemon status --config config.local.json --launchd-label com.example.neondiff
neondiff daemon start --launchd-label com.example.neondiff --dry-run true
neondiff daemon stop --launchd-label com.example.neondiff --dry-run true
```

`daemon start` and `daemon stop` default to dry-run planning. Live launchd
mutation requires both `--dry-run false` and `--confirm true`.
`daemon start` first checks whether the label is registered in the current
`gui/<uid>` launchd domain. A loaded service gets `kickstart -k`. An unloaded
service gets `bootstrap` followed by `kickstart`; without `--plist`, NeonDiff
uses `~/Library/LaunchAgents/<launchd-label>.plist` when that exact standard
path exists. Pass `--plist` for any other first-time or recovery path. A
concurrent loader that wins the race after the check is treated idempotently:
NeonDiff confirms the service is now loaded and continues with `kickstart`.
Dry-run output includes `launchdLoaded`, the selected operation, and the exact
planned commands without bootstrapping or restarting the service. To derive
that plan, dry-run start issues a read-only
`launchctl print gui/<uid>/<launchd-label>` probe; an ambiguous response fails
closed instead of guessing whether the service is loaded.
Use only operator-owned plist paths. The CLI validates the plist `Label` against
`--launchd-label` and warns when the plist lives outside the NeonDiff package
root. Live mutation with an external plist also requires
`--allow-external-plist true`; keep the default off unless the release issue
names the exact operator-owned plist path. The external-plist check is a lexical
path warning, not a realpath/symlink containment proof, so do not rely on it as
a filesystem security boundary. The automatically selected exact standard
LaunchAgent path does not require that override; explicitly supplied paths
outside the package root still do.

Live `review-pr` posting is intentionally harder than dry-run inspection. Use
`--dry-run true` for normal local checks. A live scoped PR review requires
`--dry-run false --confirm true` after the target repo, PR, head SHA, and config
path are approved by the relevant issue.

The daemon also performs a bounded worktree cleanup before selected cycles.
`worktreeCleanup.retentionMs` defaults to two hours and cannot be shorter than
two hours or `reviewConcurrency.leaseTtlMs`. Cleanup only asks Git to remove
stale, clean, registered NeonDiff review worktrees; active runs and heads, open
paths, symlinks, tracked, untracked, or ignored changes, mirrors, and unrelated
paths are preserved. The open-handle guard requires `lsof` on `PATH`; the
provided Docker image includes it, while Linux package installs must provide it
through the host package manager. If the probe is unavailable, cleanup fails
closed, logs `daemon_worktree_cleanup_failed`, and removes nothing. Set
`worktreeCleanup.enabled` to `false` to disable the pass. Run the daemon and all
review workers under the same dedicated account that owns `workRoot`; cleanup
does not claim visibility into handles owned by unrelated host users.

Launchd and live beta promotion are advanced operator tasks. Use
[docs/launchd.md](launchd.md), [docs/operator-cli.md](operator-cli.md), and
[docs/beta-release-runbook.md](beta-release-runbook.md) only after dry-run proof
passes.

On Linux, `neondiff daemon start|stop|status` intentionally does not call
`launchctl`. It returns JSON with `serviceManager: "systemd"` and points to the
Linux service guide. Use [docs/systemd.md](systemd.md) for user/system services,
[docs/docker.md](docker.md) for the Compose recipe, and
[docs/ci-runner.md](ci-runner.md) for one-shot Ubuntu runner checks.

Platform support at this beta stage:

| Platform | Supervision path | Launch-readiness truth |
| --- | --- | --- |
| macOS | launchd | Tested live beta operator path |
| Linux | systemd or Docker | Packaged and guarded by Ubuntu smoke tests; provider setup still varies by host |
| CI runners | One-shot dry-run/review commands | Documented for Ubuntu-style runners |
| Windows | CLI-only | Untested; no supervised daemon claim |

Public source-beta promotion additionally uses
[docs/public-release-manifest.json](public-release-manifest.json). The manifest
declares the current public beta version, setup/release-notes alignment, license
API state, and update-channel readiness. A local source beta may explicitly
defer license API, website, or desktop channels only when the manifest marks
that channel as `requiredForThisRelease: false`.

## Environment Variables

Commands such as `doctor` read these ambient environment variables in
addition to `config.local.json`. None of them are printed by `--json` output.
Environment values override the matching config-file value where both are
set.

| Variable | Read by | Overrides config value | Notes |
| --- | --- | --- | --- |
| `NEONDIFF_GITHUB_APP_ID` | `loadConfig`/`loadConfigFromObject` (`src/config.ts`) | `github.appId` | Set once per step 2; unset falls back to the config-file value. Legacy `EVAOS_REVIEW_BOT_APP_ID` remains supported for existing internal deployments. |
| `NEONDIFF_GITHUB_APP_CLIENT_ID` | `loadConfig`/`loadConfigFromObject` (`src/config.ts`) | `github.clientId` | Public GitHub App client ID used by desktop/device authorization. This is not a secret. |
| `NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH` | `loadConfig`/`loadConfigFromObject` (`src/config.ts`) | `github.privateKeyPath` | Path to the GitHub App private key; keep the key itself outside the repo. Legacy `EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH` remains supported for existing internal deployments. |
| `GITHUB_TOKEN` | `loadConfig`/`loadConfigFromObject` (`src/config.ts`) | `github.token` | Local-development fallback token only; App auth is required for App-authored posting. |
| `NEONDIFF_PROTECTED_CHECKOUT_ROOT` | `getProtectedCheckoutRoots` (`src/path-safety.ts`) | Adds to the built-in checkout-isolation boundary | Advanced use only: an additional path `config.workRoot` must stay outside of, alongside the current package checkout. Legacy `EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT` remains supported for existing internal deployments. |
| `NEONDIFF_ALLOW_REMOTE_SMOKE` | `providers doctor` remote smoke path (`src/providers.ts`) | N/A (opt-in gate, not a config override) | Required before a hosted (non-loopback) provider smoke check is allowed to run. See [docs/providers.md](providers.md). |
| A provider's configured `apiKeyEnv` name (e.g. `ANTHROPIC_API_KEY`, `NEONDIFF_PROVIDER_API_KEY`) | Provider adapters for any `authMode: "api-key-env"` provider (`src/providers.ts`, `src/provider-adapters.ts`) | N/A (the config only stores the variable *name*, never the key) | Applies to `anthropic`, `openai`, and `openai-compatible` adapters. See [docs/providers.md](providers.md) for the per-provider list. |

The default `zcode-glm` provider (`authMode: "zcode-app-config"`) spawns the
ZCode CLI with the full ambient environment inherited (`buildZCodeRuntimeEnv`
in `src/zcode-env.ts` layers `ZCODE_MODEL`/`ZCODE_BASE_URL`/`ZCODE_API_KEY` on
top of a copy of `process.env`, it does not start from an empty environment).
Any credential-shaped variable already exported in the shell that runs
`neondiff` (for example `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, or
`ANTHROPIC_BASE_URL` if you have one of Anthropic's own tools configured in
the same shell) is visible to that child process. Run `neondiff` from a shell
that only exports the variables listed above if you need to bound exactly
what the ZCode child process can read.

## Troubleshooting

- `doctor github` cannot read repos: verify GitHub App installation, selected
  repo access, app ID, private key configuration, and repo permissions.
- `doctor github` reports `fallback_token`: token reads may work, but this does
  not prove App-authored review posting.
- `doctor github` reports `activeRepoChecks: 0`: enable at least one selected
  installed repo in local config before using the output as install proof.
- Uninstall path: remove the GitHub App installation from GitHub settings, stop
  the local worker, remove the repo from `pilotRepos`, and then delete local App
  keys only after confirming no worker still needs them.
- Provider calls fail: verify local provider config outside this repository and
  inspect redacted provider errors only.
- Review says stale head: re-fetch the PR head and rerun against the current
  SHA; do not post stale findings.
- Evidence contains sensitive material: stop, remove the unsafe artifact from
  shareable evidence, and file a security/private follow-up.
- Private repo review is blocked: verify license setup and repo policy before
  widening permissions.

## What Setup Does Not Prove

Setup does not prove public launch, final legal adequacy, calibrated review
accuracy, enterprise readiness, desktop client readiness, or live beta
promotion. Those are separate issues and release gates.
