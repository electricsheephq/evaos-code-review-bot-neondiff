import Foundation
import Testing
import NeonDiffDesktopCore
@testable import NeonDiffDesktopEvaluationSupport

@Suite("Desktop settled geometry trace")
struct DesktopSettledGeometryTraceTests {
    @Test func acceptsStrictSameProcessOverviewReposOverviewTrace() throws {
        let trace = makeTrace()

        #expect(try DesktopSettledGeometryValidator.validate(trace) == .stable)
        #expect(try DesktopSettledGeometryTrace.decode(data: JSONEncoder().encode(trace)) == trace)
        #expect(DesktopSettledGeometryCheckResult.stable.ok)
    }

    @Test func bindsEveryRegionToOneUniquePublicAccessibilityIdentifier() {
        let identifiers = DesktopSettledGeometryRegion.allCases.map(\.accessibilityIdentifier)

        #expect(Set(identifiers).count == DesktopSettledGeometryRegion.allCases.count)
        #expect(DesktopSettledGeometryRegion.chrome.accessibilityIdentifier == "neondiff-chrome")
        #expect(DesktopSettledGeometryRegion.overviewSentinel.accessibilityIdentifier == "neondiff-overview-start-dashboard")
        #expect(DesktopSettledGeometryRegion.reposBottomSentinel.accessibilityIdentifier == "neondiff-repos-boundary")
    }

    @Test func requiresExactTwoPressNavigationLedger() {
        var actions = makeNavigationActions()
        actions[0] = .init(
            index: 0,
            fromSection: .overview,
            toSection: .repos,
            controlIdentifier: "neondiff-sidebar-section-repos",
            actionAdvertised: true,
            attemptCount: 2,
            performResult: .success
        )
        #expect(throws: DesktopSettledGeometryValidationError.invalidNavigationAction(index: 0)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(navigationActions: actions))
        }

