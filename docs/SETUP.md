# NeonDiff Setup

This guide is the first-run path for the current source-available release. The
recommended path installs the `neondiff` npm package; source checkout remains a
fallback for contributors and reviewers who want to inspect or build locally. See
[LICENSE.md](../LICENSE.md) and [docs/license-boundary.md](license-boundary.md)
for the public/private repo license boundary, and [docs/pricing.md](pricing.md)
for the support-tier pricing contract.

> **v1.0.4 release-candidate notice:** The mandatory activation behavior in
> this guide describes the next release and the current source branch. Public
> npm `latest` remains v1.0.3 until the replacement passes activation,
> install, CI, and review proof. v1.0.3 does not enforce this boundary. Do not
> use `npm install -g neondiff` as mandatory-activation proof until npm and the
> GitHub Release both report v1.0.4.

## Requirements

- Node.js 26 or newer
- npm
- GitHub App credentials for the repos you want to review
- a provider/model path available on the machine running the worker
- NeonDiff license key for API-backed activation before supported review work

API-backed activation is required for supported public, private, internal, and
unknown repository review. Support licenses cost $1/month or $10/year for
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

## 2. Create Or Install A GitHub App

Use the public NeonDiff GitHub App install URL for the beta you are testing, or
create an equivalent App while the public registration is being finalized. See
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

For the Mac desktop Repos pane, copy the GitHub App client ID into
`github.clientId` or `NEONDIFF_GITHUB_APP_CLIENT_ID`, and enable device flow in
the GitHub App settings. Without that optional feature, GitHub will return
`device_flow_disabled` when the desktop tries to show a user authorization code.

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
backend; the Desktop app remains blocked from useful actions until native
broker/launchd access is proven.
The local `machineId` sent to the license API is advisory beta metadata derived
from host name and platform, not hardware attestation or a durable seat-binding
primitive.

## 4. Check Readiness

Run the GitHub-only doctor first. It verifies App installation visibility and
repo read access without running ZCode, calling a provider, posting comments, or
printing secrets:

```bash
neondiff doctor github --config config.local.json --json
```

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

The local HTML dashboard is the human first-run surface. It shows license
status, GitHub App status, daemon status, and provider readiness with redacted
output. Use the provider card's `Verify API Key` button before launch/use; the
button checks the selected provider path and reports pass/fail without printing
the submitted key.

In the native Mac pane, the selected `providers.defaultProviderId` registry
entry is the source of truth. Endpoint/model edits are dirty until a successful
Preview and confirmed Apply/readback. Verify stays disabled until that saved
state is current, then invokes the exact provider ID and config revision. The
Keychain value crosses only bounded stdin; it is never added to the registry
patch, argv, environment, logs, or evidence.

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
