import Foundation
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

func fixtureURL(_ value: String, directory: Bool = false) -> URL {
    if value.contains("://") {
        return URL(string: value)!
    }
    return URL(filePath: value, directoryHint: directory ? .isDirectory : .notDirectory)
}

func fixtureData(_ value: String) -> Data {
    Data(value.utf8)
}

func fixtureData(repeating byte: UInt8, count: Int) -> Data {
    Data(repeating: byte, count: count)
}

func fixtureData(bytes: [UInt8]) -> Data {
    Data(bytes)
}

func fixtureDate(secondsSince1970: TimeInterval) -> Date {
    Date(timeIntervalSince1970: secondsSince1970)
}

enum RecordingDesktopDependencyError: Error, Equatable, LocalizedError {
    case standardInputTooLarge
    case destinationOutsideRoot

    var errorDescription: String? {
        switch self {
        case .standardInputTooLarge:
            "CLI standard input exceeds the test limit"
        case .destinationOutsideRoot:
            "File destination is outside the injected root"
        }
    }
}

private final class Locked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func read<Result>(_ body: (Value) -> Result) -> Result {
        lock.withLock { body(value) }
    }

    func update<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&value) }
    }
}

final class RecordingClipboard: DesktopClipboard, @unchecked Sendable {
    private let recordedStrings = Locked<[String]>([])
    private let scriptedResult: Bool

    init(result: Bool = true) {
        scriptedResult = result
    }

    var strings: [String] { recordedStrings.read { $0 } }

    @MainActor func write(_ string: String) -> Bool {
        recordedStrings.update { $0.append(string) }
        return scriptedResult
    }
}

final class RecordingURLOpener: DesktopURLOpener, @unchecked Sendable {
    private let recordedURLs = Locked<[URL]>([])
    private let scriptedResult: Bool

    init(result: Bool = true) {
        scriptedResult = result
    }

    var urls: [URL] { recordedURLs.read { $0 } }

    @MainActor func open(_ url: URL) -> Bool {
        recordedURLs.update { $0.append(url) }
        return scriptedResult
    }
}

struct RecordedCLICall: Equatable, Sendable {
    let executablePath: String
    let arguments: [String]
    let standardInput: Data?
    let timeout: TimeInterval
}

final class RecordingCLIExecutor: DesktopCLIExecuting, @unchecked Sendable {
    private let recordedCalls = Locked<[RecordedCLICall]>([])
    private let scriptedResult: CLIRunResult
    private let maximumStandardInputBytes: Int

    init(
        result: CLIRunResult = CLIRunResult(exitCode: 0, stdout: "", stderr: ""),
        maximumStandardInputBytes: Int = 64 * 1024
    ) {
        scriptedResult = result
        self.maximumStandardInputBytes = maximumStandardInputBytes
    }

    var calls: [RecordedCLICall] { recordedCalls.read { $0 } }

    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        if let standardInput, standardInput.count > maximumStandardInputBytes {
            throw RecordingDesktopDependencyError.standardInputTooLarge
        }
        recordedCalls.update {
            $0.append(RecordedCLICall(
                executablePath: executablePath,
                arguments: arguments,
                standardInput: standardInput,
                timeout: timeout
            ))
        }
        return scriptedResult
    }
}

struct RecordedDashboardLaunch: Equatable, Sendable {
    let executablePath: String
    let arguments: [String]
    let workingDirectory: URL?
}

final class RecordingDashboardLauncher: DesktopDashboardLaunching, @unchecked Sendable {
    private let recordedCalls = Locked<[RecordedDashboardLaunch]>([])
    private let scriptedResult: CLILaunchResult

    init(result: CLILaunchResult = CLILaunchResult(
        processIdentifier: 42,
        executablePath: "fixture-neondiff",
        arguments: []
    )) {
        scriptedResult = result
    }

    var calls: [RecordedDashboardLaunch] { recordedCalls.read { $0 } }

    func launch(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL?
    ) async throws -> CLILaunchResult {
        recordedCalls.update {
            $0.append(RecordedDashboardLaunch(
                executablePath: executablePath,
                arguments: arguments,
                workingDirectory: workingDirectory
            ))
        }
        return scriptedResult
    }
}

final class MemoryPreferences: DesktopPreferences, @unchecked Sendable {
    private enum Value: Sendable {
        case string(String)
        case bool(Bool)
    }

    private let values = Locked<[String: Value]>([:])

    func string(forKey key: String) -> String? {
        values.read {
            guard case .string(let value) = $0[key] else { return nil }
            return value
        }
    }

    func bool(forKey key: String) -> Bool {
        values.read {
            guard case .bool(let value) = $0[key] else { return false }
            return value
        }
    }

    func set(_ value: String, forKey key: String) {
        values.update { $0[key] = .string(value) }
    }

    func set(_ value: Bool, forKey key: String) {
        values.update { $0[key] = .bool(value) }
    }
}

