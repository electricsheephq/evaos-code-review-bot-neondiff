import XCTest

final class NeonDiffDesktopUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchesStrictDeterministicFixtureRoot() throws {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let runID = UUID().uuidString.prefix(8)
        let runRoot = URL(fileURLWithPath: "/tmp/neondiff-desktop-evaluation.\(runID)")
        let caseDirectory = runRoot.appendingPathComponent("hosted", isDirectory: true)
        let readyURL = caseDirectory.appendingPathComponent("ready.json")
        try FileManager.default.createDirectory(
            at: caseDirectory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        for directory in [runRoot, caseDirectory] {
            try FileManager.default.setAttributes(
                [.posixPermissions: 0o700],
                ofItemAtPath: directory.path
            )
        }
        defer { try? FileManager.default.removeItem(at: runRoot) }

        let app = XCUIApplication()
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        app.launchEnvironment["NEONDIFF_DESKTOP_EVALUATION_READY_PATH"] = readyURL.path
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        let readiness = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                FileManager.default.fileExists(atPath: readyURL.path)
            },
            object: nil
        )
        XCTAssertEqual(XCTWaiter.wait(for: [readiness], timeout: 10), .completed)

        let payload = try XCTUnwrap(
            try JSONSerialization.jsonObject(with: Data(contentsOf: readyURL))
                as? [String: Any]
        )
        XCTAssertEqual(payload["fixtureId"] as? String, "tab-overview")
        XCTAssertEqual(payload["ready"] as? Bool, true)
        let contentFrame = try XCTUnwrap(payload["contentFrame"] as? [String: Double])
        XCTAssertEqual(try XCTUnwrap(contentFrame["width"]), 1040, accuracy: 0.5)
        XCTAssertEqual(try XCTUnwrap(contentFrame["height"]), 680, accuracy: 0.5)
    }
}
