import Combine
import Foundation
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

private final class FixtureLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func read<Result>(_ body: (Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(value) }
    }

    func update<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&value) }
    }
}

final class MemorySecretStore: DesktopSecretStoring, @unchecked Sendable {
    private let storage = FixtureLocked<[String: String]>([:])

    var values: [String: String] {
        get { storage.read { $0 } }
        set { storage.update { $0 = newValue } }
    }

    func setSecret(_ secret: String, account: String) throws {
        storage.update { $0[account] = secret }
    }

    func readSecret(account: String) throws -> String? {
        storage.read { $0[account] }
    }

    func containsSecret(account: String) -> Bool {
        storage.read { $0[account] != nil }
    }

    func deleteSecret(account: String) throws {
        _ = storage.update { $0.removeValue(forKey: account) }
    }
}

enum ProviderFixtureTransportError: Error, LocalizedError {
    case unavailable(String)

    var errorDescription: String? {
        switch self {
        case .unavailable(let message): message
        }
    }
}

struct ProviderFixtureCLICall: Equatable, Sendable {
    let arguments: [String]
    let standardInput: Data?
    let timeout: TimeInterval
}

final class ControlledProviderVerificationCLI: NeonDiffCLIClienting, @unchecked Sendable {
    private struct CallWaiter {
        let count: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    private struct State {
        var calls: [ProviderFixtureCLICall] = []
        var result: CLIRunResult
        var error: Error?
        var blocksUntilReleased: Bool
        var released = false
        var releaseContinuation: CheckedContinuation<Void, Never>?
        var callWaiters: [CallWaiter] = []
    }

    private let state: FixtureLocked<State>

    init(result: CLIRunResult, blocked: Bool = false) {
        state = FixtureLocked(State(result: result, blocksUntilReleased: blocked))
    }

    var calls: [ProviderFixtureCLICall] { state.read(\.calls) }

    var result: CLIRunResult {
        get { state.read(\.result) }
        set { state.update { $0.result = newValue } }
    }

    var error: Error? {
        get { state.read(\.error) }
        set { state.update { $0.error = newValue } }
    }

    func waitUntilCallCount(_ expectedCount: Int) async {
        if calls.count >= expectedCount { return }
        await withCheckedContinuation { continuation in
            let shouldResume = state.update { state -> Bool in
                guard state.calls.count < expectedCount else { return true }
                state.callWaiters.append(CallWaiter(count: expectedCount, continuation: continuation))
                return false
            }
            if shouldResume { continuation.resume() }
        }
    }

    func release() {
        let continuation = state.update { state -> CheckedContinuation<Void, Never>? in
            state.released = true
            defer { state.releaseContinuation = nil }
            return state.releaseContinuation
        }
        continuation?.resume()
    }

    func run(
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) throws -> CLIRunResult {
        record(arguments: arguments, standardInput: standardInput, timeout: timeout)
        return try scriptedOutcome()
    }

    func runCancellable(
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        record(arguments: arguments, standardInput: standardInput, timeout: timeout)
        if state.read(\.blocksUntilReleased) {
            await withCheckedContinuation { continuation in
                let shouldResume = state.update { state -> Bool in
                    guard !state.released else { return true }
                    state.releaseContinuation = continuation
                    return false
                }
                if shouldResume { continuation.resume() }
            }
        }
        try Task.checkCancellation()
        return try scriptedOutcome()
    }

    func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        throw ProviderFixtureTransportError.unavailable("provider verification must not launch a detached process")
    }

    private func record(arguments: [String], standardInput: Data?, timeout: TimeInterval) {
        let resumptions = state.update { state -> [CheckedContinuation<Void, Never>] in
            state.calls.append(ProviderFixtureCLICall(
                arguments: arguments,
                standardInput: standardInput,
                timeout: timeout
            ))
            let ready = state.callWaiters.filter { state.calls.count >= $0.count }
            state.callWaiters.removeAll { state.calls.count >= $0.count }
            return ready.map(\.continuation)
        }
        resumptions.forEach { $0.resume() }
    }

    private func scriptedOutcome() throws -> CLIRunResult {
        try state.read { state in
            if let error = state.error { throw error }
            return state.result
        }
    }
}

final class FixtureProviderVerifier: DesktopProviderVerifying, @unchecked Sendable {
    private let service: ProviderVerificationService

    init(secretStore: DesktopSecretStoring, cli: NeonDiffCLIClienting) {
        service = ProviderVerificationService(keychain: secretStore, cli: cli)
    }

    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        try await service.verifyCancellable(
            account: account,
            expectedProviderId: expectedProviderId,
            expectedConfigRevision: expectedConfigRevision,
            arguments: arguments,
            timeout: timeout
        )
    }
}

private final class CancellableBox {
    var cancellable: AnyCancellable?
}

@MainActor
struct ProviderModelFixture {
    static let loadedRevision = String(repeating: "a", count: 64)
    static let appliedRevision = String(repeating: "b", count: 64)

    let model: NeonDiffDesktopModel
    let cli: ControlledProviderVerificationCLI
    let keychain: MemorySecretStore
    let preferences: MemoryPreferences
    let clock: TestClock
    let fileWriter: TemporaryFileWriter

    let providerAAccount = "provider/zcode-glm/api-key"
    let providerASecret = "fixture-provider-value"
    let providerBAccount = "provider/provider-b/api-key"
    let providerBSecret = "fixture-provider-b-value"
    let providerBRevision = ProviderModelFixture.appliedRevision

