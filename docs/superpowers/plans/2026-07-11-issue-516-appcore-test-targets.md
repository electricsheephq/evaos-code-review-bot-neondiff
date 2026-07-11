# Issue 516 AppCore And Real Test Targets Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the executable-source model compile harness with importable application logic, deterministic dependency seams, and real Core/AppCore tests now, then add a genuinely hosted UI-test target when full Xcode is available, without changing native behavior or weakening release-artifact boundaries.

**Architecture:** Keep data models, parsers, command builders, Keychain contracts, and provider/GitHub clients in `NeonDiffDesktopCore`. Add `NeonDiffDesktopAppCore` above Core for `NeonDiffDesktopModel`, its operation coordinators, and dependency protocols. Keep AppKit/SwiftUI views, Sparkle, concrete OS adapters, and the production composition root in the `NeonDiffDesktop` executable. SwiftPM test targets prove Core and AppCore behavior without browser, Keychain, network, live CLI, or live filesystem mutation. A separately hosted XCUITest target is created and run only after full Xcode is installed and selected; Command Line Tools builds are not hosted-UI evidence.

**Tech Stack:** Swift 5.10/Swift 6 toolchains, Swift Package Manager, Swift Testing, XCTest/XCUITest, SwiftUI, AppKit, Combine, macOS 14+, GitHub Actions macOS runners.

## Global Constraints

- Preserve the native SwiftUI application. Do not replace it with the HTML dashboard or a WebView.
- This is an architecture and testability change, not a visual redesign. Before/after behavior and public copy remain identical.
- Provider verification remains explicit-click only. Provider keys remain in Keychain and travel only over bounded stdin.
- Preview, confirmed Apply, exact config revision, readback, stale-response, cleanup-latch, and single-owner operation gates remain fail closed.
- Unit tests use only in-memory or temporary-directory fakes. They must not open a browser, write the pasteboard, invoke a live CLI, read the user's defaults, contact GitHub/providers, or mutate live Keychain/config/daemon/posting state.
- `NeonDiffDesktopAppCore` imports Foundation, Combine, and `NeonDiffDesktopCore`; it must not import AppKit, SwiftUI, Sparkle, Security, or XCTest.
- AppCore's executable-facing API uses Swift `package` access. Do not turn the model and its roughly 80 view-facing members into a public SDK commitment.
- AppKit adapters and the production composition root remain under `Sources/NeonDiffDesktop` and are not exported from AppCore.
- Every assertion currently in `Checks/NeonDiffDesktopModelChecks/main.swift` must have a named real-test replacement before that harness or `scripts/run-model-checks.sh` is removed. Record the mapping in the PR description.
- Keep production secret-corpus and evaluation-fixture leakage scans. Add AppCore objects/modules and the release app bundle to their inputs; do not narrow existing scan inputs.
- No fixture content, fake implementations, `--ui-testing` hooks, XCTest symbols, or test-only environment values may appear in a release executable or release app bundle.
- Do not claim hosted XCUITest, `.xcresult`, full-Xcode, signed/notarized distribution, Sparkle update, browser/native parity, or GA from a Command Line Tools build.
- #516 remains open and `owner-gated` until the full-Xcode task has actual `xcodebuild` and `.xcresult` evidence.
- Command Line Tools 6.2.4 contains Apple's signed `Testing.framework` but does not add its framework directory to SwiftPM automatically. Task 2 adds a wrapper that supplies the installed compiler/linker/rpath flags only when a direct `import Testing` probe fails; no external package is added. Every filtered file declares a correspondingly named `@Suite`. Run test discovery and require at least one matching identifier; a zero-test exit is not proof.
- Unless a command block explicitly changes directory, Tasks 1–5 run from `apps/neondiff-desktop`; Task 6 and Task 8 validation blocks run from the repository root. Every command that crosses that boundary uses `--package-path` or an absolute repo-relative path.

---

### Task 1: Add importable target and failing test-target skeletons

**Files:**
- Modify: `apps/neondiff-desktop/Package.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/NeonDiffDesktopAppCoreModule.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/CoreImportTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/AppCoreImportTests.swift`

**Interfaces:**
- Produces library product and target `NeonDiffDesktopAppCore` depending only on `NeonDiffDesktopCore`.
- Produces `.testTarget` entries `NeonDiffDesktopCoreTests` and `NeonDiffDesktopAppCoreTests`.
- Makes the executable depend on `NeonDiffDesktopAppCore`, `NeonDiffDesktopCore`, and Sparkle.

- [ ] **Step 1: Write import tests before defining the AppCore symbols**

```swift
import Testing
@testable import NeonDiffDesktopCore

@Suite struct CoreImportTests {
    @Test func moduleIsImportable() {
        #expect(NeonDiffCommandBuilder.configInspect(
            cliPath: "neondiff",
            configPath: "fixture.json"
        ).commandLine.contains("config inspect"))
    }
}
```

```swift
import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct AppCoreImportTests {
    @Test func moduleIsImportable() {
        #expect(NeonDiffDesktopAppCoreModule.contractVersion == 1)
    }
}
```

`NeonDiffDesktopAppCoreModule` deliberately does not exist yet, so the red test proves the new module contract rather than committing a test that depends on future fakes.

- [ ] **Step 2: Run the focused tests and confirm the expected missing-target failures**

Run from `apps/neondiff-desktop`:

```bash
pwd
framework_path=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" --filter CoreImportTests
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" --filter AppCoreImportTests
```

Expected: Core import test may compile; AppCore test fails because `NeonDiffDesktopAppCore` and `NeonDiffDesktopAppCoreModule` do not exist. A successful AppCore test before the target exists is not acceptable evidence.

- [ ] **Step 3: Add the products and targets**

Add to `Package.swift`:

```swift
.library(name: "NeonDiffDesktopAppCore", targets: ["NeonDiffDesktopAppCore"])
```

