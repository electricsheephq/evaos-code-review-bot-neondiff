import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite @MainActor struct AccountLinkModelTests {
    @Test func explicitConnectOpensTrustedWebsitePollsAndLoadsLocalIntersection() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-link-\(UUID().uuidString)", isDirectory: true)
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("config.local.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let preferences = MemoryPreferences()
        preferences.set(configURL.path, forKey: "neondiff.configPath")
        preferences.set("4242", forKey: "neondiff.byoGitHubAppId")
        let secrets = AccountLinkMemorySecretStore()
        try secrets.setSecret("100yenadmin", account: "github/user-login")
        let accountLink = ScriptedAccountLink(
            workspaceResults: [
                .failure(.server(reason: .accountLinkRequired)),
                .success(AccountLinkFixtures.electricSheep)
            ]
        )
        let urlOpener = RecordingURLOpener()
        let clock = TestClock(now: Date(timeIntervalSince1970: 1_800_000_000))
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: urlOpener,
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: clock,
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secrets,
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: accountLink,
            productionBoundary: .testAccountLink
        ))

        model.connectNeonDiffAccount()
        for _ in 0..<100 where model.isAccountLinkInProgress {
            await Task.yield()
        }

        #expect(model.isAccountLinkInProgress == false)
        #expect(urlOpener.urls == [accountLink.connection.connectURL])
        #expect(accountLink.registeredDeviceIds.count == 1)
        #expect(accountLink.startedDeviceIds == accountLink.registeredDeviceIds)
        #expect(accountLink.workspaceDeviceIds.count == 2)
        #expect(clock.sleeps == [.seconds(2)])
        #expect(model.accountWorkspaceCatalog.accounts.map(\.name) == ["Electric Sheep"])
        #expect(model.selectedAccountWorkspace?.name == "Electric Sheep")
        #expect(model.selectedBotInstallation?.appSlug == "evaos-code-review-bot")
        #expect(model.selectedBotInstallation?.localConfigPath == configURL.path)
        #expect(model.accountWorkspaceStatus == "Account authority verified.")
    }

    @Test func launchRefreshNeverCreatesIdentityAndFailureRemainsRetryable() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-refresh-\(UUID().uuidString)", isDirectory: true)
        let secrets = AccountLinkMemorySecretStore()
        let accountLink = ScriptedAccountLink(
            workspaceResults: [.failure(.server(reason: .accountAuthorityUnavailable))]
        )
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: TemporaryFileWriter(root: root),
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secrets,
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: accountLink,
            productionBoundary: .testAccountLink
        ))

        model.refreshAccountWorkspaces()
        for _ in 0..<100 where model.isAccountLinkInProgress {
            await Task.yield()
        }

        #expect(secrets.mutations.isEmpty)
        #expect(accountLink.workspaceDeviceIds.isEmpty)
        #expect(model.accountWorkspaceCatalog == .idle)
        #expect(model.accountWorkspaceStatus.contains("Connect your NeonDiff account"))
    }

    @Test func accountLinkCanBeCancelledWithoutBlockingTheRestOfTheApp() async {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-cancel-\(UUID().uuidString)", isDirectory: true)
        let accountLink = ScriptedAccountLink(workspaceResults: [])
        let urlOpener = RecordingURLOpener()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: urlOpener,
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: TemporaryFileWriter(root: root),
            providerVerifier: RecordingProviderVerifier(),
            secretStore: AccountLinkMemorySecretStore(),
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: accountLink,
            productionBoundary: .testAccountLink
        ))

        model.connectNeonDiffAccount()
        #expect(model.isAccountLinkInProgress)
        model.cancelAccountLink()
        await Task.yield()

        #expect(model.isAccountLinkInProgress == false)
        #expect(model.accountWorkspaceCatalog == .idle)
        #expect(model.accountWorkspaceStatus.contains("cancelled"))
        #expect(urlOpener.urls.isEmpty)
    }
}

private enum AccountLinkFixtures {
    static let electricSheep = NeonDiffAccountWorkspaceSnapshot(accounts: [
        NeonDiffAccountWorkspace(
            id: "account-electric-sheep",
            kind: .organization,
            name: "Electric Sheep",
            role: .admin,
            entitlement: .internalAdmin,
            bots: [
                NeonDiffAccountBot(
                    id: "bot-existing",
                    appID: 4242,
                    appSlug: "evaos-code-review-bot",
                    mode: .byo,
                    githubInstallationID: 9001,
                    githubAccountLogin: "electricsheephq",
                    status: .verified
                )
            ]
        )
    ])
}

private final class AccountLinkMemorySecretStore: DesktopSecretStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    private var recordedMutations: [String] = []

    var mutations: [String] { lock.withLock { recordedMutations } }

    func setSecret(_ secret: String, account: String) throws {
        lock.withLock {
            values[account] = secret
            recordedMutations.append("set:\(account)")
        }
    }

    func readSecret(account: String) throws -> String? {
        lock.withLock { values[account] }
    }

    func containsSecret(account: String) -> Bool {
        lock.withLock { values[account] != nil }
    }

    func deleteSecret(account: String) throws {
        lock.withLock {
            values.removeValue(forKey: account)
            recordedMutations.append("delete:\(account)")
        }
    }
}

private final class ScriptedAccountLink: NeonDiffAccountLinkConnecting, @unchecked Sendable {
    private let lock = NSLock()
    private var workspaceResults: [Result<NeonDiffAccountWorkspaceSnapshot, GitHubBrokerClientError>]
    private var registered: [String] = []
    private var started: [String] = []
    private var workspaces: [String] = []

    let connection = NeonDiffAccountLinkConnection(
        connectURL: URL(string: "https://www.neondiff.com/desktop/connect?state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!,
        state: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: Date(timeIntervalSince1970: 1_800_000_600)
    )

    init(workspaceResults: [Result<NeonDiffAccountWorkspaceSnapshot, GitHubBrokerClientError>]) {
        self.workspaceResults = workspaceResults
    }

    var registeredDeviceIds: [String] { lock.withLock { registered } }
    var startedDeviceIds: [String] { lock.withLock { started } }
    var workspaceDeviceIds: [String] { lock.withLock { workspaces } }

    func registerAccountLinkIdentity(identity: GitHubBrokerDeviceIdentity) async throws {
        lock.withLock { registered.append(identity.deviceId) }
    }

    func startAccountLink(identity: GitHubBrokerDeviceIdentity) async throws -> NeonDiffAccountLinkConnection {
        lock.withLock { started.append(identity.deviceId) }
        return connection
    }

    func loadAccountWorkspaces(
        identity: GitHubBrokerDeviceIdentity
    ) async throws -> NeonDiffAccountWorkspaceSnapshot {
        try lock.withLock {
            workspaces.append(identity.deviceId)
            guard workspaceResults.isEmpty == false else {
                throw GitHubBrokerClientError.transportUnavailable
            }
            return try workspaceResults.removeFirst().get()
        }
    }
}