        actions = Array(makeNavigationActions().prefix(1))
        #expect(throws: DesktopSettledGeometryValidationError.invalidNavigationAction(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(navigationActions: actions))
        }
    }

    @Test func normalizesAppKitContentFrameIntoAXGlobalTopLeftCoordinates() throws {
        let normalized = try DesktopSettledGeometryCoordinateNormalizer.normalizeContentFrame(
            appKitWindowFrame: .init(x: 100, y: 50, width: 1040, height: 710),
            appKitContentFrame: .init(x: 100, y: 50, width: 1040, height: 680),
            axWindowFrame: .init(x: 100, y: 200, width: 1040, height: 710),
            tolerancePoints: 1
        )
        #expect(normalized == .init(x: 100, y: 230, width: 1040, height: 680))

        #expect(throws: DesktopSettledGeometryCoordinateNormalizationError.windowSizeMismatch) {
            try DesktopSettledGeometryCoordinateNormalizer.normalizeContentFrame(
                appKitWindowFrame: windowFrame,
                appKitContentFrame: contentFrame,
                axWindowFrame: .init(x: 0, y: 0, width: 1000, height: 710),
                tolerancePoints: 1
            )
        }
        #expect(throws: DesktopSettledGeometryCoordinateNormalizationError.contentOutsideWindow) {
            try DesktopSettledGeometryCoordinateNormalizer.normalizeContentFrame(
                appKitWindowFrame: windowFrame,
                appKitContentFrame: .init(x: 0, y: -40, width: 1040, height: 680),
                axWindowFrame: windowFrame,
                tolerancePoints: 1
            )
        }
        #expect(throws: DesktopSettledGeometryCoordinateNormalizationError.invalidFrame) {
            try DesktopSettledGeometryCoordinateNormalizer.normalizeContentFrame(
                appKitWindowFrame: .init(
                    x: Double.greatestFiniteMagnitude,
                    y: 0,
                    width: Double.greatestFiniteMagnitude,
                    height: 710
                ),
                appKitContentFrame: contentFrame,
                axWindowFrame: windowFrame,
                tolerancePoints: 1
            )
        }
    }

    @Test func decoderRejectsUnknownFieldsAtEveryLevel() throws {
        let encoded = try JSONEncoder().encode(makeTrace())
        var root = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        root["unexpected"] = true
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryTrace.decode(data: JSONSerialization.data(withJSONObject: root))
        }

        root = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        var actions = try #require(root["navigationActions"] as? [[String: Any]])
        actions[0]["unexpected"] = true
        root["navigationActions"] = actions
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryTrace.decode(data: JSONSerialization.data(withJSONObject: root))
        }

        root = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        var checkpoints = try #require(root["checkpoints"] as? [[String: Any]])
        var samples = try #require(checkpoints[1]["samples"] as? [[String: Any]])
        var regions = try #require(samples[0]["regions"] as? [[String: Any]])
        regions[0]["unexpected"] = true
        samples[0]["regions"] = regions
        checkpoints[1]["samples"] = samples
        root["checkpoints"] = checkpoints
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryTrace.decode(data: JSONSerialization.data(withJSONObject: root))
        }
    }

    @Test func requiresExactScenarioIdentityAndSequence() {
        #expect(makeTrace().coordinateSpace == .globalTopLeft)
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryValidator.validate(makeTrace(schemaVersion: 2))
        }
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryValidator.validate(makeTrace(fixtureId: "tab-repos"))
        }
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryValidator.validate(makeTrace(pid: 0))
        }
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryValidator.validate(makeTrace(windowNumber: 0))
        }
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryValidator.validate(makeTrace(
                requestedContentSize: .init(width: 1280, height: 800)
            ))
        }

        var checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .providers)
        #expect(throws: DesktopSettledGeometryValidationError.invalidSequence(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, surfaceGeneration: 0)
        #expect(throws: DesktopSettledGeometryValidationError.invalidSequence(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        let encoded = try? JSONEncoder().encode(makeTrace())
        var root = encoded.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
        root?["coordinateSpace"] = "global-bottom-left"
        #expect(throws: DesktopSettledGeometryValidationError.invalidContract) {
            try DesktopSettledGeometryTrace.decode(
                data: try #require(root).withJSONData()
            )
        }
    }

    @Test func requiresExplicitQuiescenceAndThreeHundredMillisecondSamples() {
        var checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, quiescent: false)
        #expect(throws: DesktopSettledGeometryValidationError.notQuiescent(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(
            index: 1,
            section: .repos,
            samples: Array(samples(section: .repos).prefix(2))
        )
        #expect(throws: DesktopSettledGeometryValidationError.insufficientSamples(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var wrongCadence = samples(section: .repos)
        wrongCadence[2] = sample(section: .repos, elapsedMilliseconds: 350)
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: wrongCadence)
        #expect(throws: DesktopSettledGeometryValidationError.invalidCadence(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var overflowingCadence = samples(section: .repos)
        overflowingCadence[2] = overflowingCadence[2].withElapsedMilliseconds(Int.min)
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: overflowingCadence)
        #expect(throws: DesktopSettledGeometryValidationError.invalidCadence(index: 1)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }
    }

    @Test func checkerInputRequiresAnAbsoluteCanonicalArtifactPath() throws {
        let accepted = try DesktopSettledGeometryInputPath.validate(
            rawArgument: "/tmp/neondiff-focused/settled-geometry.json"
        )
        #expect(accepted.path == "/tmp/neondiff-focused/settled-geometry.json")

        #expect(throws: DesktopSettledGeometryInputPathError.unsafeInput) {
            try DesktopSettledGeometryInputPath.validate(rawArgument: "settled-geometry.json")
        }
        #expect(throws: DesktopSettledGeometryInputPathError.unsafeInput) {
            try DesktopSettledGeometryInputPath.validate(rawArgument: "/tmp/not-the-contract.json")
        }
    }

    @Test func requiresExactGenericAndReposBindings() {
        var missingChrome = samples(section: .overview)
        missingChrome[0] = missingChrome[0].removing(.chrome)
        var checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: missingChrome)
        #expect(throws: DesktopSettledGeometryValidationError.missingRegion(
            checkpoint: 0,
            sample: 0,
            region: .chrome
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var duplicateSentinel = samples(section: .repos)
        duplicateSentinel[0] = duplicateSentinel[0].adding(.reposBottomSentinel, frame: sentinelFrame)
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: duplicateSentinel)
        #expect(throws: DesktopSettledGeometryValidationError.duplicateRegion(
            checkpoint: 1,
            sample: 0,
            region: .reposBottomSentinel
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var extraReposBinding = samples(section: .overview)
        extraReposBinding[0] = extraReposBinding[0].adding(.reposOuterScroll, frame: reposScrollFrame)
        checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: extraReposBinding)
        #expect(throws: DesktopSettledGeometryValidationError.unexpectedRegion(
            checkpoint: 0,
            sample: 0,
            region: .reposOuterScroll
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }
    }

    @Test func rejectsInvalidContainmentOverlapAndReposAncestryGeometry() {
        let overflowingCheckpoints = makeCheckpoints().map { checkpoint in
            DesktopSettledGeometryCheckpoint(
                index: checkpoint.index,
                section: checkpoint.section,
                surfaceGeneration: checkpoint.surfaceGeneration,
                ready: checkpoint.ready,
                quiescent: checkpoint.quiescent,
                acquisitionMilliseconds: checkpoint.acquisitionMilliseconds,
                samples: checkpoint.samples.map(\.withOverflowingHorizontalEdges)
            )
        }
        #expect(throws: DesktopSettledGeometryValidationError.nonfiniteFrame(
            checkpoint: 0,
            sample: 0
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: overflowingCheckpoints))
        }

        var wrongContentSize = samples(section: .overview)
        wrongContentSize[0] = sample(
            section: .overview,
            content: .init(x: 0, y: 0, width: 1038.9, height: 680)
        )
        var checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: wrongContentSize)
        #expect(throws: DesktopSettledGeometryValidationError.contentSizeMismatch(
            checkpoint: 0,
            sample: 0
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var outsideWindow = samples(section: .overview)
        outsideWindow[0] = sample(section: .overview, chrome: .init(x: -10, y: 0, width: 1040, height: 82))
        checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: outsideWindow)
        #expect(throws: DesktopSettledGeometryValidationError.regionOutsideWindow(
            checkpoint: 0,
            sample: 0,
            region: .chrome
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var overlapping = samples(section: .overview)
        overlapping[0] = sample(
            section: .overview,
            sidebar: .init(x: 0, y: 82, width: 300, height: 598),
            detail: .init(x: 250, y: 82, width: 790, height: 598)
        )
        checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: overlapping)
        #expect(throws: DesktopSettledGeometryValidationError.sidebarDetailOverlap(checkpoint: 0, sample: 0)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var wrongScroll = samples(section: .repos)
        wrongScroll[0] = sample(
            section: .repos,
            reposScroll: .init(x: 100, y: 100, width: 900, height: 500)
        )
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: wrongScroll)
        #expect(throws: DesktopSettledGeometryValidationError.reposScrollOutsideDetail(checkpoint: 1, sample: 0)) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var wrongSentinel = samples(section: .repos)
        wrongSentinel[0] = sample(
            section: .repos,
            sentinel: .init(x: 100, y: 900, width: 120, height: 16)
        )
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: wrongSentinel)
        #expect(throws: DesktopSettledGeometryValidationError.reposSentinelOutsideScrollWidth(
            checkpoint: 1,
            sample: 0
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }
    }

    @Test func rejectsWithinCheckpointAndCrossTransitionDriftAboveOnePoint() {
        var drifting = samples(section: .overview)
        drifting[2] = sample(
            section: .overview,
            elapsedMilliseconds: 205,
            chrome: .init(x: 0, y: 1.01, width: 1040, height: 82)
        )
        var checkpoints = makeCheckpoints()
        checkpoints[0] = checkpoint(index: 0, section: .overview, samples: drifting)
        #expect(throws: DesktopSettledGeometryValidationError.unstableCheckpoint(
            checkpoint: 0,
            region: .chrome
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        let shifted = samples(section: .repos).map {
            $0.replacing(.sidebar, frame: .init(x: 0, y: 82, width: 231.01, height: 598))
        }
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: shifted)
        #expect(throws: DesktopSettledGeometryValidationError.unstableTransition(
            checkpoint: 1,
            region: .sidebar
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        var transient = samples(section: .repos)
        transient[0] = transient[0].replacing(
            .sidebar,
            frame: .init(x: 0, y: 82, width: 231.01, height: 598)
        )
        transient[1] = transient[1].replacing(
            .sidebar,
            frame: .init(x: 0, y: 82, width: 230.01, height: 598)
        )
        transient[2] = transient[2].replacing(
            .sidebar,
            frame: .init(x: 0, y: 82, width: 230.01, height: 598)
        )
        checkpoints = makeCheckpoints()
        checkpoints[1] = checkpoint(index: 1, section: .repos, samples: transient)
        #expect(throws: DesktopSettledGeometryValidationError.unstableTransition(
            checkpoint: 1,
            region: .sidebar
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }

        let shiftedReturn = samples(section: .overview).map {
            $0.replacing(
                .overviewSentinel,
                frame: .init(x: overviewSentinelFrame.x, y: overviewSentinelFrame.y + 1.01, width: overviewSentinelFrame.width, height: overviewSentinelFrame.height)
            )
        }
        checkpoints = makeCheckpoints()
        checkpoints[2] = checkpoint(index: 2, section: .overview, samples: shiftedReturn)
        #expect(throws: DesktopSettledGeometryValidationError.unstableTransition(
            checkpoint: 2,
            region: .overviewSentinel
        )) {
            try DesktopSettledGeometryValidator.validate(makeTrace(checkpoints: checkpoints))
        }
    }

    @Test func scenarioCoordinatorIsStrictFailClosedAndSingleUse() throws {
        var coordinator = DesktopSettledGeometryScenarioCoordinator(scenario: .overviewReposOverview)
        #expect(coordinator.expectedSection == .overview)
        #expect(try coordinator.recordQuiescent(section: .overview) == .navigate(.repos))
        #expect(try coordinator.recordQuiescent(section: .repos) == .navigate(.overview))
        #expect(try coordinator.recordQuiescent(section: .overview) == .complete)
        #expect(coordinator.isComplete)
        #expect(throws: DesktopSettledGeometryScenarioError.alreadyComplete) {
            try coordinator.recordQuiescent(section: .overview)
        }

        var wrong = DesktopSettledGeometryScenarioCoordinator(scenario: .overviewReposOverview)
        #expect(throws: DesktopSettledGeometryScenarioError.unexpectedSection(
            expected: .overview,
            actual: .repos
        )) {
            try wrong.recordQuiescent(section: .repos)
        }
    }

    @Test func checkerClassifiesContractSequenceAndGeometryFailures() {
        #expect(DesktopSettledGeometryCheckResult.failure(.invalidContract).category == .contract)
        #expect(DesktopSettledGeometryCheckResult.failure(.invalidSequence(index: 1)).reasonCode == "invalid-sequence")
        #expect(DesktopSettledGeometryCheckResult.failure(.unstableTransition(
            checkpoint: 2,
            region: .detail
        )).category == .geometry)
        #expect(DesktopSettledGeometryCheckResult.inputFailure("unsafe-input").category == .input)
    }
}

