#if DEBUG
import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

enum VisualProofDesktopDependencies {
    static func make() -> DesktopAppDependencies {
        DesktopAppDependencies(
            clipboard: VisualProofClipboard(),
            urlOpener: VisualProofURLOpener(),
            cli: VisualProofCLIExecutor(),
            dashboard: VisualProofDashboardLauncher(),
            preferences: VisualProofPreferences(),
            clock: VisualProofClock(),
            fileWriter: VisualProofFileWriter(),
            providerVerifier: VisualProofProviderVerifier(),
            secretStore: VisualProofSecretStore(),
            githubAuthenticator: VisualProofGitHubAuthenticator(),
            productionBoundary: .quarantined
        )
    }
}

private struct VisualProofClipboard: DesktopClipboard {
    @MainActor func write(_ string: String) -> Bool { true }
}

private struct VisualProofURLOpener: DesktopURLOpener {
    @MainActor func open(_ url: URL) -> Bool { true }
}

private struct VisualProofCLIExecutor: DesktopCLIExecuting {
    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        CLIRunResult(exitCode: 0, stdout: "", stderr: "")
    }
}

private struct VisualProofDashboardLauncher: DesktopDashboardLaunching {
    func launch(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL?
    ) async throws -> CLILaunchResult {
        CLILaunchResult(
            processIdentifier: 0,
            executablePath: "visual-proof",
            arguments: []
        )
    }
}

private final class VisualProofPreferences: DesktopPreferences, @unchecked Sendable {
    private let lock = NSLock()
    private var strings: [String: String] = [:]
    private var booleans: [String: Bool] = [:]

    func string(forKey key: String) -> String? {
        lock.withLock { strings[key] }
    }

    func bool(forKey key: String) -> Bool {
        lock.withLock { booleans[key] ?? false }
    }

    func set(_ value: String, forKey key: String) {
        lock.withLock { strings[key] = value }
    }

    func set(_ value: Bool, forKey key: String) {
        lock.withLock { booleans[key] = value }
    }

    func removeValue(forKey key: String) {
        lock.withLock {
            strings.removeValue(forKey: key)
            booleans.removeValue(forKey: key)
        }
    }
}

private struct VisualProofClock: DesktopClock {
    var now: Date {
        Date(timeIntervalSince1970: 1_783_684_800)
    }

    func sleep(for duration: Duration) async throws {}
}

private struct VisualProofFileWriter: DesktopFileWriting {
    let applicationSupportDirectory = URL(filePath: "/visual-proof/NeonDiffDesktop", directoryHint: .isDirectory)

    func write(_ data: Data, to url: URL) throws {}
}

private final class VisualProofProviderVerifier: DesktopProviderVerifying, @unchecked Sendable {
    func verify(
        executablePath: String,
        account: String,
        expectedProviderId: String,
        expectedConfigRevision: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-10T12:00:00Z",
            state: .healthy,
            mode: "openai_compatible_models",
            detail: "Verified from deterministic visual-proof dependencies.",
            troubleshooting: [],
            configRevision: String(repeating: "a", count: 64)
        )
    }
}

private final class VisualProofSecretStore: DesktopSecretStoring {
    private var secrets: [String: String] = [:]

    func setSecret(_ secret: String, account: String) throws {
        secrets[account] = secret
    }

    func readSecret(account: String) throws -> String? {
        secrets[account]
    }

    func readSecret(account: String, allowUserInteraction: Bool) throws -> String? {
        secrets[account]
    }

    func containsSecret(account: String) -> Bool {
        secrets[account] != nil
    }

    func deleteSecret(account: String) throws {
        secrets.removeValue(forKey: account)
    }
}

private enum VisualProofGitHubAuthenticationError: Error {
    case unavailable
}

private final class VisualProofGitHubAuthenticator: GitHubDesktopAuthenticating, @unchecked Sendable {
    func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode {
        throw VisualProofGitHubAuthenticationError.unavailable
    }

    func pollDeviceAuthorization(
        clientId: String,
        deviceCode: String
    ) async throws -> GitHubDeviceAuthorizationPollResult {
        throw VisualProofGitHubAuthenticationError.unavailable
    }

    func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken {
        throw VisualProofGitHubAuthenticationError.unavailable
    }

    func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser {
        throw VisualProofGitHubAuthenticationError.unavailable
    }

    func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository] {
        throw VisualProofGitHubAuthenticationError.unavailable
    }
}
#endif
