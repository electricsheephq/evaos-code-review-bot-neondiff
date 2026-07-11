import Combine
import Foundation
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

func fixtureISO8601String(_ date: Date) -> String {
    ISO8601DateFormatter().string(from: date)
}

private final class ModelFixtureLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) { self.value = value }

    func read<Result>(_ body: (Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(value) }
    }

    func update<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&value) }
    }
}

final class ScriptedDesktopCLIExecutor: DesktopCLIExecuting, @unchecked Sendable {
    private struct Waiter {
        let count: Int
        let continuation: CheckedContinuation<Void, Never>
    }

    private struct State {
        var calls: [RecordedCLICall] = []
        var outcomes: [Result<CLIRunResult, Error>]
        var waiters: [Waiter] = []
    }

    private let state: ModelFixtureLocked<State>

    init(outcomes: [Result<CLIRunResult, Error>] = []) {
        state = ModelFixtureLocked(State(outcomes: outcomes))
    }

    var calls: [RecordedCLICall] { state.read(\.calls) }

    func enqueue(_ outcome: Result<CLIRunResult, Error>) {
        state.update { $0.outcomes.append(outcome) }
    }

    func waitUntilCallCount(_ expectedCount: Int) async {
        if calls.count >= expectedCount { return }
        await withCheckedContinuation { continuation in
            let shouldResume = state.update { state -> Bool in
                guard state.calls.count < expectedCount else { return true }
                state.waiters.append(Waiter(count: expectedCount, continuation: continuation))
                return false
            }
            if shouldResume { continuation.resume() }
        }
    }

    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        let (outcome, resumptions) = state.update { state -> (Result<CLIRunResult, Error>, [CheckedContinuation<Void, Never>]) in
            state.calls.append(RecordedCLICall(
                executablePath: executablePath,
                arguments: arguments,
                standardInput: standardInput,
                timeout: timeout
            ))
            let ready = state.waiters.filter { state.calls.count >= $0.count }
            state.waiters.removeAll { state.calls.count >= $0.count }
            let outcome = state.outcomes.isEmpty
                ? .success(CLIRunResult(exitCode: 0, stdout: "", stderr: ""))
                : state.outcomes.removeFirst()
            return (outcome, ready.map(\.continuation))
        }
        resumptions.forEach { $0.resume() }
        return try outcome.get()
    }
}

final class ScriptedGitHubAuthenticator: GitHubDesktopAuthenticating, @unchecked Sendable {
    private struct State {
        var deviceCode: GitHubDeviceAuthorizationCode
        var pollResults: [GitHubDeviceAuthorizationPollResult]
        var refreshedToken: GitHubUserToken
        var user: GitHubAuthenticatedUser
        var repositories: [GitHubDiscoveredRepository]
        var requestedClientIds: [String] = []
        var pollDeviceCodes: [String] = []
        var refreshTokens: [String] = []
        var fetchedAccessTokens: [String] = []
        var listedAccessTokens: [String] = []
    }

    private let state: ModelFixtureLocked<State>

    init(
        deviceCode: GitHubDeviceAuthorizationCode = GitHubDeviceAuthorizationCode(
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationURI: fixtureURL("https://github.com/login/device"),
            expiresAt: fixtureDate(secondsSince1970: 2_000_000_000),
            intervalSeconds: 2
        ),
        pollResults: [GitHubDeviceAuthorizationPollResult] = [],
        refreshedToken: GitHubUserToken = GitHubUserToken(accessToken: "fixture-refreshed-token"),
        user: GitHubAuthenticatedUser = GitHubAuthenticatedUser(login: "fixture-user"),
        repositories: [GitHubDiscoveredRepository] = []
    ) {
        state = ModelFixtureLocked(State(
            deviceCode: deviceCode,
            pollResults: pollResults,
            refreshedToken: refreshedToken,
            user: user,
            repositories: repositories
        ))
    }

    var requestedClientIds: [String] { state.read(\.requestedClientIds) }
    var pollDeviceCodes: [String] { state.read(\.pollDeviceCodes) }
    var refreshTokens: [String] { state.read(\.refreshTokens) }
    var fetchedAccessTokens: [String] { state.read(\.fetchedAccessTokens) }
    var listedAccessTokens: [String] { state.read(\.listedAccessTokens) }

    func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode {
        state.update { $0.requestedClientIds.append(clientId) }
        return state.read(\.deviceCode)
    }

    func pollDeviceAuthorization(
        clientId: String,
        deviceCode: String
    ) async throws -> GitHubDeviceAuthorizationPollResult {
        state.update { state in
            state.pollDeviceCodes.append(deviceCode)
            return state.pollResults.isEmpty
                ? .pending(intervalSeconds: 5)
                : state.pollResults.removeFirst()
        }
    }

    func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken {
        state.update { $0.refreshTokens.append(refreshToken) }
        return state.read(\.refreshedToken)
    }

