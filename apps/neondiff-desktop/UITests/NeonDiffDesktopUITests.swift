import XCTest

private let hostedPageBottomSamplingDeadlineMilliseconds = 15_000
private let hostedNativeInnerScrollSamplingDeadlineMilliseconds = 75_000

final class NeonDiffDesktopUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testAccessibility3OverrideScalesVisibleProductionSectionTitle() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let defaultScenario = try captureRenderedTextScaleScenario(
            requestedContentSize: requestedContentSize,
            textSizeMode: "runner-default-no-test-override",
            textSizeArgument: nil,
            rootIdentifier: "neondiff.fixture.tab-overview"
        )
        let accessibility3Scenario = try captureRenderedTextScaleScenario(
            requestedContentSize: requestedContentSize,
            textSizeMode: "swiftui-dynamic-type-accessibility3-test-override",
            textSizeArgument: "accessibility3",
            rootIdentifier: "neondiff.fixture.tab-overview.text-size.accessibility3"
        )
        let defaultMaximumSample = try XCTUnwrap(
            defaultScenario.samples.max { $0.frame.height < $1.frame.height }
        )
        let accessibility3MinimumSample = try XCTUnwrap(
            accessibility3Scenario.samples.min { $0.frame.height < $1.frame.height }
        )
        let robustRenderedHeightGrowthPoints =
            accessibility3MinimumSample.frame.height - defaultMaximumSample.frame.height
        guard robustRenderedHeightGrowthPoints > 1 else {
            throw HostedRenderedTextScaleError.insufficientRenderedScale(
                defaultMaximumFrame: defaultMaximumSample.frame,
                accessibility3MinimumFrame: accessibility3MinimumSample.frame
            )
        }
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedRenderedTextScaleError.priorValidationFailure
        }

        try attach(
            HostedRenderedTextScaleTrace(
                schemaVersion: 1,
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                semanticTextIdentifier: "neondiff-section-title",
                expectedSemanticValue: "Overview",
                coordinateSpace: "xcui-screen",
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                minimumRequiredHeightGrowthPoints: 1,
                defaultMaximumHeightPoints: defaultMaximumSample.frame.height,
                accessibility3MinimumHeightPoints: accessibility3MinimumSample.frame.height,
                robustRenderedHeightGrowthPoints: robustRenderedHeightGrowthPoints,
                defaultScenario: defaultScenario,
                accessibility3Scenario: accessibility3Scenario,
                proofBoundary: "hosted-visible-production-section-title-rendered-scale-comparison-only-system-preference-excluded"
            )
        )
    }

    func testStrictFixtureSettlesAcrossOverviewReposOverview() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        let overview0 = try captureCheckpoint(
            app: app,
            section: "overview",
            generation: 0,
            markerIdentifier: "neondiff.evaluation.surface.overview.0.quiescent",
            requestedContentSize: requestedContentSize
        )
        let reposAction = try clickNavigation(
            app: app,
            index: 0,
            fromSection: "overview",
            toSection: "repos",
            identifier: "neondiff-sidebar-section-repos"
        )
        let repos1 = try captureCheckpoint(
            app: app,
            section: "repos",
            generation: 1,
            markerIdentifier: "neondiff.evaluation.surface.repos.1.quiescent",
            requestedContentSize: requestedContentSize
        )
        let overviewAction = try clickNavigation(
            app: app,
            index: 1,
            fromSection: "repos",
            toSection: "overview",
            identifier: "neondiff-sidebar-section-overview"
        )
        let overview2 = try captureCheckpoint(
            app: app,
            section: "overview",
            generation: 2,
            markerIdentifier: "neondiff.evaluation.surface.overview.2.quiescent",
            requestedContentSize: requestedContentSize
        )

        let checkpoints = [overview0, repos1, overview2]
        assertStableAcrossTransitions(checkpoints)
        try attach(
            HostedSettledGeometryTrace(
                schemaVersion: 2,
                scenario: "overview-repos-overview",
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpaces: HostedGeometryCoordinateSpaces(
                    windowAndContent: "appkit-screen",
                    regions: "swiftui-global"
                ),
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                navigationActions: [reposAction, overviewAction],
                checkpoints: checkpoints,
                proofBoundary: "hosted-overview-repos-overview-geometry-only"
            )
        )
    }

    func testStrictFixtureSettlesAcrossEverySidebarSectionAtMinimumSize() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let route = [
            HostedSidebarRouteStep(section: "overview", generation: 0),
            HostedSidebarRouteStep(section: "repos", generation: 1),
            HostedSidebarRouteStep(section: "providers", generation: 2),
            HostedSidebarRouteStep(section: "license", generation: 3),
            HostedSidebarRouteStep(section: "logs", generation: 4),
            HostedSidebarRouteStep(section: "policy", generation: 5),
            HostedSidebarRouteStep(section: "settings", generation: 6),
            HostedSidebarRouteStep(section: "overview", generation: 7)
        ]
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        var checkpoints: [HostedGeometryCheckpoint] = []
        var navigationActions: [HostedNavigationAction] = []
        for (routeIndex, step) in route.enumerated() {
            if routeIndex > 0 {
                let previous = route[routeIndex - 1]
                navigationActions.append(
                    try clickNavigation(
                        app: app,
                        index: routeIndex - 1,
                        fromSection: previous.section,
                        toSection: step.section,
                        identifier: "neondiff-sidebar-section-\(step.section)"
                    )
                )
            }
            checkpoints.append(
                try captureCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: "neondiff.evaluation.surface.\(step.section).\(step.generation).quiescent",
                    requestedContentSize: requestedContentSize
                )
            )
        }

        XCTAssertEqual(checkpoints.count, 8)
        XCTAssertEqual(navigationActions.count, 7)
        assertStableAcrossTransitions(checkpoints)
        try attach(
            HostedSettledGeometryTrace(
                schemaVersion: 2,
                scenario: "overview-repos-providers-license-logs-policy-settings-overview",
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpaces: HostedGeometryCoordinateSpaces(
                    windowAndContent: "appkit-screen",
                    regions: "swiftui-global"
                ),
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: checkpoints,
                proofBoundary: "hosted-every-sidebar-destination-minimum-size-geometry-only"
            )
        )
    }

    func testStrictFixtureReachesEverySidebarPageBottomAtMinimumSize() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let route = everySidebarPageBottomRoute
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        var checkpoints: [HostedPageBottomCheckpoint] = []
        var navigationActions: [HostedNavigationAction] = []
        for (routeIndex, step) in route.enumerated() {
            if routeIndex > 0 {
                let previous = route[routeIndex - 1]
                navigationActions.append(
                    try clickNavigation(
                        app: app,
                        index: routeIndex - 1,
                        fromSection: previous.section,
                        toSection: step.section,
                        identifier: "neondiff-sidebar-section-\(step.section)"
                    )
                )
            }

            let markerIdentifier =
                "neondiff.evaluation.surface.\(step.section).\(step.generation).quiescent"
            _ = try captureCheckpoint(
                app: app,
                section: step.section,
                generation: step.generation,
                markerIdentifier: markerIdentifier,
                requestedContentSize: requestedContentSize
            )
            checkpoints.append(
                try capturePageBottomCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: markerIdentifier,
                    outerScrollIdentifier: step.outerScrollIdentifier,
                    sentinelIdentifier: step.sentinelIdentifier
                )
            )
        }

        XCTAssertEqual(checkpoints.count, 7)
        XCTAssertEqual(navigationActions.count, 6)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedPageBottomTraceError.priorValidationFailure
        }
        try attach(
            HostedPageBottomReachabilityTrace(
                schemaVersion: 2,
                scenario: "every-sidebar-page-bottom-at-minimum-size",
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpace: "xcui-screen",
                minimumSampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: hostedPageBottomSamplingDeadlineMilliseconds,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: checkpoints,
                proofBoundary: "hosted-outer-page-bottom-reachability-only-inner-scroll-exhaustion-excluded"
            )
        )
    }

    func testHostedNativeInnerScrollsReachTerminalStateWithoutMovingOuterPage() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: "hosted-inner-scroll-overflow",
                withExtension: "json"
            )
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)[
                "neondiff.fixture.hosted-inner-scroll-overflow"
            ].waitForExistence(timeout: 10)
        )
        guard app.state == .runningForeground else {
            throw HostedNativeInnerScrollTraceError.appNotForeground
        }

        let reposMarker = "neondiff.evaluation.surface.repos.0.quiescent"
        let reposGeometry = try captureCheckpoint(
            app: app,
            section: "repos",
            generation: 0,
            markerIdentifier: reposMarker,
            requestedContentSize: requestedContentSize
        )
        let reposOuter = try capturePageBottomCheckpoint(
            app: app,
            section: "repos",
            generation: 0,
            markerIdentifier: reposMarker,
            outerScrollIdentifier: "neondiff-repos-outer-scroll",
            sentinelIdentifier: "neondiff-repos-page-bottom",
            nestedScrollControlIdentifier: "neondiff-repos-table",
            nestedScrollControlElementType: .outline,
            requiresGuardedScrollAction: true
        )
        let reposInner = try captureNativeInnerScrollExhaustion(
            app: app,
            section: "repos",
            controlIdentifier: "neondiff-repos-table",
            controlElementType: .outline,
            controlElementTypeName: "outline",
            terminalRowElementType: .outlineRow,
            terminalRowElementTypeName: "outline-row",
            outerScrollIdentifier: "neondiff-repos-outer-scroll",
            outerSentinelIdentifier: "neondiff-repos-page-bottom",
            outerPreparationCheckpoint: reposOuter,
            terminalVisibleText: "synthetic-org/repo-040",
            terminalValueToken: nil,
            terminalVisibilityMarkerIdentifier: nil
        )

        let logsNavigation = try clickNavigation(
            app: app,
            index: 0,
            fromSection: "repos",
            toSection: "logs",
            identifier: "neondiff-sidebar-section-logs"
        )
        let logsMarker = "neondiff.evaluation.surface.logs.1.quiescent"
        let logsGeometry = try captureCheckpoint(
            app: app,
            section: "logs",
            generation: 1,
            markerIdentifier: logsMarker,
            requestedContentSize: requestedContentSize
        )
        let logsOuter = try capturePageBottomCheckpoint(
            app: app,
            section: "logs",
            generation: 1,
            markerIdentifier: logsMarker,
            outerScrollIdentifier: "neondiff-logs-outer-scroll",
            sentinelIdentifier: "neondiff-logs-page-bottom",
            nestedScrollControlIdentifier: "neondiff-logs-text-editor",
            nestedScrollControlElementType: .textView,
            requiresGuardedScrollAction: true
        )
        let logsInner = try captureNativeInnerScrollExhaustion(
            app: app,
            section: "logs",
            controlIdentifier: "neondiff-logs-text-editor",
            controlElementType: .textView,
            controlElementTypeName: "text-view",
            terminalRowElementType: nil,
            terminalRowElementTypeName: nil,
            outerScrollIdentifier: "neondiff-logs-outer-scroll",
            outerSentinelIdentifier: "neondiff-logs-page-bottom",
            outerPreparationCheckpoint: logsOuter,
            terminalVisibleText: nil,
            terminalValueToken: "HOSTED_INNER_SCROLL_SAFE_TAIL_070",
            terminalVisibilityMarkerIdentifier: "neondiff-logs-visible-tail"
        )

        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedNativeInnerScrollTraceError.priorValidationFailure
        }
        try attach(
            HostedNativeInnerScrollTrace(
                schemaVersion: 13,
                scenario: "repos-and-logs-native-inner-scroll-terminal-at-1040x680",
                fixtureId: "hosted-inner-scroll-overflow",
                requestedContentSize: requestedContentSize,
                coordinateSpaces: HostedNativeInnerScrollCoordinateSpaces(
                    xcuiGeometry: "xcui-screen",
                    observedWindowAndContent: "appkit-screen",
                    observedRegions: "swiftui-global",
                    terminalNativeVisibility: "per-payload-appkit-text-view-local"
                ),
                tolerancePoints: 1,
                observedGeometryCheckpoints: [reposGeometry, logsGeometry],
                innerScrollCheckpoints: [reposInner, logsInner],
                navigationActions: [logsNavigation],
                outerPageBottomCheckpoints: [reposOuter, logsOuter],
                proofBoundary: "hosted-debug-fixture-repos-table-and-logs-text-editor-rendered-terminal-glyph-bounds-outer-page-bottom-checkpoint-then-native-inner-viewport-restaging-per-control-two-one-shot-public-xcui-coordinate-hover-capability-preparations-with-passive-settlement-before-per-control-two-one-shot-public-xcui-scrollbar-coordinate-drags-from-stable-thumb-geometry-to-terminal-repeat-bottom-drag-no-effect-and-outer-page-isolation-at-1040x680-only-wheel-trackpad-keyboard-voiceover-focus-overlay-scrollbar-not-exposed-after-hover-large-text-other-sizes-overflow-production-data-installed-signed-release-excluded"
            )
        )
    }

    func testStrictFixtureSettlesAndReachesEverySidebarPageBottomAtRemainingCanonicalSizes() throws {
        let requests = [
            HostedCanonicalSizeRequest(
                requestedContentSize: HostedContentSize(width: 1280, height: 800),
                contentSizeArgument: "1280x800"
            ),
            HostedCanonicalSizeRequest(
                requestedContentSize: HostedContentSize(width: 1440, height: 900),
                contentSizeArgument: "1440x900"
            )
        ]
        var scenarios: [HostedCanonicalSizeScenario] = []
        for request in requests {
            scenarios.append(try captureCanonicalSizeScenario(request))
        }

        XCTAssertEqual(scenarios.count, 2)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedPageBottomTraceError.priorValidationFailure
        }
        try attach(
            HostedCanonicalSizeMatrixTrace(
                schemaVersion: 1,
                fixtureId: "tab-overview",
                textSizeMode: "runner-default-no-test-override",
                scenarios: scenarios,
                proofBoundary: "hosted-remaining-canonical-size-outer-geometry-and-page-bottom-only-inner-scroll-exhaustion-excluded"
            )
        )
    }

    func testStrictFixtureSettlesAndReachesEverySidebarPageBottomAtMinimumSizeWithAccessibility3Text() throws {
        let requestedContentSize = HostedContentSize(width: 1040, height: 680)
        let textSizeMode = "swiftui-dynamic-type-accessibility3-test-override"
        let route = everySidebarPageBottomRoute
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--text-size", "accessibility3",
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)[
                "neondiff.fixture.tab-overview.text-size.accessibility3"
            ].waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        var geometryCheckpoints: [HostedGeometryCheckpoint] = []
        var pageBottomCheckpoints: [HostedPageBottomCheckpoint] = []
        var navigationActions: [HostedNavigationAction] = []
        for (routeIndex, step) in route.enumerated() {
            if routeIndex > 0 {
                let previous = route[routeIndex - 1]
                navigationActions.append(
                    try clickNavigation(
                        app: app,
                        index: routeIndex - 1,
                        fromSection: previous.section,
                        toSection: step.section,
                        identifier: "neondiff-sidebar-section-\(step.section)"
                    )
                )
            }

            let markerIdentifier =
                "neondiff.evaluation.surface.\(step.section).\(step.generation).quiescent"
            geometryCheckpoints.append(
                try captureCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: markerIdentifier,
                    requestedContentSize: requestedContentSize
                )
            )
            pageBottomCheckpoints.append(
                try capturePageBottomCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: markerIdentifier,
                    outerScrollIdentifier: step.outerScrollIdentifier,
                    sentinelIdentifier: step.sentinelIdentifier
                )
            )
        }

        XCTAssertEqual(geometryCheckpoints.count, 7)
        XCTAssertEqual(pageBottomCheckpoints.count, 7)
        XCTAssertEqual(navigationActions.count, 6)
        assertStableAcrossTransitions(geometryCheckpoints)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedPageBottomTraceError.priorValidationFailure
        }

        try attach(
            HostedLargeTextMatrixTrace(
                schemaVersion: 1,
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: textSizeMode,
                settledGeometry: HostedSettledGeometryTrace(
                    schemaVersion: 2,
                    scenario: "every-sidebar-destination-1040x680-accessibility3",
                    fixtureId: "tab-overview",
                    requestedContentSize: requestedContentSize,
                    textSizeMode: textSizeMode,
                    coordinateSpaces: HostedGeometryCoordinateSpaces(
                        windowAndContent: "appkit-screen",
                        regions: "swiftui-global"
                    ),
                    sampleIntervalMilliseconds: 100,
                    tolerancePoints: 1,
                    navigationActions: navigationActions,
                    checkpoints: geometryCheckpoints,
                    proofBoundary: "hosted-every-sidebar-destination-1040x680-accessibility3-geometry-only"
                ),
                pageBottomReachability: HostedPageBottomReachabilityTrace(
                    schemaVersion: 2,
                    scenario: "every-sidebar-page-bottom-1040x680-accessibility3",
                    fixtureId: "tab-overview",
                    requestedContentSize: requestedContentSize,
                    textSizeMode: textSizeMode,
                    coordinateSpace: "xcui-screen",
                    minimumSampleIntervalMilliseconds: 100,
                    samplingDeadlineMilliseconds: hostedPageBottomSamplingDeadlineMilliseconds,
                    tolerancePoints: 1,
                    navigationActions: navigationActions,
                    checkpoints: pageBottomCheckpoints,
                    proofBoundary: "hosted-outer-page-bottom-1040x680-accessibility3-reachability-only-inner-scroll-exhaustion-excluded"
                ),
                proofBoundary: "hosted-accessibility3-minimum-size-outer-geometry-and-page-bottom-only-inner-scroll-exhaustion-excluded"
            )
        )
    }

    func testSeparateSettingsSceneFitsVisibleScreenAndReachesPageBottom() throws {
        let requestedContentSize = HostedContentSize(width: 560, height: 700)
        let requests = [
            HostedSettingsTextSizeRequest(textSizeMode: "runner-default-no-test-override", textSizeArgument: nil),
            HostedSettingsTextSizeRequest(textSizeMode: "swiftui-dynamic-type-accessibility3-test-override", textSizeArgument: "accessibility3")
        ]
        var scenarios: [HostedSettingsSceneScenario] = []
        for request in requests {
            scenarios.append(
                try captureSettingsSceneScenario(
                    request,
                    requestedContentSize: requestedContentSize
                )
            )
        }

        XCTAssertEqual(scenarios.count, 2)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedSettingsSceneTraceError.priorValidationFailure
        }
        try attach(
            HostedSettingsSceneTrace(
                schemaVersion: 2,
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                coordinateSpace: "xcui-screen",
                sampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: 5_000,
                tolerancePoints: 1,
                scenarios: scenarios,
                proofBoundary: "hosted-separate-settings-preferred-560x700-appkit-window-and-content-layout-fitted-to-observed-visible-screen-xcui-window-dimension-bridge-outer-scroll-contained-and-page-bottom-reachable-runner-default-and-swiftui-accessibility3-test-override-only-system-text-preference-inner-scroll-manual-voiceover-focus-control-hittability-localization-multidisplay-relocation-installed-release-excluded"
            )
        )
    }

    private func captureSettingsSceneScenario(
        _ request: HostedSettingsTextSizeRequest,
        requestedContentSize: HostedContentSize
    ) throws -> HostedSettingsSceneScenario {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        if let textSizeArgument = request.textSizeArgument {
            app.launchArguments.append(contentsOf: ["--text-size", textSizeArgument])
        }
        app.launch()

        let rootIdentifier = request.textSizeArgument == nil
            ? "neondiff.fixture.tab-overview"
            : "neondiff.fixture.tab-overview.text-size.accessibility3"
        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)[rootIdentifier]
                .waitForExistence(timeout: 10)
        )
        guard app.state == .runningForeground else {
            throw HostedSettingsSceneTraceError.appNotForeground
        }

        let windowCountBeforeAction = app.windows.count
        let openActionStart = ProcessInfo.processInfo.systemUptime
        app.typeKey(",", modifierFlags: [.command])
        let settingsEvaluationContainer = app.descendants(matching: .any)[
            "neondiff-settings-evaluation-container"
        ]
        guard settingsEvaluationContainer.waitForExistence(timeout: 10) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff-settings-evaluation-container"
            )
        }
        let openAction = HostedSettingsOpenAction(
            method: "automated-command-comma",
            attemptCount: 1,
            result: "settings-evaluation-container-observed",
            elapsedMilliseconds: Int(
                ((ProcessInfo.processInfo.systemUptime - openActionStart) * 1_000).rounded()
            ),
            windowCountBefore: windowCountBeforeAction,
            windowCountAfter: app.windows.count
        )
        guard openAction.windowCountAfter == openAction.windowCountBefore + 1 else {
            throw HostedSettingsSceneTraceError.unexpectedWindowCount(
                before: openAction.windowCountBefore,
                after: openAction.windowCountAfter
            )
        }

        let markerIdentifier = "neondiff.evaluation.settings.quiescent"
        let marker = app.descendants(matching: .any)[markerIdentifier]
        guard marker.waitForExistence(timeout: 10) else {
            throw HostedSettingsSceneTraceError.missingElement(markerIdentifier)
        }
        guard !marker.isHittable else {
            throw HostedSettingsSceneTraceError.interactiveQuiescenceMarker
        }
        let textSizeMarker = app.descendants(matching: .any)[
            "neondiff.evaluation.settings.text-size"
        ]
        let textSizePrefix = "ndst1:"
        guard textSizeMarker.waitForExistence(timeout: 2) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff.evaluation.settings.text-size"
            )
        }
        let textSizeLabel = textSizeMarker.label
        guard textSizeLabel.hasPrefix(textSizePrefix) else {
            throw HostedSettingsSceneTraceError.invalidObservedTextSize(
                request.textSizeMode
            )
        }
        let observedTextSize = String(textSizeLabel.dropFirst(textSizePrefix.count))
        guard !observedTextSize.isEmpty,
              observedTextSize != "unknown" else {
            throw HostedSettingsSceneTraceError.invalidObservedTextSize(
                request.textSizeMode
            )
        }
        if request.textSizeArgument == "accessibility3",
           observedTextSize != "accessibility3" {
            throw HostedSettingsSceneTraceError.unexpectedObservedTextSize(
                expected: "accessibility3",
                observed: observedTextSize
            )
        }
        let geometryMarker = app.descendants(matching: .any)[
            "neondiff.evaluation.settings.appkit-geometry"
        ]
        guard geometryMarker.waitForExistence(timeout: 2) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff.evaluation.settings.appkit-geometry"
            )
        }
        let appKitGeometry = try decodeAndValidateSettingsAppKitGeometry(
            app: app,
            marker: geometryMarker,
            requestedContentSize: requestedContentSize,
            context: request.textSizeMode
        )
        let appKitBaseline = try XCTUnwrap(appKitGeometry.samples.first)
        let observedAppKitContentLayoutSize =
            appKitBaseline.contentLayoutScreenRect.roundedContentSize
        let observedAppKitWindowSize = appKitBaseline.windowFrame.roundedContentSize
        let outerScroll = app.descendants(matching: .any)[
            "neondiff-settings-outer-scroll"
        ]
        let bottomSentinel = app.descendants(matching: .any)[
            "neondiff-settings-page-bottom"
        ]
        guard outerScroll.waitForExistence(timeout: 2) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff-settings-outer-scroll"
            )
        }
        guard bottomSentinel.waitForExistence(timeout: 2) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff-settings-page-bottom"
            )
        }

        let preActionSamples = try captureStableSettingsSceneSamples(
            app: app,
            settingsEvaluationContainer: settingsEvaluationContainer,
            outerScroll: outerScroll,
            bottomSentinel: bottomSentinel,
            expectedAppKitWindowSize: observedAppKitWindowSize,
            appKitWindowFrame: appKitBaseline.windowFrame,
            appKitContentLayoutScreenRect: appKitBaseline.contentLayoutScreenRect,
            context: "\(request.textSizeMode)-pre"
        )
        let scrollAction: HostedSettingsScrollAction?
        let postActionSamples: [HostedSettingsSceneSample]
        if preActionSamples.allSatisfy(\.sentinelFullyContainedInOuterScroll) {
            scrollAction = nil
            postActionSamples = preActionSamples
        } else {
            outerScroll.scroll(byDeltaX: 0, deltaY: -10_000)
            postActionSamples = try captureStableSettingsSceneSamples(
                app: app,
                settingsEvaluationContainer: settingsEvaluationContainer,
                outerScroll: outerScroll,
                bottomSentinel: bottomSentinel,
                expectedAppKitWindowSize: observedAppKitWindowSize,
                appKitWindowFrame: appKitBaseline.windowFrame,
                appKitContentLayoutScreenRect: appKitBaseline.contentLayoutScreenRect,
                context: "\(request.textSizeMode)-post"
            )
            guard let preActionSentinelFrame = preActionSamples.last?.sentinelFrame,
                  let postActionSentinelFrame = postActionSamples.first?.sentinelFrame,
                  preActionSentinelFrame.differs(
                      from: postActionSentinelFrame,
                      byMoreThan: 1
                  ) else {
                throw HostedSettingsSceneTraceError.scrollHadNoEffect(
                    request.textSizeMode
                )
            }
            scrollAction = HostedSettingsScrollAction(
                controlIdentifier: "neondiff-settings-outer-scroll",
                deltaX: 0,
                deltaY: -10_000,
                attemptCount: 1,
                result: "returned",
                effectProven: true
            )
        }
        guard postActionSamples.allSatisfy(\.sentinelFullyContainedInOuterScroll) else {
            throw HostedSettingsSceneTraceError.sentinelNotContained(request.textSizeMode)
        }

        return HostedSettingsSceneScenario(
            textSizeMode: request.textSizeMode,
            launchTextSizeArgument: request.textSizeArgument,
            observedSettingsTextSize: observedTextSize,
            observedAppKitContentLayoutSize: observedAppKitContentLayoutSize,
            observedAppKitWindowSize: observedAppKitWindowSize,
            fixtureRootIdentifier: rootIdentifier,
            quiescenceMarkerIdentifier: markerIdentifier,
            openAction: openAction,
            appKitGeometry: appKitGeometry,
            preActionSamples: preActionSamples,
            scrollAction: scrollAction,
            postActionSamples: postActionSamples
        )
    }

    private func decodeAndValidateSettingsAppKitGeometry(
        app: XCUIApplication,
        marker: XCUIElement,
        requestedContentSize: HostedContentSize,
        context: String
    ) throws -> HostedSettingsAppKitGeometryEnvelope {
        let manifestPrefix = "ndsg1-chunks:"
        let manifest = marker.label
        guard manifest.hasPrefix(manifestPrefix),
              let chunkCount = Int(manifest.dropFirst(manifestPrefix.count)),
              chunkCount > 0,
              chunkCount <= 64 else {
            throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
        }
        var data = Data()
        for index in 0..<chunkCount {
            let chunk = app.descendants(matching: .any)[
                "neondiff.evaluation.settings.appkit-geometry.\(index)"
            ]
            guard chunk.waitForExistence(timeout: 2) else {
                throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
            }
            guard !chunk.isHittable else {
                throw HostedSettingsSceneTraceError.interactiveGeometryChunk(index)
            }
            let prefix = "ndsg1:\(index):\(chunkCount):"
            let label = chunk.label
            guard label.hasPrefix(prefix),
                  let decoded = Data(
                      base64Encoded: String(label.dropFirst(prefix.count))
                  ),
                  !decoded.isEmpty,
                  decoded.count <= 64,
                  (index == chunkCount - 1 || decoded.count == 64) else {
                throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
            }
            data.append(decoded)
        }
        guard let envelope = try? JSONDecoder().decode(
                  HostedSettingsAppKitGeometryEnvelope.self,
                  from: data
              ) else {
            throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
        }
        guard envelope.schemaVersion == 1,
              envelope.coordinateSpaces.windowFrame == "appkit-screen",
              envelope.coordinateSpaces.contentLayoutRect == "appkit-window",
              envelope.coordinateSpaces.contentLayoutScreenRect == "appkit-screen",
              envelope.coordinateSpaces.visibleScreenFrame == "appkit-screen",
              envelope.samples.count == 3,
              let baseline = envelope.samples.first else {
            throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
        }
        for sample in envelope.samples {
            guard sample.windowFrame.isFiniteAndNonempty,
                  sample.contentLayoutRect.isFiniteAndNonempty,
                  sample.contentLayoutScreenRect.isFiniteAndNonempty,
                  sample.visibleScreenFrame.isFiniteAndNonempty,
                  sample.contentLayoutRect.matchesFittedSettingsContent(
                      preferredContentSize: requestedContentSize,
                      windowFrame: sample.windowFrame,
                      visibleScreenFrame: sample.visibleScreenFrame,
                      tolerance: 1
                  ),
                  sample.contentLayoutScreenRect.matchesFittedSettingsContent(
                      preferredContentSize: requestedContentSize,
                      windowFrame: sample.windowFrame,
                      visibleScreenFrame: sample.visibleScreenFrame,
                      tolerance: 1
                  ),
                  sample.contentLayoutRect.isFullyContainedInWindowBounds(
                      windowFrame: sample.windowFrame,
                      tolerance: 1
                  ),
                  sample.contentLayoutScreenRect.isFullyContained(
                      in: sample.windowFrame,
                      tolerance: 1
                  ),
                  sample.windowFrame.isFullyContained(
                      in: sample.visibleScreenFrame,
                      tolerance: 1
                  ) else {
                throw HostedSettingsSceneTraceError.invalidAppKitGeometry(context)
            }
        }
        for sample in envelope.samples.dropFirst() {
            guard !baseline.windowFrame.differs(
                      from: sample.windowFrame,
                      byMoreThan: 1
                  ),
                  !baseline.contentLayoutRect.differs(
                      from: sample.contentLayoutRect,
                      byMoreThan: 1
                  ),
                  !baseline.contentLayoutScreenRect.differs(
                      from: sample.contentLayoutScreenRect,
                      byMoreThan: 1
                  ),
                  !baseline.visibleScreenFrame.differs(
                      from: sample.visibleScreenFrame,
                      byMoreThan: 1
                  ) else {
                throw HostedSettingsSceneTraceError.unstableAppKitGeometry(context)
            }
        }
        return envelope
    }

    private func captureStableSettingsSceneSamples(
        app: XCUIApplication,
        settingsEvaluationContainer: XCUIElement,
        outerScroll: XCUIElement,
        bottomSentinel: XCUIElement,
        expectedAppKitWindowSize: HostedContentSize,
        appKitWindowFrame: HostedSettingsAppKitFrame,
        appKitContentLayoutScreenRect: HostedSettingsAppKitFrame,
        context: String
    ) throws -> [HostedSettingsSceneSample] {
        let start = ProcessInfo.processInfo.systemUptime
        var samples: [HostedSettingsSceneSample] = []
        var previousSampleStart: TimeInterval?
        for index in 0..<3 {
            if index > 0, let previousSampleStart {
                let elapsedSincePrevious =
                    ProcessInfo.processInfo.systemUptime - previousSampleStart
                let remainingDelay = max(0, 0.1 - elapsedSincePrevious)
                if remainingDelay > 0 {
                    RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
                }
            }
            let sampleStart = ProcessInfo.processInfo.systemUptime
            previousSampleStart = sampleStart
            let accessibilityContainerFrame = HostedGeometryFrame(
                settingsEvaluationContainer.frame
            )
            let windowFrame = try settingsContainingWindowFrame(
                app: app,
                accessibilityContainerFrame: accessibilityContainerFrame,
                context: context
            )
            let projectedAppKitContentLayoutFrame = HostedGeometryFrame(
                appKitContentLayoutScreenRect,
                relativeTo: appKitWindowFrame,
                in: windowFrame
            )
            let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
            let sentinelFrame = HostedGeometryFrame(bottomSentinel.frame)
            guard accessibilityContainerFrame.isFiniteAndNonempty,
                  windowFrame.isFiniteAndNonempty,
                  projectedAppKitContentLayoutFrame.isFiniteAndNonempty,
                  outerScrollFrame.isFiniteAndNonempty,
                  sentinelFrame.isFiniteAndNonempty else {
                throw HostedSettingsSceneTraceError.invalidFrame(context)
            }
            guard windowFrame.matches(expectedAppKitWindowSize, tolerance: 1),
                  accessibilityContainerFrame.matches(
                      expectedAppKitWindowSize,
                      tolerance: 1
                  ) else {
                throw HostedSettingsSceneTraceError.unexpectedWindowSize(
                    expected: expectedAppKitWindowSize,
                    observedWindow: windowFrame,
                    observedAccessibilityContainer: accessibilityContainerFrame
                )
            }
            let accessibilityContainerMatchesWindowFrame =
                !accessibilityContainerFrame.differs(
                from: windowFrame,
                byMoreThan: 1
            )
            let sample = HostedSettingsSceneSample(
                elapsedMilliseconds: Int(((sampleStart - start) * 1_000).rounded()),
                completionElapsedMilliseconds: Int(
                    ((ProcessInfo.processInfo.systemUptime - start) * 1_000).rounded()
                ),
                windowFrame: windowFrame,
                accessibilityContainerFrame: accessibilityContainerFrame,
                projectedAppKitContentLayoutFrame: projectedAppKitContentLayoutFrame,
                outerScrollFrame: outerScrollFrame,
                sentinelFrame: sentinelFrame,
                accessibilityContainerMatchesWindowFrame:
                    accessibilityContainerMatchesWindowFrame,
                accessibilityContainerFullyContainedInWindow:
                    accessibilityContainerFrame.isFullyContained(
                    in: windowFrame,
                    tolerance: 1
                ),
                projectedAppKitContentLayoutFullyContainedInWindow:
                    projectedAppKitContentLayoutFrame.isFullyContained(
                    in: windowFrame,
                    tolerance: 1
                ),
                outerScrollFullyContainedInProjectedAppKitContentLayout:
                    outerScrollFrame.isFullyContained(
                    in: projectedAppKitContentLayoutFrame,
                    tolerance: 1
                ),
                sentinelFullyContainedInOuterScroll: sentinelFrame.isFullyContained(
                    in: outerScrollFrame,
                    tolerance: 1
                )
            )
            guard sample.accessibilityContainerMatchesWindowFrame,
                  sample.accessibilityContainerFullyContainedInWindow,
                  sample.projectedAppKitContentLayoutFullyContainedInWindow,
                  sample.outerScrollFullyContainedInProjectedAppKitContentLayout else {
                throw HostedSettingsSceneTraceError.invalidContainment(context)
            }
            samples.append(sample)
        }

        guard samples.count == 3,
              samples[0].elapsedMilliseconds >= 0,
              samples[0].elapsedMilliseconds <= 25,
              let finalCompletionElapsedMilliseconds =
                  samples.last?.completionElapsedMilliseconds,
              finalCompletionElapsedMilliseconds <= 5_000 else {
            throw HostedSettingsSceneTraceError.invalidCadence(context)
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            guard rhs.elapsedMilliseconds - lhs.elapsedMilliseconds >= 90 else {
                throw HostedSettingsSceneTraceError.invalidCadence(context)
            }
        }
        guard let baseline = samples.first else {
            throw HostedSettingsSceneTraceError.invalidCadence(context)
        }
        for sample in samples.dropFirst() {
            guard !baseline.windowFrame.differs(from: sample.windowFrame, byMoreThan: 1),
                  !baseline.accessibilityContainerFrame.differs(
                      from: sample.accessibilityContainerFrame,
                      byMoreThan: 1
                  ),
                  !baseline.projectedAppKitContentLayoutFrame.differs(
                      from: sample.projectedAppKitContentLayoutFrame,
                      byMoreThan: 1
                  ),
                  !baseline.outerScrollFrame.differs(
                      from: sample.outerScrollFrame,
                      byMoreThan: 1
                  ),
                  !baseline.sentinelFrame.differs(
                      from: sample.sentinelFrame,
                      byMoreThan: 1
                  ) else {
                throw HostedSettingsSceneTraceError.unstableGeometry(context)
            }
        }
        return samples
    }

    private func settingsContainingWindowFrame(
        app: XCUIApplication,
        accessibilityContainerFrame: HostedGeometryFrame,
        context: String
    ) throws -> HostedGeometryFrame {
        let candidates = (0..<app.windows.count)
            .map { HostedGeometryFrame(app.windows.element(boundBy: $0).frame) }
            .filter {
                $0.isFiniteAndNonempty
                    && accessibilityContainerFrame.isFullyContained(
                        in: $0,
                        tolerance: 1
                    )
            }
            .sorted { $0.area < $1.area }
        guard let windowFrame = candidates.first else {
            throw HostedSettingsSceneTraceError.missingContainingWindow(context)
        }
        return windowFrame
    }

    func testStrictFixtureSettlesAcrossEveryOnboardingStepAtCanonicalSize() throws {
        let requestedContentSize = HostedContentSize(width: 760, height: 560)
        let fixtureSteps = [
            HostedOnboardingFixtureStep(fixtureId: "onboarding-welcome", onboardingStep: "welcome", section: "overview"),
            HostedOnboardingFixtureStep(fixtureId: "onboarding-provider", onboardingStep: "provider", section: "providers"),
            HostedOnboardingFixtureStep(fixtureId: "onboarding-daemon", onboardingStep: "daemon", section: "overview"),
            HostedOnboardingFixtureStep(fixtureId: "onboarding-license", onboardingStep: "license", section: "license"),
            HostedOnboardingFixtureStep(fixtureId: "onboarding-done", onboardingStep: "done", section: "overview")
        ]
        var scenarios: [HostedOnboardingScenario] = []
        for fixtureStep in fixtureSteps {
            scenarios.append(
                try captureOnboardingScenario(
                    fixtureStep,
                    requestedContentSize: requestedContentSize
                )
            )
        }

        XCTAssertEqual(scenarios.count, 5)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedOnboardingTraceError.priorValidationFailure
        }
        try attach(
            HostedOnboardingMatrixTrace(
                schemaVersion: 1,
                requestedContentSize: requestedContentSize,
                coordinateSpace: "xcui-screen",
                sampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: 5_000,
                tolerancePoints: 1,
                scenarios: scenarios,
                proofBoundary: "hosted-five-onboarding-fixtures-760x560-settled-geometry-only-actions-scroll-large-text-manual-excluded"
            )
        )
    }

    private func captureOnboardingScenario(
        _ fixtureStep: HostedOnboardingFixtureStep,
        requestedContentSize: HostedContentSize
    ) throws -> HostedOnboardingScenario {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(
                forResource: fixtureStep.fixtureId,
                withExtension: "json"
            )
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "\(requestedContentSize.width)x\(requestedContentSize.height)",
            "--disable-animations"
        ]
        app.launch()

        guard app.windows.firstMatch.waitForExistence(timeout: 10) else {
            throw HostedOnboardingTraceError.missingElement("window")
        }
        let fixtureRootIdentifier = "neondiff.fixture.\(fixtureStep.fixtureId)"
        let fixtureRoot = app.descendants(matching: .any)[fixtureRootIdentifier]
        guard fixtureRoot.waitForExistence(timeout: 10) else {
            throw HostedOnboardingTraceError.missingElement(fixtureRootIdentifier)
        }
        guard app.state == .runningForeground else {
            throw HostedOnboardingTraceError.appNotForeground
        }

        let markerIdentifier =
            "neondiff.evaluation.surface.\(fixtureStep.section).0.quiescent"
        let marker = app.descendants(matching: .any)[markerIdentifier]
        guard marker.waitForExistence(timeout: 10) else {
            throw HostedOnboardingTraceError.missingElement(markerIdentifier)
        }
        guard !marker.isHittable else {
            throw HostedOnboardingTraceError.interactiveQuiescenceMarker(markerIdentifier)
        }

        let currentStepIdentifier =
            "neondiff-onboarding-current-step-\(fixtureStep.onboardingStep)"
        _ = try uniqueOnboardingElement(
            app: app,
            identifier: currentStepIdentifier
        )
        let wizard = try uniqueOnboardingElement(
            app: app,
            identifier: "neondiff-onboarding-wizard"
        )
        let regions = try [
            "neondiff-onboarding-header",
            "neondiff-onboarding-step-list",
            "neondiff-onboarding-step-content",
            "neondiff-onboarding-footer"
        ].map {
            ($0, try uniqueOnboardingElement(app: app, identifier: $0))
        }
        let samples = try captureStableOnboardingSamples(
            app: app,
            wizard: wizard,
            regions: regions,
            requestedContentSize: requestedContentSize,
            context: fixtureStep.fixtureId
        )

        return HostedOnboardingScenario(
            fixtureId: fixtureStep.fixtureId,
            onboardingStep: fixtureStep.onboardingStep,
            section: fixtureStep.section,
            fixtureRootIdentifier: fixtureRootIdentifier,
            currentStepIdentifier: currentStepIdentifier,
            quiescenceMarkerIdentifier: markerIdentifier,
            samples: samples
        )
    }

    private func uniqueOnboardingElement(
        app: XCUIApplication,
        identifier: String
    ) throws -> XCUIElement {
        let query = app.descendants(matching: .any).matching(identifier: identifier)
        let element = query.firstMatch
        guard element.waitForExistence(timeout: 5) else {
            throw HostedOnboardingTraceError.missingElement(identifier)
        }
        guard query.count == 1 else {
            throw HostedOnboardingTraceError.invalidElementCount(
                identifier: identifier,
                count: query.count
            )
        }
        return element
    }

    private func captureStableOnboardingSamples(
        app: XCUIApplication,
        wizard: XCUIElement,
        regions: [(String, XCUIElement)],
        requestedContentSize: HostedContentSize,
        context: String
    ) throws -> [HostedOnboardingSample] {
        let start = ProcessInfo.processInfo.systemUptime
        var previousSampleStart: TimeInterval?
        var samples: [HostedOnboardingSample] = []
        for index in 0..<3 {
            if index > 0, let previousSampleStart {
                let elapsedSincePrevious =
                    ProcessInfo.processInfo.systemUptime - previousSampleStart
                let remainingDelay = max(0, 0.1 - elapsedSincePrevious)
                if remainingDelay > 0 {
                    RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
                }
            }
            let sampleStart = ProcessInfo.processInfo.systemUptime
            previousSampleStart = sampleStart
            let wizardFrame = HostedGeometryFrame(wizard.frame)
            guard wizardFrame.isFiniteAndNonempty else {
                throw HostedOnboardingTraceError.invalidFrame("\(context) wizard")
            }
            guard wizardFrame.matches(requestedContentSize, tolerance: 1) else {
                throw HostedOnboardingTraceError.unexpectedContentSize(
                    context: context,
                    requested: requestedContentSize,
                    observed: wizardFrame
                )
            }
            let windowFrame = try smallestContainingWindowFrame(
                app: app,
                frame: wizardFrame,
                context: context
            )
            let fullyContainedInWindow = wizardFrame.isFullyContained(
                in: windowFrame,
                tolerance: 1
            )
            guard fullyContainedInWindow else {
                throw HostedOnboardingTraceError.wizardNotContained(
                    context: context,
                    wizard: wizardFrame,
                    window: windowFrame
                )
            }
            let regionFrames = try regions.map { identifier, element in
                let frame = HostedGeometryFrame(element.frame)
                guard frame.isFiniteAndNonempty else {
                    throw HostedOnboardingTraceError.invalidFrame(
                        "\(context) \(identifier)"
                    )
                }
                let fullyContainedInWizard = frame.isFullyContained(
                    in: wizardFrame,
                    tolerance: 1
                )
                guard fullyContainedInWizard else {
                    throw HostedOnboardingTraceError.regionNotContained(
                        context: context,
                        identifier: identifier,
                        region: frame,
                        wizard: wizardFrame
                    )
                }
                return HostedOnboardingRegionFrame(
                    identifier: identifier,
                    frame: frame,
                    fullyContainedInWizard: fullyContainedInWizard
                )
            }
            let sample = HostedOnboardingSample(
                elapsedMilliseconds: Int(((sampleStart - start) * 1_000).rounded()),
                completionElapsedMilliseconds: Int(
                    ((ProcessInfo.processInfo.systemUptime - start) * 1_000).rounded()
                ),
                windowFrame: windowFrame,
                wizardFrame: wizardFrame,
                fullyContainedInWindow: fullyContainedInWindow,
                regions: regionFrames
            )
            try validateOnboardingRegionLayout(sample, context: context)
            samples.append(sample)
        }

        guard samples.count == 3,
              samples[0].elapsedMilliseconds >= 0,
              samples[0].elapsedMilliseconds <= 25,
              let finalCompletionElapsedMilliseconds =
                  samples.last?.completionElapsedMilliseconds,
              finalCompletionElapsedMilliseconds <= 5_000,
              samples.allSatisfy({
                  $0.completionElapsedMilliseconds >= $0.elapsedMilliseconds
              }) else {
            throw HostedOnboardingTraceError.invalidCadence(context)
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            guard rhs.elapsedMilliseconds - lhs.elapsedMilliseconds >= 90 else {
                throw HostedOnboardingTraceError.invalidCadence(context)
            }
        }
        try validateStableOnboardingSamples(samples, context: context)
        return samples
    }

    private func smallestContainingWindowFrame(
        app: XCUIApplication,
        frame: HostedGeometryFrame,
        context: String
    ) throws -> HostedGeometryFrame {
        let candidates = (0..<app.windows.count)
            .map { HostedGeometryFrame(app.windows.element(boundBy: $0).frame) }
            .filter {
                $0.isFiniteAndNonempty
                    && frame.isFullyContained(in: $0, tolerance: 1)
            }
            .sorted { $0.area < $1.area }
        guard let windowFrame = candidates.first else {
            throw HostedOnboardingTraceError.missingContainingWindow(context)
        }
        return windowFrame
    }

    private func validateStableOnboardingSamples(
        _ samples: [HostedOnboardingSample],
        context: String
    ) throws {
        guard let baseline = samples.first else {
            throw HostedOnboardingTraceError.missingSamples(context)
        }
        for sample in samples.dropFirst() {
            guard !baseline.windowFrame.differs(
                from: sample.windowFrame,
                byMoreThan: 1
            ), !baseline.wizardFrame.differs(
                from: sample.wizardFrame,
                byMoreThan: 1
            ), baseline.fullyContainedInWindow,
               sample.fullyContainedInWindow,
               baseline.regions.count == sample.regions.count else {
                throw HostedOnboardingTraceError.unstableGeometry(context)
            }
            for region in baseline.regions {
                guard let candidate = sample.regions.first(where: {
                    $0.identifier == region.identifier
                }), !region.frame.differs(
                    from: candidate.frame,
                    byMoreThan: 1
                ), region.fullyContainedInWizard,
                   candidate.fullyContainedInWizard else {
                    throw HostedOnboardingTraceError.unstableGeometry(
                        "\(context) \(region.identifier)"
                    )
                }
            }
        }
    }

    private func validateOnboardingRegionLayout(
        _ sample: HostedOnboardingSample,
        context: String
    ) throws {
        let expectedIdentifiers = Set([
            "neondiff-onboarding-header",
            "neondiff-onboarding-step-list",
            "neondiff-onboarding-step-content",
            "neondiff-onboarding-footer"
        ])
        guard Set(sample.regions.map(\.identifier)) == expectedIdentifiers,
              let header = sample.regions.first(where: {
                  $0.identifier == "neondiff-onboarding-header"
              })?.frame,
              let stepList = sample.regions.first(where: {
                  $0.identifier == "neondiff-onboarding-step-list"
              })?.frame,
              let stepContent = sample.regions.first(where: {
                  $0.identifier == "neondiff-onboarding-step-content"
              })?.frame,
              let footer = sample.regions.first(where: {
                  $0.identifier == "neondiff-onboarding-footer"
              })?.frame,
              header.maxY <= min(stepList.y, stepContent.y) + 1,
              stepList.maxX <= stepContent.x + 1,
              max(stepList.maxY, stepContent.maxY) <= footer.y + 1 else {
            throw HostedOnboardingTraceError.invalidRegionLayout(context)
        }
    }

    private func captureRenderedTextScaleScenario(
        requestedContentSize: HostedContentSize,
        textSizeMode: String,
        textSizeArgument: String?,
        rootIdentifier: String
    ) throws -> HostedRenderedTextScaleScenario {
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", "1040x680",
            "--disable-animations"
        ]
        if let textSizeArgument {
            app.launchArguments.append(contentsOf: ["--text-size", textSizeArgument])
        }
        app.launch()

        guard app.windows.firstMatch.waitForExistence(timeout: 10) else {
            throw HostedRenderedTextScaleError.missingElement("window")
        }
        let root = app.descendants(matching: .any)[rootIdentifier]
        guard root.waitForExistence(timeout: 10) else {
            throw HostedRenderedTextScaleError.missingElement(rootIdentifier)
        }
        guard app.state == .runningForeground else {
            throw HostedRenderedTextScaleError.appNotForeground
        }

        let markerIdentifier = "neondiff.evaluation.surface.overview.0.quiescent"
        _ = try captureCheckpoint(
            app: app,
            section: "overview",
            generation: 0,
            markerIdentifier: markerIdentifier,
            requestedContentSize: requestedContentSize
        )

        let titleQuery = app.staticTexts.matching(identifier: "neondiff-section-title")
        guard titleQuery.count == 1 else {
            throw HostedRenderedTextScaleError.invalidElementCount(
                identifier: "neondiff-section-title",
                count: titleQuery.count
            )
        }
        let title = titleQuery.element(boundBy: 0)
        guard title.waitForExistence(timeout: 2) else {
            throw HostedRenderedTextScaleError.missingElement("neondiff-section-title")
        }
        _ = try semanticStaticTextValue(title)
        let samples = try captureStableVisibleTextSamples(
            title,
            visibleContainer: app.windows.firstMatch,
            context: textSizeMode
        )

        return HostedRenderedTextScaleScenario(
            textSizeMode: textSizeMode,
            launchTextSizeArgument: textSizeArgument,
            rootIdentifier: rootIdentifier,
            quiescenceMarkerIdentifier: markerIdentifier,
            samples: samples
        )
    }

    private func captureStableVisibleTextSamples(
        _ element: XCUIElement,
        visibleContainer: XCUIElement,
        context: String
    ) throws -> [HostedRenderedTextSample] {
        let start = ProcessInfo.processInfo.systemUptime
        var previousSampleStart: TimeInterval?
        var samples: [HostedRenderedTextSample] = []
        for index in 0..<3 {
            if index > 0, let previousSampleStart {
                let elapsedSincePrevious =
                    ProcessInfo.processInfo.systemUptime - previousSampleStart
                let remainingDelay = max(0, 0.1 - elapsedSincePrevious)
                if remainingDelay > 0 {
                    RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
                }
            }
            let sampleStart = ProcessInfo.processInfo.systemUptime
            previousSampleStart = sampleStart
            let frame = HostedGeometryFrame(element.frame)
            let visibleContainerFrame = HostedGeometryFrame(visibleContainer.frame)
            guard frame.isFiniteAndNonempty else {
                throw HostedRenderedTextScaleError.invalidFrame(context)
            }
            guard visibleContainerFrame.isFiniteAndNonempty else {
                throw HostedRenderedTextScaleError.invalidVisibleContainerFrame(context)
            }
            let semanticValue = try semanticStaticTextValue(element)
            let fullyContainedInVisibleContainer = frame.isFullyContained(
                in: visibleContainerFrame,
                tolerance: 1
            )
            guard fullyContainedInVisibleContainer else {
                throw HostedRenderedTextScaleError.textNotVisible(
                    context: context,
                    textFrame: frame,
                    visibleContainerFrame: visibleContainerFrame
                )
            }
            samples.append(
                HostedRenderedTextSample(
                    elapsedMilliseconds: Int(((sampleStart - start) * 1_000).rounded()),
                    frame: frame,
                    semanticValue: semanticValue,
                    visibleContainerFrame: visibleContainerFrame,
                    fullyContainedInVisibleContainer: fullyContainedInVisibleContainer
                )
            )
        }

        guard samples.count == 3,
              samples[0].elapsedMilliseconds >= 0,
              samples[0].elapsedMilliseconds <= 25,
              let finalElapsedMilliseconds = samples.last?.elapsedMilliseconds,
              finalElapsedMilliseconds <= 5_000 else {
            throw HostedRenderedTextScaleError.invalidCadence(context)
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            guard rhs.elapsedMilliseconds - lhs.elapsedMilliseconds >= 90 else {
                throw HostedRenderedTextScaleError.invalidCadence(context)
            }
        }
        guard let baseline = samples.first else {
            throw HostedRenderedTextScaleError.missingSamples(context)
        }
        for sample in samples.dropFirst() {
            guard !baseline.frame.differs(from: sample.frame, byMoreThan: 1),
                  !baseline.visibleContainerFrame.differs(
                      from: sample.visibleContainerFrame,
                      byMoreThan: 1
                  ),
                  baseline.fullyContainedInVisibleContainer,
                  sample.fullyContainedInVisibleContainer,
                  baseline.semanticValue == sample.semanticValue else {
                throw HostedRenderedTextScaleError.unstableGeometry(context)
            }
        }
        return samples
    }

    private func semanticStaticTextValue(_ element: XCUIElement) throws -> String {
        guard let semanticValue = element.value as? String,
              semanticValue == "Overview" else {
            throw HostedRenderedTextScaleError.unexpectedSemanticValue(
                String(describing: element.value)
            )
        }
        return semanticValue
    }

    private func captureCanonicalSizeScenario(
        _ request: HostedCanonicalSizeRequest
    ) throws -> HostedCanonicalSizeScenario {
        let route = everySidebarPageBottomRoute
        let fixtureURL = try XCTUnwrap(
            Bundle(for: Self.self).url(forResource: "tab-overview", withExtension: "json")
        )
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--ui-testing",
            "--ui-fixture", fixtureURL.path,
            "--content-size", request.contentSizeArgument,
            "--disable-animations"
        ]
        app.launch()

        XCTAssertTrue(app.windows.firstMatch.waitForExistence(timeout: 10))
        XCTAssertTrue(
            app.descendants(matching: .any)["neondiff.fixture.tab-overview"]
                .waitForExistence(timeout: 10)
        )
        XCTAssertEqual(app.state, .runningForeground)

        var geometryCheckpoints: [HostedGeometryCheckpoint] = []
        var pageBottomCheckpoints: [HostedPageBottomCheckpoint] = []
        var navigationActions: [HostedNavigationAction] = []
        for (routeIndex, step) in route.enumerated() {
            if routeIndex > 0 {
                let previous = route[routeIndex - 1]
                navigationActions.append(
                    try clickNavigation(
                        app: app,
                        index: routeIndex - 1,
                        fromSection: previous.section,
                        toSection: step.section,
                        identifier: "neondiff-sidebar-section-\(step.section)"
                    )
                )
            }

            let markerIdentifier =
                "neondiff.evaluation.surface.\(step.section).\(step.generation).quiescent"
            geometryCheckpoints.append(
                try captureCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: markerIdentifier,
                    requestedContentSize: request.requestedContentSize
                )
            )
            pageBottomCheckpoints.append(
                try capturePageBottomCheckpoint(
                    app: app,
                    section: step.section,
                    generation: step.generation,
                    markerIdentifier: markerIdentifier,
                    outerScrollIdentifier: step.outerScrollIdentifier,
                    sentinelIdentifier: step.sentinelIdentifier
                )
            )
        }

        XCTAssertEqual(geometryCheckpoints.count, 7)
        XCTAssertEqual(pageBottomCheckpoints.count, 7)
        XCTAssertEqual(navigationActions.count, 6)
        assertStableAcrossTransitions(geometryCheckpoints)
        guard (testRun?.failureCount ?? 0) == 0 else {
            throw HostedPageBottomTraceError.priorValidationFailure
        }

        return HostedCanonicalSizeScenario(
            requestedContentSize: request.requestedContentSize,
            contentSizeArgument: request.contentSizeArgument,
            settledGeometry: HostedSettledGeometryTrace(
                schemaVersion: 2,
                scenario: "every-sidebar-destination-\(request.contentSizeArgument)",
                fixtureId: "tab-overview",
                requestedContentSize: request.requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpaces: HostedGeometryCoordinateSpaces(
                    windowAndContent: "appkit-screen",
                    regions: "swiftui-global"
                ),
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: geometryCheckpoints,
                proofBoundary: "hosted-every-sidebar-destination-\(request.contentSizeArgument)-geometry-only"
            ),
            pageBottomReachability: HostedPageBottomReachabilityTrace(
                schemaVersion: 2,
                scenario: "every-sidebar-page-bottom-\(request.contentSizeArgument)",
                fixtureId: "tab-overview",
                requestedContentSize: request.requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpace: "xcui-screen",
                minimumSampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: hostedPageBottomSamplingDeadlineMilliseconds,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: pageBottomCheckpoints,
                proofBoundary: "hosted-outer-page-bottom-\(request.contentSizeArgument)-reachability-only-inner-scroll-exhaustion-excluded"
            )
        )
    }

    private var everySidebarPageBottomRoute: [HostedPageBottomRouteStep] {
        [
            HostedPageBottomRouteStep(
                section: "overview",
                generation: 0,
                outerScrollIdentifier: "neondiff-overview-outer-scroll",
                sentinelIdentifier: "neondiff-overview-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "repos",
                generation: 1,
                outerScrollIdentifier: "neondiff-repos-outer-scroll",
                sentinelIdentifier: "neondiff-repos-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "providers",
                generation: 2,
                outerScrollIdentifier: "neondiff-providers-outer-scroll",
                sentinelIdentifier: "neondiff-providers-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "license",
                generation: 3,
                outerScrollIdentifier: "neondiff-license-outer-scroll",
                sentinelIdentifier: "neondiff-license-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "logs",
                generation: 4,
                outerScrollIdentifier: "neondiff-logs-outer-scroll",
                sentinelIdentifier: "neondiff-logs-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "policy",
                generation: 5,
                outerScrollIdentifier: "neondiff-policy-outer-scroll",
                sentinelIdentifier: "neondiff-policy-page-bottom"
            ),
            HostedPageBottomRouteStep(
                section: "settings",
                generation: 6,
                outerScrollIdentifier: "neondiff-settings-outer-scroll",
                sentinelIdentifier: "neondiff-settings-page-bottom"
            )
        ]
    }

    private func captureNativeInnerScrollExhaustion(
        app: XCUIApplication,
        section: String,
        controlIdentifier: String,
        controlElementType: XCUIElement.ElementType,
        controlElementTypeName: String,
        terminalRowElementType: XCUIElement.ElementType?,
        terminalRowElementTypeName: String?,
        outerScrollIdentifier: String,
        outerSentinelIdentifier: String,
        outerPreparationCheckpoint: HostedPageBottomCheckpoint,
        terminalVisibleText: String?,
        terminalValueToken: String?,
        terminalVisibilityMarkerIdentifier: String?
    ) throws -> HostedNativeInnerScrollCheckpoint {
        let targetSampleIntervalMilliseconds = 100
        let minimumAcceptedSampleIntervalMilliseconds = 90
        let samplingDeadlineMilliseconds = hostedNativeInnerScrollSamplingDeadlineMilliseconds
        let samplingStart = ProcessInfo.processInfo.systemUptime
        let controlQuery = app.descendants(matching: controlElementType)
            .matching(identifier: controlIdentifier)
        guard controlQuery.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidElementCount(
                identifier: controlIdentifier,
                count: controlQuery.count
            )
        }
        let control = controlQuery.element(boundBy: 0)
        guard control.waitForExistence(timeout: 2) else {
            throw HostedNativeInnerScrollTraceError.missingElement(controlIdentifier)
        }
        let outerScroll = app.descendants(matching: .any)[outerScrollIdentifier]
        let outerSentinel = app.descendants(matching: .any)[outerSentinelIdentifier]
        guard outerScroll.waitForExistence(timeout: 2) else {
            throw HostedNativeInnerScrollTraceError.missingElement(outerScrollIdentifier)
        }
        guard outerSentinel.waitForExistence(timeout: 2) else {
            throw HostedNativeInnerScrollTraceError.missingElement(outerSentinelIdentifier)
        }
        let terminalVisibilityMarkerQuery = terminalVisibilityMarkerIdentifier.map {
            app.descendants(matching: .any).matching(identifier: $0)
        }

        let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
        guard outerScrollFrame.isFiniteAndNonempty else {
            throw HostedNativeInnerScrollTraceError.invalidFrame
        }
        let scrollContainers = app.descendants(matching: .scrollView)
            .allElementsBoundByIndex.filter { candidate in
                let frame = HostedGeometryFrame(candidate.frame)
                return candidate.identifier != outerScrollIdentifier
                    && frame.isFiniteAndNonempty
                    && frame.differs(from: outerScrollFrame, byMoreThan: 1)
                    && candidate.descendants(matching: controlElementType)
                        .matching(identifier: controlIdentifier).count == 1
            }
        guard scrollContainers.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollContainerCount(
                controlIdentifier: controlIdentifier,
                count: scrollContainers.count
            )
        }
        let scrollContainer = scrollContainers[0]
        let scrollContainerFrame = HostedGeometryFrame(scrollContainer.frame)
        let verticalScrollBars = scrollContainer.scrollBars.allElementsBoundByIndex.filter {
            candidate in
            let frame = HostedGeometryFrame(candidate.frame)
            return frame.isFiniteAndNonempty
                && frame.height > frame.width
                && frame.isFullyContained(in: scrollContainerFrame, tolerance: 2)
        }
        guard verticalScrollBars.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidVerticalScrollBarCount(
                controlIdentifier: controlIdentifier,
                count: verticalScrollBars.count
            )
        }
        let verticalScrollBar = verticalScrollBars[0]
        let outerPreparationSample = try captureNativeInnerScrollSample(
            app: app,
            elapsedMilliseconds: Int(
                ((ProcessInfo.processInfo.systemUptime - samplingStart) * 1_000).rounded()
            ),
            control: control,
            scrollContainer: scrollContainer,
            verticalScrollBar: verticalScrollBar,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            captureTerminalContent: false,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType
        )
        var outerPreparationFailures: [String] = []
        if outerPreparationCheckpoint.section != section {
            outerPreparationFailures.append("section-mismatch")
        }
        if outerPreparationCheckpoint.outerScrollIdentifier != outerScrollIdentifier {
            outerPreparationFailures.append("outer-scroll-identifier-mismatch")
        }
        if outerPreparationCheckpoint.sentinelIdentifier != outerSentinelIdentifier {
            outerPreparationFailures.append("sentinel-identifier-mismatch")
        }
        if let outerPreparationAction = outerPreparationCheckpoint.scrollAction {
            if outerPreparationAction.controlIdentifier != outerScrollIdentifier {
                outerPreparationFailures.append("scroll-action-control-mismatch")
            }
            if outerPreparationAction.attemptCount != 1 {
                outerPreparationFailures.append("scroll-action-attempt-count")
            }
            if outerPreparationAction.result != "returned" {
                outerPreparationFailures.append("scroll-action-result")
            }
            if !outerPreparationAction.effectProven {
                outerPreparationFailures.append("scroll-action-effect")
            }
            if outerPreparationAction.nestedScrollControlIdentifier != controlIdentifier {
                outerPreparationFailures.append("scroll-action-nested-control-mismatch")
            }
            if let before = outerPreparationAction.nestedScrollValueBefore,
               let after = outerPreparationAction.nestedScrollValueAfter {
                if before != after {
                    outerPreparationFailures.append("scroll-action-nested-value-changed")
                }
            } else {
                outerPreparationFailures.append("scroll-action-nested-value-missing")
            }
            if outerPreparationAction.targetPoint == nil {
                outerPreparationFailures.append("scroll-action-guard-target-missing")
            }
            if outerPreparationAction.guardOuterScrollFrame == nil
                || outerPreparationAction.guardNestedScrollFrame == nil {
                outerPreparationFailures.append("scroll-action-guard-frames-missing")
            }
            if let guardTargetPoint = outerPreparationAction.targetPoint,
               let guardOuterScrollFrame = outerPreparationAction.guardOuterScrollFrame,
               let guardNestedScrollFrame = outerPreparationAction.guardNestedScrollFrame {
                if !guardOuterScrollFrame.isFiniteAndNonempty {
                    outerPreparationFailures.append("scroll-action-guard-outer-frame-invalid")
                }
                if !guardNestedScrollFrame.isFiniteAndNonempty {
                    outerPreparationFailures.append("scroll-action-guard-nested-frame-invalid")
                }
                let guardTargetInsideOuter =
                    guardTargetPoint.x >= guardOuterScrollFrame.x + 1
                    && guardTargetPoint.x <= guardOuterScrollFrame.maxX - 1
                    && guardTargetPoint.y >= guardOuterScrollFrame.y + 1
                    && guardTargetPoint.y <= guardOuterScrollFrame.maxY - 1
                if !guardTargetInsideOuter {
                    outerPreparationFailures.append("scroll-action-guard-target-outside-outer")
                }
                let guardTargetOutsideNested =
                    guardTargetPoint.x < guardNestedScrollFrame.x - 1
                    || guardTargetPoint.x > guardNestedScrollFrame.maxX + 1
                    || guardTargetPoint.y < guardNestedScrollFrame.y - 1
                    || guardTargetPoint.y > guardNestedScrollFrame.maxY + 1
                if !guardTargetOutsideNested {
                    outerPreparationFailures.append("scroll-action-guard-target-inside-nested")
                }
            }
        }
        if let preparedSample = outerPreparationCheckpoint.postActionSamples.last {
            if !preparedSample.sentinelFullyContainedInOuterScroll {
                outerPreparationFailures.append("post-sentinel-outside-outer")
            }
            if !preparedSample.sentinelFullyContainedInDetailRegion {
                outerPreparationFailures.append("post-sentinel-outside-detail")
            }
            if preparedSample.outerScrollFrame.differs(
                from: outerPreparationSample.outerScrollFrame,
                byMoreThan: 1
            ) {
                outerPreparationFailures.append("outer-frame-drift")
            }
            if preparedSample.sentinelFrame.differs(
                from: outerPreparationSample.outerSentinelFrame,
                byMoreThan: 1
            ) {
                outerPreparationFailures.append("sentinel-frame-drift")
            }
        } else {
            outerPreparationFailures.append("missing-post-action-sample")
        }
        if !outerPreparationSample.outerSentinelFrame.isFullyContained(
            in: outerPreparationSample.outerScrollFrame,
            tolerance: 1
        ) {
            outerPreparationFailures.append("current-sentinel-outside-outer")
        }
        guard outerPreparationFailures.isEmpty else {
            throw HostedNativeInnerScrollTraceError.outerPreparationNotEstablished(section: section, failedChecks: outerPreparationFailures)
        }

        let restagingDeltaY = try outerRestagingDeltaY(
            scrollContainerFrame: outerPreparationSample.scrollContainerFrame,
            outerScrollFrame: outerPreparationSample.outerScrollFrame,
            tolerance: 1
        )
        let requiresOuterRestaging = abs(restagingDeltaY) > 0.5
        let outerRestagingAction: HostedNativeInnerScrollAction?
        let restagingActionStartedAt = ProcessInfo.processInfo.systemUptime
        let restagingActionElapsedMilliseconds = Int(
            ((restagingActionStartedAt - samplingStart) * 1_000).rounded()
        )
        let outerRestagingTargetPoint: HostedGeometryPoint?
        if requiresOuterRestaging {
            let target = try outerRestagingCoordinate(
                outerScroll: outerScroll,
                outerScrollFrame: outerPreparationSample.outerScrollFrame,
                scrollContainerFrame: outerPreparationSample.scrollContainerFrame,
                tolerance: 1
            )
            outerRestagingTargetPoint = target.point
            target.coordinate.scroll(byDeltaX: 0, deltaY: CGFloat(restagingDeltaY))
        } else {
            outerRestagingTargetPoint = nil
        }
        let restagingWindow = try captureStableNativeInnerScrollSamples(
            app: app,
            controlIdentifier: controlIdentifier,
            samplingStartedAt: samplingStart,
            actionStartedAt: restagingActionStartedAt,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            control: control,
            scrollContainer: scrollContainer,
            verticalScrollBar: verticalScrollBar,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            captureTerminalContent: false,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType
        )
        let outerRestagingObservedSamples = restagingWindow.observedSamples
        let outerRestagingSamples = restagingWindow.samples
        guard let preSample = outerRestagingSamples.last else {
            throw HostedNativeInnerScrollTraceError.invalidSettledWindow(controlIdentifier)
        }
        var outerRestagingFailures: [String] = []
        if !outerRestagingSamples.allSatisfy({ sample in
            sample.scrollContainerFrame.isFullyContained(
                in: sample.outerScrollFrame,
                tolerance: 1
            )
        }) {
            outerRestagingFailures.append("inner-scroll-outside-outer")
        }
        if !outerRestagingObservedSamples.allSatisfy({ sample in
            sample.normalizedScrollValue == outerPreparationSample.normalizedScrollValue
        }) {
            outerRestagingFailures.append("inner-scroll-value-changed-during-outer-restaging")
        }
        let scrollContainerTranslation =
            preSample.scrollContainerFrame.y
                - outerPreparationSample.scrollContainerFrame.y
        let restagingEffectObserved = abs(scrollContainerTranslation) > 0.5
        if requiresOuterRestaging, !restagingEffectObserved {
            outerRestagingFailures.append("outer-restaging-no-effect")
        }
        if !requiresOuterRestaging, restagingEffectObserved {
            outerRestagingFailures.append("unexpected-outer-restaging-effect")
        }
        if requiresOuterRestaging,
           restagingDeltaY * scrollContainerTranslation <= 0 {
            outerRestagingFailures.append("outer-restaging-direction-mismatch")
        }
        if !outerRestagingSamples.allSatisfy({ sample in
            !sample.outerScrollFrame.differs(
                from: outerPreparationSample.outerScrollFrame,
                byMoreThan: 1
            )
                && frameMatchesRigidVerticalTranslation(
                    baseline: outerPreparationSample.controlFrame,
                    candidate: sample.controlFrame,
                    translationY: scrollContainerTranslation,
                    tolerance: 1
                )
                && frameMatchesRigidVerticalTranslation(
                    baseline: outerPreparationSample.scrollContainerFrame,
                    candidate: sample.scrollContainerFrame,
                    translationY: scrollContainerTranslation,
                    tolerance: 1
                )
                && frameMatchesRigidVerticalTranslation(
                    baseline: outerPreparationSample.scrollBarFrame,
                    candidate: sample.scrollBarFrame,
                    translationY: scrollContainerTranslation,
                    tolerance: 1
                )
                && frameMatchesRigidVerticalTranslation(
                    baseline: outerPreparationSample.outerSentinelFrame,
                    candidate: sample.outerSentinelFrame,
                    translationY: scrollContainerTranslation,
                    tolerance: 1
                )
        }) {
            outerRestagingFailures.append("outer-restaging-translation-mismatch")
        }
        guard outerRestagingFailures.isEmpty else {
            throw HostedNativeInnerScrollTraceError.outerRestagingNotEstablished(section: section, failedChecks: outerRestagingFailures)
        }
        if !requiresOuterRestaging {
            outerRestagingAction = nil
        } else {
            outerRestagingAction = HostedNativeInnerScrollAction(
                mechanism: "public-xcui-coordinate-scroll-delta",
                elapsedMilliseconds: restagingActionElapsedMilliseconds,
                deltaX: 0,
                deltaY: restagingDeltaY,
                targetPoint: outerRestagingTargetPoint,
                attemptCount: 1,
                effectObserved: restagingEffectObserved,
                effectProven: true,
                result: "returned-and-inner-viewport-contained-with-outer-translation-proven"
            )
        }
        let preTerminalValue = preSample.normalizedScrollValue
        guard preTerminalValue < 1 else {
            throw HostedNativeInnerScrollTraceError.invalidPreTerminalValue(
                controlIdentifier: controlIdentifier,
                value: preTerminalValue
            )
        }
        if let terminalVisibilityMarkerQuery,
           terminalVisibilityMarkerQuery.count != 0 {
            throw HostedNativeInnerScrollTraceError.terminalVisibilityMarkerPresentBeforeTerminal(
                terminalVisibilityMarkerIdentifier ?? "unknown"
            )
        }

        let firstPreparedDrag = try prepareNativeScrollBarThumbForDrag(
            app: app,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementType,
            outerScrollIdentifier: outerScrollIdentifier,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            baselineSample: preSample,
            captureTerminalContent: false,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType,
            samplingStartedAt: samplingStart,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            tolerance: 1
        )
        let firstHoverPreparation = firstPreparedDrag.preparation
        let firstDragTarget = firstPreparedDrag.dragTarget
        let firstActionStartedAt = ProcessInfo.processInfo.systemUptime
        let firstActionElapsedMilliseconds = Int(
            ((firstActionStartedAt - samplingStart) * 1_000).rounded()
        )
        firstDragTarget.sourceCoordinate.click(
            forDuration: 0.1,
            thenDragTo: firstDragTarget.destinationCoordinate
        )
        if let terminalVisibilityMarkerQuery,
           let terminalVisibilityMarkerIdentifier {
            let marker = terminalVisibilityMarkerQuery.element(boundBy: 0)
            guard marker.waitForExistence(timeout: 2),
                  terminalVisibilityMarkerQuery.count == 1 else {
                throw HostedNativeInnerScrollTraceError.invalidElementCount(
                    identifier: terminalVisibilityMarkerIdentifier,
                    count: terminalVisibilityMarkerQuery.count
                )
            }
        }
        let terminalWindow = try captureStableNativeInnerScrollSamples(
            app: app,
            controlIdentifier: controlIdentifier,
            samplingStartedAt: samplingStart,
            actionStartedAt: firstActionStartedAt,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            control: firstPreparedDrag.chain.control,
            scrollContainer: firstPreparedDrag.chain.scrollContainer,
            verticalScrollBar: firstPreparedDrag.chain.verticalScrollBar,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            captureTerminalContent: true,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType
        )
        let terminalObservedSamples = terminalWindow.observedSamples
        let terminalSamples = terminalWindow.samples
        guard let terminalSample = terminalSamples.last else {
            throw HostedNativeInnerScrollTraceError.invalidSettledWindow(controlIdentifier)
        }
        let terminalValue = terminalSample.normalizedScrollValue
        guard terminalSamples.allSatisfy({ $0.normalizedScrollValue == 1 }),
              terminalValue > preTerminalValue else {
            throw HostedNativeInnerScrollTraceError.didNotReachTerminalValue(
                controlIdentifier: controlIdentifier,
                preTerminalValue: preTerminalValue,
                terminalValue: terminalValue
            )
        }
        let postFirstDragChain = try reboundNativeScrollBarChain(
            app: app,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementType,
            outerScrollIdentifier: outerScrollIdentifier,
            tolerance: 1
        )
        let firstObservedThumbTranslationY =
            postFirstDragChain.thumbFrame.y - firstDragTarget.thumbFrame.y
        guard firstObservedThumbTranslationY > 0.5,
              !postFirstDragChain.scrollBarFrame.differs(
                  from: firstDragTarget.scrollBarFrame,
                  byMoreThan: 1
              ) else {
            throw HostedNativeInnerScrollTraceError.scrollBarThumbDidNotReachTerminal(
                controlIdentifier
            )
        }

        let repeatPreparedDrag = try prepareNativeScrollBarThumbForDrag(
            app: app,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementType,
            outerScrollIdentifier: outerScrollIdentifier,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            baselineSample: terminalSample,
            captureTerminalContent: true,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType,
            samplingStartedAt: samplingStart,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            tolerance: 1
        )
        let repeatHoverPreparation = repeatPreparedDrag.preparation
        let repeatDragTarget = repeatPreparedDrag.dragTarget
        let repeatActionStartedAt = ProcessInfo.processInfo.systemUptime
        let repeatActionElapsedMilliseconds = Int(
            ((repeatActionStartedAt - samplingStart) * 1_000).rounded()
        )
        repeatDragTarget.sourceCoordinate.click(
            forDuration: 0.1,
            thenDragTo: repeatDragTarget.destinationCoordinate
        )
        let repeatTerminalWindow = try captureStableNativeInnerScrollSamples(
            app: app,
            controlIdentifier: controlIdentifier,
            samplingStartedAt: samplingStart,
            actionStartedAt: repeatActionStartedAt,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            control: repeatPreparedDrag.chain.control,
            scrollContainer: repeatPreparedDrag.chain.scrollContainer,
            verticalScrollBar: repeatPreparedDrag.chain.verticalScrollBar,
            outerScroll: outerScroll,
            outerSentinel: outerSentinel,
            captureTerminalContent: true,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
            terminalRowElementType: terminalRowElementType
        )
        let repeatTerminalObservedSamples = repeatTerminalWindow.observedSamples
        let repeatTerminalSamples = repeatTerminalWindow.samples
        guard let repeatTerminalSample = repeatTerminalSamples.last else {
            throw HostedNativeInnerScrollTraceError.invalidSettledWindow(controlIdentifier)
        }
        let repeatTerminalValue = repeatTerminalSample.normalizedScrollValue
        guard repeatTerminalObservedSamples.allSatisfy({
            $0.normalizedScrollValue == terminalValue
        }) else {
            throw HostedNativeInnerScrollTraceError.repeatTerminalScrollChangedValue(
                controlIdentifier: controlIdentifier,
                terminalValue: terminalValue,
                repeatTerminalValue: repeatTerminalValue
            )
        }
        for candidate in repeatTerminalObservedSamples {
            guard nativeInnerScrollSamplesMatch(terminalSample, candidate) else {
                throw HostedNativeInnerScrollTraceError.repeatTerminalScrollChangedGeometry(
                    controlIdentifier
                )
            }
        }
        let postRepeatChain = try reboundNativeScrollBarChain(
            app: app,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementType,
            outerScrollIdentifier: outerScrollIdentifier,
            tolerance: 1
        )
        let repeatObservedThumbTranslationY =
            postRepeatChain.thumbFrame.y - repeatDragTarget.thumbFrame.y
        guard abs(repeatObservedThumbTranslationY) <= 1,
              !postRepeatChain.scrollBarFrame.differs(
                  from: repeatDragTarget.scrollBarFrame,
                  byMoreThan: 1
              ) else {
            throw HostedNativeInnerScrollTraceError.repeatTerminalScrollChangedGeometry(
                controlIdentifier
            )
        }

        let postActionSamples = terminalSamples + repeatTerminalSamples
        let postActionObservedSamples =
            firstHoverPreparation.observedSamples.map(\.innerScrollSample)
                + terminalWindow.observedSamples
                + repeatHoverPreparation.observedSamples.map(\.innerScrollSample)
                + repeatTerminalWindow.observedSamples
        for candidate in postActionObservedSamples {
            guard !preSample.outerSentinelFrame.differs(
                from: candidate.outerSentinelFrame,
                byMoreThan: 1
            ), !preSample.outerScrollFrame.differs(
                from: candidate.outerScrollFrame,
                byMoreThan: 1
            ) else {
                throw HostedNativeInnerScrollTraceError.outerPageMoved(section)
            }
        }
        if terminalVisibleText != nil {
            guard postActionSamples.allSatisfy({ sample in
                sample.terminalElementFrame != nil
                    && sample.terminalRowFrame != nil
                    && sample.terminalElementFullyContained == true
                    && sample.terminalElementFullyContainedInRow == true
                    && sample.terminalRowFullyContained == true
            }) else {
                throw HostedNativeInnerScrollTraceError.missingTerminalContent(section)
            }
        }
        if terminalValueToken != nil,
           !postActionSamples.allSatisfy({
               $0.controlValueContainsTerminalToken == true
           }) {
            throw HostedNativeInnerScrollTraceError.missingTerminalContent(section)
        }
        if terminalVisibilityMarkerIdentifier != nil,
           let terminalValueToken {
            let terminalControlValue = String(describing: control.value ?? "")
            guard postActionSamples.allSatisfy({ sample in
                sample.terminalVisibilityMarkerFrame != nil
                    && sample.terminalVisibilityMarkerFullyContained == true
                    && sample.terminalNativeVisibility != nil
                    && sample.terminalNativeVisibility.map {
                        nativeVisibilityProvesTerminalToken(
                            $0,
                            controlValue: terminalControlValue,
                            expectedToken: terminalValueToken
                        )
                    } == true
            }) else {
                throw HostedNativeInnerScrollTraceError.missingTerminalContent(section)
            }
        } else if terminalVisibilityMarkerIdentifier != nil {
            throw HostedNativeInnerScrollTraceError.missingTerminalContent(section)
        }

        return HostedNativeInnerScrollCheckpoint(
            section: section,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementTypeName,
            scrollContainerElementType: "scroll-view",
            scrollContainerCount: scrollContainers.count,
            verticalScrollBarCount: verticalScrollBars.count,
            terminalVisibilityMarkerIdentifier: terminalVisibilityMarkerIdentifier,
            terminalVisibleText: terminalVisibleText,
            terminalValueToken: terminalValueToken,
            terminalRowElementType: terminalRowElementTypeName,
            outerPreparationCheckpoint: outerPreparationCheckpoint,
            outerPreparationResult: "verified-page-bottom-then-inner-viewport-restaged-before-isolation-baseline",
            outerPreparationSample: outerPreparationSample,
            outerRestagingAction: outerRestagingAction,
            outerRestagingObservedSamples: outerRestagingObservedSamples,
            outerRestagingSamples: outerRestagingSamples,
            outerRestagingWindowDurationMilliseconds: restagingWindow.durationMilliseconds,
            preTerminalValue: preTerminalValue,
            terminalValue: terminalValue,
            repeatTerminalValue: repeatTerminalValue,
            targetSampleIntervalMilliseconds: targetSampleIntervalMilliseconds,
            minimumAcceptedSampleIntervalMilliseconds:
                minimumAcceptedSampleIntervalMilliseconds,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds,
            terminalWindowDurationMilliseconds: terminalWindow.durationMilliseconds,
            repeatTerminalWindowDurationMilliseconds:
                repeatTerminalWindow.durationMilliseconds,
            terminalStateStable: true,
            outerIsolationProven: true,
            firstHoverPreparation: firstHoverPreparation,
            repeatHoverPreparation: repeatHoverPreparation,
            firstTerminalAction: HostedNativeInnerScrollAction(
                mechanism: "public-xcui-scrollbar-thumb-drag",
                elapsedMilliseconds: firstActionElapsedMilliseconds,
                sourcePoint: firstDragTarget.sourcePoint,
                targetPoint: firstDragTarget.destinationPoint,
                normalizedTargetValue: 1,
                requestedDisplacementY: firstDragTarget.requestedDisplacementY,
                guardScrollBarFrame: firstDragTarget.scrollBarFrame,
                guardThumbFrameBefore: firstDragTarget.thumbFrame,
                guardThumbFrameAfter: postFirstDragChain.thumbFrame,
                observedThumbTranslationY: firstObservedThumbTranslationY,
                attemptCount: 1,
                effectObserved: true,
                effectProven: true,
                result: "returned-and-terminal-value-proven"
            ),
            repeatTerminalAction: HostedNativeInnerScrollAction(
                mechanism: "public-xcui-scrollbar-thumb-drag",
                elapsedMilliseconds: repeatActionElapsedMilliseconds,
                sourcePoint: repeatDragTarget.sourcePoint,
                targetPoint: repeatDragTarget.destinationPoint,
                normalizedTargetValue: 1,
                requestedDisplacementY: repeatDragTarget.requestedDisplacementY,
                guardScrollBarFrame: repeatDragTarget.scrollBarFrame,
                guardThumbFrameBefore: repeatDragTarget.thumbFrame,
                guardThumbFrameAfter: postRepeatChain.thumbFrame,
                observedThumbTranslationY: repeatObservedThumbTranslationY,
                attemptCount: 1,
                effectObserved: false,
                effectProven: true,
                result: "returned-with-no-value-effect"
            ),
            preSample: preSample,
            terminalObservedSamples: terminalObservedSamples,
            terminalSamples: terminalSamples,
            repeatTerminalObservedSamples: repeatTerminalObservedSamples,
            repeatTerminalSamples: repeatTerminalSamples
        )
    }

    private func reboundNativeScrollBarChain(
        app: XCUIApplication,
        controlIdentifier: String,
        controlElementType: XCUIElement.ElementType,
        outerScrollIdentifier: String,
        tolerance: Double
    ) throws -> HostedNativeScrollBarChain {
        let controlQuery = app.descendants(matching: controlElementType)
            .matching(identifier: controlIdentifier)
        guard controlQuery.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidElementCount(
                identifier: controlIdentifier,
                count: controlQuery.count
            )
        }
        let control = controlQuery.element(boundBy: 0)
        guard control.exists else {
            throw HostedNativeInnerScrollTraceError.missingElement(controlIdentifier)
        }
        let outerScroll = app.descendants(matching: .any)[outerScrollIdentifier]
        guard outerScroll.exists else {
            throw HostedNativeInnerScrollTraceError.missingElement(outerScrollIdentifier)
        }
        let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
        guard outerScrollFrame.isFiniteAndNonempty else {
            throw HostedNativeInnerScrollTraceError.invalidFrame
        }
        let scrollContainers = app.descendants(matching: .scrollView)
            .allElementsBoundByIndex.filter { candidate in
                let frame = HostedGeometryFrame(candidate.frame)
                return candidate.identifier != outerScrollIdentifier
                    && frame.isFiniteAndNonempty
                    && frame.differs(from: outerScrollFrame, byMoreThan: 1)
                    && candidate.descendants(matching: controlElementType)
                        .matching(identifier: controlIdentifier).count == 1
            }
        guard scrollContainers.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollContainerCount(
                controlIdentifier: controlIdentifier,
                count: scrollContainers.count
            )
        }
        let scrollContainer = scrollContainers[0]
        let scrollContainerFrame = HostedGeometryFrame(scrollContainer.frame)
        guard scrollContainerFrame.isFiniteAndNonempty else {
            throw HostedNativeInnerScrollTraceError.invalidFrame
        }
        let verticalScrollBars = scrollContainer.scrollBars.allElementsBoundByIndex.filter {
            candidate in
            let frame = HostedGeometryFrame(candidate.frame)
            return frame.isFiniteAndNonempty
                && frame.height > frame.width
                && frame.isFullyContained(in: scrollContainerFrame, tolerance: 2)
        }
        guard verticalScrollBars.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidVerticalScrollBarCount(
                controlIdentifier: controlIdentifier,
                count: verticalScrollBars.count
            )
        }
        let verticalScrollBar = verticalScrollBars[0]
        let scrollBarFrame = HostedGeometryFrame(verticalScrollBar.frame)
        let thumbQuery = verticalScrollBar.descendants(matching: .valueIndicator)
        guard thumbQuery.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarThumbCount(
                controlIdentifier: controlIdentifier,
                count: thumbQuery.count
            )
        }
        let thumb = thumbQuery.element(boundBy: 0)
        guard thumb.exists, thumbQuery.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarThumbCount(
                controlIdentifier: controlIdentifier,
                count: thumbQuery.count
            )
        }
        let thumbFrame = HostedGeometryFrame(thumb.frame)
        guard scrollBarFrame.isFiniteAndNonempty,
              thumbFrame.isFiniteAndNonempty,
              thumbFrame.isFullyContained(in: scrollBarFrame, tolerance: tolerance) else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarDragGeometry(
                controlIdentifier
            )
        }
        return HostedNativeScrollBarChain(
            control: control,
            scrollContainer: scrollContainer,
            verticalScrollBar: verticalScrollBar,
            thumb: thumb,
            scrollBarFrame: scrollBarFrame,
            thumbFrame: thumbFrame,
            thumbEnabled: thumb.isEnabled,
            thumbHittable: thumb.isHittable
        )
    }

    private func nativeScrollBarHoverTarget(
        chain: HostedNativeScrollBarChain,
        controlIdentifier: String
    ) throws -> HostedNativeScrollBarHoverTarget {
        let point = HostedGeometryPoint(
            x: chain.thumbFrame.x + (chain.thumbFrame.width / 2),
            y: chain.thumbFrame.y + (chain.thumbFrame.height / 2)
        )
        let normalizedOffset = CGVector(
            dx: (point.x - chain.scrollBarFrame.x) / chain.scrollBarFrame.width,
            dy: (point.y - chain.scrollBarFrame.y) / chain.scrollBarFrame.height
        )
        guard normalizedOffset.dx.isFinite,
              normalizedOffset.dy.isFinite,
              normalizedOffset.dx >= 0,
              normalizedOffset.dx <= 1,
              normalizedOffset.dy >= 0,
              normalizedOffset.dy <= 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarDragGeometry(
                controlIdentifier
            )
        }
        return HostedNativeScrollBarHoverTarget(
            coordinate: chain.verticalScrollBar.coordinate(
                withNormalizedOffset: normalizedOffset
            ),
            point: point,
            chain: chain
        )
    }

    private func prepareNativeScrollBarThumbForDrag(
        app: XCUIApplication,
        controlIdentifier: String,
        controlElementType: XCUIElement.ElementType,
        outerScrollIdentifier: String,
        outerScroll: XCUIElement,
        outerSentinel: XCUIElement,
        baselineSample: HostedNativeInnerScrollSample,
        captureTerminalContent: Bool,
        terminalVisibleText: String?,
        terminalValueToken: String?,
        terminalVisibilityMarkerQuery: XCUIElementQuery?,
        terminalRowElementType: XCUIElement.ElementType?,
        samplingStartedAt: TimeInterval,
        targetSampleIntervalMilliseconds: Int,
        minimumAcceptedSampleIntervalMilliseconds: Int,
        samplingDeadlineMilliseconds: Int,
        tolerance: Double
    ) throws -> HostedNativePreparedScrollBarDrag {
        let preHoverChain = try reboundNativeScrollBarChain(
            app: app,
            controlIdentifier: controlIdentifier,
            controlElementType: controlElementType,
            outerScrollIdentifier: outerScrollIdentifier,
            tolerance: tolerance
        )
        let hoverTarget = try nativeScrollBarHoverTarget(
            chain: preHoverChain,
            controlIdentifier: controlIdentifier
        )
        let actionStartedAt = ProcessInfo.processInfo.systemUptime
        let actionElapsedMilliseconds = Int(
            ((actionStartedAt - samplingStartedAt) * 1_000).rounded()
        )
        hoverTarget.coordinate.hover()

        let targetInterval = Double(targetSampleIntervalMilliseconds) / 1_000
        let maximumSampleAttempts = max(
            3,
            samplingDeadlineMilliseconds / max(1, targetSampleIntervalMilliseconds)
        )
        var observedSamples: [HostedNativeScrollBarHoverSample] = []
        var samples: [HostedNativeScrollBarHoverSample] = []
        var finalChain: HostedNativeScrollBarChain?
        var previousSampleStartedAt = actionStartedAt
        for _ in 0..<maximumSampleAttempts {
            let elapsedSincePrevious =
                ProcessInfo.processInfo.systemUptime - previousSampleStartedAt
            let remainingDelay = max(0, targetInterval - elapsedSincePrevious)
            if remainingDelay > 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
            }
            let sampleStartedAt = ProcessInfo.processInfo.systemUptime
            previousSampleStartedAt = sampleStartedAt
            let reboundChain = try reboundNativeScrollBarChain(
                app: app,
                controlIdentifier: controlIdentifier,
                controlElementType: controlElementType,
                outerScrollIdentifier: outerScrollIdentifier,
                tolerance: tolerance
            )
            if !captureTerminalContent,
               let terminalVisibilityMarkerQuery,
               terminalVisibilityMarkerQuery.count != 0 {
                throw HostedNativeInnerScrollTraceError
                    .terminalVisibilityMarkerPresentBeforeTerminal(
                        "hover-preparation-\(controlIdentifier)"
                    )
            }
            let innerScrollSample = try captureNativeInnerScrollSample(
                app: app,
                elapsedMilliseconds: Int(
                    ((sampleStartedAt - samplingStartedAt) * 1_000).rounded()
                ),
                control: reboundChain.control,
                scrollContainer: reboundChain.scrollContainer,
                verticalScrollBar: reboundChain.verticalScrollBar,
                outerScroll: outerScroll,
                outerSentinel: outerSentinel,
                captureTerminalContent: captureTerminalContent,
                terminalVisibleText: terminalVisibleText,
                terminalValueToken: terminalValueToken,
                terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
                terminalRowElementType: terminalRowElementType
            )
            guard nativeInnerScrollSamplesMatch(baselineSample, innerScrollSample) else {
                throw HostedNativeInnerScrollTraceError.hoverPreparationChangedState(
                    controlIdentifier
                )
            }
            let sample = HostedNativeScrollBarHoverSample(
                innerScrollSample: innerScrollSample,
                thumbFrame: reboundChain.thumbFrame,
                thumbEnabled: reboundChain.thumbEnabled,
                thumbHittable: reboundChain.thumbHittable
            )
            observedSamples.append(sample)
            if let baseline = samples.first,
               nativeScrollBarHoverSamplesMatch(baseline, sample) {
                samples.append(sample)
            } else {
                samples = [sample]
            }
            finalChain = reboundChain
            if samples.count == 3 { break }
            let elapsedSinceActionMilliseconds = Int(
                ((ProcessInfo.processInfo.systemUptime - actionStartedAt) * 1_000).rounded()
            )
            if elapsedSinceActionMilliseconds >= samplingDeadlineMilliseconds { break }
        }

        let samplingCompletedAt = ProcessInfo.processInfo.systemUptime
        let durationMilliseconds = Int(
            ((samplingCompletedAt - actionStartedAt) * 1_000).rounded()
        )
        guard samples.count == 3,
              let first = samples.first,
              let last = samples.last,
              let finalChain,
              first.innerScrollSample.elapsedMilliseconds - actionElapsedMilliseconds
                  >= minimumAcceptedSampleIntervalMilliseconds,
              durationMilliseconds <= samplingDeadlineMilliseconds else {
            throw HostedNativeInnerScrollTraceError.scrollBarThumbGeometryNotStable(
                controlIdentifier
            )
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            guard rhs.innerScrollSample.elapsedMilliseconds
                    - lhs.innerScrollSample.elapsedMilliseconds
                    >= minimumAcceptedSampleIntervalMilliseconds,
                  nativeScrollBarHoverSamplesMatch(lhs, rhs) else {
                throw HostedNativeInnerScrollTraceError.invalidCadence(
                    controlIdentifier: controlIdentifier,
                    lhsElapsedMilliseconds: lhs.innerScrollSample.elapsedMilliseconds,
                    rhsElapsedMilliseconds: rhs.innerScrollSample.elapsedMilliseconds
                )
            }
        }
        let dragTarget = try nativeScrollBarBottomDragTarget(
            chain: finalChain,
            controlIdentifier: controlIdentifier,
            tolerance: tolerance
        )
        let effectObserved = !preHoverChain.thumbHittable && finalChain.thumbHittable
        let action = HostedNativeInnerScrollAction(
            mechanism: "public-xcui-coordinate-hover",
            elapsedMilliseconds: actionElapsedMilliseconds,
            targetPoint: hoverTarget.point,
            guardScrollBarFrame: preHoverChain.scrollBarFrame,
            guardScrollBarFrameAfter: finalChain.scrollBarFrame,
            guardThumbFrameBefore: preHoverChain.thumbFrame,
            guardThumbFrameAfter: finalChain.thumbFrame,
            normalizedValueBefore: baselineSample.normalizedScrollValue,
            normalizedValueAfter: last.innerScrollSample.normalizedScrollValue,
            guardThumbHittableBefore: preHoverChain.thumbHittable,
            guardThumbHittableAfter: finalChain.thumbHittable,
            attemptCount: 1,
            effectObserved: effectObserved,
            effectProven: true,
            result: effectObserved
                ? "returned-and-hittable-after-passive-settlement"
                : "returned-and-stable-geometry-confirmed-after-passive-settlement"
        )
        return HostedNativePreparedScrollBarDrag(
            preparation: HostedNativeScrollBarHoverPreparation(
                action: action,
                observedSamples: observedSamples,
                samples: samples,
                durationMilliseconds: durationMilliseconds
            ),
            chain: finalChain,
            dragTarget: dragTarget
        )
    }

    private func nativeScrollBarHoverSamplesMatch(
        _ lhs: HostedNativeScrollBarHoverSample,
        _ rhs: HostedNativeScrollBarHoverSample
    ) -> Bool {
        nativeInnerScrollSamplesMatch(lhs.innerScrollSample, rhs.innerScrollSample)
            && !lhs.thumbFrame.differs(from: rhs.thumbFrame, byMoreThan: 1)
            && lhs.thumbEnabled == rhs.thumbEnabled
            && lhs.thumbHittable == rhs.thumbHittable
    }

    private func nativeScrollBarBottomDragTarget(
        chain: HostedNativeScrollBarChain,
        controlIdentifier: String,
        tolerance: Double
    ) throws -> HostedNativeScrollBarDragTarget {
        let verticalScrollBar = chain.verticalScrollBar
        let scrollBarFrame = chain.scrollBarFrame
        let thumbFrame = chain.thumbFrame

        let sourcePoint = HostedGeometryPoint(
            x: thumbFrame.x + (thumbFrame.width / 2),
            y: thumbFrame.y + (thumbFrame.height / 2)
        )
        let destinationPoint = HostedGeometryPoint(
            x: sourcePoint.x,
            y: scrollBarFrame.maxY - max(1, tolerance)
        )
        let requestedDisplacementY = destinationPoint.y - sourcePoint.y
        let minimumDisplacement = max(2, tolerance + 1)
        guard destinationPoint.x >= scrollBarFrame.x + tolerance,
              destinationPoint.x <= scrollBarFrame.maxX - tolerance,
              destinationPoint.y >= scrollBarFrame.y + tolerance,
              destinationPoint.y <= scrollBarFrame.maxY - tolerance,
              requestedDisplacementY >= minimumDisplacement,
              requestedDisplacementY <= scrollBarFrame.height else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarDragGeometry(
                controlIdentifier
            )
        }
        let normalizedSource = CGVector(
            dx: (sourcePoint.x - scrollBarFrame.x) / scrollBarFrame.width,
            dy: (sourcePoint.y - scrollBarFrame.y) / scrollBarFrame.height
        )
        let normalizedDestination = CGVector(
            dx: (destinationPoint.x - scrollBarFrame.x) / scrollBarFrame.width,
            dy: (destinationPoint.y - scrollBarFrame.y) / scrollBarFrame.height
        )
        guard normalizedSource.dx.isFinite,
              normalizedSource.dy.isFinite,
              normalizedSource.dx >= 0,
              normalizedSource.dx <= 1,
              normalizedSource.dy >= 0,
              normalizedSource.dy <= 1,
              normalizedDestination.dx.isFinite,
              normalizedDestination.dy.isFinite,
              normalizedDestination.dx >= 0,
              normalizedDestination.dx <= 1,
              normalizedDestination.dy >= 0,
              normalizedDestination.dy <= 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollBarDragGeometry(
                controlIdentifier
            )
        }
        return HostedNativeScrollBarDragTarget(
            sourceCoordinate: verticalScrollBar.coordinate(withNormalizedOffset: normalizedSource),
            destinationCoordinate: verticalScrollBar.coordinate(withNormalizedOffset: normalizedDestination),
            sourcePoint: sourcePoint,
            destinationPoint: destinationPoint,
            scrollBarFrame: scrollBarFrame,
            thumbFrame: thumbFrame,
            requestedDisplacementY: requestedDisplacementY
        )
    }

    private func captureStableNativeInnerScrollSamples(
        app: XCUIApplication,
        controlIdentifier: String,
        samplingStartedAt: TimeInterval,
        actionStartedAt: TimeInterval,
        targetSampleIntervalMilliseconds: Int,
        minimumAcceptedSampleIntervalMilliseconds: Int,
        samplingDeadlineMilliseconds: Int,
        control: XCUIElement,
        scrollContainer: XCUIElement,
        verticalScrollBar: XCUIElement,
        outerScroll: XCUIElement,
        outerSentinel: XCUIElement,
        captureTerminalContent: Bool,
        terminalVisibleText: String?,
        terminalValueToken: String?,
        terminalVisibilityMarkerQuery: XCUIElementQuery?,
        terminalRowElementType: XCUIElement.ElementType?
    ) throws -> HostedNativeInnerScrollSettledWindow {
        let targetInterval = Double(targetSampleIntervalMilliseconds) / 1_000
        let maximumSampleAttempts = max(
            3,
            samplingDeadlineMilliseconds / max(1, targetSampleIntervalMilliseconds)
        )
        var observedSamples: [HostedNativeInnerScrollSample] = []
        var samples: [HostedNativeInnerScrollSample] = []
        var previousSampleStartedAt = actionStartedAt
        for _ in 0..<maximumSampleAttempts {
            let elapsedSincePrevious =
                ProcessInfo.processInfo.systemUptime - previousSampleStartedAt
            let remainingDelay = max(0, targetInterval - elapsedSincePrevious)
            if remainingDelay > 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
            }
            let sampleStartedAt = ProcessInfo.processInfo.systemUptime
            previousSampleStartedAt = sampleStartedAt
            let sample = try captureNativeInnerScrollSample(
                app: app,
                elapsedMilliseconds: Int(
                    ((sampleStartedAt - samplingStartedAt) * 1_000).rounded()
                ),
                control: control,
                scrollContainer: scrollContainer,
                verticalScrollBar: verticalScrollBar,
                outerScroll: outerScroll,
                outerSentinel: outerSentinel,
                captureTerminalContent: captureTerminalContent,
                terminalVisibleText: terminalVisibleText,
                terminalValueToken: terminalValueToken,
                terminalVisibilityMarkerQuery: terminalVisibilityMarkerQuery,
                terminalRowElementType: terminalRowElementType
            )
            observedSamples.append(sample)
            if let baseline = samples.first,
               nativeInnerScrollSamplesMatch(baseline, sample) {
                samples.append(sample)
            } else {
                samples = [sample]
            }
            if samples.count == 3 { break }
            let elapsedSinceActionMilliseconds = Int(
                ((ProcessInfo.processInfo.systemUptime - actionStartedAt) * 1_000).rounded()
            )
            if elapsedSinceActionMilliseconds >= samplingDeadlineMilliseconds { break }
        }

        let samplingCompletedAt = ProcessInfo.processInfo.systemUptime
        let actionElapsedMilliseconds = Int(
            ((actionStartedAt - samplingStartedAt) * 1_000).rounded()
        )
        let durationMilliseconds = Int(
            ((samplingCompletedAt - actionStartedAt) * 1_000).rounded()
        )
        guard samples.count == 3,
              let first = samples.first,
              first.elapsedMilliseconds - actionElapsedMilliseconds
                  >= minimumAcceptedSampleIntervalMilliseconds,
              durationMilliseconds <= samplingDeadlineMilliseconds else {
            throw HostedNativeInnerScrollTraceError.invalidSettledWindow(controlIdentifier)
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            guard rhs.elapsedMilliseconds - lhs.elapsedMilliseconds
                    >= minimumAcceptedSampleIntervalMilliseconds else {
                throw HostedNativeInnerScrollTraceError.invalidCadence(
                    controlIdentifier: controlIdentifier,
                    lhsElapsedMilliseconds: lhs.elapsedMilliseconds,
                    rhsElapsedMilliseconds: rhs.elapsedMilliseconds
                )
            }
        }
        guard let baseline = samples.first else {
            throw HostedNativeInnerScrollTraceError.invalidSettledWindow(controlIdentifier)
        }
        for sample in samples.dropFirst() {
            guard nativeInnerScrollSamplesMatch(baseline, sample) else {
                throw HostedNativeInnerScrollTraceError.invalidSettledWindow(
                    controlIdentifier
                )
            }
        }
        return HostedNativeInnerScrollSettledWindow(
            observedSamples: observedSamples,
            samples: samples,
            durationMilliseconds: durationMilliseconds
        )
    }

    private func nativeInnerScrollSamplesMatch(
        _ lhs: HostedNativeInnerScrollSample,
        _ rhs: HostedNativeInnerScrollSample
    ) -> Bool {
        lhs.normalizedScrollValue == rhs.normalizedScrollValue
            && !lhs.controlFrame.differs(from: rhs.controlFrame, byMoreThan: 1)
            && !lhs.scrollContainerFrame.differs(
                from: rhs.scrollContainerFrame,
                byMoreThan: 1
            )
            && !lhs.scrollBarFrame.differs(from: rhs.scrollBarFrame, byMoreThan: 1)
            && !lhs.outerScrollFrame.differs(from: rhs.outerScrollFrame, byMoreThan: 1)
            && !lhs.outerSentinelFrame.differs(from: rhs.outerSentinelFrame, byMoreThan: 1)
            && optionalNativeInnerFramesMatch(
                lhs.terminalElementFrame,
                rhs.terminalElementFrame
            )
            && optionalNativeInnerFramesMatch(lhs.terminalRowFrame, rhs.terminalRowFrame)
            && lhs.terminalElementFullyContained == rhs.terminalElementFullyContained
            && lhs.terminalElementFullyContainedInRow
                == rhs.terminalElementFullyContainedInRow
            && lhs.terminalRowFullyContained == rhs.terminalRowFullyContained
            && lhs.controlValueContainsTerminalToken
                == rhs.controlValueContainsTerminalToken
            && optionalNativeInnerFramesMatch(
                lhs.terminalVisibilityMarkerFrame,
                rhs.terminalVisibilityMarkerFrame
            )
            && lhs.terminalVisibilityMarkerFullyContained
                == rhs.terminalVisibilityMarkerFullyContained
            && lhs.terminalNativeVisibility == rhs.terminalNativeVisibility
    }

    private func optionalNativeInnerFramesMatch(
        _ lhs: HostedGeometryFrame?,
        _ rhs: HostedGeometryFrame?
    ) -> Bool {
        switch (lhs, rhs) {
        case (nil, nil):
            true
        case let (.some(lhs), .some(rhs)):
            !lhs.differs(from: rhs, byMoreThan: 1)
        default:
            false
        }
    }

    private func captureNativeInnerScrollSample(
        app: XCUIApplication,
        elapsedMilliseconds: Int,
        control: XCUIElement,
        scrollContainer: XCUIElement,
        verticalScrollBar: XCUIElement,
        outerScroll: XCUIElement,
        outerSentinel: XCUIElement,
        captureTerminalContent: Bool,
        terminalVisibleText: String?,
        terminalValueToken: String?,
        terminalVisibilityMarkerQuery: XCUIElementQuery?,
        terminalRowElementType: XCUIElement.ElementType?
    ) throws -> HostedNativeInnerScrollSample {
        let controlFrame = HostedGeometryFrame(control.frame)
        let scrollContainerFrame = HostedGeometryFrame(scrollContainer.frame)
        let scrollBarFrame = HostedGeometryFrame(verticalScrollBar.frame)
        let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
        let outerSentinelFrame = HostedGeometryFrame(outerSentinel.frame)
        guard controlFrame.isFiniteAndNonempty,
              scrollContainerFrame.isFiniteAndNonempty,
              scrollBarFrame.isFiniteAndNonempty,
              outerScrollFrame.isFiniteAndNonempty,
              outerSentinelFrame.isFiniteAndNonempty else {
            throw HostedNativeInnerScrollTraceError.invalidFrame
        }

        var terminalElementFrame: HostedGeometryFrame?
        var terminalRowFrame: HostedGeometryFrame?
        if captureTerminalContent, let terminalVisibleText {
            let terminalQuery = control.staticTexts.matching(
                identifier: terminalVisibleText
            )
            if terminalQuery.count == 1 {
                terminalElementFrame = HostedGeometryFrame(
                    terminalQuery.element(boundBy: 0).frame
                )
                guard let terminalElementFrame,
                      terminalElementFrame.isFiniteAndNonempty else {
                    throw HostedNativeInnerScrollTraceError.invalidFrame
                }
                guard let terminalRowElementType else {
                    throw HostedNativeInnerScrollTraceError.missingTerminalRowElementType(
                        control.identifier
                    )
                }
                let containingRows = control.descendants(matching: terminalRowElementType)
                    .allElementsBoundByIndex.compactMap { candidate -> HostedGeometryFrame? in
                        let candidateFrame = HostedGeometryFrame(candidate.frame)
                        guard candidateFrame.isFiniteAndNonempty,
                              terminalElementFrame.isFullyContained(
                                  in: candidateFrame,
                                  tolerance: 1
                              ) else {
                            return nil
                        }
                        return candidateFrame
                    }
                guard containingRows.count == 1 else {
                    throw HostedNativeInnerScrollTraceError.invalidTerminalRowCount(
                        controlIdentifier: control.identifier,
                        count: containingRows.count
                    )
                }
                terminalRowFrame = containingRows[0]
            } else if terminalQuery.count > 1 {
                throw HostedNativeInnerScrollTraceError.invalidElementCount(
                    identifier: terminalVisibleText,
                    count: terminalQuery.count
                )
            }
        }
        let controlValue = String(describing: control.value ?? "")
        let controlValueContainsTerminalToken = captureTerminalContent
            ? terminalValueToken.map { token in
                controlValue.contains(token)
            }
            : nil
        var terminalVisibilityMarkerFrame: HostedGeometryFrame?
        var terminalNativeVisibility: HostedTerminalNativeVisibility?
        if captureTerminalContent, let terminalVisibilityMarkerQuery {
            guard terminalVisibilityMarkerQuery.count == 1 else {
                throw HostedNativeInnerScrollTraceError.invalidElementCount(
                    identifier: "terminal-visibility-marker",
                    count: terminalVisibilityMarkerQuery.count
                )
            }
            let marker = terminalVisibilityMarkerQuery.element(boundBy: 0)
            terminalVisibilityMarkerFrame = HostedGeometryFrame(marker.frame)
            guard terminalVisibilityMarkerFrame?.isFiniteAndNonempty == true else {
                throw HostedNativeInnerScrollTraceError.invalidFrame
            }
            terminalNativeVisibility = try decodeTerminalNativeVisibility(
                app: app,
                marker: marker
            )
        }
        return HostedNativeInnerScrollSample(
            elapsedMilliseconds: elapsedMilliseconds,
            normalizedScrollValue: try normalizedScrollValue(verticalScrollBar.value),
            controlFrame: controlFrame,
            scrollContainerFrame: scrollContainerFrame,
            scrollBarFrame: scrollBarFrame,
            outerScrollFrame: outerScrollFrame,
            outerSentinelFrame: outerSentinelFrame,
            terminalElementFrame: terminalElementFrame,
            terminalElementFullyContained: terminalElementFrame.map {
                $0.isFullyContained(in: scrollContainerFrame, tolerance: 1)
            },
            terminalRowFrame: terminalRowFrame,
            terminalElementFullyContainedInRow: terminalElementFrame.flatMap { element in
                terminalRowFrame.map { row in
                    element.isFullyContained(in: row, tolerance: 1)
                }
            },
            terminalRowFullyContained: terminalRowFrame.map {
                $0.isFullyContained(in: scrollContainerFrame, tolerance: 1)
            },
            controlValueContainsTerminalToken: controlValueContainsTerminalToken,
            terminalVisibilityMarkerFrame: terminalVisibilityMarkerFrame,
            terminalVisibilityMarkerFullyContained: terminalVisibilityMarkerFrame.map {
                $0.isFullyContained(in: scrollContainerFrame, tolerance: 1)
            },
            terminalNativeVisibility: terminalNativeVisibility
        )
    }

    private func decodeTerminalNativeVisibility(
        app: XCUIApplication,
        marker: XCUIElement
    ) throws -> HostedTerminalNativeVisibility {
        let manifest = marker.label
        let manifestPrefix = "ndlv1-chunks:"
        guard manifest.hasPrefix("ndlv1-chunks:"),
              let chunkCount = Int(manifest.dropFirst(manifestPrefix.count)),
              chunkCount > 0,
              chunkCount <= 64 else {
            throw HostedNativeInnerScrollTraceError.invalidTerminalNativeVisibility
        }
        var data = Data()
        for index in 0..<chunkCount {
            let identifier = "neondiff-logs-visible-tail-chunk-\(index)"
            let query = app.descendants(matching: .any).matching(identifier: identifier)
            let chunk = query.element(boundBy: 0)
            guard chunk.waitForExistence(timeout: 2) else {
                throw HostedNativeInnerScrollTraceError.invalidTerminalNativeVisibility
            }
            guard query.count == 1 else {
                throw HostedNativeInnerScrollTraceError.invalidTerminalNativeVisibility
            }
            let label = chunk.label
            let prefix = "ndlv1:\(index):\(chunkCount):"
            guard label.utf8.count <= 128,
                  label.hasPrefix(prefix),
                  let decoded = Data(base64Encoded: String(label.dropFirst(prefix.count))),
                  !decoded.isEmpty,
                  decoded.count <= 64,
                  (index == chunkCount - 1 || decoded.count == 64) else {
                throw HostedNativeInnerScrollTraceError.invalidTerminalNativeVisibility
            }
            data.append(decoded)
        }
        guard let payload = try? JSONDecoder().decode(
                  HostedTerminalNativeVisibility.self,
                  from: data
              ),
              payload.schemaVersion == 1,
              payload.textUTF16Length >= 0,
              payload.terminalTokenRange.isValid,
              payload.visibleCharacterRange.isValid,
              payload.visibleRect.isFiniteAndNonempty,
              payload.terminalGlyphBounds.isFiniteAndNonempty else {
            throw HostedNativeInnerScrollTraceError.invalidTerminalNativeVisibility
        }
        return payload
    }

    private func nativeVisibilityProvesTerminalToken(
        _ payload: HostedTerminalNativeVisibility,
        controlValue: String,
        expectedToken: String
    ) -> Bool {
        let utf16Value = controlValue as NSString
        let expectedRange = utf16Value.range(of: expectedToken)
        guard payload.coordinateSpace == "appkit-text-view-local",
              payload.terminalToken == expectedToken,
              payload.textUTF16Length == utf16Value.length,
              expectedRange.location != NSNotFound,
              payload.terminalTokenRange == HostedTextRange(expectedRange),
              payload.visibleCharacterRange.location
                  + payload.visibleCharacterRange.length <= utf16Value.length,
              payload.visibleCharacterRange.fullyContains(
                  payload.terminalTokenRange
              ),
              payload.terminalTokenFullyVisible,
              payload.terminalGlyphBounds.isFullyContained(
                  in: payload.visibleRect,
                  tolerance: 0
              ) else {
            return false
        }
        let remainingLocation = NSMaxRange(expectedRange)
        guard remainingLocation <= utf16Value.length else { return false }
        let remainingRange = NSRange(
            location: remainingLocation,
            length: utf16Value.length - remainingLocation
        )
        return utf16Value.range(of: expectedToken, options: [], range: remainingRange).location
            == NSNotFound
    }

    private func normalizedScrollValue(_ rawValue: Any?) throws -> Double {
        let parsed: Double?
        if let number = rawValue as? NSNumber {
            parsed = number.doubleValue
        } else if let string = rawValue as? String {
            let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmed.hasSuffix("%") {
                parsed = Double(trimmed.dropLast()).map { $0 / 100 }
            } else {
                parsed = Double(trimmed)
            }
        } else {
            parsed = nil
        }
        guard let parsed, parsed.isFinite, parsed >= 0, parsed <= 1 else {
            throw HostedNativeInnerScrollTraceError.invalidNormalizedScrollValue(
                runtimeValueType(rawValue)
            )
        }
        if abs(parsed - 1) <= 0.000_1 { return 1 }
        if abs(parsed) <= 0.000_1 { return 0 }
        return parsed
    }

    private func outerRestagingDeltaY(
        scrollContainerFrame: HostedGeometryFrame,
        outerScrollFrame: HostedGeometryFrame,
        tolerance: Double
    ) throws -> Double {
        guard scrollContainerFrame.height + (tolerance * 2) <= outerScrollFrame.height else {
            throw HostedNativeInnerScrollTraceError.innerViewportExceedsOuterViewport
        }
        let minimumContainedY = outerScrollFrame.y + tolerance
        let maximumContainedY =
            outerScrollFrame.y + outerScrollFrame.height - tolerance
        if scrollContainerFrame.y < minimumContainedY {
            return minimumContainedY - scrollContainerFrame.y
        }
        let scrollContainerMaximumY =
            scrollContainerFrame.y + scrollContainerFrame.height
        if scrollContainerMaximumY > maximumContainedY {
            return maximumContainedY - scrollContainerMaximumY
        }
        return 0
    }

    private func outerRestagingCoordinate(
        outerScroll: XCUIElement,
        outerScrollFrame: HostedGeometryFrame,
        scrollContainerFrame: HostedGeometryFrame,
        tolerance: Double
    ) throws -> (coordinate: XCUICoordinate, point: HostedGeometryPoint) {
        let corridorInset = max(4, tolerance + 1)
        let minimumOuterX = outerScrollFrame.x + corridorInset
        let maximumOuterX = outerScrollFrame.maxX - corridorInset
        let leftCorridorMaximumX = scrollContainerFrame.x - corridorInset
        let rightCorridorMinimumX = scrollContainerFrame.maxX + corridorInset
        let minimumOuterY = outerScrollFrame.y + corridorInset
        let maximumOuterY = outerScrollFrame.maxY - corridorInset
        let topCorridorMaximumY = min(
            scrollContainerFrame.y - corridorInset,
            maximumOuterY
        )
        let bottomCorridorMinimumY = max(
            scrollContainerFrame.maxY + corridorInset,
            minimumOuterY
        )
        let topCorridorHeight = max(0, topCorridorMaximumY - minimumOuterY)
        let bottomCorridorHeight = max(0, maximumOuterY - bottomCorridorMinimumY)

        let targetX: Double
        let targetY: Double
        if leftCorridorMaximumX > minimumOuterX {
            targetX = leftCorridorMaximumX
            targetY = outerScrollFrame.y + (outerScrollFrame.height / 2)
        } else if maximumOuterX > rightCorridorMinimumX {
            targetX = rightCorridorMinimumX
            targetY = outerScrollFrame.y + (outerScrollFrame.height / 2)
        } else if max(topCorridorHeight, bottomCorridorHeight) > 0 {
            targetX = outerScrollFrame.x + (outerScrollFrame.width / 2)
            if topCorridorHeight >= bottomCorridorHeight {
                targetY = (minimumOuterY + topCorridorMaximumY) / 2
            } else {
                targetY = (bottomCorridorMinimumY + maximumOuterY) / 2
            }
        } else {
            throw HostedNativeInnerScrollTraceError.noSafeOuterRestagingCoordinate
        }

        let point = HostedGeometryPoint(x: targetX, y: targetY)
        let pointIsInsideOuter = targetX >= outerScrollFrame.x + tolerance
            && targetX <= outerScrollFrame.maxX - tolerance
            && targetY >= outerScrollFrame.y + tolerance
            && targetY <= outerScrollFrame.maxY - tolerance
        let pointIsOutsideInner = targetX < scrollContainerFrame.x - tolerance
            || targetX > scrollContainerFrame.maxX + tolerance
            || targetY < scrollContainerFrame.y - tolerance
            || targetY > scrollContainerFrame.maxY + tolerance
        guard pointIsInsideOuter, pointIsOutsideInner else {
            throw HostedNativeInnerScrollTraceError.noSafeOuterRestagingCoordinate
        }

        let normalizedOffset = CGVector(
            dx: (targetX - outerScrollFrame.x) / outerScrollFrame.width,
            dy: (targetY - outerScrollFrame.y) / outerScrollFrame.height
        )
        guard normalizedOffset.dx.isFinite,
              normalizedOffset.dy.isFinite,
              normalizedOffset.dx > 0,
              normalizedOffset.dx < 1,
              normalizedOffset.dy > 0,
              normalizedOffset.dy < 1 else {
            throw HostedNativeInnerScrollTraceError.noSafeOuterRestagingCoordinate
        }
        return (
            outerScroll.coordinate(withNormalizedOffset: normalizedOffset),
            point
        )
    }

    private func frameMatchesRigidVerticalTranslation(
        baseline: HostedGeometryFrame,
        candidate: HostedGeometryFrame,
        translationY: Double,
        tolerance: Double
    ) -> Bool {
        abs(candidate.x - baseline.x) <= tolerance
            && abs(candidate.y - (baseline.y + translationY)) <= tolerance
            && abs(candidate.width - baseline.width) <= tolerance
            && abs(candidate.height - baseline.height) <= tolerance
    }

    private func guardedOuterPageScrollTarget(
        app: XCUIApplication,
        outerScroll: XCUIElement,
        outerScrollIdentifier: String,
        controlIdentifier: String?,
        controlElementType: XCUIElement.ElementType?
    ) throws -> HostedPageBottomNestedScrollGuard? {
        guard controlIdentifier != nil || controlElementType != nil else {
            return nil
        }
        guard let controlIdentifier, let controlElementType else {
            throw HostedPageBottomTraceError.invalidNestedScrollGuardConfiguration
        }
        let controlQuery = app.descendants(matching: controlElementType)
            .matching(identifier: controlIdentifier)
        guard controlQuery.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidElementCount(
                identifier: controlIdentifier,
                count: controlQuery.count
            )
        }
        let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
        guard outerScrollFrame.isFiniteAndNonempty else {
            throw HostedPageBottomTraceError.invalidFrame(outerScrollIdentifier)
        }
        let scrollContainers = app.descendants(matching: .scrollView)
            .allElementsBoundByIndex.filter { candidate in
                let frame = HostedGeometryFrame(candidate.frame)
                return candidate.identifier != outerScrollIdentifier
                    && frame.isFiniteAndNonempty
                    && frame.differs(from: outerScrollFrame, byMoreThan: 1)
                    && candidate.descendants(matching: controlElementType)
                        .matching(identifier: controlIdentifier).count == 1
            }
        guard scrollContainers.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidScrollContainerCount(
                controlIdentifier: controlIdentifier,
                count: scrollContainers.count
            )
        }
        let scrollContainer = scrollContainers[0]
        let scrollContainerFrame = HostedGeometryFrame(scrollContainer.frame)
        let verticalScrollBars = scrollContainer.scrollBars.allElementsBoundByIndex.filter {
            candidate in
            let frame = HostedGeometryFrame(candidate.frame)
            return frame.isFiniteAndNonempty
                && frame.height > frame.width
                && frame.isFullyContained(in: scrollContainerFrame, tolerance: 2)
        }
        guard verticalScrollBars.count == 1 else {
            throw HostedNativeInnerScrollTraceError.invalidVerticalScrollBarCount(
                controlIdentifier: controlIdentifier,
                count: verticalScrollBars.count
            )
        }
        let verticalScrollBar = verticalScrollBars[0]
        let target = try outerRestagingCoordinate(
            outerScroll: outerScroll,
            outerScrollFrame: outerScrollFrame,
            scrollContainerFrame: scrollContainerFrame,
            tolerance: 1
        )
        return HostedPageBottomNestedScrollGuard(
            controlIdentifier: controlIdentifier,
            targetCoordinate: target.coordinate,
            targetPoint: target.point,
            outerScrollFrame: outerScrollFrame,
            nestedScrollFrame: scrollContainerFrame,
            verticalScrollBar: verticalScrollBar,
            baselineValue: try normalizedScrollValue(verticalScrollBar.value)
        )
    }

    private func capturePageBottomCheckpoint(
        app: XCUIApplication,
        section: String,
        generation: Int,
        markerIdentifier: String,
        outerScrollIdentifier: String,
        sentinelIdentifier: String,
        nestedScrollControlIdentifier: String? = nil,
        nestedScrollControlElementType: XCUIElement.ElementType? = nil,
        requiresGuardedScrollAction: Bool = false
    ) throws -> HostedPageBottomCheckpoint {
        let outerPageScroll = app.descendants(matching: .any)[outerScrollIdentifier]
        let bottomSentinel = app.descendants(matching: .any)[sentinelIdentifier]
        let detailRegion = app.descendants(matching: .any)["neondiff-detail"]
        guard outerPageScroll.waitForExistence(timeout: 2) else {
            throw HostedPageBottomTraceError.missingElement(outerScrollIdentifier)
        }
        guard bottomSentinel.waitForExistence(timeout: 2) else {
            throw HostedPageBottomTraceError.missingElement(sentinelIdentifier)
        }
        guard detailRegion.waitForExistence(timeout: 2) else {
            throw HostedPageBottomTraceError.missingElement("neondiff-detail")
        }
        let preActionWindow = try capturePageBottomSamples(
            outerPageScroll: outerPageScroll,
            bottomSentinel: bottomSentinel,
            detailRegion: detailRegion,
            context: "\(section)-pre"
        )
        let preActionSamples = preActionWindow.samples
        let nestedScrollGuard = try guardedOuterPageScrollTarget(
            app: app,
            outerScroll: outerPageScroll,
            outerScrollIdentifier: outerScrollIdentifier,
            controlIdentifier: nestedScrollControlIdentifier,
            controlElementType: nestedScrollControlElementType
        )
        if requiresGuardedScrollAction, nestedScrollGuard == nil {
            throw HostedPageBottomTraceError.invalidNestedScrollGuardConfiguration
        }
        let didIssueScroll: Bool
        let postActionWindow: HostedPageBottomSettledWindow
        if preActionSamples.allSatisfy({
            $0.sentinelFullyContainedInOuterScroll
                && $0.sentinelFullyContainedInDetailRegion
        }) {
            if requiresGuardedScrollAction {
                throw HostedPageBottomTraceError
                    .requiredGuardedScrollActionWasNotIssued(section)
            }
            didIssueScroll = false
            postActionWindow = preActionWindow
        } else {
            let outerPageScrollTarget = nestedScrollGuard?.targetCoordinate
                ?? defaultOuterPageScrollCoordinate(outerPageScroll)
            outerPageScrollTarget.scroll(byDeltaX: 0, deltaY: -10_000)
            didIssueScroll = true
            postActionWindow = try capturePageBottomSamples(
                outerPageScroll: outerPageScroll,
                bottomSentinel: bottomSentinel,
                detailRegion: detailRegion,
                context: "\(section)-post"
            )
        }
        let postActionSamples = postActionWindow.samples
        let nestedScrollValueAfter = try nestedScrollGuard.map {
            try normalizedScrollValue($0.verticalScrollBar.value)
        }
        if didIssueScroll, let nestedScrollGuard {
            guard let nestedScrollValueAfter,
                  nestedScrollValueAfter == nestedScrollGuard.baselineValue else {
                throw HostedPageBottomTraceError
                    .nestedScrollValueChangedDuringOuterPreparation(
                        controlIdentifier: nestedScrollGuard.controlIdentifier,
                        before: nestedScrollGuard.baselineValue,
                        after: nestedScrollValueAfter
                    )
            }
        }

        for (sampleIndex, postActionSample) in postActionSamples.enumerated() {
            try requireFullyContained(
                postActionSample.sentinelFrame,
                in: postActionSample.outerScrollFrame,
                context: "\(section) outer scroll sample \(sampleIndex)"
            )
            try requireFullyContained(
                postActionSample.sentinelFrame,
                in: postActionSample.detailRegionFrame,
                context: "\(section) detail region sample \(sampleIndex)"
            )
        }
        let scrollAction = didIssueScroll
            ? HostedPageScrollAction(
                controlIdentifier: outerScrollIdentifier,
                deltaX: 0,
                deltaY: -10_000,
                attemptCount: 1,
                result: "returned",
                effectProven: true,
                targetPoint: nestedScrollGuard?.targetPoint,
                nestedScrollControlIdentifier: nestedScrollGuard?.controlIdentifier,
                nestedScrollValueBefore: nestedScrollGuard?.baselineValue,
                nestedScrollValueAfter: nestedScrollValueAfter,
                guardOuterScrollFrame: nestedScrollGuard?.outerScrollFrame,
                guardNestedScrollFrame: nestedScrollGuard?.nestedScrollFrame
            )
            : nil
        return HostedPageBottomCheckpoint(
            section: section,
            surfaceGeneration: generation,
            quiescenceMarkerIdentifier: markerIdentifier,
            outerScrollIdentifier: outerScrollIdentifier,
            sentinelIdentifier: sentinelIdentifier,
            preActionSamples: preActionSamples,
            preActionSamplingDurationMilliseconds: preActionWindow.durationMilliseconds,
            scrollAction: scrollAction,
            postActionSamples: postActionSamples,
            postActionSamplingDurationMilliseconds: postActionWindow.durationMilliseconds
        )
    }

    private func defaultOuterPageScrollCoordinate(
        _ outerScroll: XCUIElement
    ) -> XCUICoordinate {
        outerScroll.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
    }

    private func capturePageBottomSamples(
        outerPageScroll: XCUIElement,
        bottomSentinel: XCUIElement,
        detailRegion: XCUIElement,
        context: String,
        samplingDeadlineMilliseconds: Int = hostedPageBottomSamplingDeadlineMilliseconds
    ) throws -> HostedPageBottomSettledWindow {
        let start = ProcessInfo.processInfo.systemUptime
        var samples: [HostedPageBottomSample] = []
        var previousSampleStart: TimeInterval?
        for index in 0..<3 {
            if index > 0, let previousSampleStart {
                let elapsedSincePrevious =
                    ProcessInfo.processInfo.systemUptime - previousSampleStart
                let remainingDelay = max(0, 0.1 - elapsedSincePrevious)
                if remainingDelay > 0 {
                    RunLoop.current.run(until: Date().addingTimeInterval(remainingDelay))
                }
            }
            let sampleStart = ProcessInfo.processInfo.systemUptime
            previousSampleStart = sampleStart
            let elapsedMilliseconds = Int(((sampleStart - start) * 1_000).rounded())
            let outerScrollFrame = HostedGeometryFrame(outerPageScroll.frame)
            let sentinelFrame = HostedGeometryFrame(bottomSentinel.frame)
            let detailRegionFrame = HostedGeometryFrame(detailRegion.frame)
            guard outerScrollFrame.isFiniteAndNonempty else {
                throw HostedPageBottomTraceError.invalidFrame("\(context) outer scroll")
            }
            guard sentinelFrame.isFiniteAndNonempty else {
                throw HostedPageBottomTraceError.invalidFrame("\(context) sentinel")
            }
            guard detailRegionFrame.isFiniteAndNonempty else {
                throw HostedPageBottomTraceError.invalidFrame("\(context) detail")
            }
            samples.append(
                HostedPageBottomSample(
                    elapsedMilliseconds: elapsedMilliseconds,
                    outerScrollFrame: outerScrollFrame,
                    sentinelFrame: sentinelFrame,
                    detailRegionFrame: detailRegionFrame,
                    sentinelFullyContainedInOuterScroll: sentinelFrame.isFullyContained(
                        in: outerScrollFrame,
                        tolerance: 1
                    ),
                    sentinelFullyContainedInDetailRegion: sentinelFrame.isFullyContained(
                        in: detailRegionFrame,
                        tolerance: 1
                    )
                )
            )
        }
        let samplingCompletedAt = ProcessInfo.processInfo.systemUptime
        let durationMilliseconds = Int(
            ((samplingCompletedAt - start) * 1_000).rounded()
        )
        try validatePageBottomCadence(
            samples,
            durationMilliseconds: durationMilliseconds,
            context: context,
            samplingDeadlineMilliseconds: samplingDeadlineMilliseconds
        )
        try validateStablePageBottomSamples(samples, context: context)
        return HostedPageBottomSettledWindow(
            samples: samples,
            durationMilliseconds: durationMilliseconds
        )
    }

    private func validatePageBottomCadence(
        _ samples: [HostedPageBottomSample],
        durationMilliseconds: Int,
        context: String,
        samplingDeadlineMilliseconds: Int
    ) throws {
        guard samples.count == 3 else {
            throw HostedPageBottomTraceError.invalidCadence(context)
        }
        guard samples[0].elapsedMilliseconds >= 0,
              samples[0].elapsedMilliseconds <= 25,
              durationMilliseconds <= samplingDeadlineMilliseconds else {
            throw HostedPageBottomTraceError.invalidCadence(context)
        }
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            let interval = rhs.elapsedMilliseconds - lhs.elapsedMilliseconds
            guard interval >= 90 else {
                throw HostedPageBottomTraceError.invalidCadence(context)
            }
        }
    }

    private func validateStablePageBottomSamples(
        _ samples: [HostedPageBottomSample],
        context: String
    ) throws {
        guard let baseline = samples.first else {
            throw HostedPageBottomTraceError.missingSamples(context)
        }
        for sample in samples.dropFirst() {
            guard !baseline.outerScrollFrame.differs(
                from: sample.outerScrollFrame,
                byMoreThan: 1
            ), !baseline.sentinelFrame.differs(
                from: sample.sentinelFrame,
                byMoreThan: 1
            ), !baseline.detailRegionFrame.differs(
                from: sample.detailRegionFrame,
                byMoreThan: 1
            ) else {
                throw HostedPageBottomTraceError.unstableGeometry(context)
            }
        }
    }

    private func requireFullyContained(
        _ frame: HostedGeometryFrame,
        in container: HostedGeometryFrame,
        context: String
    ) throws {
        guard frame.isFullyContained(in: container, tolerance: 1) else {
            throw HostedPageBottomTraceError.sentinelNotContained(
                context: context,
                sentinel: frame,
                container: container
            )
        }
    }

    private func captureCheckpoint(
        app: XCUIApplication,
        section: String,
        generation: Int,
        markerIdentifier: String,
        requestedContentSize: HostedContentSize
    ) throws -> HostedGeometryCheckpoint {
        let marker = app.descendants(matching: .any)[markerIdentifier]
        XCTAssertTrue(
            marker.waitForExistence(timeout: 5),
            "Missing app-authored quiescence marker \(markerIdentifier)"
        )
        XCTAssertFalse(
            marker.isHittable,
            "App-authored quiescence marker must remain non-hittable"
        )
        let samples = try parseAppAuthoredGeometrySamples(
            markerLabel: marker.label,
            app: app,
            section: section,
            generation: generation
        )
        for identifier in HostedGeometryRegionFrame.requiredIdentifiers {
            XCTAssertTrue(
                app.descendants(matching: .any)[identifier].waitForExistence(timeout: 2),
                "Missing hosted region \(identifier)"
            )
        }
        for sample in samples {
            assertObservedContentSize(
                HostedObservedContentGeometry(
                    contentFrame: sample.contentFrame,
                    backingScale: sample.backingScale
                ),
                requested: requestedContentSize,
                context: "\(section)-\(generation)"
            )
        }
        assertValidCadence(samples)
        assertStableSamples(samples, context: "\(section)-\(generation)")
        let finalSample = try XCTUnwrap(samples.last)
        return HostedGeometryCheckpoint(
            section: section,
            surfaceGeneration: generation,
            quiescenceMarkerIdentifier: markerIdentifier,
            observedContentGeometry: HostedObservedContentGeometry(
                contentFrame: finalSample.contentFrame,
                backingScale: finalSample.backingScale
            ),
            samples: samples
        )
    }

    private func parseAppAuthoredGeometrySamples(
        markerLabel: String,
        app: XCUIApplication,
        section: String,
        generation: Int
    ) throws -> [HostedGeometrySample] {
        let manifest = markerLabel
        guard manifest == "ndg2-chunks:4" else {
            attachTransportDiagnostic(
                HostedTransportDiagnostic(
                    stage: "manifest",
                    chunkIndex: nil,
                    runtimeValueType: runtimeValueType(markerLabel),
                    utf8ByteCount: manifest.utf8.count,
                    expectedPrefixMatched: manifest.hasPrefix("ndg2-chunks:"),
                    base64DecodedByteCount: nil,
                    equalsUnavailableSentinel: manifest == "neondiff-hosted-geometry-unavailable"
                )
            )
            throw HostedGeometryTraceError.invalidTransportManifest
        }
        var data = Data()
        for index in 0..<4 {
            let identifier = "neondiff.evaluation.geometry.\(section).\(generation).\(index)"
            let chunk = app.descendants(matching: .any)[identifier]
            guard chunk.waitForExistence(timeout: 2) else {
                attachTransportDiagnostic(
                    HostedTransportDiagnostic(
                        stage: "missing-chunk",
                        chunkIndex: index,
                        runtimeValueType: "missing",
                        utf8ByteCount: nil,
                        expectedPrefixMatched: nil,
                        base64DecodedByteCount: nil,
                        equalsUnavailableSentinel: false
                    )
                )
                throw HostedGeometryTraceError.missingTransportChunk(index)
            }
            XCTAssertFalse(
                chunk.isHittable,
                "App-authored geometry chunk must remain non-hittable: \(index)"
            )
            let prefix = "ndg2:\(index):4:"
            let expectedByteCount = min(
                68,
                CompactHostedGeometryCursor.encodedByteCount - index * 68
            )
            let rawChunkLabel = chunk.label
            let value = rawChunkLabel
            let prefixMatched = value.hasPrefix(prefix)
            let decoded = prefixMatched
                ? Data(base64Encoded: String(value.dropFirst(prefix.count)))
                : nil
            guard let decoded,
                  decoded.count == expectedByteCount else {
                attachTransportDiagnostic(
                    HostedTransportDiagnostic(
                        stage: "chunk",
                        chunkIndex: index,
                        runtimeValueType: runtimeValueType(rawChunkLabel),
                        utf8ByteCount: value.utf8.count,
                        expectedPrefixMatched: prefixMatched,
                        base64DecodedByteCount: decoded?.count,
                        equalsUnavailableSentinel: value == "neondiff-hosted-geometry-unavailable"
                    )
                )
                throw HostedGeometryTraceError.invalidTransportChunk(index)
            }
            data.append(decoded)
        }
        guard data.count == CompactHostedGeometryCursor.encodedByteCount else {
            throw HostedGeometryTraceError.invalidTransportPayloadLength(data.count)
        }
        var cursor = CompactHostedGeometryCursor(data: data)
        try cursor.validateHeader()
        let sampleCount = Int(try cursor.readByte())
        guard sampleCount == 3 else {
            throw HostedGeometryTraceError.invalidCompactPayload
        }
        var samples: [HostedGeometrySample] = []
        samples.reserveCapacity(sampleCount)
        for _ in 0..<sampleCount {
            let elapsedMilliseconds = Int(try cursor.readUInt32())
            let windowFrame = try cursor.readFrame()
            let contentFrame = try cursor.readFrame()
            let backingScale = try cursor.readFloat()
            let regions = try HostedGeometryRegionFrame.requiredIdentifiers.map { identifier in
                HostedGeometryRegionFrame(identifier: identifier, frame: try cursor.readFrame())
            }
            samples.append(
                HostedGeometrySample(
                    elapsedMilliseconds: elapsedMilliseconds,
                    windowFrame: windowFrame,
                    contentFrame: contentFrame,
                    backingScale: backingScale,
                    regions: regions
                )
            )
        }
        guard cursor.isAtEnd else {
            throw HostedGeometryTraceError.invalidCompactPayload
        }
        for sample in samples {
            XCTAssertTrue(sample.windowFrame.isFiniteAndNonempty)
            XCTAssertTrue(sample.contentFrame.isFiniteAndNonempty)
            XCTAssertTrue(sample.backingScale.isFinite && sample.backingScale > 0)
            XCTAssertEqual(
                Set(sample.regions.map(\.identifier)),
                Set(HostedGeometryRegionFrame.requiredIdentifiers)
            )
            XCTAssertTrue(sample.regions.allSatisfy { $0.frame.isFiniteAndNonempty })
        }
        return samples
    }

    private func assertObservedContentSize(
        _ observed: HostedObservedContentGeometry,
        requested: HostedContentSize,
        context: String
    ) {
        XCTAssertEqual(
            observed.contentFrame.width,
            Double(requested.width),
            accuracy: 1,
            "Observed content width does not match requested width for \(context)"
        )
        XCTAssertEqual(
            observed.contentFrame.height,
            Double(requested.height),
            accuracy: 1,
            "Observed content height does not match requested height for \(context)"
        )
    }

    private func clickNavigation(
        app: XCUIApplication,
        index: Int,
        fromSection: String,
        toSection: String,
        identifier: String
    ) throws -> HostedNavigationAction {
        let button = app.buttons[identifier]
        XCTAssertTrue(button.waitForExistence(timeout: 2), "Missing navigation button \(identifier)")
        XCTAssertTrue(button.isHittable, "Navigation button is not hittable: \(identifier)")
        button.click()
        return HostedNavigationAction(
            index: index,
            fromSection: fromSection,
            toSection: toSection,
            controlIdentifier: identifier,
            attemptCount: 1,
            result: "success"
        )
    }

    private func assertValidCadence(_ samples: [HostedGeometrySample]) {
        XCTAssertEqual(samples.count, 3)
        guard samples.count == 3 else { return }
        XCTAssertGreaterThanOrEqual(samples[0].elapsedMilliseconds, 0)
        XCTAssertLessThanOrEqual(samples[0].elapsedMilliseconds, 25)
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            let interval = rhs.elapsedMilliseconds - lhs.elapsedMilliseconds
            XCTAssertGreaterThanOrEqual(interval, 90)
            XCTAssertLessThanOrEqual(interval, 150)
        }
    }

    private func assertStableSamples(
        _ samples: [HostedGeometrySample],
        context: String
    ) {
        guard let baseline = samples.first else {
            XCTFail("Missing samples for \(context)")
            return
        }
        for sample in samples.dropFirst() {
            XCTAssertFalse(
                baseline.windowFrame.differs(from: sample.windowFrame, byMoreThan: 1),
                "Window drift exceeded one point for \(context)"
            )
            XCTAssertFalse(
                baseline.contentFrame.differs(from: sample.contentFrame, byMoreThan: 1),
                "Content drift exceeded one point for \(context)"
            )
            XCTAssertEqual(
                baseline.backingScale,
                sample.backingScale,
                accuracy: 0.01,
                "Backing scale drifted for \(context)"
            )
            for region in baseline.regions {
                guard let candidate = sample.regions.first(where: {
                    $0.identifier == region.identifier
                }) else {
                    XCTFail("Missing \(region.identifier) for \(context)")
                    continue
                }
                XCTAssertFalse(
                    region.frame.differs(from: candidate.frame, byMoreThan: 1),
                    "\(region.identifier) drift exceeded one point for \(context)"
                )
            }
        }
    }

    private func assertStableAcrossTransitions(_ checkpoints: [HostedGeometryCheckpoint]) {
        guard let baseline = checkpoints.first?.samples.first else {
            XCTFail("Missing hosted geometry checkpoints")
            return
        }
        for checkpoint in checkpoints {
            for sample in checkpoint.samples {
                let context = "\(checkpoint.section)-\(checkpoint.surfaceGeneration)-\(sample.elapsedMilliseconds)ms"
                XCTAssertFalse(
                    baseline.windowFrame.differs(from: sample.windowFrame, byMoreThan: 1),
                    "Window drift exceeded one point across transitions at \(context): "
                        + "baseline=\(baseline.windowFrame) candidate=\(sample.windowFrame)"
                )
                XCTAssertFalse(
                    baseline.contentFrame.differs(from: sample.contentFrame, byMoreThan: 1),
                    "Content drift exceeded one point across transitions at \(context): "
                        + "baseline=\(baseline.contentFrame) candidate=\(sample.contentFrame)"
                )
                XCTAssertEqual(
                    baseline.backingScale,
                    sample.backingScale,
                    accuracy: 0.01,
                    "Backing scale drifted across transitions at \(context): "
                        + "baseline=\(baseline.backingScale) candidate=\(sample.backingScale)"
                )
                for region in baseline.regions {
                    guard let candidate = sample.regions.first(where: {
                        $0.identifier == region.identifier
                    }) else {
                        XCTFail("Missing \(region.identifier) across transitions at \(context)")
                        continue
                    }
                    XCTAssertFalse(
                        region.frame.differs(from: candidate.frame, byMoreThan: 1),
                        "\(region.identifier) drift exceeded one point across transitions at \(context): "
                            + "baseline=\(region.frame) candidate=\(candidate.frame)"
                    )
                }
            }
        }
    }

    private func attach(_ trace: HostedSettledGeometryTrace) throws {
        let encoder = Foundation.JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-settled-geometry.json"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    private func attach(_ trace: HostedPageBottomReachabilityTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-page-bottom-reachability.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ trace: HostedNativeInnerScrollTrace) throws {
        let encoder = Foundation.JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-native-inner-scroll.json"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    private func attach(_ trace: HostedCanonicalSizeMatrixTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-canonical-size-matrix.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ trace: HostedLargeTextMatrixTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-large-text-matrix.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ trace: HostedRenderedTextScaleTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-rendered-text-scale.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ trace: HostedOnboardingMatrixTrace) throws {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-onboarding-matrix.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func attach(_ trace: HostedSettingsSceneTrace) throws {
        let encoder = Foundation.JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-settings-scene.json"
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }

    private func attachTransportDiagnostic(_ diagnostic: HostedTransportDiagnostic) {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        guard let data = try? encoder.encode(diagnostic) else { return }
        let attachment = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        attachment.name = "neondiff-hosted-transport-diagnostic.json"
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    private func runtimeValueType(_ value: Any?) -> String {
        value.map { String(reflecting: type(of: $0)) } ?? "nil"
    }
}