private let windowFrame = DesktopSettledGeometryFrame(x: 0, y: 0, width: 1040, height: 710)
private let contentFrame = DesktopSettledGeometryFrame(x: 0, y: 0, width: 1040, height: 680)
private let chromeFrame = DesktopSettledGeometryFrame(x: 0, y: 0, width: 1040, height: 82)
private let sidebarFrame = DesktopSettledGeometryFrame(x: 0, y: 82, width: 230, height: 598)
private let detailFrame = DesktopSettledGeometryFrame(x: 231, y: 82, width: 809, height: 598)
private let overviewSentinelFrame = DesktopSettledGeometryFrame(x: 255, y: 120, width: 180, height: 30)
private let reposScrollFrame = DesktopSettledGeometryFrame(x: 255, y: 120, width: 761, height: 520)
private let sentinelFrame = DesktopSettledGeometryFrame(x: 279, y: 770, width: 713, height: 16)

private func makeTrace(
    schemaVersion: Int = 1,
    fixtureId: String = "tab-overview",
    pid: Int32 = 42,
    windowNumber: Int = 7,
    requestedContentSize: DesktopEvaluationContentSize = .init(width: 1040, height: 680),
    navigationActions: [DesktopSettledGeometryNavigationAction] = makeNavigationActions(),
    checkpoints: [DesktopSettledGeometryCheckpoint] = makeCheckpoints()
) -> DesktopSettledGeometryTrace {
    .init(
        schemaVersion: schemaVersion,
        scenario: .overviewReposOverview,
        fixtureId: fixtureId,
        pid: pid,
        windowNumber: windowNumber,
        coordinateSpace: .globalTopLeft,
        requestedContentSize: requestedContentSize,
        tolerancePoints: 1,
        sampleIntervalMilliseconds: 100,
        navigationActions: navigationActions,
        checkpoints: checkpoints
    )
}