    static func makeUnloaded(
        result: CLIRunResult? = nil,
        blocked: Bool = false
    ) throws -> ProviderModelFixture {
        try ProviderModelFixture(loadConfig: false, result: result, blocked: blocked)
    }

    static func makeLoaded(
        result: CLIRunResult? = nil,
        blocked: Bool = false
    ) throws -> ProviderModelFixture {
        try ProviderModelFixture(loadConfig: true, result: result, blocked: blocked)
    }

    private init(loadConfig: Bool, result: CLIRunResult?, blocked: Bool) throws {
        let keychain = MemorySecretStore()
        try keychain.setSecret(providerASecret, account: providerAAccount)
        let initialResult = result ?? Self.healthyResult(providerId: "zcode-glm", revision: Self.loadedRevision)
        let cli = ControlledProviderVerificationCLI(result: initialResult, blocked: blocked)
        let preferences = MemoryPreferences()
        let clock = TestClock(now: fixtureDate(secondsSince1970: 1_782_000_000))
        let fileWriter = TemporaryFileWriter(
            root: fixtureURL("/fixture/neondiff-app-support", directory: true)
        )
        let providerVerifier = FixtureProviderVerifier(secretStore: keychain, cli: cli)
        let dependencies = DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: clock,
            fileWriter: fileWriter,
            providerVerifier: providerVerifier,
            secretStore: keychain,
            githubAuthenticator: StubGitHubAuthenticator(),
            productionBoundary: .testVerified
        )

        self.keychain = keychain
        self.cli = cli
        self.preferences = preferences
        self.clock = clock
        self.fileWriter = fileWriter
        self.model = NeonDiffDesktopModel(dependencies: dependencies)

        if loadConfig {
            model.applyCLIResultForTesting(
                CLIRunResult(exitCode: 0, stdout: Self.providerConfigInspectJSON, stderr: ""),
                fallbackCommand: "config inspect",
                configPath: model.configPath,
                launchdLabel: model.launchdLabel,
                isConfigInspectCommand: true
            )
        }
    }

    func healthyResult(providerId: String, revision: String) -> CLIRunResult {
        Self.healthyResult(providerId: providerId, revision: revision)
    }

    static func healthyResult(providerId: String, revision: String) -> CLIRunResult {
        CLIRunResult(
            exitCode: 0,
            stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:00:00.000Z","providerId":"\#(providerId)","state":"healthy","mode":"openai_compatible_models","detail":"Verified with redacted metadata.","redacted":true,"troubleshooting":[],"configRevision":"\#(revision)"}"#,
            stderr: ""
        )
    }

    func applyProviderBReadback(_ provider: ProviderRegistryTarget) {
        let previewJSON = Self.providerPatchJSON(
            provider: provider,
            dryRun: true,
            wrote: false,
            revisionBefore: Self.loadedRevision,
            revisionAfter: Self.loadedRevision
        )
        model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: previewJSON, stderr: ""),
            mode: .preview
        )
        let applyJSON = Self.providerPatchJSON(
            provider: provider,
            dryRun: false,
            wrote: true,
            revisionBefore: Self.loadedRevision,
            revisionAfter: Self.appliedRevision
        )
        model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: applyJSON, stderr: ""),
            mode: .apply
        )
    }

    func waitForVerificationToFinish() async {
        guard model.isProviderVerificationInProgress else { return }
        let box = CancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$isProviderVerificationInProgress
                .filter { !$0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    func waitForConfigPatchToFinish() async {
        guard model.isConfigPatchInProgress else { return }
        let box = CancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$isConfigPatchInProgress
                .filter { !$0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    func waitForGitHubAuthorizationToFinish() async {
        guard model.isGitHubAuthorizationInProgress else { return }
        let box = CancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$isGitHubAuthorizationInProgress
                .filter { !$0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    func waitForGitHubRefreshToFinish() async {
        guard model.isGitHubRepositoryRefreshInProgress else { return }
        let box = CancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$isGitHubRepositoryRefreshInProgress
                .filter { !$0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    private static func providerPatchJSON(
        provider: ProviderRegistryTarget,
        dryRun: Bool,
        wrote: Bool,
        revisionBefore: String,
        revisionAfter: String
    ) -> String {
        #"{"ok":true,"command":"config patch","dryRun":\#(dryRun),"wrote":\#(wrote),"revisionBefore":"\#(revisionBefore)","revisionAfter":"\#(revisionAfter)","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"\#(provider.id)","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://provider.example/v1","model":"fixture-model","authMode":"api-key-env"},"\#(provider.id)":{"enabled":true,"adapter":"\#(provider.adapter)","displayName":"\#(provider.displayName)","baseUrl":"\#(provider.baseUrl)","model":"\#(provider.model)","authMode":"\#(provider.authMode)"}}}}}"#
    }

    private static let providerConfigInspectJSON = #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"pilotRepos":[],"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://provider.example/v1","model":"fixture-model","authMode":"api-key-env"}}},"desktop":{}}}"#
}

func healthyProviderSnapshot(
    providerId: String = "zcode-glm",
    revision: String = String(repeating: "a", count: 64)
) -> ProviderVerificationSnapshot {
    ProviderVerificationSnapshot(
        ok: true,
        command: "providers verify",
        providerId: providerId,
        checkedAt: "2026-07-10T12:00:00.000Z",
        state: .healthy,
        mode: "openai_compatible_models",
        detail: "Previously verified.",
        troubleshooting: [],
        configRevision: revision
    )
}
