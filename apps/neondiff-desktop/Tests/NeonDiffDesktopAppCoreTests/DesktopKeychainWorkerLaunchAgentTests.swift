import Foundation
import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct DesktopKeychainWorkerLaunchAgentTests {
    private let home = URL(filePath: "/Users/test")
    private let appExecutable = URL(
        filePath: "/Applications/NeonDiff.app/Contents/MacOS/NeonDiff"
    )
    private let label = "com.electricsheephq.evaos-code-review-bot"
    private let appID = "4184532"

    @Test func plistContainsOnlyPublicExactCoordinates() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let request = try DesktopKeychainWorkerLaunchAgentRequest(
            appID: appID,
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

    @Test func headlessArgumentsFailClosedOutsideAccountConfigOrExactAppIdentity() throws {
        let config = home.appending(
            path: "Library/Application Support/NeonDiffDesktop/Accounts/account-1/Bots/bot-1/config.local.json"
        )
        let arguments = [
            "--neondiff-worker-daemon",
            "--config", config.path,
            "--launchd-label", label,
            "--github-app-id", appID
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
            licenseKey: "nd_live_runtime_fixture_1234"
        ).encodedData()
        let object = try #require(
            JSONSerialization.jsonObject(with: data) as? [String: Any]
        )
        #expect(object["schemaVersion"] as? Int == 1)
        #expect(object["githubAppId"] as? String == appID)
        #expect(object["githubPrivateKey"] as? String == privateKey)
        #expect(
            object["licenseKey"] as? String
                == "nd_live_runtime_fixture_1234"
        )
    }
}
