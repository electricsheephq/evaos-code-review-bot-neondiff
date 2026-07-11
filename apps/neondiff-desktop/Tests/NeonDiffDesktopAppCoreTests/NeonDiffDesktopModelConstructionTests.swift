import Testing
@testable import NeonDiffDesktopAppCore

@MainActor
@Suite struct NeonDiffDesktopModelConstructionTests {
    @Test func constructingModelReadsOnlyInjectedState() {
        let fixture = RecordingDesktopDependencies(
            root: fixtureURL("/fixture/application-support", directory: true)
        )
        fixture.preferences.set("fixture/config.json", forKey: "neondiff.configPath")

        let model = NeonDiffDesktopModel(dependencies: fixture.dependencies)

        #expect(model.configPath == "fixture/config.json")
        #expect(fixture.clipboard.strings.isEmpty)
        #expect(fixture.urlOpener.urls.isEmpty)
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.dashboard.calls.isEmpty)
        #expect(fixture.fileWriter.writes.isEmpty)
        #expect(fixture.providerVerifier.calls.isEmpty)
        #expect(fixture.secretStore.mutations.isEmpty)
    }
}
