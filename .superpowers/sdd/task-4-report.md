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

## Important review follow-up on `54a0d35`

This section supersedes the original report's statements that no AppCore model source changed and that ledger enforcement used source comments. All three Important findings were fixed with the smallest authorized model surface plus test-only ledger changes.

### False clipboard and URL results

- Root cause: `copyGitHubUserCode`, `openGitHubDeviceVerification`, and `openGitHubAppInstallation` discarded the injected dependency's `Bool` result and always reported success.
- Red proof: `scripts/run-swift-tests.sh --filter GitHubAuthorizationTests` failed with 9 issues covering false-result status/error handling and stale-error clearing on success.
- Fix: false results now install fixed, non-secret `githubAuthorizationStatus` and `lastError` messages; successful retries preserve the prior success statuses and clear stale errors.
- Green proof: `GitHubAuthorizationTests` passed 6 tests in 1 suite.

### Execution-backed in-memory migration ledger

- Removed all `#filePath`, `String(contentsOf:)`, source-file loading, comment matching, and source regex behavior from the migration ledger.
- Each of the 14 named scenario tests now creates a `LegacyModelHarnessAssertionContext` tied to its actual `#function`.
- Every one of the 85 legacy conditions executes through `legacy.expect`, which records its exact scenario/message mapping and executes a real Swift Testing `#expect`.
- Each scenario defers an exact-once completeness check, rejecting missing, duplicated, or unmapped assertion calls.
- `ModelHarnessMigrationLedgerTests` directly invokes all 14 named scenario tests under a task-local aggregate and verifies 14 scenario executions plus 85 total/85 unique assertion executions.
- Fault-injection proof: temporarily removing one mapped call made the focused ledger fail with 84/85 executions and named the missing `visual fixture selects the saved registry provider` mapping; restoring the call returned the ledger to green.

### Follow-up validation

- `scripts/run-swift-tests.sh list`: 40 package tests discovered, including 39 AppCore tests.
- `scripts/run-swift-tests.sh --filter GitHubAuthorizationTests`: 6 passed.
- `scripts/run-swift-tests.sh --filter ModelHarnessMigrationLedgerTests`: 1 passed; it executed all 14 legacy scenarios and all 85 mappings.
- Migrated suites: `ProviderVisualFixtureTests` 1 passed; `ProviderKeyScopingTests` 2 passed; `ProviderVerificationStateMachineTests` 8 passed; `ProviderConfigurationPatchTests` 3 passed.
- `scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests`: 39 tests in 11 suites passed.
- `swift build -c debug --product NeonDiffDesktop`: passed.
- `swift build -c release --product NeonDiffDesktop`: passed.
- `npm run check:secrets`: passed across 573 tracked files.
- `git diff --check`: passed.