private struct HostedContentSize: Codable {
    let width: Int
    let height: Int
}

private struct HostedSidebarRouteStep {
    let section: String
    let generation: Int
}

private struct HostedPageBottomRouteStep {
    let section: String
    let generation: Int
    let outerScrollIdentifier: String
    let sentinelIdentifier: String
}

private struct HostedCanonicalSizeRequest {
    let requestedContentSize: HostedContentSize
    let contentSizeArgument: String
}

private struct HostedOnboardingFixtureStep {
    let fixtureId: String
    let onboardingStep: String
    let section: String
}

private struct HostedGeometryFrame: Codable, Equatable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ frame: CGRect) {
        x = frame.origin.x
        y = frame.origin.y
        width = frame.width
        height = frame.height
    }

    init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    init(
        _ appKitContentLayoutScreenRect: HostedSettingsAppKitFrame,
        relativeTo appKitWindowFrame: HostedSettingsAppKitFrame,
        in xcuiWindowFrame: Self
    ) {
        x = xcuiWindowFrame.x
            + (appKitContentLayoutScreenRect.x - appKitWindowFrame.x)
        y = xcuiWindowFrame.y
            + (appKitWindowFrame.maxY - appKitContentLayoutScreenRect.maxY)
        width = appKitContentLayoutScreenRect.width
        height = appKitContentLayoutScreenRect.height
    }

    var isFiniteAndNonempty: Bool {
        [x, y, width, height, x + width, y + height].allSatisfy(\.isFinite)
            && width > 0
            && height > 0
    }

    func differs(from other: Self, byMoreThan tolerance: Double) -> Bool {
        abs(x - other.x) > tolerance
            || abs(y - other.y) > tolerance
            || abs(width - other.width) > tolerance
            || abs(height - other.height) > tolerance
    }

    func isFullyContained(in container: Self, tolerance: Double) -> Bool {
        x >= container.x - tolerance
            && y >= container.y - tolerance
            && x + width <= container.x + container.width + tolerance
            && y + height <= container.y + container.height + tolerance
    }

    func matches(_ size: HostedContentSize, tolerance: Double) -> Bool {
        abs(width - Double(size.width)) <= tolerance
            && abs(height - Double(size.height)) <= tolerance
    }

    var maxX: Double { x + width }
    var maxY: Double { y + height }
    var area: Double { width * height }
}

