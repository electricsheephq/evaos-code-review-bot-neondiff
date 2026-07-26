import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct ExistingLocalBotReconciliationTests {
    private let configPath = "/fixture/evaos-code-review-bot/config.local.json"

    @MainActor
    @Test func verifiedExistingBotReconcilesSetupWithoutUnlockingUsefulWork() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(fixture.model.githubSetupReady)
        #expect(fixture.model.providerSetupReady)
        #expect(fixture.model.licenseSetupReady)
        #expect(fixture.model.repositorySetupReady)
        #expect(fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func accountWithoutEntitlementDoesNotAppearLicenseReady() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .none)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(fixture.model.githubSetupReady)
        #expect(fixture.model.providerSetupReady)
        #expect(!fixture.model.licenseSetupReady)
        #expect(fixture.model.repositorySetupReady)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func apiKeyProviderStillRequiresItsAppOwnedKeyOrVerification() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "api-key-env"))

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(!fixture.model.providerSetupReady)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func localConfigCannotInventOrCrossServerBotAuthority() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        let remoteOnly = DesktopBotInstallation(
            id: "bot-evaos-code-review-bot",
            appID: 4_184_532,
            appSlug: "evaos-code-review-bot",
            mode: .byo,
            githubInstallationID: 72_001,
            githubAccountLogin: "electricsheephq",
            status: .verified,
            localConfigPath: nil
        )
        let account = DesktopAccountWorkspace(
            id: "account-electric-sheep",
            kind: .organization,
            name: "ElectricSheep",
            role: .admin,
            entitlement: .internalAdmin,
            bots: [remoteOnly]
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([account]))
        fixture.model.selectBotInstallation(remoteOnly.id)
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(!fixture.model.existingLocalBotIdentityReady)
        #expect(!fixture.model.githubSetupReady)
        #expect(!fixture.model.licenseSetupReady)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    private func workspace(
        entitlement: DesktopAccountEntitlement
    ) -> DesktopAccountWorkspace {
        DesktopAccountWorkspace(
            id: "account-electric-sheep",
            kind: .organization,
            name: "ElectricSheep",
            role: .admin,
            entitlement: entitlement,
            bots: [
                DesktopBotInstallation(
                    id: "bot-evaos-code-review-bot",
                    appID: 4_184_532,
                    appSlug: "evaos-code-review-bot",
                    mode: .byo,
                    githubInstallationID: 72_001,
                    githubAccountLogin: "electricsheephq",
                    status: .verified,
                    localConfigPath: configPath
                )
            ]
        )
    }

    private func existingBotConfig(authMode: String) -> String {
        let adapter = authMode == "zcode-app-config" ? "zcode" : "openai-compatible"
        return #"""
        {
          "ok": true,
          "command": "config inspect",
          "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "config": {
            "pilotRepos": ["electricsheephq/WorldOS"],
            "providers": {
              "defaultProviderId": "zcode-glm",
              "providers": {
                "zcode-glm": {
                  "enabled": true,
                  "adapter": "\#(adapter)",
                  "displayName": "ZCode GLM",
                  "baseUrl": "",
                  "model": "GLM-5.2",
                  "authMode": "\#(authMode)"
                }
              }
            }
          }
        }
        """#
    }
}
