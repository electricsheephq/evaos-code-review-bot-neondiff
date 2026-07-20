#if DEBUG
import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

enum DesktopEvaluationDependencies {
    static func make(fixture: DesktopResolvedEvaluationFixture) -> DesktopAppDependencies {
        DesktopAppDependencies(
            clipboard: EvaluationClipboard(),
            urlOpener: EvaluationURLOpener(),
            cli: EvaluationCLIExecutor(),
            dashboard: EvaluationDashboardLauncher(),
            preferences: EvaluationPreferences(onboardingCompleted: fixture.surface.onboardingStep == nil),
            clock: EvaluationClock(iso8601: fixture.environment.clock),
            fileWriter: EvaluationFileWriter(),
            providerVerifier: EvaluationProviderVerifier(fixture: fixture),
            secretStore: EvaluationSecretStore(accounts: credentialAccounts(in: fixture)),
            githubAuthenticator: EvaluationGitHubAuthenticator(),
            productionBoundary: .quarantined
        )
    }

    private static func credentialAccounts(in fixture: DesktopResolvedEvaluationFixture) -> Set<String> {
        var accounts = Set<String>()
        if let provider = fixture.state.provider,
           provider.credentialPresent,
           let account = ProviderKeychainAccount.account(providerId: provider.id) {
            accounts.insert(account)
        }
        if fixture.state.license.credentialPresent {
            accounts.insert("license/default")
        }
        if fixture.state.github.connection == "connected" {
            accounts.insert("github/user-access-token")
        }
        return accounts
    }
}

private struct EvaluationClipboard: DesktopClipboard {
    @MainActor func write(_ string: String) -> Bool { true }
}

private struct EvaluationURLOpener: DesktopURLOpener {
    @MainActor func open(_ url: URL) -> Bool { true }
}

private struct EvaluationCLIExecutor: DesktopCLIExecuting {
    func run(executablePath: String, arguments: [String], standardInput: Data?, timeout: TimeInterval) async throws -> CLIRunResult {
        CLIRunResult(exitCode: 0, stdout: "", stderr: "")
    }
}

private struct EvaluationDashboardLauncher: DesktopDashboardLaunching {
    func launch(executablePath: String, arguments: [String], workingDirectory: URL?) async throws -> CLILaunchResult {
        CLILaunchResult(processIdentifier: 1, executablePath: "fixture-neondiff", arguments: [])
    }
}

private final class EvaluationPreferences: DesktopPreferences, @unchecked Sendable {
    private let lock = NSLock()
    private var strings: [String: String] = [:]
    private var booleans: [String: Bool]

    init(onboardingCompleted: Bool) {
        booleans = ["neondiff.hasCompletedOnboarding": onboardingCompleted]
    }

    func string(forKey key: String) -> String? { lock.withLock { strings[key] } }
    func bool(forKey key: String) -> Bool { lock.withLock { booleans[key] ?? false } }
    func set(_ value: String, forKey key: String) { lock.withLock { strings[key] = value } }
    func set(_ value: Bool, forKey key: String) { lock.withLock { booleans[key] = value } }
    func removeValue(forKey key: String) {
        lock.withLock {
            strings.removeValue(forKey: key)
            booleans.removeValue(forKey: key)
        }
    }
}

private struct EvaluationClock: DesktopClock {
    let now: Date

    init(iso8601: String) {
        now = ISO8601DateFormatter().date(from: iso8601) ?? Date(timeIntervalSince1970: 0)
    }

    func sleep(for duration: Duration) async throws {}
}

private struct EvaluationFileWriter: DesktopFileWriting {
    let applicationSupportDirectory = URL(filePath: "/fixture/NeonDiffDesktop", directoryHint: .isDirectory)
    func write(_ data: Data, to url: URL) throws {}
}

private final class EvaluationProviderVerifier: DesktopProviderVerifying, @unchecked Sendable {
    private let fixture: DesktopResolvedEvaluationFixture

    init(fixture: DesktopResolvedEvaluationFixture) {
        self.fixture = fixture
    }

    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        DesktopEvaluationModelAdapter.providerVerification(
            from: fixture,
            revision: expectedConfigRevision
        ) ?? ProviderVerificationSnapshot(
            ok: false,
            command: "providers verify",
            providerId: expectedProviderId,
            checkedAt: fixture.environment.clock,
            state: .configuredUnverified,
            mode: "metadata_only",
            detail: "No deterministic verification result is configured.",
            troubleshooting: [],
            configRevision: expectedConfigRevision
        )
    }
}

private final class EvaluationSecretStore: DesktopSecretStoring {
    private let lock = NSLock()
    private var accounts: Set<String>

    init(accounts: Set<String>) { self.accounts = accounts }

    func setSecret(_ secret: String, account: String) throws {
        lock.withLock { _ = accounts.insert(account) }
    }

    func readSecret(account: String) throws -> String? {
        lock.withLock { accounts.contains(account) ? "fixture-credential" : nil }
    }

    func readSecret(account: String, allowUserInteraction: Bool) throws -> String? {
        try readSecret(account: account)
    }

    func containsSecret(account: String) -> Bool {
        lock.withLock { accounts.contains(account) }
    }

    func deleteSecret(account: String) throws {
        lock.withLock { _ = accounts.remove(account) }
    }
}

private enum EvaluationGitHubError: Error { case unavailable }

private final class EvaluationGitHubAuthenticator: GitHubDesktopAuthenticating, @unchecked Sendable {
    func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode { throw EvaluationGitHubError.unavailable }
    func pollDeviceAuthorization(clientId: String, deviceCode: String) async throws -> GitHubDeviceAuthorizationPollResult { throw EvaluationGitHubError.unavailable }
    func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken { throw EvaluationGitHubError.unavailable }
    func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser { throw EvaluationGitHubError.unavailable }
    func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository] { throw EvaluationGitHubError.unavailable }
}
#endif