private struct HostedGeometryPoint: Codable, Equatable {
    let x: Double
    let y: Double
}

private struct HostedTextRange: Codable, Equatable {
    let location: Int
    let length: Int

    init(_ range: NSRange) {
        location = range.location
        length = range.length
    }

    var isValid: Bool {
        location >= 0 && length >= 0 && location <= Int.max - length
    }

    func fullyContains(_ other: Self) -> Bool {
        isValid && other.isValid
            && other.location >= location
            && other.location + other.length <= location + length
    }
}

private struct HostedTerminalNativeVisibility: Codable, Equatable {
    let schemaVersion: Int
    let coordinateSpace: String
    let terminalToken: String
    let textUTF16Length: Int
    let terminalTokenRange: HostedTextRange
    let visibleCharacterRange: HostedTextRange
    let visibleRect: HostedGeometryFrame
    let terminalGlyphBounds: HostedGeometryFrame
    let terminalTokenFullyVisible: Bool
}

private struct HostedGeometryRegionFrame: Codable, Equatable {
    static let requiredIdentifiers = [
        "neondiff-chrome",
        "neondiff-sidebar",
        "neondiff-detail"
    ]

    let identifier: String
    let frame: HostedGeometryFrame
}

private struct HostedGeometrySample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let windowFrame: HostedGeometryFrame
    let contentFrame: HostedGeometryFrame
    let backingScale: Double
    let regions: [HostedGeometryRegionFrame]
}