```swift
.target(
    name: "NeonDiffDesktopAppCore",
    dependencies: ["NeonDiffDesktopCore"]
),
.testTarget(
    name: "NeonDiffDesktopCoreTests",
    dependencies: ["NeonDiffDesktopCore"]
),
.testTarget(
    name: "NeonDiffDesktopAppCoreTests",
    dependencies: ["NeonDiffDesktopAppCore", "NeonDiffDesktopCore"]
)
```

Add `"NeonDiffDesktopAppCore"` to the executable dependencies. Do not move the model in this step; the target skeleton should compile independently first.

- [ ] **Step 4: Define only the green module marker**

Create only `package enum NeonDiffDesktopAppCoreModule { package static let contractVersion = 1 }`. The dependency protocol types and `DesktopAppDependencies` do not exist until Task 2, so Task 1 cannot reference them. Do not add `.standard`, `.shared`, `FileManager.default`, or a real CLI client to the marker target.

- [ ] **Step 5: Run target-level compilation**

```bash
swift build --target NeonDiffDesktopCore
swift build --target NeonDiffDesktopAppCore
framework_path=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" --filter CoreImportTests
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" --filter AppCoreImportTests
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" list | rg 'CoreImportTests|AppCoreImportTests'
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path"
```

Expected: exit 0 and discovery output contains at least one test from each named `@Suite`.

- [ ] **Step 6: Commit Task 1**

```bash
git add apps/neondiff-desktop/Package.swift \
  apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/NeonDiffDesktopAppCoreModule.swift \
  apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/CoreImportTests.swift \
  apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/AppCoreImportTests.swift
git commit -m "test(desktop): add AppCore and Swift test targets"
```

### Task 2: Define deterministic operating-system seams and test fakes

**Files:**
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/DesktopAppDependencies.swift`
- Create: `apps/neondiff-desktop/scripts/run-swift-tests.sh`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopClipboard.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopURLOpener.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopCLIExecuting.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopDashboardLaunching.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopPreferences.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopClock.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopFileWriting.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Dependencies/DesktopProviderVerifying.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/FoundationProviderVerifier.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/Support/RecordingDesktopDependencies.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/DesktopAppDependenciesTests.swift`

**Interfaces:**

```swift
package protocol DesktopClipboard: Sendable {
    @MainActor func write(_ string: String) -> Bool
}

package protocol DesktopURLOpener: Sendable {
    @MainActor func open(_ url: URL) -> Bool
}

package protocol DesktopCLIExecuting: Sendable {
    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult
}

package protocol DesktopDashboardLaunching: Sendable {
    func launch(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL?
    ) async throws -> CLILaunchResult
}

package protocol DesktopPreferences: Sendable {
    func string(forKey key: String) -> String?
    func bool(forKey key: String) -> Bool
    func set(_ value: String, forKey key: String)
    func set(_ value: Bool, forKey key: String)
}

package protocol DesktopClock: Sendable {
    var now: Date { get }
    func sleep(for duration: Duration) async throws
}

package protocol DesktopFileWriting: Sendable {
    var applicationSupportDirectory: URL { get }
    func write(_ data: Data, to url: URL) throws
}

package protocol DesktopProviderVerifying: Sendable {
    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot
}
```

Keychain and GitHub service interfaces continue to come from Core. `DesktopAppDependencies` stores these eight seams plus `DesktopSecretStoring` and `GitHubDesktopAuthenticating`; provider verification is required, never an optional concrete service. Its live adapter constructs `ProviderVerificationService` with the current `executablePath`, so changing `cliPath` cannot leave verification bound to startup state. CLI execution and detached dashboard launch stay separate so tests can prove that ordinary commands cannot accidentally take the detached-launch path.

- [ ] **Step 1: Write failing seam tests**

Test that:

- `RecordingClipboard` records exactly one redacted string, returns a scripted Bool, and never touches `NSPasteboard`; the model preserves current status behavior when the Bool is false.
- `RecordingURLOpener` records the URL and can return `false`.
- `RecordingCLIExecutor` records executable, argv, bounded stdin, timeout, and scripted result.
- `RecordingDashboardLauncher` records only detached launches.
- `MemoryPreferences` is suite-independent and starts empty.
- `TestClock` advances only when instructed; polling tests do not sleep wall-clock time.
- `TemporaryFileWriter` rejects writes outside its injected root and records exact bytes/paths.
- `RecordingProviderVerifier` records the current executable path and verification metadata while never retaining or exposing the secret read by the Core service.

```swift
@Suite struct DesktopAppDependenciesTests {
    @Test func CLIAndDashboardAreDistinctCapabilities() async throws {
        let recorder = RecordingDesktopDependencies()
        _ = try await recorder.cli.run(
            executablePath: "fixture-neondiff",
            arguments: ["daemon", "status"],
            standardInput: nil,
            timeout: 15
        )
        #expect(recorder.cli.calls.count == 1)
        #expect(recorder.dashboard.calls.isEmpty)
    }
}
```

- [ ] **Step 2: Run and observe missing-protocol failures**

```bash
framework_path=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
swift test -Xswiftc -F -Xswiftc "$framework_path" -Xlinker -F -Xlinker "$framework_path" -Xlinker -rpath -Xlinker "$framework_path" --filter DesktopAppDependenciesTests
```

Expected: FAIL with unresolved dependency protocols and recording fakes.

- [ ] **Step 3: Implement the eight protocols exactly as declared above, the required dependency initializer, and the portable test wrapper**

Put each declared protocol in its named file. Store one value for each of the eight protocols plus `DesktopSecretStoring` and `GitHubDesktopAuthenticating` in `DesktopAppDependencies`; require all ten values in its `package init`. Use actor/lock-backed fakes so Swift 6 concurrency checking remains enabled. The production types must contain no AppKit references. Keep `standardInput` in the CLI protocol because provider secrets must stay off argv and environment.

`scripts/run-swift-tests.sh` must execute plain `swift test "$@"` when `swift -e 'import Testing'` succeeds. Otherwise it must require the existing Apple CLT framework directory and execute:

