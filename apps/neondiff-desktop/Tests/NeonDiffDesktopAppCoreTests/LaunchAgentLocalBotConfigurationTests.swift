import Foundation
import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct LaunchAgentLocalBotConfigurationTests {
    @Test func parsesOnlyTheKnownLabelPublicAppIDAndAbsoluteConfigPath() throws {
        let configURL = URL(filePath: NSTemporaryDirectory())
            .appendingPathComponent("existing-neondiff-worker.json")
            .standardizedFileURL
        let data = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": "/never/read/this.pem"
            ],
            arguments: [
                "/opt/homebrew/bin/neondiff",
                "daemon",
                "--config",
                configURL.path
            ]
        )

        let parsed = DesktopLaunchAgentBotConfigurationParser.parse(
            data: data,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { $0 == configURL },
            workingDirectoryExists: {
                $0 == URL(filePath: "/Volumes/LEXAR/repos/evaos-code-review-bot")
                    .standardizedFileURL
            }
        )

        #expect(parsed == DesktopLocalBotConfiguration(
            appID: 4_184_532,
            configPath: configURL.path,
            workingDirectory: "/Volumes/LEXAR/repos/evaos-code-review-bot"
        ))
    }

    @Test func rejectsWrongLabelMissingConfigAndConflictingAppIDs() throws {
        let configURL = URL(filePath: "/tmp/existing-neondiff-worker.json")
        let wrongLabel = try propertyList(
            label: "com.example.other",
            environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
            arguments: ["neondiff", "daemon", "--config", configURL.path]
        )
        let conflictingIDs = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "NEONDIFF_GITHUB_APP_ID": "4332113"
            ],
            arguments: ["neondiff", "daemon", "--config", configURL.path]
        )

        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: wrongLabel,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: conflictingIDs,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
                arguments: ["neondiff", "daemon", "--config", configURL.path]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in false },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
                arguments: ["neondiff", "daemon", "--config", configURL.path],
                workingDirectory: "relative/path"
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
                arguments: ["neondiff", "daemon", "--config", configURL.path]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true },
            workingDirectoryExists: { _ in false }
        ) == nil)
    }

    @Test func rejectsDuplicateConfigFlagsIncludingATrailingBareFlag() throws {
        let configURL = URL(filePath: "/tmp/existing-neondiff-worker.json")
        let duplicateConfig = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
            arguments: [
                "neondiff",
                "daemon",
                "--config",
                configURL.path,
                "--config"
            ]
        )

        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: duplicateConfig,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true },
            workingDirectoryExists: { _ in true }
        ) == nil)
    }

    @Test func resolvesOnlyOneExactLocalConfigToItsVerifiedWorkingDirectory() {
        let configuration = DesktopLocalBotConfiguration(
            appID: 4_184_532,
            configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
            workingDirectory: "/Volumes/LEXAR/repos/evaos-code-review-bot"
        )
        let fallback = URL(filePath: "/fallback")

        #expect(DesktopLocalBotWorkingDirectoryResolver.resolve(
            arguments: [
                "daemon",
                "status",
                "--config",
                configuration.configPath,
                "--launchd-label",
                "com.electricsheephq.evaos-code-review-bot"
            ],
            localBotConfigurations: [configuration],
            fallback: fallback
        ) == URL(filePath: configuration.workingDirectory!).standardizedFileURL)

        #expect(DesktopLocalBotWorkingDirectoryResolver.resolve(
            arguments: [
                "daemon",
                "status",
                "--config",
                configuration.configPath,
                "--config",
                configuration.configPath
            ],
            localBotConfigurations: [configuration],
            fallback: fallback
        ) == fallback)

        #expect(DesktopLocalBotWorkingDirectoryResolver.resolve(
            arguments: ["daemon", "status", "--config", "/other/config.json"],
            localBotConfigurations: [configuration],
            fallback: fallback
        ) == fallback)
    }

    @Test func normalizesExistingWorkerCredentialCoordinatesForOneExactConfig() throws {
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyURL = URL(filePath: "/Users/test/.config/neondiff/app.pem")
            .standardizedFileURL
        let data = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyURL.path
            ],
            arguments: ["neondiff", "daemon", "--config", configPath]
        )

        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0 == privateKeyURL }
        )

        #expect(context == DesktopLocalBotExecutionContext(
            configPath: configPath,
            environmentOverrides: [
                "NEONDIFF_GITHUB_APP_ID": "4184532",
                "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH": privateKeyURL.path
            ]
        ))
        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: ["review-pr", "--config", configPath, "--repo", "owner/repo"],
            executionContexts: [context!]
        ) == context?.environmentOverrides)
        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: [
                "review-pr",
                "--config", configPath,
                "--config", configPath
            ],
            executionContexts: [context!]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "/tmp/untrusted-neondiff",
            arguments: ["review-pr", "--config", configPath],
            executionContexts: [context!]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: ["config", "inspect", "--config", configPath],
            executionContexts: [context!]
        ).isEmpty)
    }

    @Test func preservesTheExactDirectCLIExecutableFromTheExistingLaunchAgent() throws {
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let executablePath = "/Users/test/.nvm/versions/node/v24.0.0/bin/neondiff"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: [
                    "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                    "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                ],
                arguments: [
                    executablePath,
                    "daemon",
                    "--config",
                    configPath
                ]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        )

        #expect(context?.executablePath == executablePath)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: ["review-pr", "--config", configPath],
            executionContexts: [context!]
        ) == executablePath)
    }

    @Test func acceptsPackagedCLIAndPreservesOnlyTheExactSystemCAOption() throws {
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let baseEnvironment = [
            "EVAOS_REVIEW_BOT_APP_ID": "4184532",
            "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath,
            "NODE_OPTIONS": "--use-system-ca"
        ]
        let arguments = [
            "/opt/homebrew/bin/node",
            "\(workingDirectory)/dist/src/cli.js",
            "daemon",
            "--config",
            configPath
        ]

        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: baseEnvironment,
                arguments: arguments,
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        )
        #expect(context?.environmentOverrides == [
            "NEONDIFF_GITHUB_APP_ID": "4184532",
            "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH": privateKeyPath,
            "NODE_OPTIONS": "--use-system-ca"
        ])
        #expect(context?.executablePath == "/opt/homebrew/bin/node")
        #expect(context?.argumentPrefix == ["\(workingDirectory)/dist/src/cli.js"])

        var unsafeEnvironment = baseEnvironment
        unsafeEnvironment["NODE_OPTIONS"] = "--require /tmp/injected.js"
        #expect(DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: unsafeEnvironment,
                arguments: arguments,
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { _ in true }
        ) == nil)
    }

    @Test func acceptsOnlyTheExactInstallerManagedWorkerForTheKnownLabel() throws {
        let label = "com.electricsheephq.evaos-code-review-bot"
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let workerRoot = URL(filePath: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers")
            .appendingPathComponent(label, isDirectory: true)
            .standardizedFileURL
        let workerCLI = workerRoot
            .appendingPathComponent("current/node_modules/neondiff/dist/src/cli.js")
            .standardizedFileURL
        let arguments = [
            "/opt/homebrew/bin/node",
            workerCLI.path,
            "daemon",
            "--config",
            configPath
        ]
        let data = try propertyList(
            label: label,
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
            ],
            arguments: arguments,
            workingDirectory: workingDirectory
        )

        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: data,
            expectedLabel: label,
            installedWorkerRoot: workerRoot,
            configExists: { $0.path == configPath },
            workingDirectoryExists: { $0.path == workingDirectory }
        ) == DesktopLocalBotConfiguration(
            appID: 4_184_532,
            configPath: configPath,
            workingDirectory: workingDirectory
        ))

        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: label,
            installedWorkerRoot: workerRoot,
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        )
        #expect(context?.executablePath == "/opt/homebrew/bin/node")
        #expect(context?.argumentPrefix == [workerCLI.path])

        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: data,
            expectedLabel: label,
            configExists: { _ in true },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: label,
            installedWorkerRoot: workerRoot.deletingLastPathComponent()
                .appendingPathComponent("other-label", isDirectory: true),
            privateKeyPathIsSafe: { _ in true }
        ) == nil)
    }

    @Test func reusesInstallerManagedWorkerForAnIsolatedNewBotConfig() throws {
        let label = "com.electricsheephq.evaos-code-review-bot"
        let existingConfigPath =
            "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let isolatedConfigPath =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account/Bots/new-bot/config.local.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let workerRoot = URL(
            filePath: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers"
        )
        .appendingPathComponent(label, isDirectory: true)
        .standardizedFileURL
        let workerCLI = workerRoot
            .appendingPathComponent(
                "current/node_modules/neondiff/dist/src/cli.js"
            )
            .standardizedFileURL
        let context = try #require(
            DesktopLaunchAgentExecutionContextParser.parse(
                data: propertyList(
                    label: label,
                    environment: [
                        "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                        "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                    ],
                    arguments: [
                        nodePath,
                        workerCLI.path,
                        "daemon",
                        "--config",
                        existingConfigPath
                    ]
                ),
                expectedLabel: label,
                installedWorkerRoot: workerRoot,
                privateKeyPathIsSafe: { $0.path == privateKeyPath }
            )
        )
        let initialize = ["init", "--config", isolatedConfigPath]
        let inspect = ["config", "inspect", "--config", isolatedConfigPath]
        let patch = [
            "config", "patch",
            "--config", isolatedConfigPath,
            "--input", "/tmp/public-safe-patch.json",
            "--dry-run", "false",
            "--confirm", "true"
        ]

        for arguments in [initialize, inspect, patch] {
            #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: "neondiff",
                arguments: arguments,
                executionContexts: [context]
            ) == nodePath)
            #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
                executablePath: "neondiff",
                arguments: arguments,
                executionContexts: [context]
            ) == [workerCLI.path] + arguments)
            #expect(DesktopLocalBotExecutionContextResolver.resolve(
                executablePath: "neondiff",
                arguments: arguments,
                executionContexts: [context]
            ).isEmpty)
        }
    }

    @Test func reusesInstallerManagedWorkerForIsolatedBYODoctorOnlyWithStdin() throws {
        let label = "com.electricsheephq.evaos-code-review-bot"
        let existingConfigPath =
            "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let isolatedConfigPath =
            "/Users/test/Library/Application Support/NeonDiffDesktop/Accounts/account/Bots/new-bot/config.local.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let workerRoot = URL(
            filePath: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers"
        )
        .appendingPathComponent(label, isDirectory: true)
        .standardizedFileURL
        let workerCLI = workerRoot
            .appendingPathComponent(
                "current/node_modules/neondiff/dist/src/cli.js"
            )
            .standardizedFileURL
        let context = try #require(
            DesktopLaunchAgentExecutionContextParser.parse(
                data: propertyList(
                    label: label,
                    environment: [
                        "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                        "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                    ],
                    arguments: [
                        nodePath,
                        workerCLI.path,
                        "daemon",
                        "--config",
                        existingConfigPath
                    ]
                ),
                expectedLabel: label,
                installedWorkerRoot: workerRoot,
                privateKeyPathIsSafe: { $0.path == privateKeyPath }
            )
        )
        let verifiedArguments = [
            "doctor", "github",
            "--config", isolatedConfigPath,
            "--github-app-id", "4184532",
            "--github-app-private-key-stdin", "true",
            "--json"
        ]
        let missingStdinContract = [
            "doctor", "github",
            "--config", isolatedConfigPath,
            "--json"
        ]
        let widenedDoctorContract = verifiedArguments + ["--repo", "owner/repo"]

        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: verifiedArguments,
            executionContexts: [context]
        ) == nodePath)
        #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: "neondiff",
            arguments: verifiedArguments,
            executionContexts: [context]
        ) == [workerCLI.path] + verifiedArguments)
        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: verifiedArguments,
            executionContexts: [context]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: missingStdinContract,
            executionContexts: [context]
        ) == nil)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: widenedDoctorContract,
            executionContexts: [context]
        ) == nil)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: [
                "config", "patch",
                "--config", isolatedConfigPath,
                "--input", "/tmp/public-safe-patch.json",
                "--dry-run", "true",
                "--confirm", "true"
            ],
            executionContexts: [context]
        ) == nil)
    }

    @Test func preservesTheAcceptedSourceRunnerInvocationForDesktopCommands() throws {
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let sourceRunner = "\(workingDirectory)/node_modules/tsx/dist/cli.mjs"
        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: [
                    "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                    "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                ],
                arguments: [
                    nodePath,
                    sourceRunner,
                    "src/cli.ts",
                    "daemon",
                    "--config",
                    configPath
                ],
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        )

        #expect(context?.executablePath == nodePath)
        #expect(context?.argumentPrefix == [sourceRunner, "src/cli.ts"])
        #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: "neondiff",
            arguments: ["review-pr", "--config", configPath],
            executionContexts: [context!]
        ) == [sourceRunner, "src/cli.ts", "review-pr", "--config", configPath])
    }

    @Test func reusesTheExactSourceRunnerForCredentialFreeConfigInspection() throws {
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let sourceRunner = "\(workingDirectory)/node_modules/tsx/dist/cli.mjs"
        let arguments = ["config", "inspect", "--config", configPath]
        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: [
                    "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                    "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                ],
                arguments: [
                    nodePath,
                    sourceRunner,
                    "src/cli.ts",
                    "daemon",
                    "--config",
                    configPath
                ],
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        )

        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context!]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context!]
        ) == nodePath)
        #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context!]
        ) == [sourceRunner, "src/cli.ts"] + arguments)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: ["config", "inspect", "--config", "/other/config.json"],
            executionContexts: [context!]
        ) == nil)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "/tmp/custom-neondiff",
            arguments: arguments,
            executionContexts: [context!]
        ) == nil)
    }

    @Test func reusesTheExactSourceRunnerForCredentialFreeReviewCapabilityHelp() throws {
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath = "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let sourceRunner = "\(workingDirectory)/node_modules/tsx/dist/cli.mjs"
        let arguments = ["review-pr", "--help", "--config", configPath]
        let context = try #require(DesktopLaunchAgentExecutionContextParser.parse(
            data: propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: [
                    "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                    "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                ],
                arguments: [
                    nodePath,
                    sourceRunner,
                    "src/cli.ts",
                    "daemon",
                    "--config",
                    configPath
                ],
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        ))

        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ) == nodePath)
        #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ) == [sourceRunner, "src/cli.ts"] + arguments)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: ["review-pr", "--help", "--config", "/other/config.json"],
            executionContexts: [context]
        ) == nil)
    }

    @Test func reusesExactWorkerForCredentialFreeLiveEntitlementStatus() throws {
        let workingDirectory = "/Volumes/LEXAR/repos/evaos-code-review-bot"
        let configPath =
            "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json"
        let privateKeyPath = "/Users/test/.config/neondiff/app.pem"
        let nodePath = "/opt/homebrew/bin/node"
        let sourceRunner = "\(workingDirectory)/node_modules/tsx/dist/cli.mjs"
        let arguments = [
            "license", "status",
            "--config", configPath,
            "--repo", "electricsheephq/evaos-code-review-bot-neondiff",
            "--refresh", "true",
            "--json"
        ]
        let context = try #require(DesktopLaunchAgentExecutionContextParser.parse(
            data: propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: [
                    "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                    "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": privateKeyPath
                ],
                arguments: [
                    nodePath,
                    sourceRunner,
                    "src/cli.ts",
                    "daemon",
                    "--config",
                    configPath
                ],
                workingDirectory: workingDirectory
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { $0.path == privateKeyPath }
        ))

        #expect(DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ).isEmpty)
        #expect(DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ) == nodePath)
        #expect(DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: "neondiff",
            arguments: arguments,
            executionContexts: [context]
        ) == [sourceRunner, "src/cli.ts"] + arguments)
    }

    @Test func reviewCapabilityRequiresTheExactDryToLiveFlagContract() throws {
        let compatible = try #require(DesktopLocalWorkerReviewCapabilityReport.parse(
            #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--config"},{"name":"--expected-config-revision"},{"name":"--zcode"}]}}"#
        ))
        #expect(compatible.supportsExactDryToLiveReview)
        #expect(compatible.licenseBoundary?.packageVersion == "1.0.4")

        let stale = try #require(DesktopLocalWorkerReviewCapabilityReport.parse(
            #"{"ok":true,"command":"review-pr","licenseBoundary":{"packageVersion":"1.0.4"},"usage":{"command":"review-pr","flags":[{"name":"--config"}]}}"#
        ))
        #expect(!stale.supportsExactDryToLiveReview)
        #expect(DesktopLocalWorkerReviewCapabilityReport.parse("not json") == nil)
    }

    @Test func rejectsUnsafeOrConflictingExistingWorkerCredentialCoordinates() throws {
        let configPath = "/tmp/neondiff.json"
        let baseEnvironment = [
            "EVAOS_REVIEW_BOT_APP_ID": "4184532",
            "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": "/Users/test/app.pem"
        ]
        let data = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: baseEnvironment,
            arguments: ["neondiff", "daemon", "--config", configPath]
        )
        #expect(DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { _ in false }
        ) == nil)

        var conflicting = baseEnvironment
        conflicting["NEONDIFF_GITHUB_APP_ID"] = "4332113"
        #expect(DesktopLaunchAgentExecutionContextParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: conflicting,
                arguments: ["neondiff", "daemon", "--config", configPath]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { _ in true }
        ) == nil)
    }

    @Test func rejectsSameLabelCredentialPlistForAnUnrelatedCommand() throws {
        let configPath = "/tmp/neondiff.json"
        let data = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH": "/Users/test/app.pem"
            ],
            arguments: [
                "/usr/bin/python3",
                "/tmp/unrelated.py",
                "--config",
                configPath
            ]
        )

        #expect(DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            privateKeyPathIsSafe: { _ in true }
        ) == nil)
    }

    private func propertyList(
        label: String,
        environment: [String: String],
        arguments: [String],
        workingDirectory: String = "/Volumes/LEXAR/repos/evaos-code-review-bot"
    ) throws -> Data {
        try PropertyListSerialization.data(
            fromPropertyList: [
                "Label": label,
                "EnvironmentVariables": environment,
                "ProgramArguments": arguments,
                "WorkingDirectory": workingDirectory
            ],
            format: .xml,
            options: 0
        )
    }
}
