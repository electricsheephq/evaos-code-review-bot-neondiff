import XCTest

final class NeonDiffDesktopUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
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
        let route = [
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
        try attach(
            HostedPageBottomReachabilityTrace(
                schemaVersion: 1,
                scenario: "every-sidebar-page-bottom-at-minimum-size",
                fixtureId: "tab-overview",
                requestedContentSize: requestedContentSize,
                textSizeMode: "runner-default-no-test-override",
                coordinateSpace: "xcui-screen",
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                navigationActions: navigationActions,
                checkpoints: checkpoints,
                proofBoundary: "hosted-outer-page-bottom-reachability-only-inner-scroll-exhaustion-excluded"
            )
        )
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
        XCTAssertTrue(
            outerPageScroll.waitForExistence(timeout: 2),
            "Missing outer page scroll \(outerScrollIdentifier)"
        )
        XCTAssertTrue(
            bottomSentinel.waitForExistence(timeout: 2),
            "Missing page-bottom sentinel \(sentinelIdentifier)"
        )
        XCTAssertTrue(detailRegion.waitForExistence(timeout: 2), "Missing detail region")
        XCTAssertFalse(bottomSentinel.isHittable, "Page-bottom sentinel must remain non-hittable")

        let preActionSamples = capturePageBottomSamples(
            outerPageScroll: outerPageScroll,
            bottomSentinel: bottomSentinel,
            detailRegion: detailRegion,
            context: "\(section)-pre"
        )
        let preActionSample = try XCTUnwrap(preActionSamples.last)
        let scrollAction: HostedPageScrollAction?
        let postActionSamples: [HostedPageBottomSample]
        if preActionSample.sentinelFullyContainedInOuterScroll
            && preActionSample.sentinelFullyContainedInDetailRegion {
            scrollAction = nil
            postActionSamples = preActionSamples
        } else {
            outerPageScroll.scroll(byDeltaX: 0, deltaY: -10_000)
            scrollAction = HostedPageScrollAction(
                controlIdentifier: outerScrollIdentifier,
                deltaX: 0,
                deltaY: -10_000,
                attemptCount: 1,
                result: "success"
            )
            postActionSamples = capturePageBottomSamples(
                outerPageScroll: outerPageScroll,
                bottomSentinel: bottomSentinel,
                detailRegion: detailRegion,
                context: "\(section)-post"
            )
        }

        let postActionSample = try XCTUnwrap(postActionSamples.last)
        assertFullyContained(
            postActionSample.sentinelFrame,
            in: postActionSample.outerScrollFrame,
            context: "\(section) outer scroll"
        )
        assertFullyContained(
            postActionSample.sentinelFrame,
            in: postActionSample.detailRegionFrame,
            context: "\(section) detail region"
        )
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
    ) -> [HostedPageBottomSample] {
        let start = ProcessInfo.processInfo.systemUptime
        var samples: [HostedPageBottomSample] = []
        for index in 0..<3 {
            if index > 0 {
                RunLoop.current.run(until: Date().addingTimeInterval(0.1))
            }
            let outerScrollFrame = HostedGeometryFrame(outerPageScroll.frame)
            let sentinelFrame = HostedGeometryFrame(bottomSentinel.frame)
            let detailRegionFrame = HostedGeometryFrame(detailRegion.frame)
            XCTAssertTrue(outerScrollFrame.isFiniteAndNonempty, "Invalid outer scroll frame for \(context)")
            XCTAssertTrue(sentinelFrame.isFiniteAndNonempty, "Invalid sentinel frame for \(context)")
            XCTAssertTrue(detailRegionFrame.isFiniteAndNonempty, "Invalid detail frame for \(context)")
            samples.append(
                HostedPageBottomSample(
                    elapsedMilliseconds: Int(
                        ((ProcessInfo.processInfo.systemUptime - start) * 1_000).rounded()
                    ),
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
        assertValidPageBottomCadence(samples, context: context)
        assertStablePageBottomSamples(samples, context: context)
        return samples
    }

    private func assertValidPageBottomCadence(
        _ samples: [HostedPageBottomSample],
        context: String
    ) {
        XCTAssertEqual(samples.count, 3, "Wrong page-bottom sample count for \(context)")
        guard samples.count == 3 else { return }
        XCTAssertGreaterThanOrEqual(samples[0].elapsedMilliseconds, 0)
        XCTAssertLessThanOrEqual(samples[0].elapsedMilliseconds, 25)
        for (lhs, rhs) in zip(samples, samples.dropFirst()) {
            let interval = rhs.elapsedMilliseconds - lhs.elapsedMilliseconds
            XCTAssertGreaterThanOrEqual(interval, 90, "Short sample interval for \(context)")
            XCTAssertLessThanOrEqual(interval, 175, "Long sample interval for \(context)")
        }
    }

    private func assertStablePageBottomSamples(
        _ samples: [HostedPageBottomSample],
        context: String
    ) {
        guard let baseline = samples.first else {
            XCTFail("Missing page-bottom samples for \(context)")
            return
        }
        for sample in samples.dropFirst() {
            XCTAssertFalse(
                baseline.outerScrollFrame.differs(from: sample.outerScrollFrame, byMoreThan: 1),
                "Outer scroll drift exceeded one point for \(context)"
            )
            XCTAssertFalse(
                baseline.sentinelFrame.differs(from: sample.sentinelFrame, byMoreThan: 1),
                "Page-bottom sentinel drift exceeded one point for \(context)"
            )
            XCTAssertFalse(
                baseline.detailRegionFrame.differs(from: sample.detailRegionFrame, byMoreThan: 1),
                "Detail region drift exceeded one point for \(context)"
            )
        }
    }

    private func assertFullyContained(
        _ frame: HostedGeometryFrame,
        in container: HostedGeometryFrame,
        context: String
    ) {
        XCTAssertTrue(
            frame.isFullyContained(in: container, tolerance: 1),
            "Page-bottom sentinel is not fully contained in \(context): "
                + "sentinel=\(frame) container=\(container)"
        )
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
    let sampleIntervalMilliseconds: Int
    let tolerancePoints: Double
    let navigationActions: [HostedNavigationAction]
    let checkpoints: [HostedPageBottomCheckpoint]
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
