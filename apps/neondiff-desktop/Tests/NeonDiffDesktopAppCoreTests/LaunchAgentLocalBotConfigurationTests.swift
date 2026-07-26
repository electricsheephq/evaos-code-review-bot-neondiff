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
            arguments: ["neondiff", "--config", configURL.path]
        )
        let conflictingIDs = try propertyList(
            label: "com.electricsheephq.evaos-code-review-bot",
            environment: [
                "EVAOS_REVIEW_BOT_APP_ID": "4184532",
                "NEONDIFF_GITHUB_APP_ID": "4332113"
            ],
            arguments: ["neondiff", "--config", configURL.path]
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
                arguments: ["neondiff", "--config", configURL.path]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in false },
            workingDirectoryExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
                arguments: ["neondiff", "--config", configURL.path],
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
                arguments: ["neondiff", "--config", configURL.path]
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
