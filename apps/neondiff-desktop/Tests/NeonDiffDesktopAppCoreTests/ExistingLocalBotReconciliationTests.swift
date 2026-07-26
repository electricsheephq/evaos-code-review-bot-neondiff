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
        #expect(!fixture.model.customerRuntimeBoundaryMessage.contains("setup is configured"))
        #expect(fixture.model.customerRuntimeBoundaryMessage.contains("bot identity"))
    }

    @MainActor
    @Test func publicFreeEntitlementIsDisplayedWithoutUnlockingUsefulWork() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .publicFree)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "none"))

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(fixture.model.providerSetupReady)
        #expect(fixture.model.licenseSetupReady)
        #expect(fixture.model.selectedAccountEntitlementLabel == "Public repositories only")
        #expect(fixture.model.existingLocalBotSetupReady)
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
    @Test func failedAPIKeyVerificationDoesNotAppearSetupReady() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "api-key-env"))
        fixture.model.providers.providerKeyStored = true
        fixture.model.providerVerification = ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-26T00:00:00Z",
            state: .configuredUnverified,
            mode: "metadata_only",
            detail: "Provider rejected current verification.",
            troubleshooting: [],
            configRevision: String(repeating: "a", count: 64)
        )

        #expect(!fixture.model.providerSetupReady)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func selectedExistingBYOBotReusesKeychainCredentialForReverification() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.pendingBYOGitHubAppId = "4184532"
        fixture.model.pendingBYOGitHubAppPrivateKey = existingBotFixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(fixture.model.byoGitHubPrivateKeyStored)
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(
            fixture.preferences.string(forKey: "neondiff.byoGitHubAppId")
                == "4184532"
        )
        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(fixture.model.byoGitHubCredentialOnboardingAvailable)
        #expect(fixture.model.byoGitHubAppIdStored)
        #expect(fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.existingLocalBotBYOGitHubVerificationAvailable)
        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func existingBYOBotExplainsAppIDMismatchWithoutBlamingAMissingKey() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.pendingBYOGitHubAppId = "999999"
        fixture.model.pendingBYOGitHubAppPrivateKey = existingBotFixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(!fixture.model.existingLocalBotBYOGitHubVerificationAvailable)
        #expect(
            fixture.model.existingLocalBotBYOGitHubVerificationStatus
                .contains("does not match")
        )
        #expect(
            !fixture.model.existingLocalBotBYOGitHubVerificationStatus
                .contains("not available")
        )
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func noKeyProviderDoesNotInventAKeyRequirement() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "none"))

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(!fixture.model.selectedProviderRequiresAPIKey)
        #expect(fixture.model.providerSetupReady)
        #expect(fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func managedExistingBotKeepsPrivateActivationRecoveryUntilRepositoryProofPasses() async {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electricsheephq/WorldOS", visibility: .private),
            GitHubBrokerRepository(fullName: "electricsheephq/PublicOS", visibility: .public)
        ])
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            githubBroker: broker,
            productionBoundary: .testManaged
        )
        let bot = DesktopBotInstallation(
            id: "bot-neondiff-managed",
            appID: 4_184_532,
            appSlug: "neondiff",
            mode: .managed,
            githubInstallationID: 42,
            githubAccountLogin: "electricsheephq",
            status: .verified,
            localConfigPath: configPath
        )
        fixture.model.applyAccountWorkspaceCatalog(
            DesktopAccountWorkspaceCatalog.loaded([
                DesktopAccountWorkspace(
                    id: "account-electric-sheep",
                    kind: .organization,
                    name: "ElectricSheep",
                    role: .admin,
                    entitlement: .internalAdmin,
                    bots: [bot]
                )
            ])
        )
        fixture.model.selectBotInstallation(bot.id)
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(
            fullName: "electricsheephq/WorldOS"
        )

        #expect(fixture.model.existingLocalBotIdentityReady)
        #expect(!fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.existingAccountEntitlementSummaryReady)

        fixture.model.selectManagedGitHubRepository(
            fullName: "electricsheephq/PublicOS"
        )

        #expect(fixture.model.existingAccountEntitlementSummaryReady)
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

private let existingBotFixturePrivateKeyLabel = "PRIVATE" + " KEY"
private let existingBotFixturePrivateKey = """
-----BEGIN \(existingBotFixturePrivateKeyLabel)-----
ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
-----END \(existingBotFixturePrivateKeyLabel)-----
"""
