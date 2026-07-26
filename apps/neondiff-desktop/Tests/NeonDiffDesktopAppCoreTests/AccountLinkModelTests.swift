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
        await model.waitForAccountLinkOperation()

        #expect(model.isAccountLinkInProgress == false)
        #expect(urlOpener.urls == [accountLink.connection.connectURL])
        #expect(accountLink.registeredDeviceIds.count == 1)
        #expect(accountLink.startedDeviceIds == accountLink.registeredDeviceIds)
        #expect(accountLink.workspaceDeviceIds.count == 2)
        #expect(clock.sleeps == [.seconds(1)])
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

        model.refreshAccountWorkspacesOnLaunch()

        #expect(model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(!model.isOnboardingPresented)

        await model.waitForAccountLinkOperation()

        #expect(secrets.mutations.isEmpty)
        #expect(accountLink.workspaceDeviceIds.isEmpty)
        #expect(model.accountWorkspaceCatalog == .idle)
        #expect(model.accountWorkspaceStatus.contains("Connect your NeonDiff account"))
        #expect(!model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(model.isOnboardingPresented)
    }

    @Test func launchRefreshHidesFalseFirstRunWhileRestoringAnExistingLocalBot() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-launch-restore-\(UUID().uuidString)", isDirectory: true)
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("existing-worker.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let secrets = AccountLinkMemorySecretStore()
        _ = try GitHubBrokerDeviceIdentityStore(secretStore: secrets).loadOrCreate()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secrets,
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [
                .success(AccountLinkFixtures.electricSheep)
            ]),
            productionBoundary: .testAccountLink,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4242,
                    configPath: configURL.path
                )
            ]
        ))

        #expect(model.isOnboardingPresented)

        model.refreshAccountWorkspacesOnLaunch()

        #expect(model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(model.isSetupMutationBlocked)
        #expect(!model.canEditProviderConfiguration)
        #expect(!model.isOnboardingPresented)
        #expect(model.customerSurfaceStatus == "RESTORING")

        await model.waitForAccountLinkOperation()
        for _ in 0..<50 where model.isConfigInspectInProgress {
            await Task.yield()
        }

        #expect(!model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(!model.isSetupMutationBlocked)
        #expect(model.selectedBotInstallation?.localConfigPath == configURL.path)
        #expect(model.existingLocalBotIdentityReady)
        #expect(!model.isOnboardingPresented)
        #expect(model.customerSurfaceStatus == "SETUP INCOMPLETE")
    }

    @Test func launchRefreshFailureStaysInRetryStateInsteadOfClaimingFirstRun() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-launch-failure-\(UUID().uuidString)", isDirectory: true)
        let secrets = AccountLinkMemorySecretStore()
        let cli = RecordingCLIExecutor()
        _ = try GitHubBrokerDeviceIdentityStore(secretStore: secrets).loadOrCreate()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: cli,
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: TemporaryFileWriter(root: root),
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secrets,
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [
                .failure(.server(reason: .accountAuthorityUnavailable))
            ]),
            productionBoundary: .testAccountLink
        ))

        model.refreshAccountWorkspacesOnLaunch()
        await model.waitForAccountLinkOperation()

        #expect(!model.isOnboardingPresented)
        #expect(model.accountWorkspaceRestoreFailed)
        #expect(model.isSetupMutationBlocked)
        #expect(!model.canEditProviderConfiguration)
        #expect(model.customerSurfaceStatus == "ACCOUNT CHECK FAILED")

        let existingRepository = RepoMonitor(
            name: "electricsheephq/evaos-code-review-bot",
            enabled: true,
            profile: "selected"
        )
        model.repos = [existingRepository]
        model.toggleRepoAllowlist(existingRepository)
        model.inspectConfig()

        #expect(model.repos.first?.enabled == true)
        #expect(cli.calls.isEmpty)
    }

    @Test func launchRefreshPresentsOnboardingAfterProvingNoLocalBotExists() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-launch-new-\(UUID().uuidString)", isDirectory: true)
        let secrets = AccountLinkMemorySecretStore()
        _ = try GitHubBrokerDeviceIdentityStore(secretStore: secrets).loadOrCreate()
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
            accountLink: ScriptedAccountLink(workspaceResults: [
                .success(AccountLinkFixtures.electricSheep)
            ]),
            productionBoundary: .testAccountLink
        ))

        model.refreshAccountWorkspacesOnLaunch()

        #expect(model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(!model.isOnboardingPresented)
        #expect(model.customerSurfaceStatus == "RESTORING")

        await model.waitForAccountLinkOperation()

        #expect(!model.isAutomaticAccountWorkspaceRefreshInProgress)
        #expect(model.selectedBotInstallation?.localConfigPath == nil)
        #expect(model.isOnboardingPresented)
        #expect(model.customerSurfaceStatus == "SETUP REQUIRED")
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

    @Test func ambiguousBYOAppAcrossAccountsNeverAttachesTheLocalConfig() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-ambiguous-\(UUID().uuidString)", isDirectory: true)
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("config.local.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let preferences = MemoryPreferences()
        preferences.set(configURL.path, forKey: "neondiff.configPath")
        preferences.set("4242", forKey: "neondiff.byoGitHubAppId")
        let secrets = AccountLinkMemorySecretStore()
        try secrets.setSecret("100yenadmin", account: "github/user-login")
        let snapshot = NeonDiffAccountWorkspaceSnapshot(accounts: [
            AccountLinkFixtures.workspace(
                id: "11111111-1111-4111-8111-111111111111",
                name: "Personal",
                login: "100yenadmin",
                botID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            ),
            AccountLinkFixtures.workspace(
                id: "22222222-2222-4222-8222-222222222222",
                name: "Electric Sheep",
                login: "electricsheephq",
                botID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            )
        ])
        let accountLink = ScriptedAccountLink(workspaceResults: [.success(snapshot)])
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secrets,
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: accountLink,
            productionBoundary: .testAccountLink
        ))

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(model.accountWorkspaceCatalog.accounts.flatMap(\.bots).allSatisfy {
            $0.localConfigPath == nil
        })
    }

    @Test func ambiguousDiscoveredBYOAppAcrossAccountsNeverAttachesTheLocalConfig() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent(
                "neondiff-account-discovered-ambiguous-\(UUID().uuidString)",
                isDirectory: true
            )
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("existing-worker.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let snapshot = NeonDiffAccountWorkspaceSnapshot(accounts: [
            AccountLinkFixtures.workspace(
                id: "11111111-1111-4111-8111-111111111111",
                name: "Personal",
                login: "100yenadmin",
                botID: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
            ),
            AccountLinkFixtures.workspace(
                id: "22222222-2222-4222-8222-222222222222",
                name: "Electric Sheep",
                login: "electricsheephq",
                botID: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
            )
        ])
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: AccountLinkMemorySecretStore(),
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [.success(snapshot)]),
            productionBoundary: .testAccountLink,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4242,
                    configPath: configURL.path
                )
            ]
        ))

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(model.accountWorkspaceCatalog.accounts.flatMap(\.bots).allSatisfy {
            $0.localConfigPath == nil
        })
        #expect(model.configPath != configURL.path)
    }

    @Test func managedOnlyBuildNeverAttachesDiscoveredBYOConfiguration() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent(
                "neondiff-account-managed-no-byo-fallback-\(UUID().uuidString)",
                isDirectory: true
            )
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("legacy-byo-worker.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: MemoryPreferences(),
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: AccountLinkMemorySecretStore(),
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [
                .success(AccountLinkFixtures.electricSheep)
            ]),
            productionBoundary: .testManagedAccountLink,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4242,
                    configPath: configURL.path
                )
            ]
        ))

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(model.accountWorkspaceCatalog.accounts.flatMap(\.bots).allSatisfy {
            $0.localConfigPath == nil
        })
        #expect(model.configPath != configURL.path)
    }

    @Test func managedInstallationReconcilesOnlyByItsSavedInstallationID() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-managed-\(UUID().uuidString)", isDirectory: true)
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("config.local.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let preferences = MemoryPreferences()
        preferences.set(configURL.path, forKey: "neondiff.configPath")
        preferences.set("9001", forKey: "neondiff.managedGitHubInstallationId")
        let managedSnapshot = NeonDiffAccountWorkspaceSnapshot(accounts: [
            NeonDiffAccountWorkspace(
                id: "11111111-1111-4111-8111-111111111111",
                kind: .organization,
                name: "Electric Sheep",
                role: .admin,
                entitlement: .internalAdmin,
                bots: [
                    NeonDiffAccountBot(
                        id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                        appID: 4_184_532,
                        appSlug: "neondiff",
                        mode: .managed,
                        githubInstallationID: 9001,
                        githubAccountLogin: "electricsheephq",
                        status: .verified
                    )
                ]
            )
        ])
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: AccountLinkMemorySecretStore(),
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [.success(managedSnapshot)]),
            productionBoundary: .testManagedAccountLink
        ))

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(model.selectedBotInstallation?.githubInstallationID == 9001)
        #expect(model.selectedBotInstallation?.localConfigPath == configURL.path)
    }

    @Test func verifiedBYOBotDiscoversTheKnownLocalLaunchAgentConfigWithoutClientAuthority() async throws {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-local-discovery-\(UUID().uuidString)", isDirectory: true)
        let fileWriter = TemporaryFileWriter(root: root)
        let configURL = root.appendingPathComponent("existing-worker.json")
        try fileWriter.write(Data("{}".utf8), to: configURL)
        let preferences = MemoryPreferences()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: TestClock(),
            fileWriter: fileWriter,
            providerVerifier: RecordingProviderVerifier(),
            secretStore: AccountLinkMemorySecretStore(),
            githubAuthenticator: StubGitHubAuthenticator(),
            accountLink: ScriptedAccountLink(workspaceResults: [
                .success(AccountLinkFixtures.electricSheep)
            ]),
            productionBoundary: .testAccountLink,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4242,
                    configPath: configURL.path
                )
            ]
        ))

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(model.selectedBotInstallation?.appSlug == "evaos-code-review-bot")
        #expect(model.selectedBotInstallation?.localConfigPath == configURL.path)
        #expect(model.configPath == configURL.path)
        #expect(preferences.string(forKey: "neondiff.byoGitHubAppId") == nil)
    }

    @Test func cancelledAccountLinkCannotInstallALateWorkspaceResult() async {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-late-\(UUID().uuidString)", isDirectory: true)
        let accountLink = BlockingAccountLink()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
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
        await accountLink.waitUntilWorkspaceRequested()
        model.cancelAccountLink()
        accountLink.complete(with: AccountLinkFixtures.electricSheep)
        await model.waitForAccountLinkOperation()

        #expect(model.accountWorkspaceCatalog == .idle)
        #expect(model.accountWorkspaceStatus.contains("cancelled"))
    }

    @Test func accountIdentityKeychainWorkRunsOffTheMainThread() async {
        let root = URL(filePath: NSTemporaryDirectory(), directoryHint: .isDirectory)
            .appendingPathComponent("neondiff-account-keychain-thread-\(UUID().uuidString)", isDirectory: true)
        let secrets = MainThreadRecordingSecretStore()
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
            accountLink: ScriptedAccountLink(workspaceResults: [.success(.init(accounts: []))]),
            productionBoundary: .testAccountLink
        ))
        secrets.resetObservation()

        model.connectNeonDiffAccount()
        await model.waitForAccountLinkOperation()

        #expect(secrets.observedMainThreadAccess == false)
        #expect(model.isAccountLinkInProgress == false)
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

    static func workspace(id: String, name: String, login: String, botID: String) -> NeonDiffAccountWorkspace {
        NeonDiffAccountWorkspace(
            id: id,
            kind: name == "Personal" ? .personal : .organization,
            name: name,
            role: name == "Personal" ? .owner : .admin,
            entitlement: .internalAdmin,
            bots: [
                NeonDiffAccountBot(
                    id: botID,
                    appID: 4242,
                    appSlug: "evaos-code-review-bot",
                    mode: .byo,
                    githubInstallationID: 9001,
                    githubAccountLogin: login,
                    status: .verified
                )
            ]
        )
    }
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
        identity: GitHubBrokerDeviceIdentity,
        state: String?
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

