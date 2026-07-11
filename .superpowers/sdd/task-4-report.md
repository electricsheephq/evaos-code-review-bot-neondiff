# Task 4 report: AppCore model-harness migration

## Status

Complete. The obsolete compile harness and runner are removed only after the migrated AppCore tests passed, and the desktop workflow now invokes the real AppCore test target through `scripts/run-swift-tests.sh`.

## Migration ledger

- Frozen pre-edit inventory: 87 `check(` matches.
- Substantive legacy assertions: 85 unique literal messages.
- Non-assertion helper matches excluded: the `check` function declaration and `check(predicate(), message)` inside the old polling helper.
- Legacy scenarios migrated: 14 concrete test functions.
- Checked-in ledger mappings: 85 unique messages, each naming one concrete test function and one source file.
- Ledger enforcement: each message must occur exactly once as a trailing assertion comment inside its mapped test function.

## Changed surface

- Added separately named Swift Testing suites for provider visual state, provider-key scoping, provider verification state transitions, provider patch ownership, GitHub authorization, configuration/control-center seams, and migration-ledger enforcement.
- Added test-only in-memory secret, CLI/provider, GitHub, clock, preferences, file, clipboard, URL, and dashboard support under `Tests/NeonDiffDesktopAppCoreTests/Support`.
- Replaced wall-clock polling with explicit continuations or injected `TestClock` behavior.
- Deleted `Checks/NeonDiffDesktopModelChecks/main.swift` and `scripts/run-model-checks.sh` after the full migrated target passed.
- Replaced the stale workflow invocation with `scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests`.
- Left `Package.swift` unchanged because no legacy model-check target remained.
- Made no AppCore model/source, composition-root, executable-adapter, view, or existing `ProductionBoundaryContractTests` edits.

## Validation

- Baseline before migration: AppCore target passed 13 tests in 4 suites.
- Red-first proof: the first focused run failed because `ProviderModelFixture` did not yet exist.
- Focused migrated suites:
  - `ProviderVisualFixtureTests`: 1 passed.
  - `ProviderKeyScopingTests`: 2 passed.
  - `ProviderVerificationStateMachineTests`: 8 passed.
  - `ProviderConfigurationPatchTests`: 3 passed.
  - `GitHubAuthorizationTests`: 5 passed.
  - `ConfigurationControlCenterTests`: 5 passed.
  - `ModelHarnessMigrationLedgerTests`: 1 passed.
- Pre-deletion AppCore target: 38 tests in 11 suites passed.
- Post-deletion guard: old files absent and no `NeonDiffDesktopModelChecks` or `run-model-checks` references remain in Package/scripts/workflows.
- Post-deletion AppCore target: 38 tests in 11 suites passed.
- `swift build -c debug --product NeonDiffDesktop`: passed.
- `swift build -c release --product NeonDiffDesktop`: passed.
- `npm run check:secrets`: passed across 572 tracked files.
- `git diff --cached --check`: passed.

## Self-review

- Confirmed the staged change set is restricted to Task 4 test/support/ledger files, the two legacy deletions, and the workflow invocation.
- Confirmed 14 legacy scenario functions and 85 unique checked-in assertion mappings.
- Confirmed migrated tests do not use `Task.sleep`, `Date()`, `UserDefaults`, live Keychain, `FileManager.default`, `NSWorkspace`, or `NSPasteboard`.
- Confirmed raw provider fixtures remain outside model/result reflection, errors, status text, displayed command lines, and recorded argv; the scoped secret is present only as recorded standard input.
- Confirmed `scripts/run-swift-tests.sh` is executable.
- The advisory `codex-review --uncommitted` helper was attempted twice, including after all new files were staged, but the nested Codex runtime exited after local plugin/MCP teardown warnings without producing a review conclusion. No advisory findings were emitted; the manual review and executable proof above are the review basis.

## Proof boundary and concerns

- No GitHub, release, runtime, customer, or source-of-truth state was mutated.
- No live Keychain prompts or ambient OS integrations were exercised.
- The only remaining concern is the unavailable nested advisory-review conclusion noted above; code/test/build/diff/secret gates are green.