private struct CompactHostedGeometryCursor {
    static let encodedByteCount = 269
    private static let magic: [UInt8] = [0x4E, 0x44, 0x47, 0x32]

    private let data: Data
    private var index = 0

    init(data: Data) {
        self.data = data
    }

    var isAtEnd: Bool {
        index == data.count
    }

    mutating func validateHeader() throws {
        let header = try (0..<Self.magic.count).map { _ in try readByte() }
        guard header == Self.magic else {
            throw HostedGeometryTraceError.invalidCompactPayload
        }
    }

    mutating func readByte() throws -> UInt8 {
        guard index < data.count else {
            throw HostedGeometryTraceError.invalidCompactPayload
        }
        defer { index += 1 }
        return data[index]
    }

    mutating func readUInt32() throws -> UInt32 {
        let byte0 = UInt32(try readByte())
        let byte1 = UInt32(try readByte())
        let byte2 = UInt32(try readByte())
        let byte3 = UInt32(try readByte())
        return byte0 | (byte1 << 8) | (byte2 << 16) | (byte3 << 24)
    }

    mutating func readFloat() throws -> Double {
        Double(Float(bitPattern: try readUInt32()))
    }

    mutating func readFrame() throws -> HostedGeometryFrame {
        let x = try readFloat()
        let y = try readFloat()
        let width = try readFloat()
        let height = try readFloat()
        return HostedGeometryFrame(x: x, y: y, width: width, height: height)
    }
}