private final class BlockingAccountLink: NeonDiffAccountLinkConnecting, @unchecked Sendable {
    private let lock = NSLock()
    private var workspaceRequested = false
    private var continuation: CheckedContinuation<NeonDiffAccountWorkspaceSnapshot, Error>?
    private let connection = NeonDiffAccountLinkConnection(
        connectURL: URL(string: "https://www.neondiff.com/desktop/connect?state=aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")!,
        state: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        expiresAt: Date(timeIntervalSince1970: 1_800_000_600)
    )

    func registerAccountLinkIdentity(identity: GitHubBrokerDeviceIdentity) async throws {}

    func startAccountLink(identity: GitHubBrokerDeviceIdentity) async throws -> NeonDiffAccountLinkConnection {
        connection
    }

    func loadAccountWorkspaces(
        identity: GitHubBrokerDeviceIdentity,
        state: String?
    ) async throws -> NeonDiffAccountWorkspaceSnapshot {
        try await withCheckedThrowingContinuation { continuation in
            lock.withLock {
                workspaceRequested = true
                self.continuation = continuation
            }
        }
    }

    func waitUntilWorkspaceRequested() async {
        while lock.withLock({ workspaceRequested == false }) {
            await Task.yield()
        }
    }

    func complete(with snapshot: NeonDiffAccountWorkspaceSnapshot) {
        let pending = lock.withLock { () -> CheckedContinuation<NeonDiffAccountWorkspaceSnapshot, Error>? in
            defer { continuation = nil }
            return continuation
        }
        pending?.resume(returning: snapshot)
    }
}

