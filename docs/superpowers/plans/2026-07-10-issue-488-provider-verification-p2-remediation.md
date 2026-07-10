# Issue #488 Provider Verification P2 Remediation

## Goal

Resolve the three current-head PR #513 P2 findings without weakening the Keychain-to-stdin, explicit-consent, redaction, timeout, or proof boundaries.

## 1. Make the saved provider registry the UI source of truth

- Parse `providers.defaultProviderId` and the selected registry entry into native provider state: id, display name, enabled state, adapter, auth mode, base URL, and model.
- Bind the Providers pane endpoint/model and selector to that registry state. Keep ZCode CLI/app-config controls separate.
- Patch only supported non-secret provider registry paths. Never write the provider key.
- Keep a loaded provider snapshot and config revision. Disable Verify while provider settings are dirty, preview-only, applying, or otherwise not confirmed by an exact live apply/readback.
- Enable the API-key Verify action only for an enabled `openai-compatible` + `api-key-env` target with a stored Keychain item.
- Pass the exact selected `--provider` and `--expected-config-revision` to the CLI. Reject revision drift before reading stdin or launching provider verification.

## 2. Make child execution cancellation-aware

- Add an async cancellable provider-verification execution path without weakening the existing single-owner process I/O loop.
- The cancellation handler may set/wake a synchronized flag only. The sole I/O owner checks cancellation before launch, after launch/before stdin, before every write/drain/poll, and owns stdin/output closure plus TERM to SIGKILL cleanup and reaping.
- Remove the model's inner detached verification task. Await the cancellable service from the tracked task.
- Context mutation cancels the active request. Keep the model busy in a redacted `Cancelling...` state until child cleanup is complete; do not allow a second Verify meanwhile.
- Discard stale output and clear the matching request/task in every terminal path. Cancellation never installs a healthy or blocked snapshot.
- Disable provider/config/CLI/key editors and config mutation actions while verification is running or cancelling.

## 3. Durable tests

- Parser and patch tests prove selected registry mapping, legacy desktop endpoint non-authority, non-secret registry patches, and eligible/ineligible target behavior.
- Model tests prove dirty settings disable Verify, successful live apply/readback enables it, exact provider/revision arguments, revision drift blocks before secret-bearing launch, and context changes cancel/discard stale work.
- Real-process Swift checks prove pre-launch and post-launch/pre-write cancellation, bounded child termination/reaping, zero leaked secret bytes, no second process, and explicit cleanup failure.
- CLI tests prove expected-revision mismatch is rejected before stdin read/provider verification.

## 4. Canonical setup documentation

- Update `README.md`, `docs/SETUP.md`, `docs/github-app-setup.md`, `docs/providers.md`, and `docs/neondiff-desktop.md` with the saved-config/apply-first workflow, Keychain to bounded stdin transport, explicit hosted consent, healthy-only success, and nonclaims.
- Update the active website onboarding in `electricsheephq/neon-diff-agent-website` through a separate focused PR. Do not mix provider BYOK with the website account/license key.

## Gate

- Focused TypeScript and Swift red/green checks, durable model checks, full local gate, release-fixture exclusion, two independent reviews, exact-head CI/CodeQL/CodeRabbit/evaOS, zero unresolved current threads, then merge.