final class TestClock: DesktopClock, @unchecked Sendable {
    private struct State: Sendable {
        var now: Date
        var sleeps: [Duration]
    }

    private let state: Locked<State>

    init(now: Date = Date(timeIntervalSince1970: 0)) {
        state = Locked(State(now: now, sleeps: []))
    }

    var now: Date { state.read(\.now) }
    var sleeps: [Duration] { state.read(\.sleeps) }

    func sleep(for duration: Duration) async throws {
        state.update { $0.sleeps.append(duration) }
    }

    func advance(by interval: TimeInterval) {
        state.update { $0.now = $0.now.addingTimeInterval(interval) }
    }
}

struct RecordedFileWrite: Equatable, Sendable {
    let data: Data
    let url: URL
}

final class TemporaryFileWriter: DesktopFileWriting, @unchecked Sendable {
    let applicationSupportDirectory: URL
    private let recordedWrites = Locked<[RecordedFileWrite]>([])

    init(root: URL) {
        applicationSupportDirectory = root.standardizedFileURL
    }

    var writes: [RecordedFileWrite] { recordedWrites.read { $0 } }

    func write(_ data: Data, to url: URL) throws {
        let destination = url.standardizedFileURL
        let rootPath = applicationSupportDirectory.path
        let destinationPath = destination.path
        guard destinationPath.hasPrefix(rootPath + "/") else {
            throw RecordingDesktopDependencyError.destinationOutsideRoot
        }
        recordedWrites.update { $0.append(RecordedFileWrite(data: data, url: destination)) }
    }
}

struct RecordedProviderVerification: Equatable, Sendable {
    let executablePath: String
    let account: String
    let expectedProviderId: String
    let expectedConfigRevision: String
    let arguments: [String]
    let timeout: TimeInterval
}

final class RecordingProviderVerifier: DesktopProviderVerifying, @unchecked Sendable {
    private let recordedCalls = Locked<[RecordedProviderVerification]>([])
    private let scriptedSnapshot: ProviderVerificationSnapshot

    init(snapshot: ProviderVerificationSnapshot = ProviderVerificationSnapshot(
        ok: true,
        command: "providers verify",
        providerId: "fixture-provider",
        checkedAt: "2026-01-01T00:00:00Z",
        state: .healthy,
        mode: "openai_compatible_models",
        detail: "verified",
        troubleshooting: [],
        configRevision: String(repeating: "a", count: 64)
    )) {
        scriptedSnapshot = snapshot
    }

    var calls: [RecordedProviderVerification] { recordedCalls.read { $0 } }

    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        recordedCalls.update {
            $0.append(RecordedProviderVerification(
                executablePath: executablePath,
                account: account,
                expectedProviderId: expectedProviderId,
                expectedConfigRevision: expectedConfigRevision,
                arguments: arguments,
                timeout: timeout
            ))
        }
        return scriptedSnapshot
    }
}

final class StubSecretStore: DesktopSecretStoring, @unchecked Sendable {
    func setSecret(_ secret: String, account: String) throws {}
    func readSecret(account: String) throws -> String? { nil }
    func containsSecret(account: String) -> Bool { false }
    func deleteSecret(account: String) throws {}
}

final class StubGitHubAuthenticator: GitHubDesktopAuthenticating, @unchecked Sendable {
    func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode { fatalError("unused") }
    func pollDeviceAuthorization(clientId: String, deviceCode: String) async throws -> GitHubDeviceAuthorizationPollResult { fatalError("unused") }
    func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken { fatalError("unused") }
    func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser { fatalError("unused") }
    func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository] { fatalError("unused") }
}

struct RecordingDesktopDependencies {
    let clipboard: RecordingClipboard
    let urlOpener: RecordingURLOpener
    let cli: RecordingCLIExecutor
    let dashboard: RecordingDashboardLauncher
    let preferences: MemoryPreferences
    let clock: TestClock
    let fileWriter: TemporaryFileWriter
    let providerVerifier: RecordingProviderVerifier
    let secretStore: StubSecretStore
    let githubAuthenticator: StubGitHubAuthenticator
    let dependencies: DesktopAppDependencies

    init(root: URL) {
        clipboard = RecordingClipboard()
        urlOpener = RecordingURLOpener()
        cli = RecordingCLIExecutor()
        dashboard = RecordingDashboardLauncher()
        preferences = MemoryPreferences()
        clock = TestClock()
        fileWriter = TemporaryFileWriter(root: root)
        providerVerifier = RecordingProviderVerifier()
        secretStore = StubSecretStore()
        githubAuthenticator = StubGitHubAuthenticator()
        dependencies = DesktopAppDependencies(
            clipboard: clipboard,
            urlOpener: urlOpener,
            cli: cli,
            dashboard: dashboard,
            preferences: preferences,
            clock: clock,
            fileWriter: fileWriter,
            providerVerifier: providerVerifier,
            secretStore: secretStore,
            githubAuthenticator: githubAuthenticator
        )
    }
}