private final class MainThreadRecordingSecretStore: DesktopSecretStoring, @unchecked Sendable {
    private let lock = NSLock()
    private var values: [String: String] = [:]
    private var touchedMainThread = false

    var observedMainThreadAccess: Bool { lock.withLock { touchedMainThread } }

    func resetObservation() {
        lock.withLock { touchedMainThread = false }
    }

    func setSecret(_ secret: String, account: String) throws {
        lock.withLock {
            touchedMainThread = touchedMainThread || Thread.isMainThread
            values[account] = secret
        }
    }

    func createSecretIfAbsent(_ secret: String, account: String) throws -> Bool {
        lock.withLock {
            touchedMainThread = touchedMainThread || Thread.isMainThread
            guard values[account] == nil else { return false }
            values[account] = secret
            return true
        }
    }

    func readSecret(account: String) throws -> String? {
        lock.withLock {
            touchedMainThread = touchedMainThread || Thread.isMainThread
            return values[account]
        }
    }

    func containsSecret(account: String) -> Bool {
        lock.withLock {
            touchedMainThread = touchedMainThread || Thread.isMainThread
            return values[account] != nil
        }
    }

    func deleteSecret(account: String) throws {
        lock.withLock {
            touchedMainThread = touchedMainThread || Thread.isMainThread
            values.removeValue(forKey: account)
        }
    }
}