```bash
framework_path=/Library/Developer/CommandLineTools/Library/Developer/Frameworks
exec swift test \
  -Xswiftc -F -Xswiftc "$framework_path" \
  -Xlinker -F -Xlinker "$framework_path" \
  -Xlinker -rpath -Xlinker "$framework_path" \
  "$@"
```

The wrapper fails closed if `Testing.framework` is absent. It does not download a package, mutate Xcode selection, or alter global toolchain configuration. All later SwiftPM test commands use this wrapper.

Mark it executable and verify the mode before any direct invocation:

```bash
chmod +x scripts/run-swift-tests.sh
test -x scripts/run-swift-tests.sh
```

Also implement `FoundationProviderVerifier` in the executable adapters. Its initializer requires the same `DesktopSecretStoring` instance later passed to `DesktopAppDependencies`. For every `verify` call it constructs `ProviderVerificationService` with a fresh `NeonDiffCLIClient` using that call's `executablePath` and `NeonDiffCLIResolver.defaultWorkingDirectory()`, then forwards to `verifyCancellable`. It stores no secret or CLI client and therefore cannot remain bound to an earlier `cliPath`.

- [ ] **Step 4: Implement bounded deterministic fakes under Tests only**

`TemporaryFileWriter.write` must standardize the destination URL and require it to remain below the injected root. Recording errors expose fixed messages and never interpolate stdin or secret values.

- [ ] **Step 5: Run AppCore seam tests and a forbidden-import check**

```bash
scripts/run-swift-tests.sh --filter DesktopAppDependenciesTests
if rg -n '^(import (AppKit|SwiftUI|Sparkle|Security|XCTest))$|NSPasteboard|NSWorkspace|FileManager\.default|UserDefaults\.standard' \
  Sources/NeonDiffDesktopAppCore; then
  echo 'forbidden AppCore OS dependency' >&2
  exit 1
fi
```

Expected: tests pass and `rg` returns no matches.

- [ ] **Step 6: Commit Task 2**

```bash
git add apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/FoundationProviderVerifier.swift \
  apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests \
  apps/neondiff-desktop/scripts/run-swift-tests.sh
git commit -m "refactor(desktop): define injectable AppCore dependencies"
```

### Task 3: Move the model into AppCore and compose all live adapters atomically

**Files:**
- Move: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Models/NeonDiffDesktopModel.swift` → `apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore/Models/NeonDiffDesktopModel.swift`
- Modify: every Swift file under `apps/neondiff-desktop/Sources/NeonDiffDesktop/Views/` that references `NeonDiffDesktopModel`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/NeonDiffDesktopModelConstructionTests.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/AppKitClipboard.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/AppKitURLOpener.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/FoundationDesktopCLIExecutor.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/FoundationDesktopDashboardLauncher.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/UserDefaultsDesktopPreferences.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/ContinuousDesktopClock.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters/ApplicationSupportFileWriter.swift`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopCompositionRoot.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProductionBoundaryContractTests.swift`

**Interfaces:**
- `@MainActor package final class NeonDiffDesktopModel: ObservableObject` is available to the executable target without becoming public API.
- Model initialization requires `DesktopAppDependencies`; it has no default OS collaborators.
- Existing asynchronous lifecycle, latest-request, cleanup-latch, and patch-proof ownership remain in the moved model for this behavior-preserving extraction. A later coordinator split requires its own failing tests and is not smuggled into the module move.

- [ ] **Step 1: Write a failing construction test**

```swift
@MainActor
@Suite struct NeonDiffDesktopModelConstructionTests {
    @Test func constructingModelReadsOnlyInjectedState() {
        let fixture = RecordingDesktopDependencies()
        fixture.preferences.values["neondiff.configPath"] = "fixture/config.json"
        let model = NeonDiffDesktopModel(dependencies: fixture.dependencies)

        #expect(model.configPath == "fixture/config.json")
        #expect(fixture.clipboard.values.isEmpty)
        #expect(fixture.urls.isEmpty)
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.dashboard.calls.isEmpty)
    }
}
```

- [ ] **Step 2: Move the model first and confirm AppKit compile failures**

Run:

```bash
scripts/run-swift-tests.sh --filter NeonDiffDesktopModelConstructionTests
```

Expected: FAIL because the moved model still imports AppKit and directly references `NSPasteboard`, `NSWorkspace`, `UserDefaults`, `Date`, `FileManager`, `Data.write`, and concrete CLI/dashboard clients.

- [ ] **Step 3: Replace direct OS calls with dependencies**

Apply these exact substitutions:

- `UserDefaults` reads/writes → `dependencies.preferences`.
- `NSPasteboard.general` → `dependencies.clipboard`.
- `NSWorkspace.shared.open` → `dependencies.urlOpener`.
- `Task.detached { NeonDiffCLIClient(...).run(...) }` → `dependencies.cli.run(...)`, preserving off-main execution and returning the result to the existing MainActor completion path.
- detached dashboard process construction → `dependencies.dashboard.launch(...)`, preserving the existing status/result mapping.
- `Date()` and wall-clock `Task.sleep` in GitHub expiry/polling → `dependencies.clock.now` and `dependencies.clock.sleep(for:)`.
- `FileManager.default` and `Data.write` for provider/control-center/repository patches → `dependencies.files.applicationSupportDirectory` and `dependencies.files.write`.
- optional/concrete provider-service fallback → required `dependencies.providerVerifier.verify(executablePath:...)`, passing the current `cliPath` on every request.

Keep existing command builders, parsers, Keychain contracts, GitHub service contracts, redactors, compare-and-swap revision checks, and provider cleanup generation counters. Do not convert a guarded operation into fire-and-forget work.

- [ ] **Step 4: Preserve state-machine ownership while replacing only effect calls**

Keep request/context generations, provider cancellation, `PendingProviderPatchProof`, control-center operation identity, and GitHub latest-request ownership in their current lexical order inside `NeonDiffDesktopModel`. The injected CLI/dashboard protocols return existing Core result types and must not retain raw provider keys, GitHub tokens, stdin, or unredacted child-process errors. Add targeted tests showing unrelated/rejected completions still cannot consume active ownership before moving any of those private state machines to another file.

- [ ] **Step 5: Import AppCore from executable views**

Add `import NeonDiffDesktopAppCore` only where the model or AppCore-owned types are referenced. Leave `NeonDiffDesktopCore` imports where views use Core value types. Do not move views, theme, `NeonWindowConfigurator`, `NeonUpdateController`, or `AppDelegate` into AppCore.

- [ ] **Step 6: Add executable-only adapters and the production composition root before any green build claim**

```swift
@MainActor
enum NeonDiffDesktopCompositionRoot {
    static func makeModel() -> NeonDiffDesktopModel {
        let keychain = KeychainSecretStore()
        NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: AppKitClipboard(),
            urlOpener: AppKitURLOpener(),
            cli: FoundationDesktopCLIExecutor(),
            dashboard: FoundationDesktopDashboardLauncher(),
            preferences: UserDefaultsDesktopPreferences(.standard),
            clock: ContinuousDesktopClock(),
            files: ApplicationSupportFileWriter(),
            keychain: keychain,
            githubAuth: GitHubDeviceAuthClient(),
            providerVerifier: FoundationProviderVerifier(keychain: keychain)
        ))
    }
}
```

- [ ] **Step 7: Add a failing source-boundary test**

The test reads the AppCore source directory relative to `#filePath` and asserts the forbidden import/singleton tokens are absent. It also asserts each concrete adapter exists below `Sources/NeonDiffDesktop/Adapters`, not AppCore.

