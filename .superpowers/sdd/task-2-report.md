# Task 2 implementation and test report

## Scope

- Added the eight package-scoped, `Sendable` AppCore operating-system seam
  protocols exactly as declared in the task brief.
- Added `DesktopAppDependencies` with a required package initializer storing
  all eight seams plus Core's `DesktopSecretStoring` and
  `GitHubDesktopAuthenticating` interfaces.
- Added deterministic, lock-backed test fakes for clipboard, URL opening, CLI
  execution, detached dashboard launch, preferences, clock, file writes, and
  provider verification.
- Added a portable, dependency-free `scripts/run-swift-tests.sh` wrapper and
  marked it executable.

## Test-first evidence

1. The seam tests and recording fakes were written before any of the production
   seam protocols or dependency container existed.
2. The brief's direct CLT framework command first exposed a local Apple CLT
   packaging issue: importing both Foundation and Testing attempted to load a
   missing `_Testing_Foundation` module. The test module was kept portable by
   confining Foundation helpers to the support source, which does not import
   Testing.
3. The next RED run failed for the intended reason with unresolved
   `DesktopClipboard`, `DesktopURLOpener`, `DesktopCLIExecuting`,
   `DesktopDashboardLaunching`, `DesktopPreferences`, `DesktopClock`,
   `DesktopFileWriting`, `DesktopProviderVerifying`, and
   `DesktopAppDependencies` symbols.
4. After the minimal production protocols, dependency container, and bounded
   fakes were added, the focused suite passed 9 tests.

## Concurrency and secret-safety review

- Every new operating-system seam conforms to `Sendable`.
- Mutable fake state is isolated behind `NSLock` in one reusable
  `@unchecked Sendable` box; fake implementations expose snapshot copies.
- Clipboard and URL operations remain `@MainActor`.
- CLI stdin is bounded before recording and over-limit failures contain only a
  fixed message, never the input bytes.
- Provider verification calls expose no secret parameter or stored secret
  field. The fake records only executable path, account, expected provider and
  revision metadata, argv, and timeout.
- File destinations are standardized and must remain below the injected root;
  rejected writes use a fixed error message and are not recorded.
- AppCore production sources contain no AppKit, SwiftUI, Sparkle, Security,
  XCTest, NSPasteboard, NSWorkspace, global FileManager, or standard
  UserDefaults references.

## Verification

From `apps/neondiff-desktop`:

```bash
chmod +x scripts/run-swift-tests.sh
test -x scripts/run-swift-tests.sh
sh -n scripts/run-swift-tests.sh
scripts/run-swift-tests.sh --filter DesktopAppDependenciesTests
scripts/run-swift-tests.sh list
scripts/run-swift-tests.sh
```

Results:

- Focused seam suite: 9 tests in 1 suite passed.
- Discovery: 11 nonzero tests listed, including all 9 seam tests plus the two
  import-contract tests.
- Full suite: 11 tests in 3 suites passed.
- Forbidden-import scan: no matches.
- Wrapper mode: `-rwxr-xr-x`.

An additional repository-wide `-strict-concurrency=complete
-warnings-as-errors` probe does not currently compile pre-existing
`NeonDiffDesktopCore` sources (including non-Sendable Core model values and a
captured mutable process flag). It fails before compiling AppCore and is outside
Task 2's owned files. The normal Swift 6.2.4 build emitted no warnings for the
new production or test sources.

## Review remediation

- `RecordingDesktopDependencies` now requires an injected `root: URL`; it no
  longer reads `FileManager.default` or creates a random UUID. The one
  aggregate-fake test supplies a fixed synthetic file URL, so its construction
  has no operating-system mutation or ambient-path dependency.
- Added `FoundationProviderVerifier` in the desktop adapter target. Its
  initializer accepts the injected `DesktopSecretStoring`; each `verify` call
  creates a new `NeonDiffCLIClient` with that call's `executablePath` and
  `NeonDiffCLIResolver.defaultWorkingDirectory()`, then a new
  `ProviderVerificationService` and forwards the account, provider ID,
  config revision, arguments, and timeout to `verifyCancellable`. It stores no
  service, CLI client, or secret value.

## Review-remediation verification

From `apps/neondiff-desktop`:

```bash
scripts/run-swift-tests.sh --filter DesktopAppDependenciesTests
scripts/run-swift-tests.sh list
scripts/run-swift-tests.sh
if rg -n 'FileManager\\.default|UUID\\(\\)\\.uuidString' \
  Tests/NeonDiffDesktopAppCoreTests/Support/RecordingDesktopDependencies.swift; then
  exit 1
fi
if rg -n '^(import (AppKit|SwiftUI|Sparkle|Security|XCTest))$|NSPasteboard|NSWorkspace|FileManager\\.default|UserDefaults\\.standard' \
  Sources/NeonDiffDesktopAppCore; then
  exit 1
fi
swift build --product NeonDiffDesktop -c debug
git diff --check
```

Results: focused AppCore suite passed 9 tests; discovery listed 11 tests;
the full wrapper suite passed 11 tests in 3 suites; both forbidden-dependency
scans were clean; the debug `NeonDiffDesktop` executable build passed; and
`git diff --check` was clean.
