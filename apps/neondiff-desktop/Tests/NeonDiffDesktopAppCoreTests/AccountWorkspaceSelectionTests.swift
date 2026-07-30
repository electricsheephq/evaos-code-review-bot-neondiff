import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct AccountWorkspaceSelectionTests {
    private let personal = DesktopAccountWorkspace(
        id: "account-personal",
        kind: .personal,
        name: "Benjamin",
        role: .owner,
        entitlement: .publicFree,
        bots: []
    )

    private let electricSheep = DesktopAccountWorkspace(
        id: "account-electric-sheep",
        kind: .organization,
        name: "ElectricSheep",
        role: .admin,
        entitlement: .internalAdmin,
        bots: [
            DesktopBotInstallation(
                id: "bot-evaos-code-review-bot",
                appID: 4_184_532,
                appSlug: "evaos-code-review-bot",
                mode: .byo,
                githubInstallationID: 72_001,
                githubAccountLogin: "electricsheephq",
                status: .verified,
                localConfigPath: nil
            )
        ]
    )

    @Test func authoritativeMembershipControlsVisibleAccounts() {
        let catalog = DesktopAccountWorkspaceCatalog.loaded([personal, electricSheep])

        #expect(catalog.accounts.map(\.name) == ["Benjamin", "ElectricSheep"])
        #expect(catalog.accounts.allSatisfy { $0.role != nil })
    }

    @Test func matchingLocalBotIsMergedWithoutDuplicatingTheServerInstallation() throws {
        let local = DesktopLocalBotCandidate(
            botID: "bot-evaos-code-review-bot",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            githubAccountLogin: "electricsheephq",
            configPath: "/Users/test/Library/Application Support/NeonDiff/config.local.json"
        )

        let merged = electricSheep.merging(localCandidates: [local])
        let bot = try #require(merged.bots.first)

        #expect(merged.bots.count == 1)
        #expect(bot.localConfigPath == local.configPath)
        #expect(bot.isAvailableOnThisMac)
    }

    @Test func localCandidateAttachesOnlyToItsExactAuthoritativeBot() {
        let managedTwin = DesktopBotInstallation(
            id: "bot-managed-twin",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            mode: .managed,
            githubInstallationID: 72_002,
            githubAccountLogin: "electricsheephq",
            status: .verified,
            localConfigPath: nil
        )
        let workspace = DesktopAccountWorkspace(
            id: electricSheep.id,
            kind: electricSheep.kind,
            name: electricSheep.name,
            role: electricSheep.role,
            entitlement: electricSheep.entitlement,
            bots: electricSheep.bots + [managedTwin]
        )
        let local = DesktopLocalBotCandidate(
            botID: "bot-evaos-code-review-bot",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            githubAccountLogin: "electricsheephq",
            configPath: "/Users/test/Library/Application Support/NeonDiff/config.local.json"
        )

        let merged = workspace.merging(localCandidates: [local])

        #expect(merged.bots[0].localConfigPath == local.configPath)
        #expect(merged.bots[1].localConfigPath == nil)
    }

    @Test func localBotCannotCrossAnAuthoritativeGitHubAccountBoundary() {
        let local = DesktopLocalBotCandidate(
            botID: "bot-evaos-code-review-bot",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            githubAccountLogin: "someone-else",
            configPath: "/tmp/other/config.local.json"
        )

        let merged = electricSheep.merging(localCandidates: [local])

        #expect(merged.bots.count == 1)
        #expect(merged.bots[0].localConfigPath == nil)
    }

    @Test func serverCatalogCannotInjectALocalConfigPath() throws {
        let data = Data(#"{"id":"bot-remote","appId":4184532,"appSlug":"evaos-code-review-bot","mode":"byo","githubInstallationId":72001,"githubAccountLogin":"electricsheephq","status":"verified","localConfigPath":"/tmp/server-controlled.json"}"#.utf8)

        let decoded = try JSONDecoder().decode(DesktopBotInstallation.self, from: data)

        #expect(decoded.localConfigPath == nil)
        #expect(decoded.appID == 4_184_532)
        #expect(decoded.githubInstallationID == 72_001)
    }

    @Test func newBotUsesADistinctPendingIdentityAndNeverReusesExistingConfig() throws {
        let existingPath = "/Users/test/Library/Application Support/NeonDiff/config.local.json"
        let plan = try DesktopNewBotPlan.make(
            account: electricSheep,
            appSlug: "electric-sheep-secondary",
            applicationSupportDirectory: URL(filePath: "/Users/test/Library/Application Support/NeonDiff", directoryHint: .isDirectory),
            occupiedConfigPaths: [existingPath]
        )

        #expect(plan.accountID == electricSheep.id)
        #expect(plan.bot.status == .pending)
        #expect(plan.bot.localConfigPath != existingPath)
        #expect(plan.bot.localConfigPath?.contains("account-electric-sheep") == true)
        #expect(plan.bot.localConfigPath?.contains("electric-sheep-secondary") == true)
    }

    @Test func newBotSkipsAnOrphanedConfigAlreadyPresentOnDisk() throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let occupied = root
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(electricSheep.id, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .appendingPathComponent("electric-sheep-secondary", isDirectory: true)
            .appendingPathComponent("config.local.json")
        try FileManager.default.createDirectory(
            at: occupied.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data("orphaned".utf8).write(to: occupied)

        let plan = try DesktopNewBotPlan.make(
            account: electricSheep,
            appSlug: "electric-sheep-secondary",
            applicationSupportDirectory: root,
            occupiedConfigPaths: [],
            fileExists: { FileManager.default.fileExists(atPath: $0.path) }
        )

        #expect(plan.bot.localConfigPath != occupied.standardizedFileURL.path)
        #expect(plan.bot.localConfigPath?.contains("electric-sheep-secondary-2") == true)
    }

    @Test func newBotRejectsASlugWithATrailingLineTerminator() {
        #expect(throws: DesktopNewBotPlanError.invalidSlug) {
            try DesktopNewBotPlan.make(
                account: electricSheep,
                appSlug: "electric-sheep-secondary\n",
                applicationSupportDirectory: URL(
                    filePath: "/Users/test/Library/Application Support/NeonDiff",
                    directoryHint: .isDirectory
                ),
                occupiedConfigPaths: []
            )
        }
    }

    @Test func switchingAccountClearsEveryWorkspaceBoundRuntimeSelection() {
        var selection = DesktopAccountWorkspaceSelection(
            accountID: personal.id,
            botID: "personal-bot",
            repository: "personal/private-repo",
            providerID: "anthropic"
        )

        selection.selectAccount(electricSheep.id)

        #expect(selection.accountID == electricSheep.id)
        #expect(selection.botID == nil)
        #expect(selection.repository == nil)
        #expect(selection.providerID == nil)
    }

    @MainActor
    @Test func modelAccountSwitchInvalidatesPriorWorkspaceProofWithoutDeletingAuthority() {
        let fixture = ModelDependencyFixture()
        fixture.secretStore.values = ["provider/anthropic": "fixture-secret"]
        fixture.model.applyAccountWorkspaceCatalog(.loaded([personal, electricSheep]))
        fixture.model.repos = [RepoMonitor(name: "personal/private-repo", enabled: true)]
        fixture.model.providers.providerKeyStored = true
        fixture.model.github.installationCount = 1

        fixture.model.selectAccountWorkspace(electricSheep.id)

        #expect(fixture.model.selectedAccountWorkspace?.id == electricSheep.id)
        #expect(fixture.model.repos.isEmpty)
        #expect(!fixture.model.providers.providerKeyStored)
        #expect(fixture.model.github.installationCount == 0)
        #expect(fixture.secretStore.values == ["provider/anthropic": "fixture-secret"])
        #expect(fixture.model.configPath == fixture.fileWriter.applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent("_unselected", isDirectory: true)
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path)
    }

    @MainActor
    @Test func catalogRefreshRevokesASelectedBotAndItsWorkspaceProof() {
        let localBot = bot(
            id: "bot-local",
            slug: "local-bot",
            configPath: "/fixture/local-bot/config.local.json"
        )
        let account = workspace(id: "account-a", name: "Account A", bots: [localBot])
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))
        fixture.model.selectBotInstallation(localBot.id)
        fixture.model.repos = [RepoMonitor(name: "account-a/private", enabled: true)]

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(id: account.id, name: account.name, bots: [])
        ]))

        #expect(fixture.model.accountWorkspaceSelection.botID == nil)
        #expect(fixture.model.selectedBotInstallation == nil)
        #expect(fixture.model.repos.isEmpty)
        #expect(fixture.preferences.string(forKey: "neondiff.accountBotID") == nil)
    }

    @MainActor
    @Test func reselectingTheCurrentBotPreservesVerifiedRuntimeState() {
        let localBot = bot(
            id: "bot-local",
            slug: "local-bot",
            configPath: "/fixture/local-bot/config.local.json"
        )
        let account = workspace(id: "account-a", name: "Account A", bots: [localBot])
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))
        fixture.model.selectBotInstallation(localBot.id)
        fixture.model.repos = [RepoMonitor(name: "account-a/private", enabled: true)]
        fixture.model.providers.providerKeyStored = true

        fixture.model.selectBotInstallation(localBot.id)

        #expect(fixture.model.repos == [RepoMonitor(name: "account-a/private", enabled: true)])
        #expect(fixture.model.providers.providerKeyStored)
    }

    @MainActor
    @Test func explicitlyReselectingRestoredBotAbandonsPreservedPendingPlan() throws {
        let existingBot = bot(id: "bot-existing", slug: "existing-bot", configPath: nil)
        let account = workspace(id: "account-existing", name: "Existing Account", bots: [existingBot])
        let pendingBotID = "pending-75f906e6-08f9-4ca0-bf6a-e83b964543e2"
        let pendingConfigPath = fixtureURL("/fixture/model-app-support/Accounts/\(account.id)/Bots/new-neondiff-bot/config.local.json").path
        let persistedPlan = String(data: try JSONSerialization.data(withJSONObject: ["schemaVersion": 1, "accountID": account.id, "botID": pendingBotID, "appSlug": "new-neondiff-bot", "configPath": pendingConfigPath]), encoding: .utf8)!
        let fixture = ModelDependencyFixture(preferenceStrings: ["neondiff.accountWorkspaceID": account.id, "neondiff.accountBotID": existingBot.id, "neondiff.configPath": "/fixture/existing-bot/config.local.json", "neondiff.pendingNewBotPlan.v1": persistedPlan])
        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))
        #expect(fixture.model.accountWorkspaceSelection.botID == existingBot.id)
        #expect(fixture.preferences.string(forKey: "neondiff.pendingNewBotPlan.v1") == persistedPlan)
        fixture.model.repos = [RepoMonitor(name: "account-existing/private", enabled: true)]
        fixture.model.providers.providerKeyStored = true
        fixture.model.github.installationCount = 1
        let selectedConfigPath = fixture.model.configPath

        fixture.model.selectBotInstallation(existingBot.id)

        #expect(fixture.preferences.string(forKey: "neondiff.pendingNewBotPlan.v1") == nil)
        #expect(fixture.model.accountWorkspaceSelection.botID == existingBot.id)
        #expect(fixture.model.configPath == selectedConfigPath)
        #expect(fixture.model.repos == [RepoMonitor(name: "account-existing/private", enabled: true)])
        #expect(fixture.model.providers.providerKeyStored)
        #expect(fixture.model.github.installationCount == 1)
    }

    @MainActor
    @Test func catalogLocalPathLossInvalidatesSelectedBotRuntimeState() {
        let localBot = bot(
            id: "bot-local",
            slug: "local-bot",
            configPath: "/fixture/local-bot/config.local.json"
        )
        let account = workspace(id: "account-a", name: "Account A", bots: [localBot])
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))
        fixture.model.selectBotInstallation(localBot.id)
        fixture.model.repos = [RepoMonitor(name: "account-a/private", enabled: true)]

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(
                id: account.id,
                name: account.name,
                bots: [bot(id: localBot.id, slug: localBot.appSlug, configPath: nil)]
            )
        ]))

        #expect(fixture.model.repos.isEmpty)
        #expect(fixture.model.configPath.contains("Accounts/account-a/Bots/local-bot/config.local.json"))
        #expect(fixture.model.isOnboardingPresented)
    }

    @MainActor
    @Test func unchangedCatalogRefreshPreservesAPendingNewBotPlan() throws {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")
        let original = try #require(fixture.model.pendingNewBotPlan)

        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))

        #expect(fixture.model.pendingNewBotPlan == original)
        #expect(fixture.model.accountWorkspaceSelection.botID == original.bot.id)
        #expect(fixture.model.configPath == original.bot.localConfigPath)
    }

    @MainActor
    @Test func localBotDiscoveryDoesNotInvalidateAPendingNewBotPlan() throws {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")
        let original = try #require(fixture.model.pendingNewBotPlan)
        let local = DesktopLocalBotCandidate(
            botID: "bot-evaos-code-review-bot",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            githubAccountLogin: "electricsheephq",
            configPath: "/fixture/evaos-code-review-bot/config.local.json"
        )

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            electricSheep.merging(localCandidates: [local])
        ]))

        #expect(fixture.model.pendingNewBotPlan == original)
        #expect(fixture.model.accountWorkspaceSelection.botID == original.bot.id)
        #expect(fixture.model.configPath == original.bot.localConfigPath)
    }

    @MainActor
    @Test func authorityChangeInvalidatesAPendingNewBotPlanAndRuntimeState() {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")
        fixture.model.repos = [RepoMonitor(name: "electric/private", enabled: true)]
        fixture.model.providers.providerKeyStored = true
        let withdrawn = DesktopAccountWorkspace(
            id: electricSheep.id,
            kind: electricSheep.kind,
            name: electricSheep.name,
            role: electricSheep.role,
            entitlement: .none,
            bots: electricSheep.bots
        )

        fixture.model.applyAccountWorkspaceCatalog(.loaded([withdrawn]))

        #expect(fixture.model.pendingNewBotPlan == nil)
        #expect(fixture.model.accountWorkspaceSelection.botID == nil)
        #expect(fixture.model.repos.isEmpty)
        #expect(!fixture.model.providers.providerKeyStored)
    }

    @MainActor
    @Test func switchingWorkspaceClearsConfigAuthorizationOnboardingProofAndTransientGitHubInput() {
        let localBot = bot(
            id: "bot-local",
            slug: "local-bot",
            configPath: "/fixture/local-bot/config.local.json"
        )
        let accountA = workspace(id: "account-a", name: "Account A", bots: [localBot])
        let accountB = workspace(id: "account-b", name: "Account B", bots: [])
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([accountA, accountB]))
        fixture.model.configPath = localBot.localConfigPath!
        fixture.loadConfig()
        fixture.model.controlCenter.pollIntervalMs += 1
        #expect(fixture.model.canPreviewControlCenter)
        fixture.model.onboardingFlow.daemonBootstrapChecked = true
        fixture.model.onboardingFlow.licenseActivation = .activated
        fixture.model.pendingBYOGitHubAppId = "4184532"
        fixture.model.pendingBYOGitHubAppPrivateKey = "fixture-private-key"
        fixture.model.pendingActivationKey = "NDL-OLD-WORKSPACE-123456"
        fixture.model.pendingIssueRepoName = "account-a/old"
        fixture.model.controlCenter.pollIntervalMs += 1
        fixture.model.githubAuthorizationCode = GitHubDeviceAuthorizationCode(
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationURI: URL(string: "https://github.com/login/device")!,
            expiresAt: Date(timeIntervalSince1970: 2_000_000_000),
            intervalSeconds: 2
        )
        fixture.model.isGitHubAuthorizationInProgress = true
        fixture.model.isGitHubRepositoryRefreshInProgress = true

        fixture.model.selectAccountWorkspace(accountB.id)

        #expect(!fixture.model.canPreviewControlCenter)
        #expect(!fixture.model.onboardingFlow.daemonBootstrapChecked)
        #expect(fixture.model.onboardingFlow.licenseActivation == .servicePending)
        #expect(fixture.model.pendingBYOGitHubAppId.isEmpty)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        #expect(fixture.model.pendingActivationKey.isEmpty)
        #expect(fixture.model.pendingIssueRepoName.isEmpty)
        #expect(fixture.model.controlCenter == DesktopControlCenterSettings())
        #expect(fixture.model.githubAuthorizationCode == nil)
        #expect(!fixture.model.isGitHubAuthorizationInProgress)
        #expect(!fixture.model.isGitHubRepositoryRefreshInProgress)
    }

    @MainActor
    @Test func firstCatalogRestoresTheSavedAuthorizedBot() {
        let savedBot = bot(
            id: "bot-saved",
            slug: "saved-bot",
            configPath: nil
        )
        let account = workspace(id: "account-saved", name: "Saved Account", bots: [savedBot])
        let fixture = ModelDependencyFixture(preferenceStrings: [
            "neondiff.accountWorkspaceID": account.id,
            "neondiff.accountBotID": savedBot.id
        ])

        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))

        #expect(fixture.model.accountWorkspaceSelection.accountID == account.id)
        #expect(fixture.model.accountWorkspaceSelection.botID == savedBot.id)
        #expect(fixture.preferences.string(forKey: "neondiff.accountBotID") == savedBot.id)
    }

    @MainActor
    @Test func firstCatalogAllocatesAnIsolatedPlanForAnAccountWithoutBots() throws {
        let account = workspace(
            id: "account-new",
            name: "New Account",
            bots: []
        )
        let fixture = ModelDependencyFixture()

        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))

        let plan = try #require(fixture.model.pendingNewBotPlan)
        #expect(plan.accountID == account.id)
        #expect(fixture.model.accountWorkspaceSelection.accountID == account.id)
        #expect(fixture.model.accountWorkspaceSelection.botID == plan.bot.id)
        #expect(fixture.model.configPath == plan.bot.localConfigPath)
        #expect(!fixture.model.configPath.contains("/Accounts/_unselected/"))
        #expect(fixture.model.isOnboardingPresented)
    }

    @MainActor
    @Test func pendingNewBotPlanAndConfigPathSurviveRelaunch() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = "electricsheephq/evaos-code-review-bot-neondiff"
        let firstLaunch = ModelDependencyFixture(root: root)
        firstLaunch.model.applyAccountWorkspaceCatalog(.loaded([personal]))
        let original = try #require(firstLaunch.model.pendingNewBotPlan)
        let originalConfigPath = try #require(original.bot.localConfigPath)
        let originalConfigURL = URL(filePath: originalConfigPath)
        try FileManager.default.createDirectory(
            at: originalConfigURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"pilotRepos":["\#(repository)"]}"#.utf8)
            .write(to: originalConfigURL)

        let savedConfigPath = try #require(
            firstLaunch.preferences.string(forKey: "neondiff.configPath")
        )
        let savedBotID = try #require(
            firstLaunch.preferences.string(forKey: "neondiff.accountBotID")
        )
        let savedPendingPlan = try #require(
            firstLaunch.preferences.string(forKey: "neondiff.pendingNewBotPlan.v1")
        )
        var inspectPayload = try #require(
            JSONSerialization.jsonObject(
                with: Data(ModelDependencyFixture.configInspectJSON.utf8)
            ) as? [String: Any]
        )
        var inspectedConfig = try #require(inspectPayload["config"] as? [String: Any])
        inspectedConfig["pilotRepos"] = [repository]
        inspectPayload["config"] = inspectedConfig
        let inspectJSON = try #require(String(
            data: JSONSerialization.data(withJSONObject: inspectPayload),
            encoding: .utf8
        ))
        let relaunched = ModelDependencyFixture(
            root: root,
            cliOutcomes: [.success(CLIRunResult(
                exitCode: 0,
                stdout: inspectJSON,
                stderr: ""
            ))],
            preferenceStrings: [
                "neondiff.accountWorkspaceID": personal.id,
                "neondiff.accountBotID": savedBotID,
                "neondiff.configPath": savedConfigPath,
                "neondiff.pendingNewBotPlan.v1": savedPendingPlan
            ]
        )

        relaunched.model.applyAccountWorkspaceCatalog(.loaded([personal]))
        await relaunched.cli.waitUntilCallCount(1)
        for _ in 0..<100 where relaunched.model.isConfigInspectInProgress {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(relaunched.model.pendingNewBotPlan == original)
        #expect(relaunched.model.accountWorkspaceSelection.botID == original.bot.id)
        #expect(relaunched.model.configPath == originalConfigPath)
        #expect(relaunched.cli.calls[0].arguments == [
            "config", "inspect", "--config", originalConfigPath
        ])
        #expect(relaunched.model.lastError == nil)
        #expect(relaunched.model.repos.map(\.name) == [repository])
    }

    @MainActor
    @Test func explicitNewBotResumesPendingPlanAfterOlderBuildSelectionDrift() async throws {
        let root = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let repository = "electricsheephq/evaos-code-review-bot-neondiff"
        let firstLaunch = ModelDependencyFixture(root: root)
        firstLaunch.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        firstLaunch.model.beginNewBot()
        let original = try #require(firstLaunch.model.pendingNewBotPlan)
        let pendingConfigPath = try #require(original.bot.localConfigPath)
        let pendingConfigURL = URL(filePath: pendingConfigPath)
        let pendingConfigData = Data(#"{"pilotRepos":["\#(repository)"]}"#.utf8)
        try FileManager.default.createDirectory(
            at: pendingConfigURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try pendingConfigData.write(to: pendingConfigURL)
        let savedPendingPlan = try #require(
            firstLaunch.preferences.string(forKey: "neondiff.pendingNewBotPlan.v1")
        )

        let existingConfigURL = root
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(electricSheep.id, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .appendingPathComponent("evaos-code-review-bot", isDirectory: true)
            .appendingPathComponent("config.local.json")
        try FileManager.default.createDirectory(
            at: existingConfigURL.deletingLastPathComponent(),
            withIntermediateDirectories: true
        )
        try Data(#"{"pilotRepos":["electricsheephq/existing-bot"]}"#.utf8)
            .write(to: existingConfigURL)
        let existingBot = bot(
            id: "bot-evaos-code-review-bot",
            slug: "evaos-code-review-bot",
            configPath: existingConfigURL.path
        )
        let account = workspace(
            id: electricSheep.id,
            name: electricSheep.name,
            bots: [existingBot]
        )
        var pendingInspectPayload = try #require(
            JSONSerialization.jsonObject(
                with: Data(ModelDependencyFixture.configInspectJSON.utf8)
            ) as? [String: Any]
        )
        var pendingInspectedConfig = try #require(
            pendingInspectPayload["config"] as? [String: Any]
        )
        pendingInspectedConfig["pilotRepos"] = [repository]
        pendingInspectPayload["config"] = pendingInspectedConfig
        let pendingInspectJSON = try #require(String(
            data: JSONSerialization.data(withJSONObject: pendingInspectPayload),
            encoding: .utf8
        ))
        let reinstalled = ModelDependencyFixture(
            root: root,
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: ModelDependencyFixture.configInspectJSON,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: pendingInspectJSON,
                    stderr: ""
                ))
            ],
            preferenceStrings: [
                "neondiff.accountWorkspaceID": electricSheep.id,
                "neondiff.accountBotID": existingBot.id,
                "neondiff.configPath": existingConfigURL.path,
                "neondiff.pendingNewBotPlan.v1": savedPendingPlan
            ]
        )

        reinstalled.model.applyAccountWorkspaceCatalog(.loaded([account]))
        await reinstalled.cli.waitUntilCallCount(1)
        for _ in 0..<100 where reinstalled.model.isConfigInspectInProgress {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(reinstalled.model.selectedBotInstallation?.id == existingBot.id)
        #expect(reinstalled.model.pendingNewBotPlan == nil)
        #expect(reinstalled.model.configPath == existingConfigURL.path)
        #expect(
            reinstalled.preferences.string(forKey: "neondiff.pendingNewBotPlan.v1")
                == savedPendingPlan
        )

        reinstalled.model.beginNewBot()
        for _ in 0..<100 where reinstalled.cli.calls.count < 2 {
            try await Task.sleep(for: .milliseconds(10))
        }
        for _ in 0..<100 where reinstalled.model.isConfigInspectInProgress {
            try await Task.sleep(for: .milliseconds(10))
        }

        #expect(reinstalled.model.pendingNewBotPlan == original)
        #expect(reinstalled.model.accountWorkspaceSelection.botID == original.bot.id)
        #expect(reinstalled.model.configPath == pendingConfigPath)
        #expect(
            reinstalled.preferences.string(forKey: "neondiff.accountBotID")
                == original.bot.id
        )
        #expect(
            reinstalled.preferences.string(forKey: "neondiff.configPath")
                == pendingConfigPath
        )
        #expect(try Data(contentsOf: pendingConfigURL) == pendingConfigData)
        #expect(reinstalled.cli.calls.count == 2)
        if reinstalled.cli.calls.count == 2 {
            #expect(reinstalled.cli.calls[1].arguments == [
                "config", "inspect", "--config", pendingConfigPath
            ])
        }
        #expect(reinstalled.model.repos.map(\.name) == [repository])
    }

    @MainActor
    @Test func pendingNewBotRelaunchRejectsAConfigOutsideTheSelectedAccount() throws {
        let root = fixtureURL("/fixture/model-app-support", directory: true)
        let savedBotID = "pending-75f906e6-08f9-4ca0-bf6a-e83b964543e2"
        let injectedPath = root
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent("another-account", isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .appendingPathComponent("new-neondiff-bot", isDirectory: true)
            .appendingPathComponent("config.local.json")
            .path
        let serialized = String(
            data: try JSONSerialization.data(withJSONObject: [
                "schemaVersion": 1,
                "accountID": personal.id,
                "botID": savedBotID,
                "appSlug": "new-neondiff-bot",
                "configPath": injectedPath
            ]),
            encoding: .utf8
        )!
        let fixture = ModelDependencyFixture(
            root: root,
            preferenceStrings: [
                "neondiff.accountWorkspaceID": personal.id,
                "neondiff.accountBotID": savedBotID,
                "neondiff.configPath": injectedPath,
                "neondiff.pendingNewBotPlan.v1": serialized
            ]
        )

        fixture.model.applyAccountWorkspaceCatalog(.loaded([personal]))

        let replacement = try #require(fixture.model.pendingNewBotPlan)
        #expect(replacement.bot.id != savedBotID)
        #expect(replacement.bot.localConfigPath != injectedPath)
        #expect(replacement.bot.localConfigPath?.contains("/Accounts/\(personal.id)/Bots/") == true)
    }

    @MainActor
    @Test func staleConfigInspectCannotPopulateTheNewWorkspace() async throws {
        let botA = bot(id: "bot-a", slug: "bot-a", configPath: "/fixture/a/config.local.json")
        let botB = bot(id: "bot-b", slug: "bot-b", configPath: "/fixture/b/config.local.json")
        let accountA = workspace(id: "account-a", name: "Account A", bots: [botA])
        let accountB = workspace(id: "account-b", name: "Account B", bots: [botB])
        let resultA = ModelDependencyFixture.configInspectJSON
            .replacingOccurrences(of: "neondiff-bot", with: "bot-a")
        let resultB = ModelDependencyFixture.configInspectJSON
            .replacingOccurrences(of: "neondiff-bot", with: "bot-b")
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(exitCode: 0, stdout: resultA, stderr: "")),
                .success(CLIRunResult(exitCode: 0, stdout: resultB, stderr: ""))
            ],
            suspendCLIRuns: true
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([accountA, accountB]))
        fixture.model.selectBotInstallation(botA.id)
        await fixture.cli.waitUntilCallCount(1)

        fixture.model.selectAccountWorkspace(accountB.id)
        fixture.model.selectBotInstallation(botB.id)
        try await Task.sleep(for: .milliseconds(50))
        #expect(fixture.cli.calls.count == 2)

        fixture.cli.resumeSuspendedRuns()
        try await Task.sleep(for: .milliseconds(100))
        #expect(fixture.model.configPath == botB.localConfigPath)
        #expect(fixture.model.github.botLogin == "bot-b")
    }

    @MainActor
    @Test func modelNewBotStartsAnIsolatedLocalPlanWithoutInventingAServerBot() throws {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        let authoritativeBotIDs = fixture.model.selectedAccountWorkspace?.bots.map(\.id)

        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")

        let plan = try #require(fixture.model.pendingNewBotPlan)
        #expect(plan.accountID == electricSheep.id)
        #expect(fixture.model.selectedBotInstallation == nil)
        #expect(fixture.model.configPath == plan.bot.localConfigPath)
        #expect(fixture.model.isOnboardingPresented)
        #expect(fixture.model.selectedAccountWorkspace?.bots.map(\.id) == authoritativeBotIDs)
        #expect(fixture.model.selectedAccountWorkspace?.bots.contains(where: {
            $0.id == plan.bot.id
        }) == false)
    }

    @MainActor
    @Test func serverBotWithoutALocalMatchGetsItsOwnIsolatedSetupPath() {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))

        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")

        #expect(fixture.model.configPath == fixture.fileWriter.applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(electricSheep.id, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
            .appendingPathComponent("evaos-code-review-bot", isDirectory: true)
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path)
        #expect(fixture.model.isOnboardingPresented)
    }

    @MainActor
    @Test func repeatedNewBotPlanDoesNotReuseThePendingConfigPath() throws {
        let fixture = ModelDependencyFixture()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([electricSheep]))
        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")
        let firstPath = try #require(fixture.model.pendingNewBotPlan?.bot.localConfigPath)

        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")
        let secondPath = try #require(fixture.model.pendingNewBotPlan?.bot.localConfigPath)

        #expect(secondPath != firstPath)
        #expect(secondPath.contains("electric-sheep-secondary-2"))
    }

    private func bot(
        id: String,
        slug: String,
        configPath: String?,
        status: DesktopBotStatus = .verified
    ) -> DesktopBotInstallation {
        DesktopBotInstallation(
            id: id,
            appID: 4_184_532,
            appSlug: slug,
            mode: .byo,
            githubInstallationID: 72_001,
            githubAccountLogin: "electricsheephq",
            status: status,
            localConfigPath: configPath
        )
    }

    private func workspace(
        id: String,
        name: String,
        bots: [DesktopBotInstallation]
    ) -> DesktopAccountWorkspace {
        DesktopAccountWorkspace(
            id: id,
            kind: .organization,
            name: name,
            role: .admin,
            entitlement: .internalAdmin,
            bots: bots
        )
    }
}
