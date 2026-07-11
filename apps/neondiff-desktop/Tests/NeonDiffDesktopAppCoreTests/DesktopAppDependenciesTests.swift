import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct DesktopAppDependenciesTests {
    @Test @MainActor func clipboardRecordsOneRedactedStringAndReturnsScriptedFailure() {
        let clipboard = RecordingClipboard(result: false)

        let wrote = clipboard.write("token=[REDACTED]")

        #expect(!wrote)
        #expect(clipboard.strings == ["token=[REDACTED]"])
    }

    @Test @MainActor func urlOpenerRecordsURLAndReturnsScriptedFailure() {
        let opener = RecordingURLOpener(result: false)
        let url = fixtureURL("https://example.com/setup")

        let opened = opener.open(url)

        #expect(!opened)
        #expect(opener.urls == [url])
    }

    @Test func CLIRecordsBoundedInputAndScriptedResult() async throws {
        let expected = CLIRunResult(exitCode: 7, stdout: "redacted", stderr: "failure")
        let recorder = RecordingCLIExecutor(result: expected, maximumStandardInputBytes: 4)
        let input = fixtureData("key")

        let result = try await recorder.run(
            executablePath: "/fixture/neondiff",
            arguments: ["providers", "verify", "--api-key-stdin", "true"],
            standardInput: input,
            timeout: 12
        )

        #expect(result == expected)
        #expect(recorder.calls == [RecordedCLICall(
            executablePath: "/fixture/neondiff",
            arguments: ["providers", "verify", "--api-key-stdin", "true"],
            standardInput: input,
            timeout: 12
        )])
        await #expect(throws: RecordingDesktopDependencyError.standardInputTooLarge) {
            _ = try await recorder.run(
                executablePath: "/fixture/neondiff",
                arguments: [],
                standardInput: fixtureData(repeating: 0, count: 5),
                timeout: 1
            )
        }
        #expect(recorder.calls.count == 1)
    }

    @Test func CLIAndDashboardAreDistinctCapabilities() async throws {
        let recorder = RecordingDesktopDependencies(
            root: fixtureURL("/fixture/recording-dependencies", directory: true)
        )

        _ = try await recorder.cli.run(
            executablePath: "fixture-neondiff",
            arguments: ["daemon", "status"],
            standardInput: nil,
            timeout: 15
        )

        #expect(recorder.cli.calls.count == 1)
        #expect(recorder.dashboard.calls.isEmpty)
    }

    @Test func dashboardRecordsOnlyDetachedLaunches() async throws {
        let dashboard = RecordingDashboardLauncher()
        let workingDirectory = fixtureURL("/fixture/work", directory: true)

        _ = try await dashboard.launch(
            executablePath: "/fixture/neondiff",
            arguments: ["dashboard", "open"],
            workingDirectory: workingDirectory
        )

        #expect(dashboard.calls == [RecordedDashboardLaunch(
            executablePath: "/fixture/neondiff",
            arguments: ["dashboard", "open"],
            workingDirectory: workingDirectory
        )])
    }

    @Test func preferencesAreSuiteIndependentAndStartEmpty() {
        let first = MemoryPreferences()
        let second = MemoryPreferences()

        #expect(first.string(forKey: "account") == nil)
        #expect(!first.bool(forKey: "enabled"))
        first.set("fixture", forKey: "account")
        first.set(true, forKey: "enabled")

        #expect(first.string(forKey: "account") == "fixture")
        #expect(first.bool(forKey: "enabled"))
        #expect(second.string(forKey: "account") == nil)
        #expect(!second.bool(forKey: "enabled"))
    }

    @Test func clockOnlyAdvancesWhenInstructed() async throws {
        let start = fixtureDate(secondsSince1970: 100)
        let clock = TestClock(now: start)

        try await clock.sleep(for: .seconds(30))

        #expect(clock.now == start)
        #expect(clock.sleeps == [.seconds(30)])
        clock.advance(by: 5)
        #expect(clock.now == start.addingTimeInterval(5))
    }

    @Test func fileWriterRestrictsWritesToInjectedRoot() throws {
        let root = fixtureURL("/tmp/neondiff-fixture-root", directory: true)
        let writer = TemporaryFileWriter(root: root)
        let destination = root.appending(path: "nested/evidence.json")
        let bytes = fixtureData(bytes: [0x01, 0x02, 0x03])

        try writer.write(bytes, to: destination)

        #expect(writer.writes == [RecordedFileWrite(data: bytes, url: destination.standardizedFileURL)])
        #expect(throws: RecordingDesktopDependencyError.destinationOutsideRoot) {
            try writer.write(fixtureData("secret"), to: root.appending(path: "../outside.json"))
        }
        #expect(writer.writes.count == 1)
    }

    @Test func providerVerifierRecordsCurrentPathAndMetadataWithoutSecretSurface() async throws {
        let verifier = RecordingProviderVerifier()
        let revision = String(repeating: "b", count: 64)

        _ = try await verifier.verify(
            executablePath: "/current/neondiff",
            account: "openai",
            expectedProviderId: "openai-compatible",
            expectedConfigRevision: revision,
            arguments: ["providers", "verify", "--api-key-stdin", "true"],
            timeout: 20
        )

        #expect(verifier.calls == [RecordedProviderVerification(
            executablePath: "/current/neondiff",
            account: "openai",
            expectedProviderId: "openai-compatible",
            expectedConfigRevision: revision,
            arguments: ["providers", "verify", "--api-key-stdin", "true"],
            timeout: 20
        )])
        #expect(String(describing: verifier.calls).contains("api-key") == true)
        #expect(String(describing: verifier.calls).contains("secret") == false)
    }
}