- [ ] **Step 8: Implement adapters as thin translations**

Adapters contain no product state machine. `ApplicationSupportFileWriter` standardizes destinations, creates only the `NeonDiffDesktop` application-support directory, and performs atomic writes. CLI adapters wrap existing Core client APIs and preserve bounded stdin. `FoundationProviderVerifier` constructs `ProviderVerificationService` from the request's current executable path, injected Keychain store, and a fresh Core CLI client. Clock sleep uses `ContinuousClock`, while `now` uses a single wall-clock source for token expiry comparisons. `AppKitClipboard.write` returns the existing `NSPasteboard.setString` Bool without introducing a new thrown-error state.

- [ ] **Step 9: Make the app construct the model through the composition root**

Replace:

```swift
@StateObject private var model = NeonDiffDesktopModel()
```

with:

```swift
@StateObject private var model: NeonDiffDesktopModel

init() {
    _model = StateObject(wrappedValue: NeonDiffDesktopCompositionRoot.makeModel())
}
```

No view may instantiate a production dependency.

- [ ] **Step 10: Run boundary and build proof**

```bash
scripts/run-swift-tests.sh --filter ProductionBoundaryContractTests
scripts/run-swift-tests.sh list | rg 'NeonDiffDesktopModelConstructionTests|ProductionBoundaryContractTests'
swift build -c debug --product NeonDiffDesktop
swift build -c release --product NeonDiffDesktop
```

Expected: tests/builds pass. AppCore has zero forbidden tokens.

- [ ] **Step 11: Commit the atomic model move and live composition**

```bash
git add apps/neondiff-desktop/Sources/NeonDiffDesktop/Adapters \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/App \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/Views \
  apps/neondiff-desktop/Sources/NeonDiffDesktopAppCore \
  apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/NeonDiffDesktopModelConstructionTests.swift \
  apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProductionBoundaryContractTests.swift
git commit -m "refactor(desktop): move model into AppCore"
```

### Task 4: Migrate every model compile-harness assertion into real AppCore tests

**Files:**
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProviderVisualFixtureTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProviderKeyScopingTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProviderVerificationStateMachineTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ProviderConfigurationPatchTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/GitHubAuthorizationTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ConfigurationControlCenterTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests/ModelHarnessMigrationLedgerTests.swift`
- Delete only after migration passes: `apps/neondiff-desktop/Checks/NeonDiffDesktopModelChecks/main.swift`
- Delete only after migration passes: `apps/neondiff-desktop/scripts/run-model-checks.sh`
- Modify only after migration passes: `apps/neondiff-desktop/Package.swift`
- Modify only after migration passes: `.github/workflows/swift-desktop-gate.yml`

**Migration ledger:**

Before editing, record the exact source assertions:

```bash
rg -n 'check\(' apps/neondiff-desktop/Checks/NeonDiffDesktopModelChecks/main.swift \
  > "$TMPDIR/neondiff-model-harness-assertions.txt"
```

For every line in that inventory, add a named `#expect` or `#require` in the real test files and include the old assertion message verbatim as a trailing comment. `ModelHarnessMigrationLedgerTests` reads the checked-in migration ledger fixture and fails if any old message is unmapped or duplicated. Do not satisfy the ledger with a string-only list: each mapping names a concrete test function.

- [ ] **Step 1: Port fixture construction, not production shortcuts**

Move `MemorySecretStore`, scripted CLI/provider verification behavior, loaded revision fixtures, and async wait helpers into `Tests/NeonDiffDesktopAppCoreTests/Support`. They may not be compiled into production targets. Replace polling wall-clock waits with `TestClock` or explicit continuations.

- [ ] **Step 2: Port visual-fixture and provider-key-scope assertions**

Cover the existing guarantees:

- saved registry selection and display metadata;
- API-key eligibility and selected-provider binding;
- provider B never reuses provider A or legacy unscoped key state;
- provider B's secret is the only stdin value for provider B verification;
- clearing a key deletes only the selected provider account;
- invalid provider identifiers fail closed with fixed redacted errors.

Run:

```bash
scripts/run-swift-tests.sh --filter ProviderVisualFixtureTests
scripts/run-swift-tests.sh --filter ProviderKeyScopingTests
```

