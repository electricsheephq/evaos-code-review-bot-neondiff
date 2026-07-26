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

    @Test func localBotCannotCrossAnAuthoritativeGitHubAccountBoundary() {
        let local = DesktopLocalBotCandidate(
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            githubAccountLogin: "someone-else",
            configPath: "/tmp/other/config.local.json"
        )

        let merged = electricSheep.merging(localCandidates: [local])

        #expect(merged.bots.count == 1)
        #expect(merged.bots[0].localConfigPath == nil)
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
            occupiedConfigPaths: []
        )

        #expect(plan.bot.localConfigPath != occupied.standardizedFileURL.path)
        #expect(plan.bot.localConfigPath?.contains("electric-sheep-secondary-2") == true)
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
        fixture.model.repos = [RepoMonitor(name: "personal/private-repo", enabled: true)]
        fixture.model.providers.providerKeyStored = true
        fixture.model.github.installationCount = 1
        fixture.secretStore.values = ["provider/anthropic": "fixture-secret"]
        fixture.model.applyAccountWorkspaceCatalog(.loaded([personal, electricSheep]))

        fixture.model.selectAccountWorkspace(electricSheep.id)

        #expect(fixture.model.selectedAccountWorkspace?.id == electricSheep.id)
        #expect(fixture.model.repos.isEmpty)
        #expect(!fixture.model.providers.providerKeyStored)
        #expect(fixture.model.github.installationCount == 0)
        #expect(fixture.secretStore.values == ["provider/anthropic": "fixture-secret"])
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

        fixture.model.beginNewBot(appSlug: "electric-sheep-secondary")

        let plan = try #require(fixture.model.pendingNewBotPlan)
        #expect(plan.accountID == electricSheep.id)
        #expect(fixture.model.selectedBotInstallation == nil)
        #expect(fixture.model.configPath == plan.bot.localConfigPath)
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
