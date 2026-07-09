# Desktop Release Smoke

`.github/workflows/desktop-release-smoke.yml` is the unsigned macOS app-bundle smoke lane for NeonDiff Desktop. It is manual and tag-oriented, compiles `NeonDiffDesktopCoreChecks`, runs the focused hosted-runner-safe `NeonDiffDesktopKeychainChecks` and appcast checks, builds the `.app`, validates bundle structure, and uploads the zipped bundle with metadata.

The uploaded bundle is non-release proof. Its metadata marks `release_ready: false`, `customer_ready: false`, and `artifact_classification: unsigned-desktop-release-smoke`, so it is customer-not-ready by design.

The metadata packet records artifact identity and the proof boundary for later
release packets: `artifact_sha256`, `source_sha`, `source_ref`,
`app_bundle_path`, `bundle_id`, `short_version`, `build_version`,
`signing_identity_class`, `ui_launch`, and `visual_smoke_required`. Hosted CI
keeps `ui_launch: false`; a real release packet still needs a local visible smoke
that opens the app artifact and clicks through first-run controls before claiming
user-ready desktop behavior.

`NeonDiffDesktopCoreChecks` and the Keychain-backed `NeonDiffDesktopCoreSmoke` executable remain local proof on a runner with known-good detached-process and Keychain behavior. Hosted CI compiles the broad checks but executes only the focused Keychain contract target because the unsigned release-smoke lane must stay deterministic without touching credentials or depending on a long-lived detached process.
