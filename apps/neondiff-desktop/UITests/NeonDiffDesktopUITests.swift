import XCTest

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
                schemaVersion: 1,
                scenario: "every-sidebar-page-bottom-at-minimum-size",
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpace: "xcui-screen",
                minimumSampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: 5_000,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: checkpoints,
                proofBoundary: "hosted-outer-page-bottom-reachability-only-inner-scroll-exhaustion-excluded"
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
                    schemaVersion: 1,
                    scenario: "every-sidebar-page-bottom-1040x680-accessibility3",
                    fixtureId: "tab-overview",
                    requestedContentSize: requestedContentSize,
                    textSizeMode: textSizeMode,
                    coordinateSpace: "xcui-screen",
                    minimumSampleIntervalMilliseconds: 100,
                    samplingDeadlineMilliseconds: 5_000,
                    tolerancePoints: 1,
                    navigationActions: navigationActions,
                    checkpoints: pageBottomCheckpoints,
                    proofBoundary: "hosted-outer-page-bottom-1040x680-accessibility3-reachability-only-inner-scroll-exhaustion-excluded"
                ),
                proofBoundary: "hosted-accessibility3-minimum-size-outer-geometry-and-page-bottom-only-inner-scroll-exhaustion-excluded"
            )
        )
    }

    func testSeparateSettingsSceneSettlesAtCanonicalSizeAndReachesPageBottom() throws {
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
                schemaVersion: 1,
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                coordinateSpace: "xcui-screen",
                sampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: 5_000,
                tolerancePoints: 1,
                scenarios: scenarios,
                proofBoundary: "hosted-separate-settings-root-and-appkit-content-layout-560x700-default-and-observed-accessibility3-visible-screen-outer-page-bottom-only-system-preference-inner-scroll-manual-excluded"
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
        let settingsContent = app.descendants(matching: .any)[
            "neondiff-settings-window-content"
        ]
        guard settingsContent.waitForExistence(timeout: 10) else {
            throw HostedSettingsSceneTraceError.missingElement(
                "neondiff-settings-window-content"
            )
        }
        let openAction = HostedSettingsOpenAction(
            method: "automated-command-comma",
            attemptCount: 1,
            result: "settings-window-content-observed",
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
        guard textSizeMarker.waitForExistence(timeout: 2),
              let observedTextSize = textSizeMarker.value as? String,
              !observedTextSize.isEmpty,
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
            marker: geometryMarker,
            requestedContentSize: requestedContentSize,
            context: request.textSizeMode
        )
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
            settingsContent: settingsContent,
            outerScroll: outerScroll,
            bottomSentinel: bottomSentinel,
            requestedContentSize: requestedContentSize,
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
                settingsContent: settingsContent,
                outerScroll: outerScroll,
                bottomSentinel: bottomSentinel,
                requestedContentSize: requestedContentSize,
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
        marker: XCUIElement,
        requestedContentSize: HostedContentSize,
        context: String
    ) throws -> HostedSettingsAppKitGeometryEnvelope {
        guard let encodedPayload = marker.value as? String,
              encodedPayload != "unavailable",
              encodedPayload != "encoding-failed",
              let data = Data(base64Encoded: encodedPayload),
              let envelope = try? JSONDecoder().decode(
                  HostedSettingsAppKitGeometryEnvelope.self,
                  from: data
              ) else {
            throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
        }
        guard envelope.schemaVersion == 1,
              envelope.coordinateSpace == "appkit-screen",
              envelope.samples.count == 3,
              let baseline = envelope.samples.first else {
            throw HostedSettingsSceneTraceError.invalidAppKitGeometryPayload(context)
        }
        for sample in envelope.samples {
            guard sample.windowFrame.isFiniteAndNonempty,
                  sample.contentLayoutRect.isFiniteAndNonempty,
                  sample.visibleScreenFrame.isFiniteAndNonempty,
                  sample.contentLayoutRect.matches(
                      requestedContentSize,
                      tolerance: 1
                  ),
                  sample.contentLayoutScreenRect.matches(
                      requestedContentSize,
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
        settingsContent: XCUIElement,
        outerScroll: XCUIElement,
        bottomSentinel: XCUIElement,
        requestedContentSize: HostedContentSize,
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
            let settingsContentFrame = HostedGeometryFrame(settingsContent.frame)
            let windowFrame = try settingsContainingWindowFrame(
                app: app,
                settingsContentFrame: settingsContentFrame,
                context: context
            )
            let outerScrollFrame = HostedGeometryFrame(outerScroll.frame)
            let sentinelFrame = HostedGeometryFrame(bottomSentinel.frame)
            guard settingsContentFrame.isFiniteAndNonempty,
                  windowFrame.isFiniteAndNonempty,
                  outerScrollFrame.isFiniteAndNonempty,
                  sentinelFrame.isFiniteAndNonempty else {
                throw HostedSettingsSceneTraceError.invalidFrame(context)
            }
            guard settingsContentFrame.matches(requestedContentSize, tolerance: 1) else {
                throw HostedSettingsSceneTraceError.unexpectedContentSize(
                    requested: requestedContentSize,
                    observed: settingsContentFrame
                )
            }
            let sample = HostedSettingsSceneSample(
                elapsedMilliseconds: Int(((sampleStart - start) * 1_000).rounded()),
                completionElapsedMilliseconds: Int(
                    ((ProcessInfo.processInfo.systemUptime - start) * 1_000).rounded()
                ),
                windowFrame: windowFrame,
                settingsContentFrame: settingsContentFrame,
                outerScrollFrame: outerScrollFrame,
                sentinelFrame: sentinelFrame,
                settingsContentFullyContainedInWindow: settingsContentFrame.isFullyContained(
                    in: windowFrame,
                    tolerance: 1
                ),
                outerScrollFullyContainedInSettingsContent: outerScrollFrame.isFullyContained(
                    in: settingsContentFrame,
                    tolerance: 1
                ),
                sentinelFullyContainedInOuterScroll: sentinelFrame.isFullyContained(
                    in: outerScrollFrame,
                    tolerance: 1
                )
            )
            guard sample.settingsContentFullyContainedInWindow,
                  sample.outerScrollFullyContainedInSettingsContent else {
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
                  !baseline.settingsContentFrame.differs(
                      from: sample.settingsContentFrame,
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
        settingsContentFrame: HostedGeometryFrame,
        context: String
    ) throws -> HostedGeometryFrame {
        let candidates = (0..<app.windows.count)
            .map { HostedGeometryFrame(app.windows.element(boundBy: $0).frame) }
            .filter {
                $0.isFiniteAndNonempty
                    && settingsContentFrame.isFullyContained(in: $0, tolerance: 1)
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
                schemaVersion: 1,
                scenario: "every-sidebar-page-bottom-\(request.contentSizeArgument)",
                fixtureId: "tab-overview",
                requestedContentSize: request.requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpace: "xcui-screen",
                minimumSampleIntervalMilliseconds: 100,
                samplingDeadlineMilliseconds: 5_000,
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

    private func capturePageBottomCheckpoint(
        app: XCUIApplication,
        section: String,
        generation: Int,
        markerIdentifier: String,
        outerScrollIdentifier: String,
        sentinelIdentifier: String
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
        let preActionSamples = try capturePageBottomSamples(
            outerPageScroll: outerPageScroll,
            bottomSentinel: bottomSentinel,
            detailRegion: detailRegion,
            context: "\(section)-pre"
        )
        let didIssueScroll: Bool
        let postActionSamples: [HostedPageBottomSample]
        if preActionSamples.allSatisfy({
            $0.sentinelFullyContainedInOuterScroll
                && $0.sentinelFullyContainedInDetailRegion
        }) {
            didIssueScroll = false
            postActionSamples = preActionSamples
        } else {
            outerPageScroll.scroll(byDeltaX: 0, deltaY: -10_000)
            didIssueScroll = true
            postActionSamples = try capturePageBottomSamples(
                outerPageScroll: outerPageScroll,
                bottomSentinel: bottomSentinel,
                detailRegion: detailRegion,
                context: "\(section)-post"
            )
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
                effectProven: true
            )
            : nil
        return HostedPageBottomCheckpoint(
            section: section,
            surfaceGeneration: generation,
            quiescenceMarkerIdentifier: markerIdentifier,
            outerScrollIdentifier: outerScrollIdentifier,
            sentinelIdentifier: sentinelIdentifier,
            preActionSamples: preActionSamples,
            scrollAction: scrollAction,
            postActionSamples: postActionSamples
        )
    }

    private func capturePageBottomSamples(
        outerPageScroll: XCUIElement,
        bottomSentinel: XCUIElement,
        detailRegion: XCUIElement,
        context: String
    ) throws -> [HostedPageBottomSample] {
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
        try validatePageBottomCadence(samples, context: context)
        try validateStablePageBottomSamples(samples, context: context)
        return samples
    }

    private func validatePageBottomCadence(
        _ samples: [HostedPageBottomSample],
        context: String
    ) throws {
        guard samples.count == 3 else {
            throw HostedPageBottomTraceError.invalidCadence(context)
        }
        guard samples[0].elapsedMilliseconds >= 0,
              samples[0].elapsedMilliseconds <= 25,
              let finalElapsed = samples.last?.elapsedMilliseconds,
              finalElapsed <= 5_000 else {
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
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-settled-geometry.json"
        attachment.lifetime = .keepAlways
        add(attachment)
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
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        let attachment = XCTAttachment(
            data: try encoder.encode(trace),
            uniformTypeIdentifier: "public.json"
        )
        attachment.name = "neondiff-hosted-settings-scene.json"
        attachment.lifetime = .keepAlways
        add(attachment)
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

private struct HostedPageScrollAction: Codable, Equatable {
    let controlIdentifier: String
    let deltaX: Double
    let deltaY: Double
    let attemptCount: Int
    let result: String
    let effectProven: Bool
}

private struct HostedPageBottomCheckpoint: Codable, Equatable {
    let section: String
    let surfaceGeneration: Int
    let quiescenceMarkerIdentifier: String
    let outerScrollIdentifier: String
    let sentinelIdentifier: String
    let preActionSamples: [HostedPageBottomSample]
    let scrollAction: HostedPageScrollAction?
    let postActionSamples: [HostedPageBottomSample]
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
    let settingsContentFrame: HostedGeometryFrame
    let outerScrollFrame: HostedGeometryFrame
    let sentinelFrame: HostedGeometryFrame
    let settingsContentFullyContainedInWindow: Bool
    let outerScrollFullyContainedInSettingsContent: Bool
    let sentinelFullyContainedInOuterScroll: Bool
}

private struct HostedSettingsSceneScenario: Codable {
    let textSizeMode: String
    let launchTextSizeArgument: String?
    let observedSettingsTextSize: String
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
    let coordinateSpace: String
    let samples: [HostedSettingsAppKitSample]
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

private enum HostedPageBottomTraceError: LocalizedError {
    case priorValidationFailure
    case missingElement(String)
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
    case invalidAppKitGeometry(String)
    case unstableAppKitGeometry(String)
    case unexpectedWindowCount(before: Int, after: Int)
    case invalidFrame(String)
    case unexpectedContentSize(
        requested: HostedContentSize,
        observed: HostedGeometryFrame
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
        case .invalidAppKitGeometry(let context):
            "Hosted Settings AppKit geometry is invalid or not contained: \(context)"
        case .unstableAppKitGeometry(let context):
            "Hosted Settings AppKit geometry drift exceeded one point: \(context)"
        case let .unexpectedWindowCount(before, after):
            "Hosted Settings command did not create exactly one window: "
                + "before=\(before) after=\(after)"
        case .invalidFrame(let context):
            "Invalid hosted Settings frame: \(context)"
        case let .unexpectedContentSize(requested, observed):
            "Hosted Settings content size does not match the request: "
                + "requested=\(requested.width)x\(requested.height) observed=\(observed)"
        case .missingContainingWindow(let context):
            "Hosted Settings content has no containing app window: \(context)"
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
