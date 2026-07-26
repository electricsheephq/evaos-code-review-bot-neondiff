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
        #expect(fixture.model.existingAccountEntitlementNeedsCurrentAccessVerification)
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
        #expect(!fixture.model.existingAccountEntitlementNeedsCurrentAccessVerification)
        #expect(fixture.model.repositorySetupReady)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(!fixture.model.customerRuntimeBoundaryMessage.contains("setup is configured"))
        #expect(fixture.model.customerRuntimeBoundaryMessage.contains("bot identity"))
    }

    @MainActor
    @Test func existingEntitlementRecoveryExitsOnboardingAndOpensRepositories() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))
        fixture.model.onboardingFlow.currentStep = .license
        fixture.model.isOnboardingPresented = true

        fixture.model.reviewExistingBotRepositoryAccess()

        #expect(fixture.model.selectedSection == .repos)
        #expect(!fixture.model.isOnboardingPresented)
        #expect(fixture.model.onboardingFlow.currentStep == .license)
        #expect(!fixture.model.productionUsefulWorkAvailable)
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
    @Test func reconciledGoldenPathCompletionPersistsInsteadOfReopeningEveryLaunch() async {
        let repository = "electricsheephq/PublicOS"
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: repository, visibility: .public)
        ])
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(existingBotConfigResult(authMode: "zcode-app-config")),
                .success(existingBotRepoPatchJSON(repository: repository)),
                .success(existingBotConfigResult(
                    authMode: "zcode-app-config",
                    repository: repository
                ))
            ],
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
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            DesktopAccountWorkspace(
                id: "account-electric-sheep",
                kind: .organization,
                name: "ElectricSheep",
                role: .admin,
                entitlement: .internalAdmin,
                bots: [bot]
            )
        ]))
        fixture.model.selectBotInstallation(bot.id)
        await fixture.cli.waitUntilCallCount(1)
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: repository)
        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()
        fixture.model.inspectConfig()
        await fixture.cli.waitUntilCallCount(3)
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        #expect(fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.providerSetupReady)

        fixture.model.onboardingFlow.currentStep = .done
        fixture.model.advanceOnboarding()

        #expect(!fixture.model.isOnboardingPresented)
        #expect(
            fixture.preferences.bool(
                forKey: "neondiff.hasCompletedActivationOnboarding.v2"
            )
        )
    }

    @MainActor
    @Test func currentKeyActivationDoesNotRenderAStaleNoEntitlementSummary() async {
        let repository = "electricsheephq/WorldOS"
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: repository, visibility: .private)
        ])
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(existingBotConfigResult(authMode: "zcode-app-config")),
                .success(existingBotRepoPatchJSON(repository: repository))
            ],
            githubBroker: broker,
            activationLicenseClient: ExistingBotActiveActivationClient(),
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
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            DesktopAccountWorkspace(
                id: "account-electric-sheep",
                kind: .organization,
                name: "ElectricSheep",
                role: .admin,
                entitlement: .none,
                bots: [bot]
            )
        ]))
        fixture.model.selectBotInstallation(bot.id)
        await fixture.cli.waitUntilCallCount(1)
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: repository)
        fixture.model.pendingActivationKey = "NDL-FIXTURE-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()
        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()

        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.selectedAccountEntitlementLabel == "No active entitlement")
        #expect(!fixture.model.existingAccountEntitlementSummaryReady)
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

private struct ExistingBotActiveActivationClient: ActivationLicenseClienting {
    func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .active(.init(
            status: .active,
            repoVisibilityScope: "private",
            privateRepoAllowed: true,
            updateEntitlement: true,
            expiresAt: nil,
            plan: "beta",
            seats: 1
        ))
    }

    func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        try await activate(key: key)
    }
}

private func existingBotRepoPatchJSON(repository: String) -> CLIRunResult {
    CLIRunResult(
        exitCode: 0,
        stdout: #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"pilotRepos":["\#(repository)"],"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"zcode","displayName":"ZCode GLM","baseUrl":"","model":"GLM-5.2","authMode":"zcode-app-config"}}}}}"#,
        stderr: ""
    )
}

private func existingBotConfigResult(
    authMode: String,
    repository: String = "electricsheephq/WorldOS"
) -> CLIRunResult {
    let adapter = authMode == "zcode-app-config" ? "zcode" : "openai-compatible"
    return CLIRunResult(
        exitCode: 0,
        stdout: #"""
        {
          "ok": true,
          "command": "config inspect",
          "revision": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "config": {
            "pilotRepos": ["\#(repository)"],
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
        """#,
        stderr: ""
    )
}

private let existingBotFixturePrivateKeyLabel = "PRIVATE" + " KEY"
private let existingBotFixturePrivateKey = """
-----BEGIN \(existingBotFixturePrivateKeyLabel)-----
ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
-----END \(existingBotFixturePrivateKeyLabel)-----
"""
