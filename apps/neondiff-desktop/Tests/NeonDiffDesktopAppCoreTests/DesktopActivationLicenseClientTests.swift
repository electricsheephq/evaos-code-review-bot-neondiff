import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct DesktopActivationLicenseClientTests {
    @Test func bindsActivationToBrokerDeviceAndRepositoryWithoutArgvSecret() async throws {
        let rawKey = "nd_live_keychain-desktop-fixture"
        let cli = RecordingCLIExecutor(result: CLIRunResult(
            exitCode: 0,
            stdout: """
            {"command":"license activate","ok":true,"status":"active","source":"api",
             "checkedAt":"2026-07-18T00:00:00.000Z",
             "entitlement":{"status":"active","repoVisibilityScope":"private",
             "privateRepoAllowed":true,"updateEntitlement":true}}
            """,
            stderr: ""
        ))
        let client = DesktopActivationLicenseClient(
            cli: cli,
            executablePath: "/fixture/neondiff",
            configPath: "/fixture/config.json",
            machineId: "broker-device-binding-123",
            repository: "octo/private"
        )

        _ = try await client.activate(key: ActivationKeyMaterial(rawKey))

        let call = try #require(cli.calls.first)
        #expect(call.standardInput == Data(rawKey.utf8))
        #expect(call.arguments.contains("--license-machine-id"))
        #expect(call.arguments.contains("broker-device-binding-123"))
        #expect(call.arguments.contains("--repo"))
        #expect(call.arguments.contains("octo/private"))
        #expect(call.arguments.allSatisfy { !$0.contains(rawKey) })
    }
}