private struct HostedGeometryCheckpoint: Codable, Equatable {
    let section: String
    let surfaceGeneration: Int
    let quiescenceMarkerIdentifier: String
    let observedContentGeometry: HostedObservedContentGeometry
    let samples: [HostedGeometrySample]
}

private struct HostedObservedContentGeometry: Codable, Equatable {
    let contentFrame: HostedGeometryFrame
    let backingScale: Double
}

private struct HostedNavigationAction: Codable {
    let index: Int
    let fromSection: String
    let toSection: String
    let controlIdentifier: String
    let attemptCount: Int
    let result: String
}

private struct HostedSettledGeometryTrace: Codable {
    let schemaVersion: Int
    let scenario: String
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let textSizeMode: String
    let coordinateSpaces: HostedGeometryCoordinateSpaces
    let sampleIntervalMilliseconds: Int
    let tolerancePoints: Double
    let navigationActions: [HostedNavigationAction]
    let checkpoints: [HostedGeometryCheckpoint]
    let proofBoundary: String
}

private struct HostedPageBottomSample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let outerScrollFrame: HostedGeometryFrame
    let sentinelFrame: HostedGeometryFrame
    let detailRegionFrame: HostedGeometryFrame
    let sentinelFullyContainedInOuterScroll: Bool
    let sentinelFullyContainedInDetailRegion: Bool
}

