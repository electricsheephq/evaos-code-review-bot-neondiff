import XCTest

// Issue #612 — additive XCUITest coverage for the native purchase-to-activation
// handoff: public skip, paid return/redeem, cancel/retry, restart/resume, and
// Keychain prompt stability. This is an ADDITIVE file (the #517 lane owns the
// geometry/XCUITest-matrix files, which are untouched here).
//
// Execution is owner-gated: the full XCUITest lane requires Xcode + xcodebuild
// (#516) and the #517 launch/fixture harness. Absent that harness these tests
// self-skip via XCTSkipUnless rather than fail, so this file never destabilizes
// the `swift test` lane (which does not build the UITest bundle). The executable
// proof for restart-resume, no-init-Keychain-decrypt, redaction, and outcome
// mapping lives in the Core + AppCore unit/integration suites.
final class ActivationHandoffUITests: XCTestCase {
    private var isHarnessAvailable: Bool {
        ProcessInfo.processInfo.environment["NEONDIFF_UITEST_ACTIVATION"] == "1"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            isHarnessAvailable,
            "Activation-handoff XCUITests require the Xcode UITest harness (#516) with --activation-handoff plumbing."
        )
    }

    private func launchActivation(state: String, extraArguments: [String] = []) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--ui-testing",
            "--disable-animations",
            "--activation-handoff",
            "--activation-state", state
        ] + extraArguments
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        return app
    }

    /// Public path reaches provider/GitHub setup with NO license/checkout UI (AC2).
    func testPublicPathSkipsWithoutLicenseWall() throws {
        let app = launchActivation(state: "public_free_skip")
        defer { app.terminate() }
        let surface = app.descendants(matching: .any)["neondiff.activation.state.public_free_skip"]
        XCTAssertTrue(surface.waitForExistence(timeout: 10))
        XCTAssertFalse(app.descendants(matching: .any)["neondiff.activation.key-field"].exists)
        XCTAssertFalse(app.descendants(matching: .any)["neondiff.activation.primary"].exists)
    }

    /// Paid return/redeem: paste an existing key while checkout is paused, activate.
    func testPaidReturnRedeemActivates() throws {
        let app = launchActivation(state: "checkout_paused")
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.checkout_paused"].waitForExistence(timeout: 10))
        let keyField = app.secureTextFields["neondiff.activation.key-field"]
        XCTAssertTrue(keyField.waitForExistence(timeout: 5))
        keyField.click()
        keyField.typeText("NDL-UITEST-0123456789")
        app.descendants(matching: .any)["neondiff.activation.primary"].firstMatch.click()
        // key_ready → activate again → active (fixture license client returns active).
        let primary = app.descendants(matching: .any)["neondiff.activation.primary"].firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 5))
        primary.click()
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.active"].waitForExistence(timeout: 10))
    }

    /// Cancel an in-flight checkout, then retry from purchase_required.
    func testCancelThenRetry() throws {
        let app = launchActivation(state: "checkout_pending")
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.checkout_pending"].waitForExistence(timeout: 10))
        app.descendants(matching: .any)["neondiff.activation.primary"].firstMatch.click()
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.purchase_required"].waitForExistence(timeout: 10))
    }

    /// Restart resumes the exact same bounded state (AC6).
    func testRestartResumesExactState() throws {
        let app = launchActivation(state: "key_ready")
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.key_ready"].waitForExistence(timeout: 10))
        app.terminate()
        // Relaunch WITHOUT seeding state — it must restore from persisted preferences.
        let relaunched = XCUIApplication()
        relaunched.launchArguments = ["--ui-testing", "--disable-animations", "--activation-handoff"]
        relaunched.launch()
        defer { relaunched.terminate() }
        XCTAssertTrue(relaunched.descendants(matching: .any)["neondiff.activation.state.key_ready"].waitForExistence(timeout: 10))
    }

    /// Relaunching must not trigger a repeated Keychain prompt (no init decrypt).
    func testRestartDoesNotRepeatKeychainPrompt() throws {
        let app = launchActivation(state: "active")
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.active"].waitForExistence(timeout: 10))
        app.terminate()
        let relaunched = launchActivation(state: "active", extraArguments: ["--assert-no-keychain-prompt"])
        defer { relaunched.terminate() }
        // A Keychain authorization sheet is a system dialog; its absence is asserted
        // by the harness flag above. The window must reach foreground unblocked.
        XCTAssertEqual(relaunched.state, .runningForeground)
    }
}
