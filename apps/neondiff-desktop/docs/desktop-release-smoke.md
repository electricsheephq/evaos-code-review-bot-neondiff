# Desktop Release Smoke

`.github/workflows/desktop-release-smoke.yml` is the unsigned macOS app-bundle smoke lane for NeonDiff Desktop. It is manual and tag-oriented, runs `NeonDiffDesktopCoreTests` with explicit nonzero discovery, compiles `NeonDiffDesktopKeychainChecks`, runs the hosted-safe appcast checks, builds the `.app`, validates bundle structure, and uploads the zipped bundle with metadata.

The uploaded bundle is non-release proof. Its metadata marks `release_ready: false`, `customer_ready: false`, and `artifact_classification: unsigned-desktop-release-smoke`, so it is customer-not-ready by design.

The metadata packet records artifact identity and the proof boundary for later
release packets: `artifact_sha256`, `source_sha`, `source_ref`,
`app_bundle_path`, `bundle_id`, `short_version`, `build_version`,
`signing_identity_class`, `ui_launch`, and `visual_smoke_required`. Hosted CI
keeps `ui_launch: false`; a real release packet still needs a local visible smoke
that opens the app artifact and clicks through first-run controls before claiming
user-ready desktop behavior.

`NeonDiffDesktopKeychainChecks` and the Keychain-backed `NeonDiffDesktopCoreSmoke` executable remain local proof on a runner with known-good detached-process and Keychain behavior. Hosted CI runs `NeonDiffDesktopCoreTests` and compiles the Keychain check target on a pinned `macos-15` runner but does not execute Security.framework-linked helpers because the headless macOS 15 image can kill those executables after a successful link. Runtime proof comes from the named local bundle's visible startup smoke, not from treating a hosted helper process as an app launch.
