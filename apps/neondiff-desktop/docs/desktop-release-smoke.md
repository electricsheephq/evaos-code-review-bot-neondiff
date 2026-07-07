# Desktop Release Smoke

`.github/workflows/desktop-release-smoke.yml` is the unsigned macOS app-bundle smoke lane for NeonDiff Desktop. It is manual and tag-oriented, runs the hosted-runner-safe `NeonDiffDesktopCoreChecks` and appcast checks, builds the `.app`, validates bundle structure, and uploads the zipped bundle with metadata.

The uploaded bundle is non-release proof. Its metadata marks `release_ready: false`, `customer_ready: false`, and `artifact_classification: unsigned-desktop-release-smoke`, so it is customer-not-ready by design.

The Keychain-backed `NeonDiffDesktopCoreSmoke` executable remains a local or release-smoke proof on a runner with known-good Keychain behavior. Hosted CI does not run that target because the unsigned release-smoke lane is meant to prove build, package, and app-bundle shape without touching credentials or local Keychain state.
