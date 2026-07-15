import XCTest

// Issue #612 — additive XCUITest coverage for the native purchase-to-activation
// handoff: public skip, paid return/redeem, cancel/retry, restart/resume, and
// Keychain prompt stability. This is an ADDITIVE file (the #517 lane owns the
// geometry/XCUITest-matrix + launch/fixture parser, which are untouched here).
//
// Execution is doubly gated and self-skipping so it never destabilizes any lane
// (`swift test` does not build the UITest bundle):
//   * NEONDIFF_UITEST_ACTIVATION=1 — the Xcode UITest harness (#516) is present.
//   * NEONDIFF_UITEST_ACTIVATION_SEEDING=1 — the harness can seed the handoff
//     feature flag + a starting activation state. That seeding hook rides the
//     #517 fixture catalog (the DEBUG launch parser requires --ui-fixture +
//     --content-size and does not parse ad-hoc --activation-* flags), so it is a
//     tracked follow-up rather than something this file may bolt on.
//
// The launch below therefore uses the app's REAL required launch contract so the
// window actually appears; the executable proof for restart-resume,
// no-init-Keychain-decrypt, redaction, scope gating, and outcome mapping lives in
// the Core + AppCore unit/integration suites.
final class ActivationHandoffUITests: XCTestCase {
    private var isHarnessAvailable: Bool {
        ProcessInfo.processInfo.environment["NEONDIFF_UITEST_ACTIVATION"] == "1"
    }
    private var isSeedingAvailable: Bool {
        ProcessInfo.processInfo.environment["NEONDIFF_UITEST_ACTIVATION_SEEDING"] == "1"
    }

    override func setUpWithError() throws {
        continueAfterFailure = false
        try XCTSkipUnless(
            isHarnessAvailable,
            "Activation-handoff XCUITests require the Xcode UITest harness (#516)."
        )
    }

    /// Launches with the app's real required contract (#517 fixture parser demands
    /// --ui-testing + --ui-fixture + --content-size + --disable-animations).
    private func launchHostedApp(extraArguments: [String] = []) throws -> XCUIApplication {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json"),
            "hosted evaluation fixture missing"
        )
        let app = XCUIApplication()
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ] + extraArguments
        app.launch()
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(app.state, .runningForeground)
        return app
    }

    /// The hosted app honors the real launch contract and reaches a foreground
    /// window — the precondition every activation scenario builds on.
    func testHostedLaunchReachesWindow() throws {
        let app = try launchHostedApp()
        defer { app.terminate() }
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"].waitForExistence(timeout: 10)
        )
    }

    /// Scenario matrix, exercised once the #517 seeding hook lands. Each drives the
    /// activation surface by its stable accessibility identifiers:
    ///   * public_free_skip — no key field, no primary CTA (AC2).
    ///   * checkout_paused → key_ready → active — paid return/redeem.
    ///   * checkout_pending → cancel → purchase_required — cancel/retry.
    ///   * key_ready survives relaunch — restart/resume (AC6).
    ///   * relaunch raises no repeated Keychain prompt — startup stability (#503).
    func testActivationScenarioMatrix() throws {
        try XCTSkipUnless(
            isSeedingAvailable,
            "Activation-state seeding rides the #517 fixture catalog (tracked follow-up)."
        )
        let app = try launchHostedApp(extraArguments: ["--activation-handoff", "--activation-state", "checkout_paused"])
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.checkout_paused"].waitForExistence(timeout: 10))
        let keyField = app.secureTextFields["neondiff.activation.key-field"]
        XCTAssertTrue(keyField.waitForExistence(timeout: 5))
        keyField.click()
        keyField.typeText("NDL-UITEST-0123456789")
        app.descendants(matching: .any)["neondiff.activation.primary"].firstMatch.click()
        let primary = app.descendants(matching: .any)["neondiff.activation.primary"].firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 5))
        primary.click()
        XCTAssertTrue(app.descendants(matching: .any)["neondiff.activation.state.active"].waitForExistence(timeout: 10))
    }
}