Expected before production adjustments: FAIL on missing migrated helpers; after porting: pass without Keychain prompts.

- [ ] **Step 3: Port the provider verification state machine**

Cover healthy, configured-unverified, blocked, wrong-provider, wrong-command, transport failure, concurrent click, stdin-only secret, config/provider/key mutation cancellation, cleanup timeout/restart latch, stale completion rejection, editing lockout, and retry blocking. Assert raw fixture secrets are absent from model reflection, errors, status, command lines, and recorded argv.

```swift
@MainActor
@Suite struct ProviderVerificationStateMachineTests {
    @Test func concurrentVerifyClicksLaunchOneStdinOnlyOperation() async throws {
        let fixture = ProviderModelFixture.blockedCLI()
        fixture.model.verifyProviderKey()
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)
        #expect(fixture.cli.calls.count == 1)
        #expect(fixture.cli.calls[0].arguments.joined().contains(fixture.secret) == false)
        #expect(fixture.cli.calls[0].standardInput == Data(fixture.secret.utf8))
    }
}
```

- [ ] **Step 4: Port provider/config compare-and-swap and ownership assertions**

Cover loaded revision, dirty edit, exact preview, confirmed apply, readback, verification invalidation after live config write, active patch progress, unrelated completion rejection, rejected overlap, and exact owning response consumption. Preserve the current `PendingProviderPatchProof` ownership semantics.

- [ ] **Step 5: Add deterministic tests for newly injected GitHub/clock/file seams**

Cover token-expiry thresholds at exact injected times, refresh expiry, device polling interval changes without wall-clock sleep, URL-opening failure, clipboard failure, preferences persistence, application-support path selection, atomic patch bytes, out-of-root write rejection, CLI failure redaction, and detached-dashboard launch separation.

- [ ] **Step 6: Run the migration ledger and full AppCore target**

```bash
scripts/run-swift-tests.sh --filter ModelHarnessMigrationLedgerTests
scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests
```

Expected: all old assertion messages map exactly once to passing real tests. No test accesses live OS state.

- [ ] **Step 7: Delete the model compile harness only after Step 6 passes**

Remove the harness source, runner script, any Package target used only by that harness, and the workflow invocation `./scripts/run-model-checks.sh`. Replace it with:

```bash
scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests
```

Run this guard:

```bash
test ! -e Checks/NeonDiffDesktopModelChecks/main.swift
test ! -e scripts/run-model-checks.sh
! rg -n 'NeonDiffDesktopModelChecks|run-model-checks' Package.swift scripts .github/workflows
scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests
```

- [ ] **Step 8: Commit Task 4**

```bash
git add apps/neondiff-desktop/Tests/NeonDiffDesktopAppCoreTests \
  apps/neondiff-desktop/Checks/NeonDiffDesktopModelChecks \
  apps/neondiff-desktop/scripts/run-model-checks.sh \
  apps/neondiff-desktop/Package.swift \
  .github/workflows/swift-desktop-gate.yml
git commit -m "test(desktop): migrate model harness to AppCore tests"
```

### Task 5: Migrate Core checks into `NeonDiffDesktopCoreTests`