private func makeNavigationActions() -> [DesktopSettledGeometryNavigationAction] {
    [
        .init(
            index: 0,
            fromSection: .overview,
            toSection: .repos,
            controlIdentifier: "neondiff-sidebar-section-repos",
            actionAdvertised: true,
            attemptCount: 1,
            performResult: .success
        ),
        .init(
            index: 1,
            fromSection: .repos,
            toSection: .overview,
            controlIdentifier: "neondiff-sidebar-section-overview",
            actionAdvertised: true,
            attemptCount: 1,
            performResult: .success
        )
    ]
}

private extension Dictionary where Key == String, Value == Any {
    func withJSONData() throws -> Data {
        try JSONSerialization.data(withJSONObject: self)
    }
}

private func makeCheckpoints() -> [DesktopSettledGeometryCheckpoint] {
    [
        checkpoint(index: 0, section: .overview),
        checkpoint(index: 1, section: .repos),
        checkpoint(index: 2, section: .overview)
    ]
}

private func checkpoint(
    index: Int,
    section: DesktopSection,
    surfaceGeneration: Int? = nil,
    quiescent: Bool = true,
    samples providedSamples: [DesktopSettledGeometrySample]? = nil
) -> DesktopSettledGeometryCheckpoint {
    .init(
        index: index,
        section: section,
        surfaceGeneration: surfaceGeneration ?? index,
        ready: true,
        quiescent: quiescent,
        acquisitionMilliseconds: 250,
        samples: providedSamples ?? samples(section: section)
    )
}