    func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser {
        state.update { $0.fetchedAccessTokens.append(accessToken) }
        return state.read(\.user)
    }

    func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository] {
        state.update { $0.listedAccessTokens.append(accessToken) }
        return state.read(\.repositories)
    }
}

private final class ModelCancellableBox {
    var cancellable: AnyCancellable?
}

@MainActor
struct ModelDependencyFixture {
    let model: NeonDiffDesktopModel
    let clipboard: RecordingClipboard
    let urlOpener: RecordingURLOpener
    let cli: ScriptedDesktopCLIExecutor
    let dashboard: RecordingDashboardLauncher
    let preferences: MemoryPreferences
    let clock: TestClock
    let fileWriter: TemporaryFileWriter
    let secretStore: MemorySecretStore
    let githubAuthenticator: ScriptedGitHubAuthenticator

    init(
        root: URL = fixtureURL("/fixture/model-app-support", directory: true),
        now: Date = fixtureDate(secondsSince1970: 1_000_000),
        cliOutcomes: [Result<CLIRunResult, Error>] = [],
        clipboardResult: Bool = true,
        urlResult: Bool = true,
        githubAuthenticator: ScriptedGitHubAuthenticator = ScriptedGitHubAuthenticator()
    ) {
        clipboard = RecordingClipboard(result: clipboardResult)
        urlOpener = RecordingURLOpener(result: urlResult)
        cli = ScriptedDesktopCLIExecutor(outcomes: cliOutcomes)
        dashboard = RecordingDashboardLauncher()
        preferences = MemoryPreferences()
        clock = TestClock(now: now)
        fileWriter = TemporaryFileWriter(root: root)
        secretStore = MemorySecretStore()
        self.githubAuthenticator = githubAuthenticator
        model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: clipboard,
            urlOpener: urlOpener,
            cli: cli,
            dashboard: dashboard,
            preferences: preferences,
            clock: clock,
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secretStore,
            githubAuthenticator: githubAuthenticator
        ))
    }

    func loadConfig(_ json: String? = nil) {
        let json = json ?? Self.configInspectJSON
        model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: json, stderr: ""),
            fallbackCommand: "config inspect",
            configPath: model.configPath,
            launchdLabel: model.launchdLabel,
            isConfigInspectCommand: true
        )
    }

    func waitForConfigPatchToFinish() async {
        await waitUntilFalse(model.$isConfigPatchInProgress, current: model.isConfigPatchInProgress)
    }

    func waitForGitHubAuthorizationToFinish() async {
        await waitUntilFalse(model.$isGitHubAuthorizationInProgress, current: model.isGitHubAuthorizationInProgress)
    }

    func waitForGitHubRefreshToFinish() async {
        await waitUntilFalse(model.$isGitHubRepositoryRefreshInProgress, current: model.isGitHubRepositoryRefreshInProgress)
    }

    func waitForDashboardLaunch() async {
        guard model.dashboardProcessIdentifier == nil else { return }
        let box = ModelCancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$dashboardProcessIdentifier
                .compactMap { $0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    func waitForLastError() async {
        guard model.lastError == nil else { return }
        let box = ModelCancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = model.$lastError
                .compactMap { $0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    private func waitUntilFalse(
        _ publisher: Published<Bool>.Publisher,
        current: Bool
    ) async {
        guard current else { return }
        let box = ModelCancellableBox()
        await withCheckedContinuation { continuation in
            box.cancellable = publisher
                .filter { !$0 }
                .prefix(1)
                .sink { _ in
                    box.cancellable = nil
                    continuation.resume()
                }
        }
    }

    static func configPatchJSON(
        dryRun: Bool,
        wrote: Bool,
        revisionBefore: String = String(repeating: "a", count: 64),
        revisionAfter: String
    ) -> String {
        #"{"ok":true,"command":"config patch","dryRun":\#(dryRun),"wrote":\#(wrote),"revisionBefore":"\#(revisionBefore)","revisionAfter":"\#(revisionAfter)","config":{}}"#
    }

    static let configInspectJSON = #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"pilotRepos":[],"pollIntervalMs":90000,"skipDrafts":true,"reviewConcurrency":{"maxActiveRuns":1,"leaseTtlMs":900000},"reviewGate":{"maxInlineComments":25},"issueEnrichment":{"enabled":false,"postIssueComment":false,"allowlist":[],"maxIssuesPerCycle":5,"maxCommentsPerCycle":1,"globalMaxIssuesPerCycle":5,"globalMaxCommentsPerCycle":1,"maxActiveRuns":1,"leaseTtlMs":1200000,"cooldownMs":3600000,"burstWindowMs":3600000,"maxIssuesPerBurst":10,"lookbackMs":600000,"processExistingOpenIssuesOnActivation":false},"github":{"clientId":"fixture-client-id","botLogin":"neondiff-bot"}}}"#
}