**Files:**
- Split assertions from the retired monolithic Core checks entrypoint.
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/CommandBuilderTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/ConfigParsingTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/GitHubDeviceAuthTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/ProviderRegistryTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/ProviderVerificationServiceTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/RedactorTests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/CoreChecksMigrationLedgerTests.swift`
- Delete the retired monolithic Core checks entrypoint after complete migration.
- Modify: `apps/neondiff-desktop/Package.swift`
- Modify: `.github/workflows/swift-desktop-gate.yml`

- [ ] **Step 1: Inventory CoreChecks assertions and group them by public API**

```bash
rg -n 'context\.expect\(' Tests/NeonDiffDesktopCoreTests/Support/*.swift \
  > "$TMPDIR/neondiff-core-check-assertions.txt"
```

The migration ledger follows the same concrete-test-function rule as Task 4. Keep `NeonDiffDesktopCoreSmoke`, Keychain compile checks, fixture checks, appcast checks, and appcast dry-run targets: they exercise distinct executable/artifact contracts and are not silently replaced by unit tests.

- [ ] **Step 2: Write the real Core tests in failing-first slices**

For each group, first add imports and assertions, run its filter, observe the failure if visibility or injection is missing, then make the smallest Core change needed. Do not make internal APIs public solely for tests; use `@testable import NeonDiffDesktopCore`.

```bash
scripts/run-swift-tests.sh --filter CommandBuilderTests
scripts/run-swift-tests.sh --filter ConfigParsingTests
scripts/run-swift-tests.sh --filter GitHubDeviceAuthTests
scripts/run-swift-tests.sh --filter ProviderRegistryTests
scripts/run-swift-tests.sh --filter ProviderVerificationServiceTests
scripts/run-swift-tests.sh --filter RedactorTests
```

- [ ] **Step 3: Prove secret transport and parser strictness in real tests**

Require provider stdin stays out of argv/errors, only exact redacted envelopes parse, contradictory process/result state fails, known nonhealthy states remain visible but unverified, and fixture secrets are absent from retained structures.

- [ ] **Step 4: Delete only the migrated monolithic executable target**

```bash
scripts/run-swift-tests.sh --filter CoreChecksMigrationLedgerTests
scripts/run-swift-tests.sh --filter NeonDiffDesktopCoreTests
```

After both pass, remove the retired monolithic executable target from `Package.swift` and replace its workflow command with `scripts/run-swift-tests.sh --filter NeonDiffDesktopCoreTests`.

- [ ] **Step 5: Commit Task 5**

```bash
git add apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests \
  apps/neondiff-desktop/Tests/NeonDiffDesktopCoreTests/Support \
  apps/neondiff-desktop/Package.swift \
  .github/workflows/swift-desktop-gate.yml
git commit -m "test(desktop): migrate Core checks to Swift tests"
```

### Task 6: Preserve and expand release-artifact leakage gates

**Files:**
- Modify: `.github/workflows/swift-desktop-gate.yml`
- Modify: `scripts/check-desktop-fixture-boundary.mjs`
- Modify: `scripts/check-secret-corpus-boundary.mjs`
- Modify: `tests/desktop-fixture-boundary.test.ts`
- Modify: `tests/secret-corpus-boundary.test.ts`
- Modify if inputs are assembled there: `apps/neondiff-desktop/script/build_and_run.sh`

**Required release scan inputs:**

- debug and release `NeonDiffDesktop` executables;
- debug and release `NeonDiffDesktopCore.build`;
- debug and release `NeonDiffDesktopAppCore.build`;
- debug and release Core/AppCore `.swiftmodule` directories;
- the independently built `dist-release/NeonDiffDesktop.app`;
- release bundle resources and embedded frameworks.

- [ ] **Step 1: Add failing scanner tests for AppCore leakage**

Create fixture artifacts containing representative test-only markers such as `RecordingDesktopDependencies`, `--ui-testing`, `NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE`, `VisualProofDesktopDependencies`, `VisualProofSecretStore`, and a fixture-catalog marker. Assert each is rejected when placed in an AppCore object/module or release app, while a clean artifact passes. Construct token-shaped negative fixtures from fragments so the repository secret scan itself remains clean.

- [ ] **Step 2: Run focused scanner tests and confirm missing AppCore coverage**

```bash
npx vitest run tests/desktop-fixture-boundary.test.ts tests/secret-corpus-boundary.test.ts \
  --pool=forks --maxWorkers=1
```

Expected: FAIL until the scanners/workflow include the new target surfaces.

- [ ] **Step 3: Expand scanner inputs without weakening existing checks**

Use canonicalized, symlink-safe paths and retain the existing escape checks. Missing expected AppCore build/module paths fail closed after AppCore exists; they must not silently skip.

- [ ] **Step 4: Build and scan exact debug/release artifacts**

```bash
cd "$(git rev-parse --show-toplevel)"
npm run build
swift build --package-path apps/neondiff-desktop -c debug --product NeonDiffDesktop
swift build --package-path apps/neondiff-desktop -c release --product NeonDiffDesktop
NEONDIFF_DESKTOP_DIST_DIR="$PWD/apps/neondiff-desktop/dist-release" \
  apps/neondiff-desktop/script/build_and_run.sh release-bundle-check
debug_bin="$(swift build --package-path apps/neondiff-desktop -c debug --show-bin-path)"
release_bin="$(swift build --package-path apps/neondiff-desktop -c release --show-bin-path)"
npm run check:secret-corpus-boundary -- \
  "$debug_bin/NeonDiffDesktop" \
  "$release_bin/NeonDiffDesktop" \
  "$debug_bin/NeonDiffDesktopCore.build" \
  "$release_bin/NeonDiffDesktopCore.build" \
  "$debug_bin/NeonDiffDesktopAppCore.build" \
  "$release_bin/NeonDiffDesktopAppCore.build" \
  "$debug_bin/Modules/NeonDiffDesktopCore.swiftmodule" \
  "$release_bin/Modules/NeonDiffDesktopCore.swiftmodule" \
  "$debug_bin/Modules/NeonDiffDesktopAppCore.swiftmodule" \
  "$release_bin/Modules/NeonDiffDesktopAppCore.swiftmodule"
npm run check:desktop-fixture-boundary -- \
  "$release_bin/NeonDiffDesktop" \
  "$release_bin/NeonDiffDesktopAppCore.build" \
  "$release_bin/Modules/NeonDiffDesktopAppCore.swiftmodule" \
  "$PWD/apps/neondiff-desktop/dist-release/NeonDiffDesktop.app"
```

Expected: every command exits 0; release artifact scan reports zero violations.

- [ ] **Step 5: Commit Task 6**

```bash
git add .github/workflows/swift-desktop-gate.yml \
  scripts/check-desktop-fixture-boundary.mjs \
  scripts/check-secret-corpus-boundary.mjs \
  tests/desktop-fixture-boundary.test.ts \
  tests/secret-corpus-boundary.test.ts \
  apps/neondiff-desktop/script/build_and_run.sh
git commit -m "test(desktop): scan AppCore release boundaries"
```

### Task 7: Add hosted XCUITest structure under full Xcode, with an explicit owner gate

**Prerequisite gate:**

This task must not begin until full Xcode fits on the machine and is installed. Storage cleanup/offload requires separate path-level owner approval. No Homebrew XCTest package is needed.

```bash
test -d /Applications/Xcode.app
sudo xcode-select -s /Applications/Xcode.app/Contents/Developer
sudo xcodebuild -runFirstLaunch
xcodebuild -version
xcrun simctl help >/dev/null
```

Expected: selected developer directory is `/Applications/Xcode.app/Contents/Developer`; `xcodebuild -version` prints the recorded Xcode build. If any prerequisite fails, stop this task, preserve Tasks 1–6 proof, and report #516 as still owner-gated. Do not claim XCUITest from `swift test`.

**Files:**
- Modify: `apps/neondiff-desktop/Package.swift` to expose `NeonDiffDesktopEvaluationSupport` as a local package library product for the Xcode-hosted test build
- Create: `apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/project.pbxproj`
- Create: `apps/neondiff-desktop/NeonDiffDesktop.xcodeproj/xcshareddata/xcschemes/NeonDiffDesktop.xcscheme`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopUITests/NeonDiffDesktopUITests.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopUITests/UITestLaunchContract.swift`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktopUITests/Info.plist`
- Create: `apps/neondiff-desktop/Tests/NeonDiffDesktop.xctestplan`
- Create: `apps/neondiff-desktop/Sources/NeonDiffDesktop/App/DesktopEvaluationBootstrap.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopCompositionRoot.swift`
- Modify: `apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift`
- Modify: `.github/workflows/swift-desktop-gate.yml`

**Hosted target contract:**

- Application target: `NeonDiffDesktop`.
- UI test bundle: `NeonDiffDesktopUITests` with `TEST_TARGET_NAME = NeonDiffDesktop`.
- Shared scheme builds the app and hosted UI bundle. Core/AppCore tests run separately through SwiftPM.
- `NeonDiffDesktop.xctestplan` contains the hosted `Critical UI` configuration. Core/AppCore remain real SwiftPM test targets and run separately; do not claim they are inside the UI `.xcresult`.
- The UI test launch contract uses only the approved debug arguments: `--ui-testing`, `--ui-fixture <absolute-path>`, `--content-size <width>x<height>`, and `--disable-animations`.
- Release configuration excludes UI-test source, fixture resources, launch hooks, and test environment values.
- The Xcode app target may resolve the static `NeonDiffDesktopEvaluationSupport` package product, but every import/reference is inside `#if DEBUG`. Release dead-stripping plus the Task 6 binary/bundle scans must prove no fixture/parser marker reaches the release product; project metadata alone is not proof.

- [ ] **Step 1: Add one failing hosted smoke test**

```swift
final class NeonDiffDesktopUITests: XCTestCase {
    func testLaunchesBaselineFixtureAtRequestedContentSize() throws {
        let app = XCUIApplication()
        let fixture = try UITestLaunchContract.fixtureURL(named: "overview-ready")
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixture.path,
            "--content-size", "1280x800",
            "--disable-animations"
        ]
        app.launch()
        XCTAssertTrue(app.windows["NeonDiff Desktop"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.otherElements["desktop.overview.root"].exists)
    }
}
```

- [ ] **Step 2: Run the hosted test and confirm the expected missing-host/launch-hook failure**

```bash
set -o pipefail
xcodebuild test \
  -project NeonDiffDesktop.xcodeproj \
  -scheme NeonDiffDesktop \
  -testPlan NeonDiffDesktop \
  -configuration Debug \
  -destination 'platform=macOS' \
  -only-testing:NeonDiffDesktopUITests/NeonDiffDesktopUITests/testLaunchesBaselineFixtureAtRequestedContentSize \
  -resultBundlePath "$TMPDIR/NeonDiffDesktop-516-red.xcresult"
```

Expected: FAIL because the hosted target or approved launch injection is not yet wired. A test that passes by launching a separately rebuilt helper is invalid.

- [ ] **Step 3: Add the project, shared scheme, and test plan**

Reference the existing package products rather than duplicating Core/AppCore source membership. The app target is a macOS application product with the existing canonical bundle identifier `com.electricsheephq.NeonDiffDesktop`, deployment target 14.0, generated Info.plist plus existing app resources, and `CODE_SIGNING_ALLOWED=NO` for CI Debug tests. Because AppCore intentionally uses `package` access, set `OTHER_SWIFT_FLAGS=$(inherited) -package-name neondiff_desktop` on the Xcode app target, matching SwiftPM's package identity exactly. It links AppCore/Core/Sparkle and resolves the static evaluation-support product, but production source may import that product only under `#if DEBUG`. The UI target is a UI-testing bundle with `TEST_TARGET_NAME=NeonDiffDesktop`, a target dependency/TestTargetID pointing to the app, and `TEST_HOST` resolved from that target. The shared scheme's Test action references `NeonDiffDesktop.xctestplan`, whose Critical UI configuration selects only the hosted UI bundle. Core/AppCore tests run with `swift test` before `xcodebuild`; they are not represented as Xcode test targets or counted in the UI result bundle. Check all shared metadata into the repository.

Validate the host graph before proceeding:

```bash
xcodebuild -list -project NeonDiffDesktop.xcodeproj
xcodebuild -showBuildSettings \
  -project NeonDiffDesktop.xcodeproj \
  -scheme NeonDiffDesktop \
  -configuration Debug \
  | rg 'PRODUCT_BUNDLE_IDENTIFIER|PRODUCT_TYPE|TEST_HOST|TEST_TARGET_NAME|CODE_SIGNING_ALLOWED|OTHER_SWIFT_FLAGS'
xcodebuild build \
  -project NeonDiffDesktop.xcodeproj \
  -scheme NeonDiffDesktop \
  -configuration Debug \
  -destination 'platform=macOS' \
  CODE_SIGNING_ALLOWED=NO
```

Expected: the app and UI-test targets are listed; the app product type is application, the UI product type is UI testing bundle, TestTargetID/host resolve to the app, `OTHER_SWIFT_FLAGS` contains exactly one `-package-name neondiff_desktop`, the Debug app compiles against package-access AppCore, and CI signing is disabled for the test build.

- [ ] **Step 4: Wire only the minimum approved debug launch contract**

Use the strict fixture parser from the evaluation support lane. Construct recording dependencies before `NeonDiffDesktopModel` initialization, isolate preferences, disable restoration/animations, and never read live Keychain/config/network. Compile all launch-hook code behind `#if DEBUG`; release builds do not accept or contain the hook markers.

- [ ] **Step 5: Run real unit and hosted UI targets with `.xcresult` evidence**

```bash
rm -rf "$TMPDIR/NeonDiffDesktop-516.xcresult"
set -o pipefail
xcodebuild test \
  -project NeonDiffDesktop.xcodeproj \
  -scheme NeonDiffDesktop \
  -testPlan NeonDiffDesktop \
  -configuration Debug \
  -destination 'platform=macOS' \
  -resultBundlePath "$TMPDIR/NeonDiffDesktop-516.xcresult"
xcrun xcresulttool get test-results summary \
  --path "$TMPDIR/NeonDiffDesktop-516.xcresult"
ditto -c -k --sequesterRsrc --keepParent \
  "$TMPDIR/NeonDiffDesktop-516.xcresult" \
  "$TMPDIR/NeonDiffDesktop-516.xcresult.zip"
shasum -a 256 "$TMPDIR/NeonDiffDesktop-516.xcresult.zip"
```

Expected: zero failed hosted UI tests; the summary records the hosted UI count only. Core/AppCore counts come from the preceding `swift test` commands and remain separate evidence. Upload and hash the exact same zip archive. Record the Xcode version, UI count/duration, SwiftPM counts, and archive hash in issue/PR evidence without publishing secret-bearing local paths.

- [ ] **Step 6: Add the critical hosted smoke to macOS CI**

Add an `xcodebuild test` step on `macos-15`, archive the `.xcresult` with the exact `ditto` command from Step 5, and upload that exact hashed zip on success or failure with short retention and the head SHA in the artifact name. Keep `swift test` as the real-unit gate; hosted UI is additional, not a replacement.

- [ ] **Step 7: Re-run the release-boundary scans after hosted hooks exist**

Run every Task 6 command against a fresh release build. Expected: zero fixture/test-hook markers in the release executable, AppCore objects/modules, or app bundle.

- [ ] **Step 8: Commit Task 7**

```bash
git add apps/neondiff-desktop/NeonDiffDesktop.xcodeproj \
  apps/neondiff-desktop/Package.swift \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/App/DesktopEvaluationBootstrap.swift \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopCompositionRoot.swift \
  apps/neondiff-desktop/Sources/NeonDiffDesktop/App/NeonDiffDesktopApp.swift \
  apps/neondiff-desktop/Tests/NeonDiffDesktopUITests \
  apps/neondiff-desktop/Tests/NeonDiffDesktop.xctestplan \
  .github/workflows/swift-desktop-gate.yml
git commit -m "test(desktop): add hosted macOS UI target"
```

### Task 8: Run full exact-head validation and prepare current-truth evidence

**Files:**
- Modify if behavior or developer commands changed: `apps/neondiff-desktop/README.md`
- Modify: `apps/neondiff-desktop/docs/ui-evaluation.md`
- Modify: `docs/superpowers/specs/2026-07-10-neondiff-desktop-ga-ux-evaluation.md` only if the landed target names or commands differ from the approved contract

- [ ] **Step 1: Run focused Swift proof from a clean worktree**

```bash
pwd
git status --short
cd apps/neondiff-desktop
scripts/run-swift-tests.sh --filter NeonDiffDesktopCoreTests
scripts/run-swift-tests.sh --filter NeonDiffDesktopAppCoreTests
swift build -c debug --product NeonDiffDesktop
swift build -c release --product NeonDiffDesktop
swift run NeonDiffDesktopFixtureChecks
swift build --target NeonDiffDesktopKeychainChecks
```

Expected: all exit 0. No Keychain prompt, browser, network request, live CLI, or user-default mutation occurs.

- [ ] **Step 2: Run Node/action/release-boundary proof**

From repository root:

```bash
npm ci
npm run build
npx vitest run tests/desktop-fixture-boundary.test.ts tests/secret-corpus-boundary.test.ts \
  --pool=forks --maxWorkers=1
npm run check:secrets
actionlint .github/workflows/swift-desktop-gate.yml
cd apps/neondiff-desktop
script/build_and_run.sh build
script/build_and_run.sh bundle-check
NEONDIFF_DESKTOP_DIST_DIR="$PWD/dist-release" script/build_and_run.sh release-bundle-check
```

Expected: all exit 0; release bundle reports zero fixture/test leakage.

- [ ] **Step 3: Run full-Xcode proof only if Task 7's prerequisite is satisfied**

```bash
xcodebuild -version
xcodebuild test \
  -project apps/neondiff-desktop/NeonDiffDesktop.xcodeproj \
  -scheme NeonDiffDesktop \
  -testPlan NeonDiffDesktop \
  -configuration Debug \
  -destination 'platform=macOS' \
  -resultBundlePath "$TMPDIR/NeonDiffDesktop-516-final.xcresult"
```

If Xcode remains unavailable, explicitly report: “Core/AppCore real SwiftPM tests are proven; hosted XCUITest and `.xcresult` remain owner-gated and #516 is not complete.”

- [ ] **Step 4: Inspect the complete diff and migration ledgers**

```bash
git diff --check
git diff --stat origin/main...HEAD
! git diff origin/main...HEAD -- apps/neondiff-desktop/Sources/NeonDiffDesktop/Views \
  | rg '^[-+].*(Text\(|Label\(|font\(|foreground|background|frame\()'
```

Any visual/product-copy diff requires removal or a separately scoped issue. Confirm the model and Core assertion ledgers have no missing mappings.

- [ ] **Step 5: Push a PR and require exact-head evidence**

The PR description must include:

- exact head SHA;
- Core/AppCore test counts and commands;
- model/Core harness migration ledger totals;
- debug/release build proof;
- release-artifact scan result;
- full-Xcode version, hosted UI count, duration, and `.xcresult` hash, or the explicit owner gate;
- unchanged behavior/proof boundary;
- statement that #503, #116, #449, signed/notarized distribution, appcast update proof, browser/native parity, and v1.1 release remain unproven.

Wait for current-head CI, Swift desktop gate, CodeQL/security, evaOS review, human/bot threads, and independent spec/safety review. Resolve every actionable thread on the current head before merge. Do not use a stale approval or a prior-head run.

- [ ] **Step 6: Merge only when #516 acceptance is actually met**

Do not close #516 if Task 7 is owner-gated. If Tasks 1–6 land separately, describe that PR as the AppCore/unit-test foundation and leave the hosted target acceptance open. Close #516 only after the hosted target exists, full-Xcode tests pass, `.xcresult` evidence is recorded, all compile-harness assertions are migrated, release leakage scans pass, and post-merge `main` checks pass at the merge SHA.

- [ ] **Step 7: Verify post-merge `main`**

After merge, verify CI, Swift Desktop Gate, and CodeQL at the exact merge SHA. Update #514 and #516 with compact proof and the next child issue. This architecture enables #517/#518 geometry/accessibility work; it does not itself prove those gates or authorize broad redesign.
