import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct DesktopKeychainWorkerLaunchAgentTests {
    private let home = URL(filePath: "/Users/test")
    private let appExecutable = URL(
        filePath: "/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop"
    )
    private let label = "com.electricsheephq.evaos-code-review-bot"
    private let appID = "4184532"
    private let licenseMachineID = String(repeating: "a", count: 43)

    @Test func restartPlanDoesNotKillTheFreshlyBootstrappedService() {
        let domain = "gui/501"
        let plistPath = "/Users/test/Library/LaunchAgents/\(label).plist"

        #expect(
            DesktopKeychainWorkerLaunchAgentContract.restartCommands(
                domain: domain,
                label: label,
                plistPath: plistPath,
                isLoaded: true
            ) == [
                ["bootout", "\(domain)/\(label)"],
                ["bootstrap", domain, plistPath]
            ]
        )
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.restartCommands(
                domain: domain,
                label: label,
                plistPath: plistPath,
                isLoaded: false
            ) == [
                ["bootstrap", domain, plistPath]
            ]
        )
    }

    @Test func stableServiceWinsOverTransientBootstrapExitFailure() {
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.restartOutcome(
                bootstrapStatus: 5,
                stablePIDObserved: true
            ) == .accepted
        )
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.restartOutcome(
                bootstrapStatus: 5,
                stablePIDObserved: false
            ) == .launchctlRejected
        )
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.restartOutcome(
                bootstrapStatus: 0,
                stablePIDObserved: false
            ) == .notReady
        )
    }

    @Test func restartObservationCoversDelayedLaunchdSpawn() {
        let observationWindowMicroseconds =
            DesktopKeychainWorkerLaunchAgentContract
                .restartObservationAttempts
            * Int(
                DesktopKeychainWorkerLaunchAgentContract
                    .restartObservationIntervalMicroseconds
            )

        #expect(observationWindowMicroseconds >= 30_000_000)
    }

    @Test func plistContainsOnlyPublicExactCoordinates() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
            licenseMachineID: licenseMachineID,
            configPath: config.path,
            launchdLabel: label,
            homeDirectory: home
        )
        let data = try DesktopKeychainWorkerLaunchAgentContract.propertyListData(
            request: request,
            appExecutableURL: appExecutable
        )
        let text = String(decoding: data, as: UTF8.self)

        #expect(!text.localizedCaseInsensitiveContains("private key"))
        #expect(!text.contains("github/byo-app/private-key"))
        #expect(!text.contains("NEONDIFF_GITHUB_APP_PRIVATE_KEY"))

        let parsed = try #require(
            DesktopKeychainWorkerLaunchAgentContract.parsePropertyList(
                data,
                expectedLabel: label,
                homeDirectory: home,
                appExecutableIsSafe: { $0 == self.appExecutable },
                configExists: { $0 == config }
            )
        )
        #expect(parsed == request)
    }

    @Test func sealedWorkerDaemonRunsLiveAfterExplicitNativeInstall() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
            licenseMachineID: licenseMachineID,
            configPath: config.path,
            launchdLabel: label,
            homeDirectory: home
        )

        let arguments = DesktopKeychainWorkerLaunchAgentContract
            .sealedWorkerDaemonArguments(request: request)

        #expect(arguments == [
            "daemon",
            "--config", config.path,
            "--runtime-credentials-stdin", "true",
            "--dry-run", "false"
        ])
        #expect(!arguments.contains(appID))
        #expect(!arguments.contains(licenseMachineID))
    }

    @Test func signedAppIssueRunIsExactLiveAndSecretFree() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let publicArguments = [
            "--neondiff-worker-issue-run",
            "--config", config.path,
            "--github-app-id", appID,
            "--license-machine-id", licenseMachineID,
            "--repo", "electricsheephq/lcm-x",
            "--issue", "153",
            "--dry-run", "false",
            "--confirm", "true"
        ]
        let request = try #require(
            DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
                publicArguments,
                homeDirectory: home
            )
        )

        #expect(DesktopKeychainWorkerLaunchAgentContract
            .sealedWorkerIssueRunArguments(request: request) == [
                "issue-enrichment-run",
                "--config", config.path,
                "--repo", "electricsheephq/lcm-x",
                "--issue", "153",
                "--dry-run", "false",
                "--confirm", "true",
                "--runtime-credentials-stdin", "true"
            ])
        #expect(!DesktopKeychainWorkerLaunchAgentContract
            .sealedWorkerIssueRunArguments(request: request).contains(appID))
        var dryRun = publicArguments
        dryRun[12] = "true"
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
            dryRun,
            homeDirectory: home
        ) == nil)
        var invalidRepository = publicArguments
        invalidRepository[8] = "bad repo"
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
            invalidRepository,
            homeDirectory: home
        ) == nil)
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
            publicArguments + ["--private-key", "forbidden"],
            homeDirectory: home
        ) == nil)

        let forcedPublicArguments = publicArguments + ["--force", "true"]
        let forcedRequest = try #require(
            DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
                forcedPublicArguments,
                homeDirectory: home
            )
        )
        #expect(DesktopKeychainWorkerLaunchAgentContract
            .sealedWorkerIssueRunArguments(request: forcedRequest).suffix(2) == [
                "--force", "true"
            ])
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseIssueRunArguments(
            publicArguments + ["--force", "false"],
            homeDirectory: home
        ) == nil)
    }

    @Test func previewExposesTheCompleteRedactedMutationPlan() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
            licenseMachineID: licenseMachineID,
            configPath: config.path,
            launchdLabel: label,
            homeDirectory: home
        )

        let preview = DesktopKeychainWorkerLaunchAgentContract
            .redactedPreviewText(
                request: request,
                appExecutableURL: appExecutable,
                sealedWorkerPath:
                    "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
                homeDirectory: home,
                preservedRepositoryCount: 53
            )

        #expect(preview.contains(
            "/Users/test/Library/LaunchAgents/\(label).plist"
        ))
        #expect(preview.contains(appExecutable.path))
        #expect(preview.contains(
            "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker"
        ))
        #expect(preview.contains("--config \(config.path)"))
        #expect(preview.contains("--launchd-label \(label)"))
        #expect(preview.contains("--github-app-id [stored App ID]"))
        #expect(preview.contains(
            "--license-machine-id [stored device ID]"
        ))
        #expect(preview.contains("EnvironmentVariables: none"))
        #expect(preview.contains(
            "RunAtLoad=true; KeepAlive=true; ProcessType=Background; Session=Aqua"
        ))
        #expect(preview.contains("stdout=/dev/null; stderr=/dev/null"))
        #expect(preview.contains(
            "Repository allowlist: preserved unchanged (53 configured repositories)"
        ))
        #expect(preview.contains("no config write"))
        #expect(!preview.contains(appID))
        #expect(!preview.contains(licenseMachineID))
        #expect(!preview.localizedCaseInsensitiveContains("private key"))
        #expect(!preview.localizedCaseInsensitiveContains("license key"))
    }

    @Test func headlessArgumentsFailClosedOutsideAccountConfigOrExactAppIdentity() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let arguments = [
            "--neondiff-worker-daemon",
            "--config", config.path,
            "--launchd-label", label,
            "--github-app-id", appID,
            "--license-machine-id", licenseMachineID
        ]

        #expect(DesktopKeychainWorkerLaunchAgentContract.parseHeadlessArguments(
            arguments,
            homeDirectory: home
        ) != nil)
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseHeadlessArguments(
            [
                "--neondiff-worker-daemon",
                "--config", "/tmp/config.local.json",
                "--launchd-label", label,
                "--github-app-id", appID
            ],
            homeDirectory: home
        ) == nil)
        #expect(DesktopKeychainWorkerLaunchAgentContract.parseHeadlessArguments(
            arguments + ["--private-key", "forbidden"],
            homeDirectory: home
        ) == nil)
    }

    @Test func exactLegacyLaunchAgentCanBeReplacedWithDeviceBoundContract() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
            licenseMachineID: licenseMachineID,
            configPath: config.path,
            launchdLabel: label,
            homeDirectory: home
        )
        let currentData = try DesktopKeychainWorkerLaunchAgentContract
            .propertyListData(
                request: request,
                appExecutableURL: appExecutable
            )
        var legacy = try #require(
            PropertyListSerialization.propertyList(
                from: currentData,
                options: [],
                format: nil
            ) as? [String: Any]
        )
        var arguments = try #require(legacy["ProgramArguments"] as? [String])
        arguments.removeLast(2)
        legacy["ProgramArguments"] = arguments
        let legacyData = try PropertyListSerialization.data(
            fromPropertyList: legacy,
            format: .xml,
            options: 0
        )

        #expect(DesktopKeychainWorkerLaunchAgentContract.parsePropertyList(
            legacyData,
            expectedLabel: label,
            homeDirectory: home,
            appExecutableIsSafe: { $0 == self.appExecutable },
            configExists: { $0 == config }
        ) == nil)
        #expect(DesktopKeychainWorkerLaunchAgentContract.parsePropertyList(
            legacyData,
            expectedLabel: label,
            homeDirectory: home,
            appExecutableIsSafe: { $0 == self.appExecutable },
            configExists: { $0 == config },
            legacyLicenseMachineID: licenseMachineID
        ) == request)
    }

    @Test func legacyReplacementMustMatchTheSelectedBotCoordinates() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
            licenseMachineID: licenseMachineID,
            configPath: config.path,
            launchdLabel: label,
            homeDirectory: home
        )
        let currentData = try DesktopKeychainWorkerLaunchAgentContract
            .propertyListData(
                request: request,
                appExecutableURL: appExecutable
            )
        var legacy = try #require(
            PropertyListSerialization.propertyList(
                from: currentData,
                options: [],
                format: nil
            ) as? [String: Any]
        )
        var arguments = try #require(legacy["ProgramArguments"] as? [String])
        arguments.removeLast(2)
        arguments[7] = "9999999"
        legacy["ProgramArguments"] = arguments
        let legacyData = try PropertyListSerialization.data(
            fromPropertyList: legacy,
            format: .xml,
            options: 0
        )

        #expect(!DesktopKeychainWorkerLaunchAgentContract
            .propertyListMatchesRequest(
                legacyData,
                request: request,
                homeDirectory: home,
                appExecutableIsSafe: { $0 == self.appExecutable },
                configExists: { $0 == config }
            ))
    }

    @Test func runtimeEnvelopeContainsBothKeychainSecretsOnlyInBoundedInput() throws {
        let privateKeyLabel = "PRIVATE" + " KEY"
        let privateKey = """
        -----BEGIN \(privateKeyLabel)-----
        ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
        -----END \(privateKeyLabel)-----
        """
        let data = try DesktopRuntimeCredentialEnvelope(
            appID: appID,
            privateKey: privateKey,
            licenseKey: "nd_live_runtime_fixture_1234",
            licenseMachineID: licenseMachineID
        ).encodedData()
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        #expect(object["schemaVersion"] as? Int == 2)
        #expect(object["githubAppId"] as? String == appID)
        #expect(object["githubPrivateKey"] as? String == privateKey)
        #expect(
            object["licenseKey"] as? String
                == "nd_live_runtime_fixture_1234"
        )
        #expect(object["licenseMachineId"] as? String == licenseMachineID)
    }

    @Test func runtimeEnvelopeNormalizesLegacyHexEncodedPrivateKeyInMemory() throws {
        let privateKeyLabel = "RSA PRIVATE" + " KEY"
        let privateKey = """
        -----BEGIN \(privateKeyLabel)-----
        ZmFrZS1sZWdhY3ktcHJpdmF0ZS1rZXk=
        -----END \(privateKeyLabel)-----
        """
        let legacyHex = privateKey.utf8.map {
            String(format: "%02x", $0)
        }.joined()

        let data = try DesktopRuntimeCredentialEnvelope(
            appID: appID,
            privateKey: legacyHex,
            licenseKey: "nd_live_runtime_fixture_1234",
            licenseMachineID: licenseMachineID
        ).encodedData()
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )

        #expect(object["githubPrivateKey"] as? String == privateKey)
        #expect(object["githubPrivateKey"] as? String != legacyHex)
    }

    @Test func runtimeEnvelopeRejectsHexThatDoesNotDecodeToAPrivateKey() {
        let nonKeyHex = "not-a-private-key".utf8.map {
            String(format: "%02x", $0)
        }.joined()

        #expect(throws: BYOGitHubAppCredentialError.invalidPrivateKey) {
            try DesktopRuntimeCredentialEnvelope(
                appID: appID,
                privateKey: nonKeyHex,
                licenseKey: "nd_live_runtime_fixture_1234",
                licenseMachineID: licenseMachineID
            )
        }
    }

    @Test func runtimeEnvelopeRejectsInvalidBrokerDeviceIdentity() {
        let privateKeyLabel = "PRIVATE" + " KEY"
        let privateKey = """
        -----BEGIN \(privateKeyLabel)-----
        ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
        -----END \(privateKeyLabel)-----
        """

        #expect(throws: DesktopRuntimeCredentialEnvelopeError.invalidLicenseMachineID) {
            try DesktopRuntimeCredentialEnvelope(
                appID: appID,
                privateKey: privateKey,
                licenseKey: "nd_live_runtime_fixture_1234",
                licenseMachineID: "local-host-hash"
            )
        }
    }

    @Test func credentialBearingCommandsRequireTheSignedBundledWorker() {
        #expect(DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "review-pr",
                "--config", "/fixture/config.local.json",
                "--runtime-credentials-stdin", "true"
            ],
            hasStandardInput: true
        ))
        #expect(DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "doctor", "github",
                "--config", "/fixture/config.local.json",
                "--github-app-private-key-stdin", "true"
            ],
            hasStandardInput: true
        ))
        #expect(DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "license", "activate",
                "--license-key-stdin", "true"
            ],
            hasStandardInput: true
        ))
        #expect(!DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "review-pr",
                "--config", "/fixture/config.local.json"
            ],
            hasStandardInput: false
        ))
    }

    @Test func deviceBoundLicenseStatusRequiresTheSignedBundledWorker() {
        #expect(DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "license", "status",
                "--config", "/fixture/config.local.json",
                "--repo", "electricsheephq/evaos-code-review-bot-neondiff",
                "--refresh", "true",
                "--license-machine-id", licenseMachineID,
                "--json"
            ],
            hasStandardInput: false
        ))
        #expect(!DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
            arguments: [
                "license", "status",
                "--config", "/fixture/config.local.json",
                "--repo", "electricsheephq/evaos-code-review-bot-neondiff",
                "--refresh", "true",
                "--json"
            ],
            hasStandardInput: false
        ))
    }

    @Test func trustedBundledWorkerUsesOnlySealedAppCoordinates() throws {
        let app = URL(filePath: "/Applications/NeonDiff.app")
        let context = try #require(
            DesktopTrustedBundledWorkerContract.executionContext(
                appBundleURL: app,
                appSignatureIsValid: { $0 == app },
                sealedFileIsValid: {
                    [
                        "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker"
                    ].contains($0.path)
                }
            )
        )
        #expect(
            context.executablePath
                == "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker"
        )
        #expect(context.argumentPrefix.isEmpty)
        #expect(context.environmentOverrides.isEmpty)
        #expect(DesktopTrustedBundledWorkerContract.executionContext(
            appBundleURL: app,
            appSignatureIsValid: { _ in false },
            sealedFileIsValid: { _ in true }
        ) == nil)
    }

    @Test func launchctlReadinessRequiresAStableRunningPID() {
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.runningPID(
                launchctlPrint: """
                state = running
                pid = 41845
                """
            ) == 41845
        )
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.runningPID(
                launchctlPrint: """
                state = waiting
                last exit code = 78
                """
            ) == nil
        )
        #expect(
            DesktopKeychainWorkerLaunchAgentContract.runningPID(
                launchctlPrint: """
                state = running
                pid = 0
                """
            ) == nil
        )
    }

    @Test func sealedWorkerWinsCleanSetupResolutionOverMutableInstalledWorker() {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        ).path
        let sealed = DesktopLocalBotExecutionContext(
            configPath: "",
            executablePath:
                "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
            argumentPrefix: [],
            environmentOverrides: [:]
        )
        let mutable = DesktopLocalBotExecutionContext(
            configPath: "",
            executablePath: "/opt/homebrew/bin/node",
            argumentPrefix: [
                "\(home.path)/Library/Application Support/NeonDiffDesktop/Workers/\(label)/current/node_modules/neondiff/dist/src/cli.js"
            ],
            environmentOverrides: [:]
        )
        let arguments = ["init", "--config", config]

        #expect(
            DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: "neondiff",
                arguments: arguments,
                executionContexts: [mutable, sealed]
            ) == sealed.executablePath
        )
        #expect(
            DesktopLocalBotExecutionContextResolver.resolveArguments(
                executablePath: "neondiff",
                arguments: arguments,
                executionContexts: [mutable, sealed]
            ) == arguments
        )
    }

    @Test func sealedWorkerRunsIsolatedDaemonStatusWithoutLaunchAgent() {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        ).path
        let sealed = DesktopLocalBotExecutionContext(
            configPath: "",
            executablePath:
                "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
            argumentPrefix: [],
            environmentOverrides: [:]
        )
        let status = [
            "daemon", "status",
            "--config", config,
            "--launchd-label", label
        ]

        #expect(
            DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: "neondiff",
                arguments: status,
                executionContexts: [sealed]
            ) == sealed.executablePath
        )
        #expect(
            DesktopLocalBotExecutionContextResolver.resolveArguments(
                executablePath: "neondiff",
                arguments: status,
                executionContexts: [sealed]
            ) == status
        )
        for mutation in ["start", "stop"] {
            #expect(
                DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                    executablePath: "neondiff",
                    arguments: [
                        "daemon", mutation,
                        "--config", config,
                        "--launchd-label", label
                    ],
                    executionContexts: [sealed]
                ) == nil
            )
        }
    }
}
