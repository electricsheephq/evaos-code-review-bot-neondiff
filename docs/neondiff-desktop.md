# NeonDiff Desktop Dev MVP

NeonDiff Desktop is a SwiftPM macOS app scaffold for issue #115. It is a thin local control panel over the NeonDiff CLI and daemon contracts.

## Boundaries

- No review engine runs in the desktop app.
- No UI path posts GitHub reviews directly.
- No signing, notarization, Sparkle appcast, downloadable artifact, TCC, Mac-control, or customer-control proof is claimed here.
- Provider and license keys are stored in macOS Keychain under a NeonDiff-specific service and are never written to config files.

## Local Commands

```bash
cd apps/neondiff-desktop
swift run NeonDiffDesktopCoreSmoke
swift build
./script/build_and_run.sh --verify
```

`./script/build_and_run.sh` stages a local unsigned `.app` bundle under `apps/neondiff-desktop/dist/` for development only.

## CLI Contract

The desktop uses these JSON-first CLI surfaces:

```bash
neondiff config inspect --config config.local.json
neondiff config patch --config config.local.json --input desktop-patch.json --dry-run true
neondiff daemon status --config config.local.json --launchd-label com.example.neondiff
neondiff daemon start --config config.local.json --launchd-label com.example.neondiff --dry-run true
neondiff daemon stop --config config.local.json --launchd-label com.example.neondiff --dry-run true
```

`config patch` writes only whitelisted non-secret fields, defaults to dry-run, and requires `--confirm true` for live writes.

The ZCode defaults in `config.example.json` are developer-machine paths. On any non-author workstation or packaged desktop install, set explicit local values for `zcode.cliPath`, `zcode.appConfigPath`, and `zcode.model` before relying on daemon controls.
