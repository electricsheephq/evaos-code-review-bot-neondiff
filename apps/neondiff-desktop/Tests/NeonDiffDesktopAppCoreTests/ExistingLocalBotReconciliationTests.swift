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
    @Test func publicFreeEntitlementDoesNotAppearActiveForBYORepository() {
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
        #expect(!fixture.model.licenseSetupReady)
        #expect(fixture.model.selectedAccountEntitlementLabel == "Public repositories only")
        #expect(!fixture.model.existingAccountEntitlementSummaryReady)
        #expect(!fixture.model.existingAccountEntitlementNeedsCurrentAccessVerification)
        #expect(!fixture.model.existingLocalBotSetupReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func activatedBYOBotKeepsRepositoryRecoveryUntilGitHubVerification() async {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            activationLicenseClient: ExistingBotActiveActivationClient(),
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))
        fixture.model.pendingActivationKey = "NDL-FIXTURE-0123456789"
        fixture.model.provideExistingActivationKey()

        await fixture.model.submitActivation()

        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.existingAccountEntitlementSummaryReady)
        #expect(fixture.model.existingAccountEntitlementNeedsCurrentAccessVerification)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func persistedReviewTargetActivatesWithoutCollapsingExistingMultiRepoAllowlist() async throws {
        let targetRepository = "electricsheephq/WorldOS"
        let otherRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let boundary = DesktopProductionBoundary.resolve(infoDictionary: [
            "NeonDiffPaidBetaContract": "paid-mac-beta-byo-v1",
            "NeonDiffBYOGitHubEnabled": true
        ])
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(CLIRunResult(
                exitCode: 0,
                stdout: """
                {"command":"license activate","ok":true,"status":"active","source":"api",
                 "checkedAt":"2026-07-27T00:00:00.000Z",
                 "entitlement":{"status":"active","repoVisibilityScope":"private",
                 "privateRepoAllowed":true,"updateEntitlement":true}}
                """,
                stderr: ""
            ))],
            preferenceStrings: [
                "neondiff.byoReviewRepository.v1": targetRepository
            ],
            productionBoundary: boundary
        )
        fixture.preferences.set(
            fixture.model.configPath,
            forKey: "neondiff.byoReviewRepositoryConfigPath.v1"
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [targetRepository, otherRepository]
        ))
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        await fixture.model.submitActivation()

        let call = try #require(fixture.cli.calls.first)
        #expect(call.arguments.contains("--repo"))
        #expect(call.arguments.contains(targetRepository))
        #expect(!call.arguments.contains(otherRepository))
        #expect(fixture.model.repos.filter(\.enabled).count == 2)
        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.activationState == .active)
    }

    @MainActor
    @Test func selectingReviewTargetPersistsExactConfigContextWithoutChangingAllowlist() {
        let firstRepository = "electricsheephq/WorldOS"
        let targetRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [firstRepository, targetRepository]
        ))
        let enabledBefore = fixture.model.repos.filter(\.enabled).map(\.name)

        fixture.model.selectBYOReviewRepository(fullName: targetRepository)

        #expect(fixture.model.selectedBYOReviewRepository == targetRepository)
        #expect(fixture.model.selectedReviewRepository == targetRepository)
        #expect(fixture.model.repos.filter(\.enabled).map(\.name) == enabledBefore)
        #expect(
            fixture.preferences.string(
                forKey: "neondiff.byoReviewRepository.v1"
            ) == targetRepository
        )
        #expect(
            fixture.preferences.string(
                forKey: "neondiff.byoReviewRepositoryConfigPath.v1"
            ) == fixture.model.configPath
        )
    }

    @MainActor
    @Test func persistedReviewTargetFromAnotherConfigFailsClosed() async {
        let targetRepository = "electricsheephq/WorldOS"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            preferenceStrings: [
                "neondiff.byoReviewRepository.v1": targetRepository,
                "neondiff.byoReviewRepositoryConfigPath.v1": "/fixture/another-bot.json"
            ],
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [
                targetRepository,
                "electricsheephq/evaos-code-review-bot-neondiff"
            ]
        ))
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        await fixture.model.submitActivation()

        #expect(fixture.model.selectedBYOReviewRepository == nil)
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.model.activationState == .serviceError)
        #expect(fixture.model.activationTargetSelectionRequired)
        #expect(fixture.model.lastError?.contains("Choose one Review Target") == true)
        #expect(!fixture.model.currentRepositoryActivationReady)
    }

    @MainActor
    @Test func activationAttemptLocksReviewTargetUntilServerBindingCanBeChangedSafely() async {
        let firstRepository = "electricsheephq/WorldOS"
        let secondRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let client = ExistingBotGatedActivationClient()
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            activationLicenseClient: client,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [firstRepository, secondRepository]
        ))
        fixture.model.selectBYOReviewRepository(fullName: firstRepository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        let activation = Task {
            await fixture.model.submitActivation()
        }
        #expect(await client.waitUntilStarted())
        fixture.model.selectBYOReviewRepository(fullName: secondRepository)
        #expect(fixture.model.selectedBYOReviewRepository == firstRepository)
        #expect(fixture.model.lastError?.contains("in progress") == true)
        client.release(.active(.init(
            status: .active,
            repoVisibilityScope: "private",
            privateRepoAllowed: true,
            updateEntitlement: true,
            expiresAt: nil,
            plan: "beta",
            seats: 1
        )))
        await activation.value

        #expect(fixture.model.selectedBYOReviewRepository == firstRepository)
        #expect(fixture.model.currentRepositoryActivationReady)
        fixture.model.selectBYOReviewRepository(fullName: secondRepository)
        #expect(fixture.model.selectedBYOReviewRepository == firstRepository)
        #expect(fixture.model.lastError?.contains("bound") == true)
    }

    @MainActor
    @Test func repositoryChangeDuringActivationReturnsToRetryableState() async {
        let firstRepository = "electricsheephq/WorldOS"
        let client = ExistingBotGatedActivationClient()
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            activationLicenseClient: client,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [
                firstRepository,
                "electricsheephq/evaos-code-review-bot-neondiff"
            ]
        ))
        fixture.model.selectBYOReviewRepository(fullName: firstRepository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        let activation = Task {
            await fixture.model.submitActivation()
        }
        #expect(await client.waitUntilStarted())
        fixture.model.configPath = "/fixture/another-bot.json"

        #expect(fixture.model.activationState == .keyReady)
        client.release(.active(.init(
            status: .active,
            repoVisibilityScope: "private",
            privateRepoAllowed: true,
            updateEntitlement: true,
            expiresAt: nil,
            plan: "beta",
            seats: 1
        )))
        await activation.value

        #expect(fixture.model.activationState == .keyReady)
        #expect(!fixture.model.currentRepositoryActivationReady)
    }

    @MainActor
    @Test func ambiguousActivationPinBlocksReconciledDifferentRepositoryRetry() async {
        let firstRepository = "electricsheephq/WorldOS"
        let secondRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let client = ExistingBotGatedActivationClient()
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            activationLicenseClient: client,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [firstRepository, secondRepository]
        ))
        fixture.model.selectBYOReviewRepository(fullName: firstRepository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        let activation = Task {
            await fixture.model.submitActivation()
        }
        #expect(await client.waitUntilStarted())
        fixture.model.configPath = "/fixture/another-bot.json"
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [secondRepository]
        ))
        client.release(.offline)
        await activation.value

        #expect(fixture.model.activationState == .keyReady)
        #expect(fixture.model.selectedBYOReviewRepository == secondRepository)

        await fixture.model.submitActivation()

        #expect(client.callCount == 1)
        #expect(fixture.model.activationState == .serviceError)
        #expect(fixture.model.lastError?.contains(firstRepository) == true)
    }

    @MainActor
    @Test func definitiveActivationRejectionDoesNotPinRepositoryTarget() async {
        let firstRepository = "electricsheephq/WorldOS"
        let secondRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            activationLicenseClient: ExistingBotRejectedActivationClient(),
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [firstRepository, secondRepository]
        ))
        fixture.model.selectBYOReviewRepository(fullName: firstRepository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()

        await fixture.model.submitActivation()
        fixture.model.selectBYOReviewRepository(fullName: secondRepository)

        #expect(fixture.model.activationState == .invalid)
        #expect(fixture.model.selectedBYOReviewRepository == secondRepository)
    }

    @MainActor
    @Test func stagedRepositoryCannotBecomeActivationTargetBeforeApply() {
        let appliedRepository = "electricsheephq/WorldOS"
        let stagedRepository = "electricsheephq/unapplied"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [
                appliedRepository,
                "electricsheephq/evaos-code-review-bot-neondiff"
            ]
        ))
        fixture.model.selectBYOReviewRepository(fullName: appliedRepository)
        fixture.model.pendingRepoName = stagedRepository
        fixture.model.addPendingRepoToAllowlist()

        fixture.model.selectBYOReviewRepository(fullName: stagedRepository)

        #expect(fixture.model.selectedBYOReviewRepository == appliedRepository)
        #expect(fixture.model.lastError?.contains("Apply") == true)
        #expect(!fixture.model.canSelectBYOReviewRepository(fullName: stagedRepository))
    }

    @MainActor
    @Test func multiRepoWorkerExplainsRuntimeScopeBlockAfterTargetSelection() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [
                "electricsheephq/WorldOS",
                "electricsheephq/evaos-code-review-bot-neondiff"
            ]
        ))
        fixture.model.selectBYOReviewRepository(
            fullName: "electricsheephq/WorldOS"
        )

        #expect(
            fixture.model.customerRuntimeBoundaryMessage
                .contains("multiple repositories")
        )
        #expect(!fixture.model.reviewTargetRuntimeReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func staleConfigInspectCannotReplaceCurrentRepositoryState() {
        let firstConfigPath = "/fixture/first-bot.json"
        let currentConfigPath = "/fixture/current-bot.json"
        let firstRepository = "electricsheephq/WorldOS"
        let currentRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.configPath = firstConfigPath
        let staleResult = existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [firstRepository]
        )
        fixture.loadConfig(staleResult)
        fixture.model.configPath = currentConfigPath
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [currentRepository]
        ))

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: staleResult, stderr: ""),
            fallbackCommand: "config inspect",
            configPath: firstConfigPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: true
        )

        #expect(fixture.model.configPath == currentConfigPath)
        #expect(fixture.model.repos.filter(\.enabled).map(\.name) == [currentRepository])
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
    @Test func scopedReviewRequiresTheProviderConfigurationUsedByZCode() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(existingBotConfig(authMode: "api-key-env"))
        fixture.model.providers.providerKeyStored = true
        fixture.model.providerVerification = ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-27T00:00:00Z",
            state: .healthy,
            mode: "live",
            detail: "Provider accepted current verification.",
            troubleshooting: [],
            configRevision: String(repeating: "a", count: 64)
        )

        #expect(fixture.model.providerSetupReady)
        #expect(!fixture.model.scopedReviewProviderReady)

        fixture.loadConfig(existingBotConfig(authMode: "zcode-app-config"))

        #expect(fixture.model.providerSetupReady)
        #expect(fixture.model.scopedReviewProviderReady)
    }

    @MainActor
    @Test func scopedReviewAcceptsAnExplicitProviderFromZCodesOwnNamespace() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(
            existingBotConfig(
                authMode: "zcode-app-config",
                zcodeProviderId: "different-provider"
            )
        )

        #expect(fixture.model.providerSetupReady)
        #expect(fixture.model.scopedReviewProviderReady)
    }

    @MainActor
    @Test func scopedReviewRejectsAMissingExplicitZCodeProviderBinding() {
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            productionBoundary: .testAccountLink
        )
        fixture.loadConfig(
            existingBotConfig(
                authMode: "zcode-app-config",
                zcodeProviderId: nil
            )
        )

        #expect(fixture.model.providerSetupReady)
        #expect(!fixture.model.scopedReviewProviderReady)
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
    @Test func incompatibleLocalWorkerBlocksReviewAndOffersVisibleRecovery() async throws {
        let repository = "electricsheephq/evaos-code-review-bot-neondiff"
        let staleHelp = #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--config"},{"name":"--repo"},{"name":"--pr"},{"name":"--dry-run"},{"name":"--confirm"}]}}"#
        let compatibleHelp = #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--config"},{"name":"--repo"},{"name":"--pr"},{"name":"--dry-run"},{"name":"--confirm"},{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [repository]
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: staleHelp,
                    stderr: ""
                ))
            ],
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }

        #expect(fixture.cli.calls[1].arguments == [
            "review-pr", "--help", "--config", configPath
        ])
        #expect(fixture.cli.calls[1].standardInput == nil)
        #expect(fixture.model.localWorkerReviewUpdateRequired)
        #expect(!fixture.model.scopedReviewExecutionAvailable)
        #expect(fixture.model.scopedReviewStatus.contains("update required"))

        fixture.model.openLocalWorkerUpdateGuide()
        #expect(fixture.urlOpener.urls.last?.absoluteString.contains(
            "docs/SETUP.md#update-an-existing-local-worker"
        ) == true)

        fixture.cli.enqueue(.success(CLIRunResult(
            exitCode: 0,
            stdout: compatibleHelp,
            stderr: ""
        )))
        fixture.model.checkLocalWorkerReviewCompatibility()
        await fixture.cli.waitUntilCallCount(3)
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }

        #expect(fixture.model.localWorkerReviewCompatibility.isCompatible)
        #expect(!fixture.model.localWorkerReviewUpdateRequired)
        #expect(fixture.model.scopedReviewStatus.contains("supports exact"))
    }

    @MainActor
    @Test func workerChangeWhileDryReviewIsRunningCannotRecreateApproval() async throws {
        let repository = "electricsheephq/evaos-code-review-bot-neondiff"
        let headSHA = String(repeating: "c", count: 40)
        let boundary = DesktopProductionBoundary.resolve(infoDictionary: [
            "NeonDiffPaidBetaContract": "paid-mac-beta-byo-v1",
            "NeonDiffBYOGitHubEnabled": true
        ])
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [repository]
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"electricsheephq/evaos-code-review-bot-neondiff","ok":true,"visibility_result":"private","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
                    stderr: ""
                )),
                .success(existingAgentLicenseStatus(
                    scope: "private",
                    privateRepoAllowed: true
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":true,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":699,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/699"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":1,"failed":0,"skippedProcessed":0}}"#,
                    stderr: ""
                ))
            ],
            activationLicenseClient: ExistingBotActiveActivationClient(),
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: boundary
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: repository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()
        fixture.model.verifyExistingLocalBotGitHubAccess()
        #expect(await reachesCallCount(fixture, 4))
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }
        #expect(fixture.model.scopedReviewExecutionAvailable)

        fixture.cli.suspendFutureRuns()
        fixture.model.pendingReviewPullNumber = "699"
        fixture.model.runScopedDryReview()
        await fixture.cli.waitUntilCallCount(5)
        fixture.model.cliPath = "/fixture/bin/neondiff-updated"
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }

        #expect(fixture.model.scopedDryRunHeadSHA == nil)
        #expect(!fixture.model.scopedLiveReviewConfirmationAvailable)
        #expect(fixture.model.localWorkerReviewCompatibility == .unknown)
    }

    @MainActor
    @Test func selectedExistingBYOBotPrefersItsExactLocalAgentOverStoredKeychainMaterial() async throws {
        let targetRepository =
            "electricsheephq/evaos-code-review-bot-neondiff"
        let otherRepository = "electricsheephq/WorldOS"
        let repositories = [
            otherRepository,
            targetRepository
        ]
        let readChecks =
            #"{"repo":"\#(targetRepository)","ok":true,"visibility_result":"private","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}"#
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: repositories
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[\#(readChecks)]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: """
                    {"command":"license status","ok":true,"status":"active","source":"api",
                     "checkedAt":"2026-07-29T00:00:00.000Z",
                     "entitlement":{"status":"active","repoVisibilityScope":"all",
                     "privateRepoAllowed":true,"updateEntitlement":true,
                     "plan":"internal-owner-recovery","seats":1}}
                    """,
                    stderr: ""
                ))
            ],
            suspendCLIRuns: true,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: targetRepository)
        fixture.model.pendingBYOGitHubAppId = "4184532"
        fixture.model.pendingBYOGitHubAppPrivateKey = existingBotFixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        #expect(fixture.model.existingLocalAgentAccessAvailable)
        #expect(fixture.model.existingLocalBotBYOGitHubVerificationAvailable)
        #expect(fixture.model.byoGitHubAppIdStored)
        #expect(fixture.model.byoGitHubPrivateKeyStored)

        // Relaunch restores the persisted state but not this launch's live
        // entitlement proof. Existing-agent verification must refresh it.
        fixture.model.activationState = .active
        #expect(!fixture.model.currentRepositoryActivationReady)

        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(3)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.cli.calls.count == 4)
        let githubCall = fixture.cli.calls[2]
        #expect(githubCall.arguments == [
            "doctor", "github",
            "--config", configPath,
            "--repo", targetRepository,
            "--json"
        ])
        #expect(githubCall.standardInput == nil)
        #expect(githubCall.timeout == 150)
        let entitlementCall = try #require(fixture.cli.calls.last)
        #expect(entitlementCall.arguments == [
            "license", "status",
            "--config", configPath,
            "--repo", targetRepository,
            "--refresh", "true",
            "--json"
        ])
        #expect(entitlementCall.standardInput == nil)
        #expect(fixture.model.repos.filter(\.enabled).count == 2)
        #expect(fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.activationState == .active)
        #expect(fixture.model.productionUsefulWorkAvailable)
        #expect(
            fixture.model.existingLocalBotBYOGitHubVerificationStatus
                .contains("entitlement")
        )

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .none)
        ]))
        #expect(!fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.existingLocalBotCurrentAccessVerified)
        #expect(!fixture.model.productionUsefulWorkAvailable)

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.cliPath = "/tmp/untrusted-neondiff"
        #expect(!fixture.model.existingLocalAgentAccessAvailable)
        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(
            fixture.model.existingLocalBotBYOGitHubVerificationStatus
                .contains("Custom executables never receive")
        )
    }

    @MainActor
    @Test func publicBotDiscoveryWithoutAnExecutionContextStaysInRecovery() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: ["electricsheephq/WorldOS"]
                    ),
                    stderr: ""
                ))
            ],
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: ["electricsheephq/WorldOS"]
        ))

        #expect(!fixture.model.existingLocalAgentAccessAvailable)
        #expect(
            fixture.model.existingLocalBotBYOGitHubVerificationStatus
                .contains("recovery")
        )
        let diagnosis =
            fixture.model.existingLocalBotBYOGitHubVerificationStatus
        fixture.model.verifyExistingLocalBotGitHubAccess()
        #expect(fixture.model.lastError == diagnosis)
        #expect(fixture.model.byoGitHubCredentialStatus == diagnosis)
    }

    @MainActor
    @Test func authorityDowngradeDropsInFlightExistingAgentEntitlement() async throws {
        let targetRepository =
            "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [targetRepository]
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"\#(targetRepository)","ok":true,"visibility_result":"private","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
                    stderr: ""
                )),
                .success(existingAgentLicenseStatus(
                    scope: "private",
                    privateRepoAllowed: true
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: """
                    {"command":"license status","ok":true,"status":"active","source":"api",
                     "checkedAt":"2026-07-29T00:00:00.000Z",
                     "entitlement":{"status":"active","repoVisibilityScope":"all",
                     "privateRepoAllowed":true,"updateEntitlement":true,
                     "plan":"internal-owner-recovery","seats":1}}
                    """,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [targetRepository]
                    ),
                    stderr: ""
                ))
            ],
            suspendCLIRuns: true,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20
            where fixture.model.localWorkerReviewCompatibility == .checking
        {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: targetRepository)
        fixture.model.activationState = .active

        fixture.cli.suspendFutureRuns()
        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(3)
        fixture.cli.resumeNextSuspendedRun()
        await fixture.cli.waitUntilCallCount(4)

        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .none)
        ]))
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20
            where fixture.model.isBYOGitHubVerificationInProgress
                || fixture.model.isConfigInspectInProgress
        {
            await Task.yield()
        }

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.existingLocalBotCurrentAccessVerified)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func privateRepositoryRejectsPublicOnlyExistingAgentEntitlement() async throws {
        let targetRepository =
            "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [targetRepository]
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"\#(targetRepository)","ok":true,"visibility_result":"private","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: """
                    {"command":"license status","ok":true,"status":"active","source":"api",
                     "checkedAt":"2026-07-29T00:00:00.000Z",
                     "entitlement":{"status":"active","repoVisibilityScope":"public",
                     "privateRepoAllowed":false,"updateEntitlement":false,
                     "plan":"public-free","seats":1}}
                    """,
                    stderr: ""
                ))
            ],
            suspendCLIRuns: true,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20
            where fixture.model.localWorkerReviewCompatibility == .checking
        {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: targetRepository)

        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(4)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.existingLocalBotCurrentAccessVerified)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.activationState == .invalid)
        #expect(
            fixture.model.lastError?.contains("does not cover private")
                == true
        )
    }

    @MainActor
    @Test func publicRepositoryAcceptsPrivateExistingAgentEntitlement() async throws {
        let fixture = await preparedExistingAgentVerificationFixture(
            visibility: "public",
            licenseResult: existingAgentLicenseStatus(
                scope: "private",
                privateRepoAllowed: true
            )
        )

        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(4)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.productionUsefulWorkAvailable)
    }

    @MainActor
    @Test func nonzeroStructuredExistingAgentStatusKeepsTypedExpiredState() async throws {
        let fixture = await preparedExistingAgentVerificationFixture(
            visibility: "private",
            licenseResult: CLIRunResult(
                exitCode: 1,
                stdout: """
                {"command":"license status","ok":false,"status":"expired","source":"api",
                 "checkedAt":"2026-07-29T00:00:00.000Z",
                 "entitlement":{"status":"expired","repoVisibilityScope":"private",
                 "privateRepoAllowed":true,"updateEntitlement":false,
                 "plan":"fixture-paid","seats":1}}
                """,
                stderr: ""
            )
        )

        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(4)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.model.activationState == .expired)
        #expect(!fixture.model.currentRepositoryActivationReady)
    }

    @MainActor
    @Test func exactWorkerStatusRefreshRunsEvenAfterNativeActivation() async throws {
        let fixture = await preparedExistingAgentVerificationFixture(
            visibility: "private",
            licenseResult: existingAgentLicenseStatus(
                scope: "private",
                privateRepoAllowed: true
            ),
            activationLicenseClient: ExistingBotActiveActivationClient()
        )
        fixture.model.pendingActivationKey = "NDL-FIXTURE-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()
        #expect(fixture.model.currentRepositoryActivationReady)

        fixture.model.verifyExistingLocalBotGitHubAccess()
        for _ in 0..<20 where fixture.cli.calls.count < 4 {
            await Task.yield()
        }
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.cli.calls.count == 4)
        #expect(fixture.cli.calls.last?.arguments.first == "license")
        #expect(fixture.model.currentRepositoryActivationReady)
    }

    @MainActor
    @Test func multiRepoExistingAgentWithoutStoredAppKeyUnlocksScopedReviewAfterReverify() async {
        let targetRepository =
            "electricsheephq/evaos-code-review-bot-neondiff"
        let fixture = await preparedExistingAgentVerificationFixture(
            visibility: "private",
            licenseResult: existingAgentLicenseStatus(
                scope: "private",
                privateRepoAllowed: true
            ),
            repositories: [
                "electricsheephq/WorldOS",
                targetRepository
            ]
        )

        #expect(!fixture.model.byoGitHubAppIdStored)
        #expect(!fixture.model.byoGitHubPrivateKeyStored)
        fixture.model.verifyExistingLocalBotGitHubAccess()
        #expect(await reachesCallCount(fixture, 4))
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        fixture.model.pendingReviewPullNumber = "708"
        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.scopedReviewExecutionAvailable)
        #expect(fixture.model.positivePendingReviewPullNumber == 708)
    }

    @MainActor
    @Test func staleExactWorkerStatusClearsOwnedProgressState() async throws {
        let fixture = await preparedExistingAgentVerificationFixture(
            visibility: "private",
            licenseResult: existingAgentLicenseStatus(
                scope: "private",
                privateRepoAllowed: true
            )
        )
        fixture.cli.suspendFutureRuns()
        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(3)
        fixture.cli.resumeNextSuspendedRun()
        await fixture.cli.waitUntilCallCount(4)
        #expect(fixture.model.isBYOGitHubVerificationInProgress)

        fixture.model.cliPath = "/fixture/bin/replaced-neondiff"
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(!fixture.model.isBYOGitHubVerificationInProgress)
        #expect(fixture.model.activationState != .activationPending)
        #expect(!fixture.model.currentRepositoryActivationReady)
    }

    @MainActor
    @Test func selectedTargetUnlocksScopedReviewButNotMultiRepoDaemonStart() async throws {
        let targetRepository = "electricsheephq/evaos-code-review-bot-neondiff"
        let otherRepository = "electricsheephq/WorldOS"
        let headSHA = String(repeating: "a", count: 40)
        let boundary = DesktopProductionBoundary.resolve(infoDictionary: [
            "NeonDiffPaidBetaContract": "paid-mac-beta-byo-v1",
            "NeonDiffBYOGitHubEnabled": true
        ])
        let activation = ExistingBotActiveActivationClient()
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: [otherRepository, targetRepository]
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"\#(targetRepository)","ok":true,"visibility_result":"private","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
                    stderr: ""
                )),
                .success(existingAgentLicenseStatus(
                    scope: "private",
                    privateRepoAllowed: true
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":true,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":0,"failed":0,"skippedProcessed":1}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":true,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":1,"failed":0,"skippedProcessed":0}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 1,
                    stdout: #"{"ok":false,"command":"review-pr","dryRun":false,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":0,"failed":0,"skippedProcessed":1}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":true,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":1,"failed":0,"skippedProcessed":0}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":true,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":1,"failed":0,"skippedProcessed":0}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","dryRun":false,"useZCode":true,"scope":{"repo":"electricsheephq/evaos-code-review-bot-neondiff","pullNumber":685,"headSha":"\#(headSHA)","url":"https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/685"},"result":{"reposScanned":1,"pullsSeen":1,"reviewed":1,"failed":0,"skippedProcessed":0}}"#,
                    stderr: ""
                ))
            ],
            suspendCLIRuns: true,
            activationLicenseClient: activation,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: boundary
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: targetRepository)
        fixture.model.pendingActivationKey = "NDL-BYO-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()
        fixture.model.verifyExistingLocalBotGitHubAccess()
        await fixture.cli.waitUntilCallCount(4)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(fixture.cli.calls[2].arguments == [
            "doctor", "github",
            "--config", configPath,
            "--repo", targetRepository,
            "--json"
        ])
        #expect(fixture.model.productionUsefulWorkAvailable)
        #expect(!fixture.model.productionDaemonStartAvailable)

        fixture.model.pendingReviewPullNumber = "685"
        fixture.model.runScopedDryReview()
        #expect(await reachesCallCount(fixture, 5))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }

        #expect(!fixture.model.scopedLiveReviewConfirmationAvailable)
        #expect(fixture.model.scopedReviewStatus.contains("failed closed"))

        fixture.model.runScopedDryReview()
        #expect(await reachesCallCount(fixture, 6))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }

        #expect(fixture.model.scopedDryRunHeadSHA == headSHA)
        #expect(fixture.model.scopedLiveReviewConfirmationAvailable)

        fixture.model.runScopedLiveReview()
        #expect(await reachesCallCount(fixture, 7))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }

        #expect(!fixture.model.scopedLiveReviewConfirmationAvailable)
        #expect(fixture.model.scopedReviewStatus.contains("failed closed"))

        fixture.model.runScopedDryReview()
        #expect(await reachesCallCount(fixture, 8))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }
        #expect(fixture.model.scopedLiveReviewConfirmationAvailable)
        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [otherRepository, targetRepository],
            revision: String(repeating: "b", count: 64)
        ))
        #expect(await reachesCallCount(fixture, 9))
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }
        #expect(!fixture.model.scopedLiveReviewConfirmationAvailable)
        fixture.model.runScopedLiveReview()
        await Task.yield()
        #expect(fixture.cli.calls.count == 9)

        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [otherRepository, targetRepository]
        ))
        #expect(await reachesCallCount(fixture, 10))
        for _ in 0..<20 where fixture.model.localWorkerReviewCompatibility == .checking {
            await Task.yield()
        }
        fixture.model.runScopedDryReview()
        #expect(await reachesCallCount(fixture, 11))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }
        fixture.model.runScopedLiveReview()
        #expect(await reachesCallCount(fixture, 12))
        for _ in 0..<20 where fixture.model.isScopedReviewInProgress {
            await Task.yield()
        }

        let liveCall = try #require(fixture.cli.calls.last)
        #expect(liveCall.arguments == [
            "review-pr",
            "--config", configPath,
            "--repo", targetRepository,
            "--pr", "685",
            "--head-sha", headSHA,
            "--expected-config-revision",
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "--dry-run", "false",
            "--confirm", "true",
            "--zcode", "true"
        ])
        #expect(fixture.model.scopedReviewStatus.contains("posted"))
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
        #expect(fixture.model.productionDaemonStartAvailable)

        fixture.loadConfig(existingBotConfig(
            authMode: "api-key-env",
            repositories: [repository]
        ))
        fixture.model.providers.providerKeyStored = true
        fixture.model.providerVerification = ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-27T00:00:00Z",
            state: .healthy,
            mode: "live",
            detail: "Provider accepted current verification.",
            troubleshooting: [],
            configRevision: String(repeating: "a", count: 64)
        )

        #expect(fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.providerSetupReady)
        #expect(!fixture.model.scopedReviewProviderReady)
        #expect(!fixture.model.productionDaemonStartAvailable)

        fixture.loadConfig(existingBotConfig(
            authMode: "zcode-app-config",
            repositories: [repository]
        ))

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

    @MainActor
    private func preparedExistingAgentVerificationFixture(
        visibility: String,
        licenseResult: CLIRunResult,
        activationLicenseClient: (any ActivationLicenseClienting)? = nil,
        repositories: [String]? = nil
    ) async -> ModelDependencyFixture {
        let targetRepository =
            "electricsheephq/evaos-code-review-bot-neondiff"
        let configuredRepositories = repositories ?? [targetRepository]
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: existingBotConfig(
                        authMode: "zcode-app-config",
                        repositories: configuredRepositories
                    ),
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#,
                    stderr: ""
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"configured"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"\#(targetRepository)","ok":true,"visibility_result":"\#(visibility)","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
                    stderr: ""
                )),
                .success(licenseResult)
            ],
            activationLicenseClient: activationLicenseClient,
            localBotConfigurations: [
                DesktopLocalBotConfiguration(
                    appID: 4_184_532,
                    configPath: configPath,
                    workingDirectory: "/fixture/evaos-code-review-bot"
                )
            ],
            localBotExecutionConfigPaths: [configPath],
            productionBoundary: .testAccountLink
        )
        fixture.model.applyAccountWorkspaceCatalog(.loaded([
            workspace(entitlement: .internalAdmin)
        ]))
        fixture.model.selectBotInstallation("bot-evaos-code-review-bot")
        await fixture.cli.waitUntilCallCount(1)
        for _ in 0..<20 where fixture.model.isConfigInspectInProgress {
            await Task.yield()
        }
        await fixture.cli.waitUntilCallCount(2)
        for _ in 0..<20
            where fixture.model.localWorkerReviewCompatibility == .checking
        {
            await Task.yield()
        }
        fixture.model.selectBYOReviewRepository(fullName: targetRepository)
        return fixture
    }

    private func existingAgentLicenseStatus(
        scope: String,
        privateRepoAllowed: Bool
    ) -> CLIRunResult {
        CLIRunResult(
            exitCode: 0,
            stdout: """
            {"command":"license status","ok":true,"status":"active","source":"api",
             "checkedAt":"2026-07-29T00:00:00.000Z",
             "entitlement":{"status":"active","repoVisibilityScope":"\(scope)",
             "privateRepoAllowed":\(privateRepoAllowed),"updateEntitlement":true,
             "plan":"fixture-paid","seats":1}}
            """,
            stderr: ""
        )
    }

    @MainActor
    private func reachesCallCount(
        _ fixture: ModelDependencyFixture,
        _ expected: Int
    ) async -> Bool {
        for _ in 0..<100 where fixture.cli.calls.count < expected {
            await Task.yield()
        }
        return fixture.cli.calls.count >= expected
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

    private func existingBotConfig(
        authMode: String,
        repositories: [String] = ["electricsheephq/WorldOS"],
        zcodeProviderId: String? = "zcode-glm",
        revision: String = String(repeating: "a", count: 64)
    ) -> String {
        let adapter = authMode == "zcode-app-config" ? "zcode" : "openai-compatible"
        let zcodeProviderEntry = zcodeProviderId.map {
            #""providerId": "\#($0)","#
        } ?? ""
        let repositoryJSON = repositories
            .map { "\"\($0)\"" }
            .joined(separator: ", ")
        return #"""
        {
          "ok": true,
          "command": "config inspect",
          "revision": "\#(revision)",
          "config": {
            "pilotRepos": [\#(repositoryJSON)],
            "zcode": {
              \#(zcodeProviderEntry)
              "model": "GLM-5.2",
              "cliPath": "zcode",
              "appConfigPath": "zcode.json"
            },
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

private struct ExistingBotRejectedActivationClient: ActivationLicenseClienting {
    func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .invalid
    }

    func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .invalid
    }
}

private final class ExistingBotGatedActivationClient:
    ActivationLicenseClienting,
    @unchecked Sendable
{
    private let lock = NSLock()
    private var continuation: CheckedContinuation<ActivationClientOutcome, Never>?
    private var startedContinuation: CheckedContinuation<Void, Never>?
    private var started = false
    private var activationCount = 0

    var callCount: Int {
        lock.withLock { activationCount }
    }

    func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        let shouldGate = lock.withLock {
            activationCount += 1
            return activationCount == 1
        }
        guard shouldGate else {
            return .offline
        }
        return await withCheckedContinuation { continuation in
            let startedContinuation = lock.withLock {
                started = true
                self.continuation = continuation
                let startedContinuation = self.startedContinuation
                self.startedContinuation = nil
                return startedContinuation
            }
            startedContinuation?.resume()
        }
    }

    func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        try await activate(key: key)
    }

    func waitUntilStarted() async -> Bool {
        await withCheckedContinuation { continuation in
            let alreadyStarted = lock.withLock {
                if started {
                    return true
                }
                startedContinuation = continuation
                return false
            }
            if alreadyStarted {
                continuation.resume()
            }
        }
        return true
    }

    func release(_ outcome: ActivationClientOutcome) {
        let pending = lock.withLock {
            let pending = continuation
            continuation = nil
            return pending
        }
        pending?.resume(returning: outcome)
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
            "zcode": {
              "providerId": "zcode-glm",
              "model": "GLM-5.2",
              "cliPath": "zcode",
              "appConfigPath": "zcode.json"
            },
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
