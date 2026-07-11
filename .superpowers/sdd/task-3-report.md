# Task 3 implementation and verification report

## Scope

- Baseline: `365c79506d7f2c3263006c8f59f957530be1c4e9`.
- Moved `NeonDiffDesktopModel` from the executable target into
  `NeonDiffDesktopAppCore` as a package-scoped `ObservableObject`.
- Replaced the model's concrete preferences, clipboard, URL, CLI, dashboard,
  clock, application-support file, provider-verification, Keychain, and GitHub
  effects with required `DesktopAppDependencies` collaborators.
- Added executable-only adapters and a production composition root, then
  imported AppCore from each executable view that consumes the model.
- Added construction and production source-boundary contract tests.
- No GitHub, release, runtime, customer, or publication state was changed.

## RED evidence and repair

The inherited staged patch was not assumed correct.

1. Running the brief's literal command from the repository root failed with
   exit 127 because the runner is package-local:

   ```bash
   scripts/run-swift-tests.sh --filter NeonDiffDesktopModelConstructionTests
   ```

   Result: `no such file or directory: scripts/run-swift-tests.sh`.

2. Running the same focused command from `apps/neondiff-desktop` compiled the
   moved AppCore model, then failed in the staged boundary test:

   ```bash
   scripts/run-swift-tests.sh --filter NeonDiffDesktopModelConstructionTests
   ```

   Result: exit 1, `ProductionBoundaryContractTests.swift:58:22: error:
   cannot find 'appCoreFileNames' in scope`.

3. The repair moved the AppCore filename snapshot into the test method that
   consumes it. No production behavior changed for this repair.

## GREEN evidence

All commands below were run from `apps/neondiff-desktop` unless noted.

```bash
scripts/run-swift-tests.sh --filter NeonDiffDesktopModelConstructionTests
```

Result: 1 test in 1 suite passed.

```bash
scripts/run-swift-tests.sh --filter ProductionBoundaryContractTests
```

Result: 2 tests in 1 suite passed.

```bash
scripts/run-swift-tests.sh list
```

Result: 14 tests discovered. The three Task 3 tests were present and a
separate nonzero assertion reported `task3_discovered_tests=3`.

```bash
scripts/run-swift-tests.sh
```

Result: 14 tests in 5 suites passed.

```bash
swift build -c debug --product NeonDiffDesktop
swift build -c release --product NeonDiffDesktop
```

Result: both product builds completed successfully.

The following direct source checks also exited zero:

```bash
if rg -n '^(import (AppKit|SwiftUI|Sparkle|Security|XCTest))$|NSPasteboard|NSWorkspace|FileManager\.default|UserDefaults\.standard|Task\.sleep|Date\(\)|NeonDiffCLIClient\(|ProviderVerificationService\(' Sources/NeonDiffDesktopAppCore; then exit 1; fi
if rg -n 'NeonDiffDesktopModel\(' Sources/NeonDiffDesktop/Views; then exit 1; fi
test ! -e Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift
test -e Sources/NeonDiffDesktopAppCore/Models/NeonDiffDesktopModel.swift
rg -n '^package final class NeonDiffDesktopModel: ObservableObject' Sources/NeonDiffDesktopAppCore/Models/NeonDiffDesktopModel.swift
git diff --check
```

Results: AppCore forbidden-dependency scan clean; no view constructs a model;
the old executable-model path is absent; the AppCore package-scoped model is
present; whitespace check clean.

## Self-review

- State-machine ownership: comparing the rename diff against baseline shows
  request/context generations, provider cancellation and cleanup latch,
  `PendingProviderPatchProof`, control-center operation identity, and GitHub
  latest-request guards remain in their original lexical order. Only effect
  calls and package access changed.
- Effect substitution: ordinary CLI work remains detached from the MainActor
  and awaits `DesktopCLIExecuting`; dashboard launch remains a separately
  detached adapter capability; provider verification remains awaited inside
  its guarded task and receives the current request's `cliPath`; GitHub polling
  awaits the injected monotonic sleep and uses the injected wall clock.
- Package boundary: the model and view-consumed API are package-scoped, AppCore
  imports `Combine` instead of SwiftUI/AppKit, and debug/release executable
  builds prove the executable target can access the package API.
- Shared Keychain: the composition root creates exactly one
  `KeychainSecretStore` and injects that same instance as both the model's
  `secretStore` and `FoundationProviderVerifier`'s secret store.
- File boundary: the production writer standardizes its root and destination,
  rejects destinations outside `NeonDiffDesktop` application support, creates
  only that root directory, and uses atomic writes.

## Proof boundary

This proves Swift package tests, source-boundary contracts, and debug/release
compilation at the recorded worktree state. It does not claim a launched-app UI
smoke, signed/notarized artifact, release, deployment, or customer-runtime
proof.
