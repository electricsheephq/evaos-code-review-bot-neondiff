# NeonDiff Desktop Dev MVP

NeonDiff Desktop is a SwiftPM macOS app scaffold for issue #115. It is a thin local control panel over the NeonDiff CLI and daemon contracts.
For the 1.0 launch bar, the Mac app is intentionally a minimal launcher:
opening the app starts `neondiff dashboard` and opens the same local HTML
dashboard used by the CLI.

## Boundaries

- No review engine runs in the desktop app.
- No UI path posts GitHub reviews directly.
- The Mac launcher does not implement a separate native setup flow; the local
  HTML dashboard remains the first-run/provider/license/status surface.
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
