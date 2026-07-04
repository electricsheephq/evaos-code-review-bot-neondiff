# NeonDiff Setup

This guide is the first-run path for the current source-available beta. After
`npm run build`, the source checkout exposes the beta `neondiff` binary. See
[LICENSE.md](../LICENSE.md) and [docs/license-boundary.md](license-boundary.md)
for the public/private repo license boundary, and [docs/pricing.md](pricing.md)
for the support-tier pricing contract.

## Requirements

- Node.js 26 or newer
- npm
- GitHub App credentials for the repos you want to review
- a provider/model path available on the machine running the worker
- optional NeonDiff license key for private or commercial repo use

Public open-source repos are free. Private and commercial repos require a paid
support license: $1/month, $10/year, or $100 lifetime. Paid support includes
private repo review, commercial usage, and auto-updates. Provider/model costs
remain external through your own provider key or local model; NeonDiff does not
include hosted model credits, unlimited SaaS inference, or bundled provider
tokens.

## 1. Install From Source

```bash
git clone https://github.com/electricsheephq/evaos-code-review-bot.git neondiff
cd neondiff
npm install
npm run build
npm link
```

`npm link` installs the local source-checkout shim so the examples below can use
`neondiff`. If you intentionally skip linking, substitute `./dist/src/cli.js`
for `neondiff`.

## 2. Create A GitHub App

Create a GitHub App for NeonDiff and install it only on repos you intend to
review.

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
export EVAOS_REVIEW_BOT_APP_ID="<github-app-id>"
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
```

## 3. Configure Provider And License

Create a local config from the example, then edit it for your local repo
allowlist, provider path, state path, and evidence path:

```bash
neondiff init --config config.local.json
```

For the current internal provider path, the worker derives transient ZCode/GLM
environment from the local app config referenced by `config.local.json`. Do not
copy provider API keys into this repository.

If you are reviewing private or commercial repos, set your license key through
the configured local secret path or environment used by your operator wrapper.
Do not paste license keys into tracked config.

The public license path is explicit and local-first. By default, license
enforcement is disabled in the example config so internal beta workers do not
change behavior accidentally. For a public/private repo install, enable
`license.enabled`, use the beta `file` storage backend, and activate the key
without writing it to tracked config. The file backend writes the key with 0600
permissions under the configured `license.keyPath`, which defaults next to
`statePath` when omitted.
Private-repo review only accepts a cached entitlement during a transient API
outage for up to 15 minutes; longer grace windows are rejected at config load.

```bash
NEONDIFF_LICENSE_KEY="..." \
  neondiff license activate \
  --config config.local.json \
  --license-key-env NEONDIFF_LICENSE_KEY \
  --json
```

Check entitlement cache state:

```bash
neondiff license status --config config.local.json --json
```

Inspect the canonical support-tier pricing without making a network call:

```bash
neondiff pricing --json
```

Remove the local key and cache:

```bash
neondiff license deactivate --config config.local.json --json
```

When `license.enabled` and `license.privateReposRequireEntitlement` are true,
private repo review fails closed before worktree prep, model/provider calls, or
GitHub review posting unless the cached entitlement is active and covers private
repos. Public repo review may run without a license when `license.publicReposFree`
is true.

The `keychain` backend remains listed for future native macOS storage support,
but headless CLI activation currently rejects Keychain writes rather than passing
license keys through `security add-generic-password` process arguments.
Treat `--license-storage keychain` as read/delete-only for pre-existing native
items during this beta; `license activate` with `keychain` intentionally throws.
The local `machineId` sent to the license API is advisory beta metadata derived
from host name and platform, not hardware attestation or a durable seat-binding
primitive.

## 4. Check Readiness

Run doctor with the config you intend to use:

```bash
neondiff doctor --config config.local.json --json
```

The doctor output is JSON. Check:

- `ok`
- `github.readMode`
- each `github.readChecks[]`
- provider readiness
- repo policy allow/skip state

## 5. Run A Dry-Run Review

Use a known repo, PR number, and current head. A dry-run review should produce
structured output and evidence without posting comments:

```bash
neondiff review-pr \
  --config config.local.json \
  --repo owner/name \
  --pr 123 \
  --dry-run true \
  --zcode false
```

Do not run with `--dry-run false` until dry-run evidence, focused tests, and
the relevant issue explicitly approve the exact repo, PR, head SHA, and config
path.

## 6. Inspect Daemon And Status

Before touching launchd, use JSON status commands:

```bash
neondiff status --json --config config.local.json
neondiff queue --config config.local.json
neondiff dashboard --config config.local.json --limit 10
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
`daemon start` without `--plist` restarts an already loaded LaunchAgent with
`kickstart`; first-time LaunchAgent installation must pass the plist path so the
dry-run plan includes `bootstrap`. If a live `bootstrap` fails because the
LaunchAgent is already loaded, rerun `daemon start` without `--plist` to perform
the kickstart-only restart path.
Use only operator-owned plist paths. The CLI validates the plist `Label` against
`--launchd-label` and warns when the plist lives outside the NeonDiff package
root. Live mutation with an external plist also requires
`--allow-external-plist true`; keep the default off unless the release issue
names the exact operator-owned plist path. The external-plist check is a lexical
path warning, not a realpath/symlink containment proof, so do not rely on it as
a filesystem security boundary.

Live `review-pr` posting is intentionally harder than dry-run inspection. Use
`--dry-run true` for normal local checks. A live scoped PR review requires
`--dry-run false --confirm true` after the target repo, PR, head SHA, and config
path are approved by the relevant issue.

Launchd and live beta promotion are advanced operator tasks. Use
[docs/launchd.md](launchd.md), [docs/operator-cli.md](operator-cli.md), and
[docs/beta-release-runbook.md](beta-release-runbook.md) only after dry-run proof
passes.

Public source-beta promotion additionally uses
[docs/public-release-manifest.json](public-release-manifest.json). The manifest
declares the current public beta version, setup/release-notes alignment, license
API state, and update-channel readiness. A local source beta may explicitly
defer license API, website, or desktop channels only when the manifest marks
that channel as `requiredForThisRelease: false`.

## Troubleshooting

- `doctor` cannot read repos: verify GitHub App installation, app ID, private
  key path, and repo permissions.
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
accuracy, enterprise readiness, desktop client readiness, package publishing, or
live beta promotion. Those are separate issues and release gates.
