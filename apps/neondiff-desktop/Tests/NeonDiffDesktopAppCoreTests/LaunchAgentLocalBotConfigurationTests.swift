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
            configExists: { $0 == configURL }
        )

        #expect(parsed == DesktopLocalBotConfiguration(
            appID: 4_184_532,
            configPath: configURL.path
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
            configExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: conflictingIDs,
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in true }
        ) == nil)
        #expect(DesktopLaunchAgentBotConfigurationParser.parse(
            data: try propertyList(
                label: "com.electricsheephq.evaos-code-review-bot",
                environment: ["EVAOS_REVIEW_BOT_APP_ID": "4184532"],
                arguments: ["neondiff", "--config", configURL.path]
            ),
            expectedLabel: "com.electricsheephq.evaos-code-review-bot",
            configExists: { _ in false }
        ) == nil)
    }

    private func propertyList(
        label: String,
        environment: [String: String],
        arguments: [String]
    ) throws -> Data {
        try PropertyListSerialization.data(
            fromPropertyList: [
                "Label": label,
                "EnvironmentVariables": environment,
                "ProgramArguments": arguments
            ],
            format: .xml,
            options: 0
        )
    }
}