private struct HostedPageBottomSettledWindow {
    let samples: [HostedPageBottomSample]
    let durationMilliseconds: Int
}

private struct HostedPageBottomNestedScrollGuard {
    let controlIdentifier: String
    let targetCoordinate: XCUICoordinate
    let targetPoint: HostedGeometryPoint
    let outerScrollFrame: HostedGeometryFrame
    let nestedScrollFrame: HostedGeometryFrame
    let verticalScrollBar: XCUIElement
    let baselineValue: Double
}

private struct HostedPageScrollAction: Codable, Equatable {
    let controlIdentifier: String
    let deltaX: Double
    let deltaY: Double
    let attemptCount: Int
    let result: String
    let effectProven: Bool
    let targetPoint: HostedGeometryPoint?
    let nestedScrollControlIdentifier: String?
    let nestedScrollValueBefore: Double?
    let nestedScrollValueAfter: Double?
    let guardOuterScrollFrame: HostedGeometryFrame?
    let guardNestedScrollFrame: HostedGeometryFrame?

    private enum CodingKeys: String, CodingKey {
        case controlIdentifier
        case deltaX
        case deltaY
        case attemptCount
        case result
        case effectProven
        case targetPoint
        case nestedScrollControlIdentifier
        case nestedScrollValueBefore
        case nestedScrollValueAfter
        case guardOuterScrollFrame
        case guardNestedScrollFrame
    }

