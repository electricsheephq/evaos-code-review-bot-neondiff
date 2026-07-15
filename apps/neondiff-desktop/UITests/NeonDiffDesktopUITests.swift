import XCTest

final class NeonDiffDesktopUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testLaunchesDeterministicAppRoot() {
        let app = XCUIApplication()
        app.launchEnvironment["NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE"] = "provider-verification"
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.desktop.root"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)
    }
}
