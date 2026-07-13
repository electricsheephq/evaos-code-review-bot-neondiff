import Testing
@testable import NeonDiffDesktopEvaluationSupport

@Suite("Desktop evaluation launch context")
struct DesktopEvaluationLaunchContextTests {
    @Test func loadsAnAbsoluteRegularFixtureAndPinsRequestedSize() throws {
        let fixtureURL = try temporaryFixture()
        defer { removeTemporaryFixture(fixtureURL) }

        let context = try DesktopEvaluationLaunchContext.load(arguments: [
            "NeonDiffDesktop",
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1280x800",
            "--disable-animations"
        ])

        #expect(context?.fixture.id == "tab-overview")
        #expect(context?.options.contentSize == DesktopEvaluationContentSize(width: 1280, height: 800))
    }

    @Test func rejectsSymlinkedFixtureFiles() throws {
        let fixtureURL = try temporaryFixture()
        defer { removeTemporaryFixture(fixtureURL) }
        let linkURL = fixtureURL.deletingLastPathComponent().appendingPathComponent("linked.json")
        try createFixtureSymlink(at: linkURL, destination: fixtureURL)

        #expect(throws: DesktopEvaluationFixtureError.invalidValue("launch fixture file")) {
            try DesktopEvaluationLaunchContext.load(arguments: [
                "NeonDiffDesktop",
                "--ui-testing",
                "--ui-fixture", linkURL.path,
                "--content-size", "1040x680",
                "--disable-animations"
            ])
        }
    }

    @Test func rejectsFixtureContentSizeThatConflictsWithLaunchSize() throws {
        let fixtureURL = try temporaryFixture(contentSize: "{\"width\": 1040, \"height\": 680}")
        defer { removeTemporaryFixture(fixtureURL) }

        #expect(throws: DesktopEvaluationFixtureError.invalidValue("launch content size mismatch")) {
            try DesktopEvaluationLaunchContext.load(arguments: [
                "NeonDiffDesktop",
                "--ui-testing",
                "--ui-fixture", fixtureURL.path,
                "--content-size", "1280x800",
                "--disable-animations"
            ])
        }
    }

}