    init(
        controlIdentifier: String,
        deltaX: Double,
        deltaY: Double,
        attemptCount: Int,
        result: String,
        effectProven: Bool,
        targetPoint: HostedGeometryPoint? = nil,
        nestedScrollControlIdentifier: String? = nil,
        nestedScrollValueBefore: Double? = nil,
        nestedScrollValueAfter: Double? = nil,
        guardOuterScrollFrame: HostedGeometryFrame? = nil,
        guardNestedScrollFrame: HostedGeometryFrame? = nil
    ) {
        self.controlIdentifier = controlIdentifier
        self.deltaX = deltaX
        self.deltaY = deltaY
        self.attemptCount = attemptCount
        self.result = result
        self.effectProven = effectProven
        self.targetPoint = targetPoint
        self.nestedScrollControlIdentifier = nestedScrollControlIdentifier
        self.nestedScrollValueBefore = nestedScrollValueBefore
        self.nestedScrollValueAfter = nestedScrollValueAfter
        self.guardOuterScrollFrame = guardOuterScrollFrame
        self.guardNestedScrollFrame = guardNestedScrollFrame
    }

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        controlIdentifier = try container.decode(String.self, forKey: .controlIdentifier)
        deltaX = try container.decode(Double.self, forKey: .deltaX)
        deltaY = try container.decode(Double.self, forKey: .deltaY)
        attemptCount = try container.decode(Int.self, forKey: .attemptCount)
        result = try container.decode(String.self, forKey: .result)
        effectProven = try container.decode(Bool.self, forKey: .effectProven)
        targetPoint = try container.decodeIfPresent(
            HostedGeometryPoint.self,
            forKey: .targetPoint
        )
        nestedScrollControlIdentifier = try container.decodeIfPresent(
            String.self,
            forKey: .nestedScrollControlIdentifier
        )
        nestedScrollValueBefore = try container.decodeIfPresent(
            Double.self,
            forKey: .nestedScrollValueBefore
        )
        nestedScrollValueAfter = try container.decodeIfPresent(
            Double.self,
            forKey: .nestedScrollValueAfter
        )
        guardOuterScrollFrame = try container.decodeIfPresent(
            HostedGeometryFrame.self,
            forKey: .guardOuterScrollFrame
        )
        guardNestedScrollFrame = try container.decodeIfPresent(
            HostedGeometryFrame.self,
            forKey: .guardNestedScrollFrame
        )
    }

    func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(controlIdentifier, forKey: .controlIdentifier)
        try container.encode(deltaX, forKey: .deltaX)
        try container.encode(deltaY, forKey: .deltaY)
        try container.encode(attemptCount, forKey: .attemptCount)
        try container.encode(result, forKey: .result)
        try container.encode(effectProven, forKey: .effectProven)
        try container.encodeIfPresent(targetPoint, forKey: .targetPoint)
        try container.encodeIfPresent(
            nestedScrollControlIdentifier,
            forKey: .nestedScrollControlIdentifier
        )
        try container.encodeIfPresent(
            nestedScrollValueBefore,
            forKey: .nestedScrollValueBefore
        )
        try container.encodeIfPresent(
            nestedScrollValueAfter,
            forKey: .nestedScrollValueAfter
        )
        try container.encodeIfPresent(
            guardOuterScrollFrame,
            forKey: .guardOuterScrollFrame
        )
        try container.encodeIfPresent(
            guardNestedScrollFrame,
            forKey: .guardNestedScrollFrame
        )
    }
}

private struct HostedPageBottomCheckpoint: Codable, Equatable {
    let section: String
    let surfaceGeneration: Int
    let quiescenceMarkerIdentifier: String
    let outerScrollIdentifier: String
    let sentinelIdentifier: String
    let preActionSamples: [HostedPageBottomSample]
    let preActionSamplingDurationMilliseconds: Int
    let scrollAction: HostedPageScrollAction?
    let postActionSamples: [HostedPageBottomSample]
    let postActionSamplingDurationMilliseconds: Int
}

private struct HostedPageBottomReachabilityTrace: Codable {
    let schemaVersion: Int
    let scenario: String
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let textSizeMode: String
    let coordinateSpace: String
    let minimumSampleIntervalMilliseconds: Int
    let samplingDeadlineMilliseconds: Int
    let tolerancePoints: Double
    let navigationActions: [HostedNavigationAction]
    let checkpoints: [HostedPageBottomCheckpoint]
    let proofBoundary: String
}

private struct HostedNativeScrollBarDragTarget {
    let sourceCoordinate: XCUICoordinate
    let destinationCoordinate: XCUICoordinate
    let sourcePoint: HostedGeometryPoint
    let destinationPoint: HostedGeometryPoint
    let scrollBarFrame: HostedGeometryFrame
    let thumbFrame: HostedGeometryFrame
    let requestedDisplacementY: Double
}

private struct HostedNativeScrollBarChain {
    let control: XCUIElement
    let scrollContainer: XCUIElement
    let verticalScrollBar: XCUIElement
    let thumb: XCUIElement
    let scrollBarFrame: HostedGeometryFrame
    let thumbFrame: HostedGeometryFrame
    let thumbEnabled: Bool
    let thumbHittable: Bool
}

private struct HostedNativeScrollBarHoverTarget {
    let coordinate: XCUICoordinate
    let point: HostedGeometryPoint
    let chain: HostedNativeScrollBarChain
}

private struct HostedNativeScrollBarHoverSample: Codable, Equatable {
    let innerScrollSample: HostedNativeInnerScrollSample
    let thumbFrame: HostedGeometryFrame
    let thumbEnabled: Bool
    let thumbHittable: Bool
}

private struct HostedNativeScrollBarHoverPreparation: Codable, Equatable {
    let action: HostedNativeInnerScrollAction
    let observedSamples: [HostedNativeScrollBarHoverSample]
    let samples: [HostedNativeScrollBarHoverSample]
    let durationMilliseconds: Int
}

private struct HostedNativePreparedScrollBarDrag {
    let preparation: HostedNativeScrollBarHoverPreparation
    let chain: HostedNativeScrollBarChain
    let dragTarget: HostedNativeScrollBarDragTarget
}

private struct HostedNativeInnerScrollAction: Codable, Equatable {
    let mechanism: String
    let elapsedMilliseconds: Int
    let deltaX: Double?
    let deltaY: Double?
    let sourcePoint: HostedGeometryPoint?
    let targetPoint: HostedGeometryPoint?
    let normalizedTargetValue: Double?
    let requestedDisplacementY: Double?
    let guardScrollBarFrame: HostedGeometryFrame?
    let guardScrollBarFrameAfter: HostedGeometryFrame?
    let guardThumbFrameBefore: HostedGeometryFrame?
    let guardThumbFrameAfter: HostedGeometryFrame?
    let normalizedValueBefore: Double?
    let normalizedValueAfter: Double?
    let guardThumbHittableBefore: Bool?
    let guardThumbHittableAfter: Bool?
    let observedThumbTranslationY: Double?
    let attemptCount: Int
    let effectObserved: Bool
    let effectProven: Bool
    let result: String

    init(
        mechanism: String,
        elapsedMilliseconds: Int,
        deltaX: Double? = nil,
        deltaY: Double? = nil,
        sourcePoint: HostedGeometryPoint? = nil,
        targetPoint: HostedGeometryPoint? = nil,
        normalizedTargetValue: Double? = nil,
        requestedDisplacementY: Double? = nil,
        guardScrollBarFrame: HostedGeometryFrame? = nil,
        guardScrollBarFrameAfter: HostedGeometryFrame? = nil,
        guardThumbFrameBefore: HostedGeometryFrame? = nil,
        guardThumbFrameAfter: HostedGeometryFrame? = nil,
        normalizedValueBefore: Double? = nil,
        normalizedValueAfter: Double? = nil,
        guardThumbHittableBefore: Bool? = nil,
        guardThumbHittableAfter: Bool? = nil,
        observedThumbTranslationY: Double? = nil,
        attemptCount: Int,
        effectObserved: Bool,
        effectProven: Bool,
        result: String
    ) {
        self.mechanism = mechanism
        self.elapsedMilliseconds = elapsedMilliseconds
        self.deltaX = deltaX
        self.deltaY = deltaY
        self.sourcePoint = sourcePoint
        self.targetPoint = targetPoint
        self.normalizedTargetValue = normalizedTargetValue
        self.requestedDisplacementY = requestedDisplacementY
        self.guardScrollBarFrame = guardScrollBarFrame
        self.guardScrollBarFrameAfter = guardScrollBarFrameAfter
        self.guardThumbFrameBefore = guardThumbFrameBefore
        self.guardThumbFrameAfter = guardThumbFrameAfter
        self.normalizedValueBefore = normalizedValueBefore
        self.normalizedValueAfter = normalizedValueAfter
        self.guardThumbHittableBefore = guardThumbHittableBefore
        self.guardThumbHittableAfter = guardThumbHittableAfter
        self.observedThumbTranslationY = observedThumbTranslationY
        self.attemptCount = attemptCount
        self.effectObserved = effectObserved
        self.effectProven = effectProven
        self.result = result
    }
}

private struct HostedNativeInnerScrollSample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let normalizedScrollValue: Double
    let controlFrame: HostedGeometryFrame
    let scrollContainerFrame: HostedGeometryFrame
    let scrollBarFrame: HostedGeometryFrame
    let outerScrollFrame: HostedGeometryFrame
    let outerSentinelFrame: HostedGeometryFrame
    let terminalElementFrame: HostedGeometryFrame?
    let terminalElementFullyContained: Bool?
    let terminalRowFrame: HostedGeometryFrame?
    let terminalElementFullyContainedInRow: Bool?
    let terminalRowFullyContained: Bool?
    let controlValueContainsTerminalToken: Bool?
    let terminalVisibilityMarkerFrame: HostedGeometryFrame?
    let terminalVisibilityMarkerFullyContained: Bool?
    let terminalNativeVisibility: HostedTerminalNativeVisibility?
}

private struct HostedNativeInnerScrollSettledWindow {
    let observedSamples: [HostedNativeInnerScrollSample]
    let samples: [HostedNativeInnerScrollSample]
    let durationMilliseconds: Int
}

private struct HostedNativeInnerScrollCheckpoint: Codable, Equatable {
    let section: String
    let controlIdentifier: String
    let controlElementType: String
    let scrollContainerElementType: String
    let scrollContainerCount: Int
    let verticalScrollBarCount: Int
    let terminalVisibilityMarkerIdentifier: String?
    let terminalVisibleText: String?
    let terminalValueToken: String?
    let terminalRowElementType: String?
    let outerPreparationCheckpoint: HostedPageBottomCheckpoint
    let outerPreparationResult: String
    let outerPreparationSample: HostedNativeInnerScrollSample
    let outerRestagingAction: HostedNativeInnerScrollAction?
    let outerRestagingObservedSamples: [HostedNativeInnerScrollSample]
    let outerRestagingSamples: [HostedNativeInnerScrollSample]
    let outerRestagingWindowDurationMilliseconds: Int
    let preTerminalValue: Double
    let terminalValue: Double
    let repeatTerminalValue: Double
    let targetSampleIntervalMilliseconds: Int
    let minimumAcceptedSampleIntervalMilliseconds: Int
    let samplingDeadlineMilliseconds: Int
    let terminalWindowDurationMilliseconds: Int
    let repeatTerminalWindowDurationMilliseconds: Int
    let terminalStateStable: Bool
    let outerIsolationProven: Bool
    let firstHoverPreparation: HostedNativeScrollBarHoverPreparation
    let repeatHoverPreparation: HostedNativeScrollBarHoverPreparation
    let firstTerminalAction: HostedNativeInnerScrollAction
    let repeatTerminalAction: HostedNativeInnerScrollAction
    let preSample: HostedNativeInnerScrollSample
    let terminalObservedSamples: [HostedNativeInnerScrollSample]
    let terminalSamples: [HostedNativeInnerScrollSample]
    let repeatTerminalObservedSamples: [HostedNativeInnerScrollSample]
    let repeatTerminalSamples: [HostedNativeInnerScrollSample]
}

private struct HostedNativeInnerScrollTrace: Codable {
    let schemaVersion: Int
    let scenario: String
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let coordinateSpaces: HostedNativeInnerScrollCoordinateSpaces
    let tolerancePoints: Double
    let observedGeometryCheckpoints: [HostedGeometryCheckpoint]
    let innerScrollCheckpoints: [HostedNativeInnerScrollCheckpoint]
    let navigationActions: [HostedNavigationAction]
    let outerPageBottomCheckpoints: [HostedPageBottomCheckpoint]
    let proofBoundary: String
}

private struct HostedNativeInnerScrollCoordinateSpaces: Codable {
    let xcuiGeometry: String
    let observedWindowAndContent: String
    let observedRegions: String
    let terminalNativeVisibility: String
}

private struct HostedCanonicalSizeScenario: Codable {
    let requestedContentSize: HostedContentSize
    let contentSizeArgument: String
    let settledGeometry: HostedSettledGeometryTrace
    let pageBottomReachability: HostedPageBottomReachabilityTrace
}

private struct HostedCanonicalSizeMatrixTrace: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let textSizeMode: String
    let scenarios: [HostedCanonicalSizeScenario]
    let proofBoundary: String
}

private struct HostedLargeTextMatrixTrace: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let textSizeMode: String
    let settledGeometry: HostedSettledGeometryTrace
    let pageBottomReachability: HostedPageBottomReachabilityTrace
    let proofBoundary: String
}

private struct HostedRenderedTextSample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let frame: HostedGeometryFrame
    let semanticValue: String
    let visibleContainerFrame: HostedGeometryFrame
    let fullyContainedInVisibleContainer: Bool
}

private struct HostedRenderedTextScaleScenario: Codable {
    let textSizeMode: String
    let launchTextSizeArgument: String?
    let rootIdentifier: String
    let quiescenceMarkerIdentifier: String
    let samples: [HostedRenderedTextSample]
}

private struct HostedRenderedTextScaleTrace: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let semanticTextIdentifier: String
    let expectedSemanticValue: String
    let coordinateSpace: String
    let sampleIntervalMilliseconds: Int
    let tolerancePoints: Double
    let minimumRequiredHeightGrowthPoints: Double
    let defaultMaximumHeightPoints: Double
    let accessibility3MinimumHeightPoints: Double
    let robustRenderedHeightGrowthPoints: Double
    let defaultScenario: HostedRenderedTextScaleScenario
    let accessibility3Scenario: HostedRenderedTextScaleScenario
    let proofBoundary: String
}

private struct HostedOnboardingRegionFrame: Codable, Equatable {
    let identifier: String
    let frame: HostedGeometryFrame
    let fullyContainedInWizard: Bool
}

private struct HostedOnboardingSample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let completionElapsedMilliseconds: Int
    let windowFrame: HostedGeometryFrame
    let wizardFrame: HostedGeometryFrame
    let fullyContainedInWindow: Bool
    let regions: [HostedOnboardingRegionFrame]
}

