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

    @Test func installerActionRefreshesNewCredentialFreeWorkerWithoutRelaunch() {
        let fixture = ModelDependencyFixture(
            preferenceStrings: [
                "neondiff.cliPath": "neondiff",
                "neondiff.configPath":
                    "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account/Bots/new-bot/config.local.json"
            ],
            productionBoundary: exactB0Boundary
        )
        let workerCLI =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/com.electricsheephq.evaos-code-review-bot/current/node_modules/neondiff/dist/src/cli.js"
        fixture.model.localWorkerExecutionContextProvider = {
            [
                DesktopLocalBotExecutionContext(
                    configPath: "",
                    executablePath: "/usr/local/bin/node",
                    argumentPrefix: [workerCLI],
                    environmentOverrides: [:]
                )
            ]
        }

        #expect(!fixture.model.localWorkerCLIAvailable)
        fixture.model.openLocalWorkerUpdateGuide()

        #expect(fixture.model.localWorkerCLIAvailable)
        #expect(fixture.urlOpener.urls.isEmpty)
    }

    @Test func statusCheckRefreshesLateSealedWorkerForNativeInstallGate() {
        let configPath =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account/Bots/existing-bot/config.local.json"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            preferenceStrings: [
                "neondiff.cliPath": "neondiff",
                "neondiff.configPath": configPath
            ],
            productionBoundary: exactB0Boundary
        )
        fixture.model.localWorkerExecutionContextProvider = {
            [
                DesktopLocalBotExecutionContext(
                    configPath: "",
                    executablePath:
                        "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
                    argumentPrefix: [],
                    environmentOverrides: [:]
                )
            ]
        }

        #expect(!fixture.model.localWorkerCLIAvailable)
        fixture.model.refreshStatus()

        #expect(fixture.model.localWorkerCLIAvailable)
    }

    @Test func statusCheckIgnoresConfigBoundDuplicateOfUnboundSealedWorker() {
        let configPath =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account/Bots/existing-bot/config.local.json"
        let fixture = ModelDependencyFixture(
            suspendCLIRuns: true,
            preferenceStrings: [
                "neondiff.cliPath": "neondiff",
                "neondiff.configPath": configPath
            ],
            productionBoundary: exactB0Boundary
        )
        let sealedWorker =
            "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker"
        fixture.model.localWorkerExecutionContextProvider = {
            [
                DesktopLocalBotExecutionContext(
                    configPath: configPath,
                    executablePath: sealedWorker,
                    argumentPrefix: [],
                    environmentOverrides: [:]
                ),
                DesktopLocalBotExecutionContext(
                    configPath: "",
                    executablePath: sealedWorker,
                    argumentPrefix: [],
                    environmentOverrides: [:]
                )
            ]
        }

        #expect(!fixture.model.localWorkerCLIAvailable)
        fixture.model.refreshStatus()

        #expect(fixture.model.localWorkerCLIAvailable)
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

    @Test func isolatedNewBotCanReuseOneInstallerManagedWorker() {
        let configPath =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account-a/Bots/new-neondiff-bot/config.local.json"
        let workerCLI =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/v1.1.0-beta.44/current/node_modules/neondiff/dist/src/cli.js"
        let fixture = ModelDependencyFixture(
            preferenceStrings: [
                "neondiff.cliPath": "neondiff",
                "neondiff.configPath": configPath
            ],
            localBotExecutionContexts: [
                DesktopLocalBotExecutionContext(
                    configPath: "/Users/test/existing/config.local.json",
                    executablePath: "/usr/local/bin/node",
                    argumentPrefix: [workerCLI],
                    environmentOverrides: [:]
                )
            ],
            productionBoundary: exactB0Boundary
        )

        #expect(fixture.model.configPath == configPath)
        #expect(fixture.model.localWorkerCLIAvailable)
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
            preferenceStrings: availableCLIPreference,
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
            preferenceStrings: availableCLIPreference,
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

    @Test func byoRepositoryApplyKeepsPolicyProfilesAlignedWithRepositorySelection() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(CLIRunResult(
                exitCode: 0,
                stdout: byoRepoPatchJSON(repository: "acme/demo"),
                stderr: ""
            ))],
            preferenceStrings: availableCLIPreference,
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [
            RepoMonitor(name: "acme/demo", enabled: true),
            RepoMonitor(name: "acme/disabled", enabled: false)
        ]

        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()

        let write = try #require(fixture.fileWriter.writes.last)
        let patch = try #require(
            JSONSerialization.jsonObject(with: write.data) as? [String: Any]
        )
        #expect(patch["pilotRepos"] as? [String] == ["acme/demo"])
        let repoProfiles = try #require(patch["repoProfiles"] as? [String: Any])
        let repositories = try #require(repoProfiles["repos"] as? [String: Any])
        let selectedProfile = try #require(repositories["acme/demo"] as? [String: Any])
        let disabledProfile = try #require(repositories["acme/disabled"] as? [String: Any])
        #expect(selectedProfile["enabled"] as? Bool == true)
        #expect(disabledProfile["enabled"] as? Bool == false)
    }

    @Test func removingFinalRepositoryDisablesItsPersistedPolicyProfile() async throws {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(CLIRunResult(
                exitCode: 0,
                stdout: #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"pilotRepos":[],"repoProfiles":{"repos":{"acme/demo":{"enabled":false}}}}}"#,
                stderr: ""
            ))],
            preferenceStrings: availableCLIPreference,
            productionBoundary: exactB0Boundary
        )
        let repository = RepoMonitor(name: "acme/demo", enabled: true)
        fixture.model.repos = [repository]

        fixture.model.removeRepoFromAllowlist(repository)
        fixture.model.applyRepoAllowlistPatch()
        await fixture.waitForConfigPatchToFinish()

        let write = try #require(fixture.fileWriter.writes.last)
        let patch = try #require(
            JSONSerialization.jsonObject(with: write.data) as? [String: Any]
        )
        #expect(patch["pilotRepos"] as? [String] == [])
        let repoProfiles = try #require(patch["repoProfiles"] as? [String: Any])
        let repositories = try #require(repoProfiles["repos"] as? [String: Any])
        let removedProfile = try #require(repositories["acme/demo"] as? [String: Any])
        #expect(removedProfile["enabled"] as? Bool == false)
    }

    @Test func configInspectReusesExistingPolicyProfileCasing() throws {
        let snapshot = try #require(ConfigInspectParser.parse(
            #"{"ok":true,"command":"config inspect","config":{"pilotRepos":["acme/demo"],"repoProfiles":{"repos":{"Acme/Demo":{"enabled":false,"reviewProfile":"strict"}}}}}"#,
            providerKeyStored: false,
            licenseKeyStored: false
        ))

        #expect(snapshot.repos.map(\.name) == ["Acme/Demo"])
        #expect(snapshot.repos.map(\.profile) == ["strict"])
    }

    @Test func missingRepositoryProfileReportsPolicyRecoveryInsteadOfInstallationFailure() async {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(
                readChecks: doctorReadCheck(
                    repo: "acme/demo",
                    skippedByPolicy: "repo_profile_missing"
                ),
                exitCode: 1,
                ok: false
            ))],
            preferenceStrings: availableCLIPreference,
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.verifyBYOGitHubAppCredentials()
        await waitForBYOVerification(fixture)

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.lastError?.contains("repository policy") == true)
        #expect(fixture.model.lastError?.contains("Apply Repository") == true)
        #expect(fixture.model.lastError?.contains("App installation") == false)
    }

    @Test func disabledRepositoryProfileReportsPolicyRecoveryInsteadOfInstallationFailure() async {
        let fixture = ModelDependencyFixture(
            cliOutcomes: [.success(doctorResult(
                readChecks: doctorReadCheck(
                    repo: "acme/demo",
                    skippedByPolicy: "repo_profile_disabled"
                ),
                exitCode: 1,
                ok: false
            ))],
            preferenceStrings: availableCLIPreference,
            productionBoundary: exactB0Boundary
        )
        fixture.model.repos = [RepoMonitor(name: "acme/demo", enabled: true)]
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.verifyBYOGitHubAppCredentials()
        await waitForBYOVerification(fixture)

        #expect(!fixture.model.byoGitHubCredentialsVerified)
        #expect(fixture.model.lastError?.contains("repository policy") == true)
        #expect(fixture.model.lastError?.contains("Apply Repository") == true)
        #expect(fixture.model.lastError?.contains("App installation") == false)
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
            preferenceStrings: availableCLIPreference,
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
                preferenceStrings: availableCLIPreference,
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
            preferenceStrings: availableCLIPreference,
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
            preferenceStrings: availableCLIPreference,
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
            preferenceStrings: availableCLIPreference,
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
            preferenceStrings: availableCLIPreference,
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

private let availableCLIPreference = [
    "neondiff.cliPath": "/usr/bin/true"
]

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

private func doctorResult(
    readChecks: String,
    exitCode: Int32 = 0,
    ok: Bool = true
) -> CLIRunResult {
    CLIRunResult(
        exitCode: exitCode,
        stdout: #"{"ok":\#(ok),"command":"doctor github","appCredentials":{"appIdConfigured":true,"privateKeyConfigured":true,"source":"stdin"},"github":{"canPostAsApp":true,"readMode":"app_installation","readChecks":[\#(readChecks)]}}"#,
        stderr: ""
    )
}

private func doctorReadCheck(
    repo: String,
    skippedByPolicy: String? = nil,
    ok: Bool = true
) -> String {
    let skippedField = skippedByPolicy.map {
        #","skippedByPolicy":"\#($0)""#
    } ?? ""
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