private func samples(section: DesktopSection) -> [DesktopSettledGeometrySample] {
    [0, 100, 205].map { sample(section: section, elapsedMilliseconds: $0) }
}

private func sample(
    section: DesktopSection,
    elapsedMilliseconds: Int = 0,
    content: DesktopSettledGeometryFrame = contentFrame,
    chrome: DesktopSettledGeometryFrame = chromeFrame,
    sidebar: DesktopSettledGeometryFrame = sidebarFrame,
    detail: DesktopSettledGeometryFrame = detailFrame,
    reposScroll: DesktopSettledGeometryFrame = reposScrollFrame,
    sentinel: DesktopSettledGeometryFrame = sentinelFrame
) -> DesktopSettledGeometrySample {
    var regions: [DesktopSettledGeometryRegionFrame] = [
        .init(id: .chrome, frame: chrome),
        .init(id: .sidebar, frame: sidebar),
        .init(id: .detail, frame: detail)
    ]
    if section == .overview {
        regions.append(.init(id: .overviewSentinel, frame: overviewSentinelFrame))
    } else if section == .repos {
        regions.append(.init(id: .reposOuterScroll, frame: reposScroll))
        regions.append(.init(id: .reposBottomSentinel, frame: sentinel))
    }
    return .init(
        elapsedMilliseconds: elapsedMilliseconds,
        windowFrame: windowFrame,
        contentFrame: content,
        regions: regions
    )
}

private extension DesktopSettledGeometrySample {
    var withOverflowingHorizontalEdges: Self {
        let origin = Double.greatestFiniteMagnitude
        func moved(_ frame: DesktopSettledGeometryFrame) -> DesktopSettledGeometryFrame {
            .init(x: origin, y: frame.y, width: frame.width, height: frame.height)
        }
        return .init(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: .init(
                x: origin,
                y: windowFrame.y,
                width: Double.greatestFiniteMagnitude,
                height: windowFrame.height
            ),
            contentFrame: moved(contentFrame),
            regions: regions.map { .init(id: $0.id, frame: moved($0.frame)) }
        )
    }

    func withElapsedMilliseconds(_ elapsedMilliseconds: Int) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            regions: regions
        )
    }

    func removing(_ id: DesktopSettledGeometryRegion) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            regions: regions.filter { $0.id != id }
        )
    }

    func adding(_ id: DesktopSettledGeometryRegion, frame: DesktopSettledGeometryFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            regions: regions + [.init(id: id, frame: frame)]
        )
    }

    func replacing(_ id: DesktopSettledGeometryRegion, frame: DesktopSettledGeometryFrame) -> Self {
        .init(
            elapsedMilliseconds: elapsedMilliseconds,
            windowFrame: windowFrame,
            contentFrame: contentFrame,
            regions: regions.map { $0.id == id ? .init(id: id, frame: frame) : $0 }
        )
    }
}