private struct HostedOnboardingScenario: Codable {
    let fixtureId: String
    let onboardingStep: String
    let section: String
    let fixtureRootIdentifier: String
    let currentStepIdentifier: String
    let quiescenceMarkerIdentifier: String
    let samples: [HostedOnboardingSample]
}

private struct HostedOnboardingMatrixTrace: Codable {
    let schemaVersion: Int
    let requestedContentSize: HostedContentSize
    let coordinateSpace: String
    let sampleIntervalMilliseconds: Int
    let samplingDeadlineMilliseconds: Int
    let tolerancePoints: Double
    let scenarios: [HostedOnboardingScenario]
    let proofBoundary: String
}

private struct HostedSettingsTextSizeRequest {
    let textSizeMode: String
    let textSizeArgument: String?
}

private struct HostedSettingsOpenAction: Codable {
    let method: String
    let attemptCount: Int
    let result: String
    let elapsedMilliseconds: Int
    let windowCountBefore: Int
    let windowCountAfter: Int
}

private struct HostedSettingsScrollAction: Codable {
    let controlIdentifier: String
    let deltaX: Double
    let deltaY: Double
    let attemptCount: Int
    let result: String
    let effectProven: Bool
}

private struct HostedSettingsSceneSample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let completionElapsedMilliseconds: Int
    let windowFrame: HostedGeometryFrame
    let accessibilityContainerFrame: HostedGeometryFrame
    let projectedAppKitContentLayoutFrame: HostedGeometryFrame
    let outerScrollFrame: HostedGeometryFrame
    let sentinelFrame: HostedGeometryFrame
    let accessibilityContainerMatchesWindowFrame: Bool
    let accessibilityContainerFullyContainedInWindow: Bool
    let projectedAppKitContentLayoutFullyContainedInWindow: Bool
    let outerScrollFullyContainedInProjectedAppKitContentLayout: Bool
    let sentinelFullyContainedInOuterScroll: Bool
}

private struct HostedSettingsSceneScenario: Codable {
    let textSizeMode: String
    let launchTextSizeArgument: String?
    let observedSettingsTextSize: String
    let observedAppKitContentLayoutSize: HostedContentSize
    let observedAppKitWindowSize: HostedContentSize
    let fixtureRootIdentifier: String
    let quiescenceMarkerIdentifier: String
    let openAction: HostedSettingsOpenAction
    let appKitGeometry: HostedSettingsAppKitGeometryEnvelope
    let preActionSamples: [HostedSettingsSceneSample]
    let scrollAction: HostedSettingsScrollAction?
    let postActionSamples: [HostedSettingsSceneSample]
}

private struct HostedSettingsAppKitGeometryEnvelope: Codable {
    let schemaVersion: Int
    let coordinateSpaces: HostedSettingsAppKitCoordinateSpaces
    let samples: [HostedSettingsAppKitSample]
}

private struct HostedSettingsAppKitCoordinateSpaces: Codable {
    let windowFrame: String
    let contentLayoutRect: String
    let contentLayoutScreenRect: String
    let visibleScreenFrame: String
}

private struct HostedSettingsAppKitSample: Codable {
    let windowFrame: HostedSettingsAppKitFrame
    let contentLayoutRect: HostedSettingsAppKitFrame
    let contentLayoutScreenRect: HostedSettingsAppKitFrame
    let visibleScreenFrame: HostedSettingsAppKitFrame
}

private struct HostedSettingsAppKitFrame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    var isFiniteAndNonempty: Bool {
        x.isFinite && y.isFinite && width.isFinite && height.isFinite
            && width > 0 && height > 0
    }

    func matches(_ size: HostedContentSize, tolerance: Double) -> Bool {
        abs(width - Double(size.width)) <= tolerance
            && abs(height - Double(size.height)) <= tolerance
    }

    var roundedContentSize: HostedContentSize {
        HostedContentSize(
            width: Int(width.rounded()),
            height: Int(height.rounded())
        )
    }

    var maxY: Double { y + height }

    func matchesFittedSettingsContent(
        preferredContentSize: HostedContentSize,
        windowFrame: Self,
        visibleScreenFrame: Self,
        tolerance: Double
    ) -> Bool {
        let chromeHeight = windowFrame.height - height
        let availableContentHeight = visibleScreenFrame.height - chromeHeight
        guard chromeHeight.isFinite,
              chromeHeight >= -tolerance,
              availableContentHeight.isFinite,
              availableContentHeight > 0 else {
            return false
        }
        let expectedHeight = min(
            Double(preferredContentSize.height),
            floor(availableContentHeight)
        )
        return abs(width - Double(preferredContentSize.width)) <= tolerance
            && abs(height - expectedHeight) <= tolerance
    }

    func isFullyContained(in container: Self, tolerance: Double) -> Bool {
        x >= container.x - tolerance
            && y >= container.y - tolerance
            && x + width <= container.x + container.width + tolerance
            && y + height <= container.y + container.height + tolerance
    }

    func isFullyContainedInWindowBounds(
        windowFrame: Self,
        tolerance: Double
    ) -> Bool {
        x >= -tolerance
            && y >= -tolerance
            && x + width <= windowFrame.width + tolerance
            && y + height <= windowFrame.height + tolerance
    }

    func differs(from other: Self, byMoreThan tolerance: Double) -> Bool {
        abs(x - other.x) > tolerance
            || abs(y - other.y) > tolerance
            || abs(width - other.width) > tolerance
            || abs(height - other.height) > tolerance
    }
}

private struct HostedSettingsSceneTrace: Codable {
    let schemaVersion: Int
    let fixtureId: String
    let requestedContentSize: HostedContentSize
    let coordinateSpace: String
    let sampleIntervalMilliseconds: Int
    let samplingDeadlineMilliseconds: Int
    let tolerancePoints: Double
    let scenarios: [HostedSettingsSceneScenario]
    let proofBoundary: String
}

private struct HostedGeometryCoordinateSpaces: Codable {
    let windowAndContent: String
    let regions: String
}

private struct HostedTransportDiagnostic: Codable {
    let stage: String
    let chunkIndex: Int?
    let runtimeValueType: String
    let utf8ByteCount: Int?
    let expectedPrefixMatched: Bool?
    let base64DecodedByteCount: Int?
    let equalsUnavailableSentinel: Bool
}

private enum HostedNativeInnerScrollTraceError: LocalizedError {
    case priorValidationFailure
    case appNotForeground
    case missingElement(String)
    case invalidElementCount(identifier: String, count: Int)
    case invalidScrollContainerCount(controlIdentifier: String, count: Int)
    case invalidVerticalScrollBarCount(controlIdentifier: String, count: Int)
    case invalidScrollBarThumbCount(controlIdentifier: String, count: Int)
    case scrollBarThumbGeometryNotStable(String)
    case hoverPreparationChangedState(String)
    case invalidScrollBarDragGeometry(String)
    case scrollBarThumbDidNotReachTerminal(String)
    case missingTerminalRowElementType(String)
    case invalidTerminalRowCount(controlIdentifier: String, count: Int)
    case invalidNormalizedScrollValue(String)
    case invalidPreTerminalValue(controlIdentifier: String, value: Double)
    case didNotReachTerminalValue(
        controlIdentifier: String,
        preTerminalValue: Double,
        terminalValue: Double
    )
    case repeatTerminalScrollChangedValue(
        controlIdentifier: String,
        terminalValue: Double,
        repeatTerminalValue: Double
    )
    case repeatTerminalScrollChangedGeometry(String)
    case invalidCadence(
        controlIdentifier: String,
        lhsElapsedMilliseconds: Int,
        rhsElapsedMilliseconds: Int
    )
    case invalidSettledWindow(String)
    case invalidFrame
    case innerViewportExceedsOuterViewport
    case noSafeOuterRestagingCoordinate
    case outerPreparationNotEstablished(section: String, failedChecks: [String])
    case outerRestagingNotEstablished(section: String, failedChecks: [String])
    case outerPageMoved(String)
    case missingTerminalContent(String)
    case terminalVisibilityMarkerPresentBeforeTerminal(String)
    case invalidTerminalNativeVisibility

    var errorDescription: String? {
        switch self {
        case .priorValidationFailure:
            "Hosted native inner-scroll trace withheld after an earlier validation failure"
        case .appNotForeground:
            "Hosted native inner-scroll fixture is not running in the foreground"
        case .missingElement(let identifier):
            "Missing hosted native inner-scroll element: \(identifier)"
        case let .invalidElementCount(identifier, count):
            "Hosted native inner-scroll element count is not exactly one: "
                + "identifier=\(identifier) count=\(count)"
        case let .invalidScrollContainerCount(controlIdentifier, count):
            "Hosted native control does not bind exactly one inner scroll container: "
                + "control=\(controlIdentifier) count=\(count)"
        case let .invalidVerticalScrollBarCount(controlIdentifier, count):
            "Hosted native control does not have exactly one geometry-bound vertical scrollbar: "
                + "control=\(controlIdentifier) count=\(count)"
        case let .invalidScrollBarThumbCount(controlIdentifier, count):
            "Hosted native vertical scrollbar does not expose exactly one public value indicator: "
                + "control=\(controlIdentifier) count=\(count)"
        case .scrollBarThumbGeometryNotStable(let controlIdentifier):
            "Hosted native vertical scrollbar thumb geometry did not establish a stable sampled window: "
                + "control=\(controlIdentifier)"
        case .hoverPreparationChangedState(let controlIdentifier):
            "Hosted native scrollbar hover preparation changed inner or outer state: "
                + "control=\(controlIdentifier)"
        case .invalidScrollBarDragGeometry(let controlIdentifier):
            "Hosted native vertical scrollbar thumb has no safe bounded downward drag: "
                + "control=\(controlIdentifier)"
        case .scrollBarThumbDidNotReachTerminal(let controlIdentifier):
            "Hosted native vertical scrollbar thumb did not translate to terminal geometry: "
                + "control=\(controlIdentifier)"
        case .missingTerminalRowElementType(let controlIdentifier):
            "Hosted native terminal text requires a semantic row type: "
                + "control=\(controlIdentifier)"
        case let .invalidTerminalRowCount(controlIdentifier, count):
            "Hosted native terminal text does not bind exactly one semantic row: "
                + "control=\(controlIdentifier) count=\(count)"
        case .invalidNormalizedScrollValue(let runtimeType):
            "Hosted native scrollbar value is not normalized: runtimeType=\(runtimeType)"
        case let .invalidPreTerminalValue(controlIdentifier, value):
            "Hosted native scrollbar started at its terminal value: "
                + "control=\(controlIdentifier) value=\(value)"
        case let .didNotReachTerminalValue(
            controlIdentifier,
            preTerminalValue,
            terminalValue
        ):
            "Hosted native scrollbar did not reach terminal value: "
                + "control=\(controlIdentifier) pre=\(preTerminalValue) "
                + "terminal=\(terminalValue)"
        case let .repeatTerminalScrollChangedValue(
            controlIdentifier,
            terminalValue,
            repeatTerminalValue
        ):
            "Repeated hosted terminal scroll changed the scrollbar value: "
                + "control=\(controlIdentifier) terminal=\(terminalValue) "
                + "repeat=\(repeatTerminalValue)"
        case .repeatTerminalScrollChangedGeometry(let controlIdentifier):
            "Repeated hosted terminal scroll changed inner-control geometry: "
                + "control=\(controlIdentifier)"
        case let .invalidCadence(
            controlIdentifier,
            lhsElapsedMilliseconds,
            rhsElapsedMilliseconds
        ):
            "Hosted native inner-scroll sample cadence is invalid: "
                + "control=\(controlIdentifier) lhs=\(lhsElapsedMilliseconds)ms "
                + "rhs=\(rhsElapsedMilliseconds)ms"
        case .invalidSettledWindow(let controlIdentifier):
            "Hosted native inner-scroll settled window is invalid: "
                + "control=\(controlIdentifier)"
        case .invalidFrame:
            "Hosted native inner-scroll geometry contains an invalid frame"
        case .innerViewportExceedsOuterViewport:
            "Hosted native inner-scroll viewport cannot fit inside its outer page viewport"
        case .noSafeOuterRestagingCoordinate:
            "Hosted native inner-scroll trace could not bind an outer-only restaging coordinate"
        case .outerPreparationNotEstablished(let section, let failedChecks):
            "Hosted native inner-scroll outer page was not prepared at page bottom: "
                + "section=\(section) failedChecks=\(failedChecks.joined(separator: ","))"
        case .outerRestagingNotEstablished(let section, let failedChecks):
            "Hosted native inner-scroll viewport was not restaged inside its outer page: "
                + "section=\(section) failedChecks=\(failedChecks.joined(separator: ","))"
        case .outerPageMoved(let section):
            "Hosted outer page moved while scrolling its native inner control: \(section)"
        case .missingTerminalContent(let section):
            "Hosted native inner control did not expose its terminal content: \(section)"
        case .terminalVisibilityMarkerPresentBeforeTerminal(let identifier):
            "Hosted native terminal visibility marker existed before terminal scroll: "
                + "identifier=\(identifier)"
        case .invalidTerminalNativeVisibility:
            "Hosted native terminal visibility payload was missing or invalid"
        }
    }
}

private enum HostedPageBottomTraceError: LocalizedError {
    case priorValidationFailure
    case missingElement(String)
    case invalidNestedScrollGuardConfiguration
    case requiredGuardedScrollActionWasNotIssued(String)
    case nestedScrollValueChangedDuringOuterPreparation(
        controlIdentifier: String,
        before: Double,
        after: Double?
    )
    case invalidFrame(String)
    case missingSamples(String)
    case invalidCadence(String)
    case unstableGeometry(String)
    case sentinelNotContained(
        context: String,
        sentinel: HostedGeometryFrame,
        container: HostedGeometryFrame
    )

    var errorDescription: String? {
        switch self {
        case .priorValidationFailure:
            "Hosted page-bottom trace withheld after an earlier validation failure"
        case .missingElement(let identifier):
            "Missing hosted page-bottom element: \(identifier)"
        case .invalidNestedScrollGuardConfiguration:
            "Hosted page-bottom nested-scroll guard requires both identifier and element type"
        case .requiredGuardedScrollActionWasNotIssued(let section):
            "Hosted page-bottom fixture did not require its guarded outer scroll action: "
                + "section=\(section)"
        case let .nestedScrollValueChangedDuringOuterPreparation(
            controlIdentifier,
            before,
            after
        ):
            "Hosted outer page preparation changed a nested native scrollbar: "
                + "control=\(controlIdentifier) before=\(before) "
                + "after=\(String(describing: after))"
        case .invalidFrame(let context):
            "Invalid hosted page-bottom frame: \(context)"
        case .missingSamples(let context):
            "Missing hosted page-bottom samples: \(context)"
        case .invalidCadence(let context):
            "Invalid hosted page-bottom sample cadence: \(context)"
        case .unstableGeometry(let context):
            "Hosted page-bottom geometry drift exceeded one point: \(context)"
        case let .sentinelNotContained(context, sentinel, container):
            "Hosted page-bottom sentinel is not fully contained in \(context): "
                + "sentinel=\(sentinel) container=\(container)"
        }
    }
}

private enum HostedRenderedTextScaleError: LocalizedError {
    case priorValidationFailure
    case appNotForeground
    case missingElement(String)
    case invalidElementCount(identifier: String, count: Int)
    case unexpectedSemanticValue(String)
    case invalidFrame(String)
    case invalidVisibleContainerFrame(String)
    case textNotVisible(
        context: String,
        textFrame: HostedGeometryFrame,
        visibleContainerFrame: HostedGeometryFrame
    )
    case missingSamples(String)
    case invalidCadence(String)
    case unstableGeometry(String)
    case insufficientRenderedScale(
        defaultMaximumFrame: HostedGeometryFrame,
        accessibility3MinimumFrame: HostedGeometryFrame
    )

    var errorDescription: String? {
        switch self {
        case .priorValidationFailure:
            "Hosted rendered-text trace withheld after an earlier validation failure"
        case .appNotForeground:
            "Hosted rendered-text fixture is not running in the foreground"
        case .missingElement(let identifier):
            "Missing hosted rendered-text element: \(identifier)"
        case let .invalidElementCount(identifier, count):
            "Hosted rendered-text element count is not exactly one: "
                + "identifier=\(identifier) count=\(count)"
        case .unexpectedSemanticValue(let value):
            "Hosted rendered-text element has an unexpected semantic value: \(value)"
        case .invalidFrame(let context):
            "Hosted rendered-text frame is invalid: \(context)"
        case .invalidVisibleContainerFrame(let context):
            "Hosted rendered-text visible-container frame is invalid: \(context)"
        case let .textNotVisible(context, textFrame, visibleContainerFrame):
            "Hosted rendered-text frame is not fully contained in the visible container: "
                + "context=\(context) text=\(textFrame) "
                + "container=\(visibleContainerFrame)"
        case .missingSamples(let context):
            "Hosted rendered-text samples are missing: \(context)"
        case .invalidCadence(let context):
            "Hosted rendered-text sample cadence is invalid: \(context)"
        case .unstableGeometry(let context):
            "Hosted rendered-text geometry drift exceeded one point: \(context)"
        case let .insufficientRenderedScale(
            defaultMaximumFrame,
            accessibility3MinimumFrame
        ):
            "Accessibility3 did not increase visible production text height by more than "
                + "one point in the worst case: defaultMaximum=\(defaultMaximumFrame) "
                + "accessibility3Minimum=\(accessibility3MinimumFrame)"
        }
    }
}

private enum HostedOnboardingTraceError: LocalizedError {
    case priorValidationFailure
    case appNotForeground
    case missingElement(String)
    case invalidElementCount(identifier: String, count: Int)
    case interactiveQuiescenceMarker(String)
    case invalidFrame(String)
    case unexpectedContentSize(
        context: String,
        requested: HostedContentSize,
        observed: HostedGeometryFrame
    )
    case missingContainingWindow(String)
    case wizardNotContained(
        context: String,
        wizard: HostedGeometryFrame,
        window: HostedGeometryFrame
    )
    case regionNotContained(
        context: String,
        identifier: String,
        region: HostedGeometryFrame,
        wizard: HostedGeometryFrame
    )
    case missingSamples(String)
    case invalidCadence(String)
    case unstableGeometry(String)
    case invalidRegionLayout(String)

    var errorDescription: String? {
        switch self {
        case .priorValidationFailure:
            "Hosted onboarding trace withheld after an earlier validation failure"
        case .appNotForeground:
            "Hosted onboarding fixture is not running in the foreground"
        case .missingElement(let identifier):
            "Missing hosted onboarding element: \(identifier)"
        case let .invalidElementCount(identifier, count):
            "Hosted onboarding element count is not exactly one: "
                + "identifier=\(identifier) count=\(count)"
        case .interactiveQuiescenceMarker(let identifier):
            "Hosted onboarding quiescence marker is unexpectedly interactive: \(identifier)"
        case .invalidFrame(let context):
            "Invalid hosted onboarding frame: \(context)"
        case let .unexpectedContentSize(context, requested, observed):
            "Hosted onboarding content size does not match the request: "
                + "context=\(context) requested=\(requested.width)x\(requested.height) "
                + "observed=\(observed)"
        case .missingContainingWindow(let context):
            "Hosted onboarding wizard has no containing app window: \(context)"
        case let .wizardNotContained(context, wizard, window):
            "Hosted onboarding wizard is not fully contained: "
                + "context=\(context) wizard=\(wizard) window=\(window)"
        case let .regionNotContained(context, identifier, region, wizard):
            "Hosted onboarding region is not fully contained: "
                + "context=\(context) identifier=\(identifier) "
                + "region=\(region) wizard=\(wizard)"
        case .missingSamples(let context):
            "Missing hosted onboarding samples: \(context)"
        case .invalidCadence(let context):
            "Invalid hosted onboarding sample cadence: \(context)"
        case .unstableGeometry(let context):
            "Hosted onboarding geometry drift exceeded one point: \(context)"
        case .invalidRegionLayout(let context):
            "Hosted onboarding regions overlap or are ordered incorrectly: \(context)"
        }
    }
}

private enum HostedSettingsSceneTraceError: LocalizedError {
    case priorValidationFailure
    case appNotForeground
    case missingElement(String)
    case interactiveQuiescenceMarker
    case invalidObservedTextSize(String)
    case unexpectedObservedTextSize(expected: String, observed: String)
    case invalidAppKitGeometryPayload(String)
    case interactiveGeometryChunk(Int)
    case invalidAppKitGeometry(String)
    case unstableAppKitGeometry(String)
    case unexpectedWindowCount(before: Int, after: Int)
    case invalidFrame(String)
    case unexpectedWindowSize(
        expected: HostedContentSize,
        observedWindow: HostedGeometryFrame,
        observedAccessibilityContainer: HostedGeometryFrame
    )
    case missingContainingWindow(String)
    case invalidContainment(String)
    case invalidCadence(String)
    case unstableGeometry(String)
    case scrollHadNoEffect(String)
    case sentinelNotContained(String)

    var errorDescription: String? {
        switch self {
        case .priorValidationFailure:
            "Hosted Settings trace withheld after an earlier validation failure"
        case .appNotForeground:
            "Hosted Settings fixture is not running in the foreground"
        case .missingElement(let identifier):
            "Missing hosted Settings element: \(identifier)"
        case .interactiveQuiescenceMarker:
            "Hosted Settings quiescence marker is unexpectedly interactive"
        case .invalidObservedTextSize(let context):
            "Hosted Settings did not expose its observed text size: \(context)"
        case let .unexpectedObservedTextSize(expected, observed):
            "Hosted Settings observed text size does not match the override: "
                + "expected=\(expected) observed=\(observed)"
        case .invalidAppKitGeometryPayload(let context):
            "Hosted Settings AppKit geometry payload is invalid: \(context)"
        case .interactiveGeometryChunk(let index):
            "Hosted Settings AppKit geometry chunk is interactive: \(index)"
        case .invalidAppKitGeometry(let context):
            "Hosted Settings AppKit geometry is invalid or not contained: \(context)"
        case .unstableAppKitGeometry(let context):
            "Hosted Settings AppKit geometry drift exceeded one point: \(context)"
        case let .unexpectedWindowCount(before, after):
            "Hosted Settings command did not create exactly one window: "
                + "before=\(before) after=\(after)"
        case .invalidFrame(let context):
            "Invalid hosted Settings frame: \(context)"
        case let .unexpectedWindowSize(
            expected,
            observedWindow,
            observedAccessibilityContainer
        ):
            "Hosted Settings AppKit/XCUI window dimensions do not match: "
                + "expected=\(expected.width)x\(expected.height) "
                + "window=\(observedWindow) "
                + "accessibilityContainer=\(observedAccessibilityContainer)"
        case .missingContainingWindow(let context):
            "Hosted Settings evaluation container has no containing app window: \(context)"
        case .invalidContainment(let context):
            "Hosted Settings containment failed: \(context)"
        case .invalidCadence(let context):
            "Hosted Settings sample cadence is invalid: \(context)"
        case .unstableGeometry(let context):
            "Hosted Settings geometry drift exceeded one point: \(context)"
        case .scrollHadNoEffect(let context):
            "Hosted Settings outer scroll did not move the bottom sentinel: \(context)"
        case .sentinelNotContained(let context):
            "Hosted Settings bottom sentinel is not reachable: \(context)"
        }
    }
}

private enum HostedGeometryTraceError: LocalizedError {
    case invalidTransportManifest
    case missingTransportChunk(Int)
    case invalidTransportChunk(Int)
    case invalidTransportPayloadLength(Int)
    case invalidCompactPayload

    var errorDescription: String? {
        switch self {
        case .invalidTransportManifest:
            "Invalid app-authored geometry transport manifest"
        case .missingTransportChunk(let index):
            "Missing app-authored geometry transport chunk \(index)"
        case .invalidTransportChunk(let index):
            "Invalid app-authored geometry transport chunk \(index)"
        case .invalidTransportPayloadLength(let byteCount):
            "Invalid app-authored geometry payload length: \(byteCount) bytes"
        case .invalidCompactPayload:
            "Invalid app-authored compact geometry payload"
        }
    }
}
