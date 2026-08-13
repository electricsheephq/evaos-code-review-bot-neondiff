import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct BYOGitHubAppCredentialOnboardingTests {
    @Test func missingConfiguredCLIBlocksStepOneAndRoutesToWorkerInstaller() {
        let guideURL = URL(
            string: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases/tag/v1.1.0-beta.37"
        )!
        let fixture = ModelDependencyFixture(
            preferenceStrings: [
                "neondiff.cliPath": "/fixture/missing/neondiff"
            ],
            productionBoundary: exactB0Boundary,
            localWorkerUpdateGuideURL: guideURL
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]

        #expect(!fixture.model.localWorkerCLIAvailable)
        #expect(fixture.model.localWorkerCLIStatus.contains("/fixture/missing/neondiff"))

        fixture.model.initializeConfigForOnboarding()
        fixture.model.applyRepoAllowlistPatch()
        fixture.model.verifyBYOGitHubAppCredentials()

        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.model.lastError?.contains("Install / Update Local Worker") == true)

        fixture.model.openLocalWorkerUpdateGuide()
        #expect(fixture.urlOpener.urls == [guideURL])
    }

    @Test func cleanInstallInitializationUsesNonDestructiveCLIInit() async {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(CLIRunResult(
                exitCode: 0,
                stdout: #"{"ok":true,"command":"init","created":true}"#,
                stderr: ""
            ))],
            preferenceStrings: [
                "neondiff.cliPath": "/usr/bin/true"
            ],
            productionBoundary: exactB0Boundary
        )

        #expect(fixture.model.localWorkerCLIAvailable)
        fixture.model.initializeConfigForOnboarding()
        await fixture.cli.waitUntilCallCount(1)

        let expectedConfigPath = fixture.fileWriter.applicationSupportDirectory
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path
        #expect(fixture.model.configPath == expectedConfigPath)
        #expect(fixture.cli.calls[0].executablePath == "/usr/bin/true")
        #expect(fixture.cli.calls[0].arguments == ["init", "--config", expectedConfigPath])
        #expect(!fixture.cli.calls[0].arguments.contains("--force"))
        #expect(fixture.model.configInitializeCommand.commandLine.contains(" init --config "))
        #expect(!fixture.model.configInitializeCommand.commandLine.contains("--force"))
    }

    @Test func repositoryRemovalIsBlockedDuringProviderVerificationCleanup() {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        let repository = RepoMonitor(name: "acme/demo", enabled: true)
        fixture.model.repos = [repository]
        fixture.model.isProviderVerificationInProgress = true

        fixture.model.removeRepoFromAllowlist(repository)

        #expect(fixture.model.repos == [repository])
        #expect(fixture.model.lastError?.contains("provider verification cleanup") == true)
    }

    @Test func exactB0BuildStoresPrivateKeyOnlyInFixedKeychainAccount() throws {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        #expect(!fixture.model.canAdvanceOnboarding)
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey

        fixture.model.storeBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == "123456")
        #expect(
            try fixture.secretStore.readSecret(account: BYOGitHubAppKeychainAccount.privateKey)
                == fixturePrivateKey
        )
        #expect(fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.byoGitHubCredentialsStored)
        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.canAdvanceOnboarding)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        #expect(fixture.model.pendingBYOGitHubAppId == "123456")
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.model.lastError == nil)
    }

    @Test func invalidInputFailsClosedWithoutPersistingOrEchoingSecret() {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        let invalidSecret = "not-a-private-key-sensitive-fixture"
        fixture.model.pendingBYOGitHubAppId = "not-an-app-id"
        fixture.model.pendingBYOGitHubAppPrivateKey = invalidSecret

        fixture.model.storeBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId")?.isEmpty != false)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
        #expect(!fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        #expect(fixture.model.lastError?.contains(invalidSecret) == false)
    }

    @Test func nonASCIIAppIdAndPrivateKeyBodyAreRejected() {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        fixture.model.pendingBYOGitHubAppId = "１２３４５６"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)

        fixture.model.pendingBYOGitHubAppId = "00123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)

        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey.replacingOccurrences(
            of: "Z",
            with: "é"
        )
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
    }

    @Test func managedOrQuarantinedBuildCannotEnterBYOCredentials() {
        for boundary in [DesktopProductionBoundary.testManaged, .quarantined] {
            let fixture = ModelDependencyFixture(productionBoundary: boundary)
            fixture.model.pendingBYOGitHubAppId = "123456"
            fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey

            fixture.model.storeBYOGitHubAppCredentials()

            #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == nil)
            #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
            #expect(!fixture.model.byoGitHubPrivateKeyStored)
            #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        }
    }

    @Test func removalDeletesOnlyTheFixedBYOKeyAndRetainsNoSecretInModel() throws {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.clearBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == nil)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
        #expect(!fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.pendingBYOGitHubAppId.isEmpty)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
    }

    @Test func explicitVerificationReadsKeychainAndUsesOnlyBoundedCLIStdin() async throws {
        let doctorResult = CLIRunResult(
            exitCode: 0,
            stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"stdin"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[{"repo":"acme/demo","ok":true,"visibility_result":"public","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true}]}}"#,
            stderr: ""
        )
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult)],
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.verifyBYOGitHubAppCredentials()
        await fixture.cli.waitUntilCallCount(1)
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        let call = try #require(fixture.cli.calls.first)
        #expect(call.arguments == [
            "doctor", "github",
            "--config", fixture.model.configPath,
            "--github-app-id", "123456",
            "--github-app-private-key-stdin", "true",
            "--json"
        ])
        #expect(call.standardInput == Data(fixturePrivateKey.utf8))
        #expect(!call.arguments.joined(separator: " ").contains(fixturePrivateKey))
        #expect(!fixture.model.lastCommandLine.contains(fixturePrivateKey))
        #expect(fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.isBYOGitHubVerificationInProgress)
        #expect(fixture.model.byoGitHubCredentialStatus.contains("acme/demo"))
        #expect(fixture.model.canAdvanceOnboarding)
        #expect(!fixture.model.repositoryConfigurationReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
        #expect(fixture.model.isOnboardingPresented)

        fixture.model.openReadOnlyAppFromQuarantinedOnboarding()

        #expect(!fixture.model.isOnboardingPresented)
        #expect(!fixture.preferences.bool(forKey: "neondiff.hasCompletedActivationOnboarding.v2"))

        fixture.model.configPath = "/tmp/changed-config.json"
        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.byoGitHubCredentialStatus.contains("Verify App access again"))
        #expect(!fixture.model.canAdvanceOnboarding)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
    }

    @Test func byoRepositoryReadinessDoesNotUnlockUnactivatedUsefulWork() async {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(
                readChecks: doctorReadCheck(repo: "acme/demo")
            ))],
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.model.verifyBYOGitHubAppCredentials()
        await waitForBYOVerification(fixture)

        #expect(!fixture.model.repositoryConfigurationReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)

        fixture.cli.enqueue(.success(CLIRunResult(
            exitCode: 0,
            stdout: byoRepoPatchJSON(repository: "acme/demo"),
            stderr: ""
        )))
        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()

        #expect(fixture.model.repositoryConfigurationReady)
        #expect(!fixture.model.currentRepositoryActivationReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)
    }

    @Test func cleanInstallBYOUnlocksAfterExactSetupAndActivation() async {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [
                .success(doctorResult(
                    readChecks: doctorReadCheck(repo: "acme/demo")
                )),
                .success(CLIRunResult(
                    exitCode: 0,
                    stdout: byoRepoPatchJSON(repository: "acme/demo"),
                    stderr: ""
                ))
            ],
            activationLicenseClient: ActiveBYOActivationClient(),
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.selectBYOReviewRepository(fullName: "acme/demo")
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.model.verifyBYOGitHubAppCredentials()
        await waitForBYOVerification(fixture)
        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()

        fixture.model.pendingActivationKey = "NDL-FIXTURE-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()

        #expect(fixture.model.selectedAccountWorkspace == nil)
        #expect(fixture.model.selectedBotInstallation == nil)
        #expect(fixture.model.currentRepositoryActivationReady)
        #expect(fixture.model.productionUsefulWorkAvailable)
    }

    @Test func verificationFailsClosedUnlessDoctorChecksExactlyMatchEnabledRepositories() async throws {
        struct Scenario {
            let name: String
            let configuredRepositories: [RepoMonitor]
            let readChecks: String
            let shouldVerify: Bool
        }

        let matchingChecks = [
            doctorReadCheck(repo: "acme/api"),
            doctorReadCheck(repo: "acme/demo")
        ].joined(separator: ",")
        let scenarios = [
            Scenario(
                name: "all normalized repositories match",
                configuredRepositories: [
                    RepoMonitor(name: "Acme/Demo", enabled: true),
                    RepoMonitor(name: "acme/api", enabled: true)
                ],
                readChecks: matchingChecks,
                shouldVerify: true
            ),
            Scenario(
                name: "stale on-disk repository set is missing the new repository",
                configuredRepositories: [
                    RepoMonitor(name: "acme/demo", enabled: true),
                    RepoMonitor(name: "acme/api", enabled: true)
                ],
                readChecks: doctorReadCheck(repo: "acme/demo"),
                shouldVerify: false
            ),
            Scenario(
                name: "doctor returns an extra repository",
                configuredRepositories: [RepoMonitor(name: "acme/demo", enabled: true)],
                readChecks: matchingChecks,
                shouldVerify: false
            ),
            Scenario(
                name: "doctor returns a duplicate repository",
                configuredRepositories: [RepoMonitor(name: "acme/demo", enabled: true)],
                readChecks: [
                    doctorReadCheck(repo: "acme/demo"),
                    doctorReadCheck(repo: "ACME/DEMO")
                ].joined(separator: ","),
                shouldVerify: false
            ),
            Scenario(
                name: "configured repository is policy skipped",
                configuredRepositories: [RepoMonitor(name: "acme/demo", enabled: true)],
                readChecks: doctorReadCheck(
                    repo: "acme/demo",
                    skippedByPolicy: "repo_profile_disabled"
                ),
                shouldVerify: false
            ),
            Scenario(
                name: "repository permission check failed",
                configuredRepositories: [RepoMonitor(name: "acme/demo", enabled: true)],
                readChecks: doctorReadCheck(repo: "acme/demo", ok: false),
                shouldVerify: false
            )
        ]

        for scenario in scenarios {
            let fixture = ModelDependencyFixture(
                cliOutcomes: [.success(doctorResult(readChecks: scenario.readChecks))],
                productionBoundary: exactB0Boundary
            )
            fixture.model.repos = scenario.configuredRepositories
            fixture.model.pendingBYOGitHubAppId = "123456"
            fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
            fixture.model.storeBYOGitHubAppCredentials()

            fixture.model.verifyBYOGitHubAppCredentials()
            await waitForBYOVerification(fixture)

            #expect(
                fixture.model.byoGitHubCredentialsVerified == scenario.shouldVerify,
                Comment(rawValue: scenario.name)
            )
            #expect(!fixture.model.repositoryConfigurationReady)
            #expect(
                !fixture.model.productionUsefulWorkAvailable,
                Comment(rawValue: scenario.name)
            )
            #expect(fixture.model.productionDaemonStopAvailable)
        }
    }

    @Test func enabledRepositoryMutationRevokesUsefulWorkUntilReverified() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(readChecks: doctorReadCheck(repo: "acme/demo")))],
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.model.verifyBYOGitHubAppCredentials()
        await waitForBYOVerification(fixture)

        #expect(fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.repositoryConfigurationReady)
        #expect(!fixture.model.productionUsefulWorkAvailable)

        fixture.model.repos.append(RepoMonitor(name: "acme/api", enabled: true))

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(!fixture.model.canAdvanceOnboarding)
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
    }

    @Test func contextMutationWhileDoctorRunsDiscardsOtherwiseSuccessfulProof() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(readChecks: doctorReadCheck(repo: "acme/demo")))],
            suspendCLIRuns: true,
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.verifyBYOGitHubAppCredentials()
        await fixture.cli.waitUntilCallCount(1)
        #expect(fixture.model.isBYOGitHubVerificationInProgress)

        fixture.model.repos.append(RepoMonitor(name: "acme/api", enabled: true))
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.byoGitHubCredentialStatus.contains("Configuration changed"))
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
    }

    @Test func workspaceSwitchDiscardsAStaleDoctorFailureWithoutMutatingNewWorkspace() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.failure(NSError(domain: "fixture-old-workspace", code: 1))],
            suspendCLIRuns: true,
            productionBoundary: exactB0Boundary
        )
        let accountA = fixtureWorkspace(id: "account-a")
        let accountB = fixtureWorkspace(id: "account-b")
        fixture.model.applyAccountWorkspaceCatalog(.loaded([accountA, accountB]))
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.model.verifyBYOGitHubAppCredentials()
        await fixture.cli.waitUntilCallCount(1)

        fixture.model.selectAccountWorkspace(accountB.id)
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 { await Task.yield() }

        #expect(fixture.model.selectedAccountWorkspace?.id == accountB.id)
        #expect(fixture.model.lastError == nil)
        #expect(!fixture.model.isBYOGitHubVerificationInProgress)
    }

    @Test func privateKeyRotationWhileDoctorRunsDiscardsOldKeyProof() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(readChecks: doctorReadCheck(repo: "acme/demo")))],
            suspendCLIRuns: true,
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.verifyBYOGitHubAppCredentials()
        await fixture.cli.waitUntilCallCount(1)
        #expect(fixture.model.isBYOGitHubVerificationInProgress)

        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = rotatedFixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        fixture.cli.resumeSuspendedRuns()
        for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
            await Task.yield()
        }

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.byoGitHubCredentialStatus.contains("Configuration changed"))
        #expect(!fixture.model.productionUsefulWorkAvailable)
        #expect(fixture.model.productionDaemonStopAvailable)
    }
}

