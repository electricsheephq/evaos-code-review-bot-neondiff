import XCTest

final class NeonDiffDesktopUITests: XCTestCase {
    override func setUpWithError() throws {
        continueAfterFailure = false
    }

    func testStrictFixtureSettlesAcrossOverviewReposOverview() throws {
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
            markerIdentifier: "neondiff.evaluation.surface.overview.0.quiescent"
        )
        let reposAction = try tapNavigation(
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
            markerIdentifier: "neondiff.evaluation.surface.repos.1.quiescent"
        )
        let overviewAction = try tapNavigation(
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
            markerIdentifier: "neondiff.evaluation.surface.overview.2.quiescent"
        )

        let checkpoints = [overview0, repos1, overview2]
        assertStableAcrossTransitions(checkpoints)
        try attach(
            HostedSettledGeometryTrace(
                schemaVersion: 1,
                scenario: "overview-repos-overview",
                fixtureId: "tab-overview",
                requestedContentSize: HostedContentSize(width: 1040, height: 680),
                sampleIntervalMilliseconds: 100,
                tolerancePoints: 1,
                navigationActions: [reposAction, overviewAction],
                checkpoints: checkpoints,
                proofBoundary: "hosted-overview-repos-overview-geometry-only"
            )
        )
    }

    private func captureCheckpoint(
        app: XCUIApplication,
        section: String,
        generation: Int,
        markerIdentifier: String
    ) throws -> HostedGeometryCheckpoint {
        let marker = app.descendants(matching: .any)[markerIdentifier]
        XCTAssertTrue(
            marker.waitForExistence(timeout: 5),
            "Missing app-authored quiescence marker \(markerIdentifier)"
        )

        let started = ProcessInfo.processInfo.systemUptime
        var samples: [HostedGeometrySample] = []
        for index in 0..<3 {
            let deadline = started + Double(index) * 0.1
            let remaining = deadline - ProcessInfo.processInfo.systemUptime
            if remaining > 0 {
                Thread.sleep(forTimeInterval: remaining)
            }
            let elapsed = Int(
                ((ProcessInfo.processInfo.systemUptime - started) * 1_000).rounded()
            )
            samples.append(try sample(app: app, elapsedMilliseconds: elapsed))
        }
        assertValidCadence(samples)
        assertStableSamples(samples, context: "\(section)-\(generation)")
        return HostedGeometryCheckpoint(
            section: section,
            surfaceGeneration: generation,
            quiescenceMarkerIdentifier: markerIdentifier,
            samples: samples
        )
    }

    private func sample(
        app: XCUIApplication,
        elapsedMilliseconds: Int
    ) throws -> HostedGeometrySample {
        let window = app.windows.firstMatch
        XCTAssertTrue(window.exists)
        let regionIdentifiers = [
            "neondiff-chrome",
            "neondiff-sidebar",
            "neondiff-detail"
        ]
        var regions: [HostedGeometryRegionFrame] = []
        for identifier in regionIdentifiers {
            let element = app.descendants(matching: .any)[identifier]
            XCTAssertTrue(element.waitForExistence(timeout: 2), "Missing region \(identifier)")
            let frame = HostedGeometryFrame(element.frame)
            XCTAssertTrue(frame.isFiniteAndNonempty, "Invalid frame for \(identifier)")
            regions.append(.init(identifier: identifier, frame: frame))
        }
        let windowFrame = HostedGeometryFrame(window.frame)
        XCTAssertTrue(windowFrame.isFiniteAndNonempty, "Invalid hosted window frame")
        return HostedGeometrySample(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: windowFrame,
            regions: regions
        )
    }

    private func tapNavigation(
        app: XCUIApplication,
        index: Int,
        fromSection: String,
        toSection: String,
        identifier: String
    ) throws -> HostedNavigationAction {
        let button = app.buttons[identifier]
        XCTAssertTrue(button.waitForExistence(timeout: 2), "Missing navigation button \(identifier)")
        XCTAssertTrue(button.isHittable, "Navigation button is not hittable: \(identifier)")
        button.tap()
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
        let samples = checkpoints.flatMap(\.samples)
        guard let baseline = samples.first else {
            XCTFail("Missing hosted geometry checkpoints")
            return
        }
        for sample in samples.dropFirst() {
            XCTAssertFalse(
                baseline.windowFrame.differs(from: sample.windowFrame, byMoreThan: 1),
                "Window drift exceeded one point across transitions"
            )
            for region in baseline.regions {
                guard let candidate = sample.regions.first(where: {
                    $0.identifier == region.identifier
                }) else {
                    XCTFail("Missing \(region.identifier) across transitions")
                    continue
                }
                XCTAssertFalse(
                    region.frame.differs(from: candidate.frame, byMoreThan: 1),
                    "\(region.identifier) drift exceeded one point across transitions"
                )
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
}

private struct HostedContentSize: Codable {
    let width: Int
    let height: Int
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
}

private struct HostedGeometryRegionFrame: Codable, Equatable {
    let identifier: String
    let frame: HostedGeometryFrame
}

private struct HostedGeometrySample: Codable, Equatable {
    let elapsedMilliseconds: Int
    let windowFrame: HostedGeometryFrame
    let regions: [HostedGeometryRegionFrame]
}

private struct HostedGeometryCheckpoint: Codable, Equatable {
    let section: String
    let surfaceGeneration: Int
    let quiescenceMarkerIdentifier: String
    let samples: [HostedGeometrySample]
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
    let sampleIntervalMilliseconds: Int
    let tolerancePoints: Double
    let navigationActions: [HostedNavigationAction]
    let checkpoints: [HostedGeometryCheckpoint]
    let proofBoundary: String
}
