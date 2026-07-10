# NeonDiff Desktop Dev MVP

NeonDiff Desktop is a SwiftPM macOS app scaffold for issue #115. It is a thin local control panel over the NeonDiff CLI and daemon contracts.
For the 1.0 launch bar, the Mac app is intentionally a minimal launcher:
opening the app shows local controls that can start `neondiff dashboard` or open
the same local HTML dashboard used by the CLI.

## Boundaries

- No review engine runs in the desktop app.
- No UI path posts GitHub reviews directly.
- The Mac launcher implements native setup/status controls only where they can
  write through existing CLI contracts. The local HTML dashboard remains the
  deeper browser-first setup surface.
- No signing, notarization, Sparkle appcast, downloadable artifact, TCC, Mac-control, or customer-control proof is claimed here.
- Provider and license keys are stored in macOS Keychain under a NeonDiff-specific service and are never written to config files.

## Local Commands

```bash
cd apps/neondiff-desktop
swift run NeonDiffDesktopCoreSmoke
swift build
./script/build_and_run.sh build
./script/build_and_run.sh bundle-check
```

`./script/build_and_run.sh` stages a local unsigned `.app` bundle under `apps/neondiff-desktop/dist/` for development only.
Use that unsigned bundle for dev smoke and bundle-resource proof only. Signed,
notarized, appcast, and installed-app visual proof belong to the Mac release
runbook after source behavior is already proven.

## CLI Contract

The desktop uses these JSON-first CLI surfaces:

```bash
neondiff config inspect --config config.local.json
neondiff config patch --config config.local.json --input desktop-patch.json --dry-run true
neondiff daemon status --config config.local.json --launchd-label com.example.neondiff
neondiff daemon start --config config.local.json --launchd-label com.example.neondiff --dry-run true
neondiff daemon stop --config config.local.json --launchd-label com.example.neondiff --dry-run true
neondiff dashboard --config config.local.json --launchd-label com.example.neondiff --open true
```

`config patch` writes only whitelisted non-secret fields, defaults to dry-run, and requires `--confirm true` for live writes.
Patch inputs use nested JSON object shape for editable paths. For example, the advertised `zcode.cliPath` path is supplied as `{ "zcode": { "cliPath": "/path/to/neondiff" } }`; flat dotted keys such as `{ "zcode.cliPath": "/path/to/neondiff" }` are rejected to avoid ambiguous profile keys.

The ZCode defaults in `config.example.json` are developer-machine paths. On any non-author workstation or packaged desktop install, set explicit local values for `zcode.cliPath`, `zcode.appConfigPath`, and `zcode.model` before relying on daemon controls.

## GitHub And Repo Allowlist

The Repos pane shows GitHub App setup state without exposing tokens. The public
GitHub App `clientId` may be stored in config for the desktop/device
authorization flow, while GitHub user access tokens belong in Keychain only.

When `github.clientId` is configured and device flow is enabled in the GitHub
App settings, the Repos pane can start GitHub device authorization, show the
short user code, open GitHub's verification page, store the resulting user token
in Keychain, and list repositories visible through the user's GitHub App
installations. Repository discovery is read-only and uses the standard GitHub
user installation APIs; the desktop never stores the user token in config or
release evidence. If GitHub returns `device_flow_disabled`, enable device flow
on the GitHub App before retrying.

The repo selector persists selected repositories by writing a `pilotRepos` patch
through `config patch`. Discovered repositories are disabled until the user
selects them. It does not post reviews, widen App permissions, or write GitHub
user tokens into config. Live PR reviews still post only through the configured
GitHub App bot identity.

The Repos pane links to the public GitHub App's install/manage page and tells
users to choose `Only select repositories`. It names the core review permissions
and keeps optional Issues access scoped to the separate issue-enrichment feature.
It distinguishes expired user
authorization, API rate limiting, missing App installation, and organization
policy or permission blocks without showing raw API bodies. Discovered repos
show one of these access cues:

- `PUBLIC · FREE` for the public-repo path;
- `PRIVATE · LICENSE REQUIRED` until active entitlement is proven;
- `PRIVATE · LICENSE ACTIVE` only for an explicit active entitlement state;
- `INSUFFICIENT READ ACCESS` when GitHub reports that the user cannot read the
  repository.

A stored license key is not treated as active entitlement. Repo selection still
writes only the local allowlist; the worker's pre-checkout license and GitHub App
gates remain authoritative for review execution.

## Local Dashboard Launcher

The dev app no longer opens a browser tab automatically. It exposes explicit
controls to start the same local dashboard server without opening a browser, or
to open the browser dashboard when the user chooses it:

```bash
neondiff dashboard --config config.local.json --launchd-label com.electricsheephq.evaos-code-review-bot --open false
neondiff dashboard --config config.local.json --launchd-label com.electricsheephq.evaos-code-review-bot --open true
```

The dashboard owns first-run setup and readiness display for provider API key
verification, license status, GitHub App status, daemon status, and provider
readiness. The Swift app only launches that browser-first surface and shows the
redacted command/status locally.