private func fixtureWorkspace(id: String) -> DesktopAccountWorkspace {
    DesktopAccountWorkspace(
        id: id,
        kind: .organization,
        name: id,
        role: .admin,
        entitlement: .internalAdmin,
        bots: []
    )
}

@MainActor
private func waitForBYOVerification(_ fixture: ModelDependencyFixture) async {
    await fixture.cli.waitUntilCallCount(1)
    for _ in 0..<20 where fixture.model.isBYOGitHubVerificationInProgress {
        await Task.yield()
    }
}

private func byoRepoPatchJSON(repository: String) -> String {
    #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"pilotRepos":["\#(repository)"]}}"#
}

private func doctorResult(readChecks: String) -> CLIRunResult {
    CLIRunResult(
        exitCode: 0,
        stdout: #"{"ok":true,"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"stdin"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[\#(readChecks)]}}"#,
        stderr: ""
    )
}

private func doctorReadCheck(
    repo: String,
    skippedByPolicy: String? = nil,
    ok: Bool = true
) -> String {
    let skippedField = skippedByPolicy.map { #",\"skippedByPolicy\":\"\#($0)\""# } ?? ""
    return #"{"repo":"\#(repo)","ok":\#(ok),"visibility_result":"public","installation_id_present":true,"app_can_read_metadata":true,"app_can_read_pull_requests":true\#(skippedField)}"#
}

private let exactB0Boundary = DesktopProductionBoundary.resolve(infoDictionary: [
    "NeonDiffPaidBetaContract": "paid-mac-beta-byo-v1",
    "NeonDiffBYOGitHubEnabled": true
])

private struct ActiveBYOActivationClient: ActivationLicenseClienting {
    func activate(key _: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .active(ActivationEntitlementSummary(
            status: .active,
            repoVisibilityScope: "private",
            privateRepoAllowed: true,
            updateEntitlement: true,
            expiresAt: nil,
            plan: "fixture-paid",
            seats: 1
        ))
    }

    func revalidate(key _: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .serviceError
    }
}

private let fixturePrivateKeyLabel = "PRIVATE" + " KEY"
private let fixturePrivateKey = """
-----BEGIN \(fixturePrivateKeyLabel)-----
ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
-----END \(fixturePrivateKeyLabel)-----
"""
private let rotatedFixturePrivateKey = """
-----BEGIN \(fixturePrivateKeyLabel)-----
ZmFrZS1maXh0dXJlLXJvdGF0ZWQta2V5
-----END \(fixturePrivateKeyLabel)-----
"""
