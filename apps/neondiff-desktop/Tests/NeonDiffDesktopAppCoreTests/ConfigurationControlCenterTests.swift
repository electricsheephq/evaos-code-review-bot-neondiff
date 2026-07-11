import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ConfigurationControlCenterTests {
    @Test func localPreferencesPersistOnlyThroughInjectedStore() {
        let fixture = ModelDependencyFixture()
        fixture.model.configPath = "fixture/config.json"
        fixture.model.cliPath = "/fixture/bin/neondiff"
        fixture.model.launchdLabel = "com.example.fixture"

        fixture.model.persistLocalSettings()

        #expect(fixture.preferences.string(forKey: "neondiff.configPath") == "fixture/config.json")
        #expect(fixture.preferences.string(forKey: "neondiff.cliPath") == "/fixture/bin/neondiff")
        #expect(fixture.preferences.string(forKey: "neondiff.launchdLabel") == "com.example.fixture")
    }

    @Test func previewWritesExactPatchBytesUnderInjectedApplicationSupportRoot() async throws {
        let revision = String(repeating: "a", count: 64)
        let preview = ModelDependencyFixture.configPatchJSON(
            dryRun: true,
            wrote: false,
            revisionAfter: revision
        )
        let root = fixtureURL("/fixture/custom-application-support", directory: true)
        let fixture = ModelDependencyFixture(
            root: root,
            cliOutcomes: [.success(CLIRunResult(exitCode: 0, stdout: preview, stderr: ""))]
        )
        fixture.loadConfig()
        fixture.model.controlCenter.pollIntervalMs = 120_000
        fixture.model.controlCenter.issueAllowlist = ["electric/example"]
        let expectedBytes = try DesktopControlCenterPatchBuilder.data(for: fixture.model.controlCenter)

        fixture.model.previewControlCenterPatch()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForConfigPatchToFinish()

        let write = try #require(fixture.fileWriter.writes.first)
        #expect(write.url == root.appending(path: "control-center-patch.json").standardizedFileURL)
        #expect(write.data == expectedBytes)
        #expect(fixture.cli.calls[0].arguments == [
            "config", "patch", "--config", "config.local.json",
            "--input", root.appending(path: "control-center-patch.json").path,
            "--dry-run", "true", "--expected-revision", revision
        ])
        #expect(fixture.model.canApplyControlCenter)
    }

    @Test func fileWriterRejectsAnyDestinationOutsideInjectedRoot() {
        let root = fixtureURL("/fixture/strict-root", directory: true)
        let writer = TemporaryFileWriter(root: root)

        #expect(throws: RecordingDesktopDependencyError.destinationOutsideRoot) {
            try writer.write(fixtureData("fixture"), to: root.appending(path: "../escape.json"))
        }
        #expect(writer.writes.isEmpty)
    }

    @Test func CLITransportFailureIsRedactedBeforeModelState() async {
        let sensitive = ["token", String(repeating: "x", count: 32)].joined(separator: ": ")
        let failure = ProviderFixtureTransportError.unavailable("CLI unavailable for \(sensitive)")
        let fixture = ModelDependencyFixture(cliOutcomes: [.failure(failure)])

        fixture.model.refreshStatus()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForLastError()

        #expect(fixture.model.lastError?.contains(sensitive) != true)
        #expect(fixture.model.logText.contains(sensitive) == false)
        #expect(fixture.cli.calls[0].standardInput == nil)
    }

    @Test func dashboardLaunchUsesDetachedCapabilityNotCLIExecutor() async {
        let fixture = ModelDependencyFixture()

        fixture.model.openDashboard()
        await fixture.waitForDashboardLaunch()

        #expect(fixture.dashboard.calls.count == 1)
        #expect(fixture.dashboard.calls[0].arguments.first == "dashboard")
        #expect(fixture.dashboard.calls[0].arguments.contains("--open"))
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.model.dashboardProcessIdentifier == 42)
    }
}
