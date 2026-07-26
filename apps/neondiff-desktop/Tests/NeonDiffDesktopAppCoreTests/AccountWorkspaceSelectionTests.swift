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
}
