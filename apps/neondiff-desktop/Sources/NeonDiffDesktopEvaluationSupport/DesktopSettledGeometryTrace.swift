import Foundation
import NeonDiffDesktopCore

public enum DesktopSettledGeometryScenario: String, Codable, Equatable, Sendable {
    case overviewReposOverview = "overview-repos-overview"

    public var sections: [DesktopSection] {
        switch self {
        case .overviewReposOverview: [.overview, .repos, .overview]
        }
    }
}

public enum DesktopSettledGeometryCoordinateSpace: String, Codable, Equatable, Sendable {
    case globalTopLeft = "global-top-left"
}

public enum DesktopSettledGeometryRegion: String, Codable, CaseIterable, Equatable, Sendable {
    case chrome
    case sidebar
    case detail
    case overviewSentinel = "overview-sentinel"
    case reposOuterScroll = "repos-outer-scroll"
    case reposBottomSentinel = "repos-bottom-sentinel"

    public var accessibilityIdentifier: String {
        switch self {
        case .chrome: "neondiff-chrome"
        case .sidebar: "neondiff-sidebar"
        case .detail: "neondiff-detail"
        case .overviewSentinel: "neondiff-overview-start-dashboard"
        case .reposOuterScroll: "neondiff-repos-outer-scroll"
        case .reposBottomSentinel: "neondiff-repos-boundary"
        }
    }
}

public struct DesktopSettledGeometryFrame: Codable, Equatable, Sendable {
    public let x: Double
    public let y: Double
    public let width: Double
    public let height: Double

    public init(x: Double, y: Double, width: Double, height: Double) {
        self.x = x
        self.y = y
        self.width = width
        self.height = height
    }

    fileprivate var isFiniteAndNonempty: Bool {
        let maxX = x + width
        let maxY = y + height
        return [x, y, width, height, maxX, maxY].allSatisfy(\.isFinite)
            && width > 0
            && height > 0
    }

    fileprivate func contains(_ other: Self, tolerance: Double) -> Bool {
        other.x >= x - tolerance
            && other.y >= y - tolerance
            && other.x + other.width <= x + width + tolerance
            && other.y + other.height <= y + height + tolerance
    }

    fileprivate func containsHorizontally(_ other: Self, tolerance: Double) -> Bool {
        other.x >= x - tolerance
            && other.x + other.width <= x + width + tolerance
    }

    fileprivate func differs(from other: Self, byMoreThan tolerance: Double) -> Bool {
        abs(x - other.x) > tolerance
            || abs(y - other.y) > tolerance
            || abs(width - other.width) > tolerance
            || abs(height - other.height) > tolerance
    }

    fileprivate func overlaps(_ other: Self, byMoreThan tolerance: Double) -> Bool {
        let overlapWidth = min(x + width, other.x + other.width) - max(x, other.x)
        let overlapHeight = min(y + height, other.y + other.height) - max(y, other.y)
        return overlapWidth > tolerance && overlapHeight > tolerance
    }
}

public enum DesktopSettledGeometryCoordinateNormalizationError: Error, Equatable, Sendable {
    case invalidFrame
    case windowSizeMismatch
    case contentOutsideWindow
}

public enum DesktopSettledGeometryCoordinateNormalizer {
    public static func normalizeContentFrame(
        appKitWindowFrame: DesktopSettledGeometryFrame,
        appKitContentFrame: DesktopSettledGeometryFrame,
        axWindowFrame: DesktopSettledGeometryFrame,
        tolerancePoints: Double
    ) throws -> DesktopSettledGeometryFrame {
        guard tolerancePoints.isFinite,
              tolerancePoints >= 0,
              tolerancePoints <= 1,
              appKitWindowFrame.isFiniteAndNonempty,
              appKitContentFrame.isFiniteAndNonempty,
              axWindowFrame.isFiniteAndNonempty else {
            throw DesktopSettledGeometryCoordinateNormalizationError.invalidFrame
        }
        guard appKitWindowFrame.contains(appKitContentFrame, tolerance: tolerancePoints) else {
            throw DesktopSettledGeometryCoordinateNormalizationError.contentOutsideWindow
        }
        guard abs(appKitWindowFrame.width - axWindowFrame.width) <= tolerancePoints,
              abs(appKitWindowFrame.height - axWindowFrame.height) <= tolerancePoints else {
            throw DesktopSettledGeometryCoordinateNormalizationError.windowSizeMismatch
        }

        let horizontalInset = appKitContentFrame.x - appKitWindowFrame.x
        let topInset = (appKitWindowFrame.y + appKitWindowFrame.height)
            - (appKitContentFrame.y + appKitContentFrame.height)
        let normalized = DesktopSettledGeometryFrame(
            x: axWindowFrame.x + horizontalInset,
            y: axWindowFrame.y + topInset,
            width: appKitContentFrame.width,
            height: appKitContentFrame.height
        )
        guard normalized.isFiniteAndNonempty else {
            throw DesktopSettledGeometryCoordinateNormalizationError.invalidFrame
        }
        guard axWindowFrame.contains(normalized, tolerance: tolerancePoints) else {
            throw DesktopSettledGeometryCoordinateNormalizationError.contentOutsideWindow
        }
        return normalized
    }
}

public struct DesktopSettledGeometryRegionFrame: Codable, Equatable, Sendable {
    public let id: DesktopSettledGeometryRegion
    public let frame: DesktopSettledGeometryFrame

    public init(id: DesktopSettledGeometryRegion, frame: DesktopSettledGeometryFrame) {
        self.id = id
        self.frame = frame
    }
}

public struct DesktopSettledGeometrySample: Codable, Equatable, Sendable {
    public let elapsedMilliseconds: Int
    public let windowFrame: DesktopSettledGeometryFrame
    public let contentFrame: DesktopSettledGeometryFrame
    public let regions: [DesktopSettledGeometryRegionFrame]

    public init(
        elapsedMilliseconds: Int,
        windowFrame: DesktopSettledGeometryFrame,
        contentFrame: DesktopSettledGeometryFrame,
        regions: [DesktopSettledGeometryRegionFrame]
    ) {
        self.elapsedMilliseconds = elapsedMilliseconds
        self.windowFrame = windowFrame
        self.contentFrame = contentFrame
        self.regions = regions
    }
}

public struct DesktopSettledGeometryCheckpoint: Codable, Equatable, Sendable {
    public let index: Int
    public let section: DesktopSection
    public let ready: Bool
    public let quiescent: Bool
    public let acquisitionMilliseconds: Int
    public let samples: [DesktopSettledGeometrySample]

    public init(
        index: Int,
        section: DesktopSection,
        ready: Bool,
        quiescent: Bool,
        acquisitionMilliseconds: Int,
        samples: [DesktopSettledGeometrySample]
    ) {
        self.index = index
        self.section = section
        self.ready = ready
        self.quiescent = quiescent
        self.acquisitionMilliseconds = acquisitionMilliseconds
        self.samples = samples
    }
}

public enum DesktopSettledGeometryNavigationActionResult: String, Codable, Equatable, Sendable {
    case success
    case failure
}

public struct DesktopSettledGeometryNavigationAction: Codable, Equatable, Sendable {
    public let index: Int
    public let fromSection: DesktopSection
    public let toSection: DesktopSection
    public let controlIdentifier: String
    public let actionAdvertised: Bool
    public let attemptCount: Int
    public let performResult: DesktopSettledGeometryNavigationActionResult

    public init(
        index: Int,
        fromSection: DesktopSection,
        toSection: DesktopSection,
        controlIdentifier: String,
        actionAdvertised: Bool,
        attemptCount: Int,
        performResult: DesktopSettledGeometryNavigationActionResult
    ) {
        self.index = index
        self.fromSection = fromSection
        self.toSection = toSection
        self.controlIdentifier = controlIdentifier
        self.actionAdvertised = actionAdvertised
        self.attemptCount = attemptCount
        self.performResult = performResult
    }
}

public struct DesktopSettledGeometryTrace: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let scenario: DesktopSettledGeometryScenario
    public let fixtureId: String
    public let pid: Int32
    public let windowNumber: Int
    public let coordinateSpace: DesktopSettledGeometryCoordinateSpace
    public let requestedContentSize: DesktopEvaluationContentSize
    public let tolerancePoints: Double
    public let sampleIntervalMilliseconds: Int
    public let navigationActions: [DesktopSettledGeometryNavigationAction]
    public let checkpoints: [DesktopSettledGeometryCheckpoint]

    public init(
        schemaVersion: Int,
        scenario: DesktopSettledGeometryScenario,
        fixtureId: String,
        pid: Int32,
        windowNumber: Int,
        coordinateSpace: DesktopSettledGeometryCoordinateSpace,
        requestedContentSize: DesktopEvaluationContentSize,
        tolerancePoints: Double,
        sampleIntervalMilliseconds: Int,
        navigationActions: [DesktopSettledGeometryNavigationAction],
        checkpoints: [DesktopSettledGeometryCheckpoint]
    ) {
        self.schemaVersion = schemaVersion
        self.scenario = scenario
        self.fixtureId = fixtureId
        self.pid = pid
        self.windowNumber = windowNumber
        self.coordinateSpace = coordinateSpace
        self.requestedContentSize = requestedContentSize
        self.tolerancePoints = tolerancePoints
        self.sampleIntervalMilliseconds = sampleIntervalMilliseconds
        self.navigationActions = navigationActions
        self.checkpoints = checkpoints
    }

    public static func decode(data: Data) throws -> Self {
        guard data.count <= 256 * 1024 else {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        guard validateShape(object) else {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        let trace: Self
        do {
            trace = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        _ = try DesktopSettledGeometryValidator.validate(trace)
        return trace
    }

    private static func validateShape(_ object: Any) -> Bool {
        guard let root = object as? [String: Any],
              hasOnly(root, [
                  "schemaVersion", "scenario", "fixtureId", "pid", "windowNumber",
                  "coordinateSpace", "requestedContentSize", "tolerancePoints",
                  "sampleIntervalMilliseconds", "navigationActions", "checkpoints"
              ]),
              let size = root["requestedContentSize"] as? [String: Any],
              hasOnly(size, ["width", "height"]),
              let navigationActions = root["navigationActions"] as? [Any],
              let checkpoints = root["checkpoints"] as? [Any] else {
            return false
        }
        guard navigationActions.allSatisfy({ value in
            guard let action = value as? [String: Any] else { return false }
            return hasOnly(action, [
                "index", "fromSection", "toSection", "controlIdentifier",
                "actionAdvertised", "attemptCount", "performResult"
            ])
        }) else {
            return false
        }
        return checkpoints.allSatisfy { value in
            guard let checkpoint = value as? [String: Any],
                  hasOnly(checkpoint, [
                      "index", "section", "ready", "quiescent", "acquisitionMilliseconds", "samples"
                  ]),
                  let samples = checkpoint["samples"] as? [Any] else {
                return false
            }
            return samples.allSatisfy { value in
                guard let sample = value as? [String: Any],
                      hasOnly(sample, ["elapsedMilliseconds", "windowFrame", "contentFrame", "regions"]),
                      validateFrame(sample["windowFrame"]),
                      validateFrame(sample["contentFrame"]),
                      let regions = sample["regions"] as? [Any] else {
                    return false
                }
                return regions.allSatisfy { value in
                    guard let region = value as? [String: Any],
                          hasOnly(region, ["id", "frame"]),
                          validateFrame(region["frame"]) else {
                        return false
                    }
                    return true
                }
            }
        }
    }

    private static func validateFrame(_ value: Any?) -> Bool {
        guard let frame = value as? [String: Any] else { return false }
        return hasOnly(frame, ["x", "y", "width", "height"])
    }

    private static func hasOnly(_ object: [String: Any], _ keys: Set<String>) -> Bool {
        Set(object.keys) == keys
    }
}

public enum DesktopSettledGeometryInputPathError: Error, Equatable, Sendable {
    case unsafeInput
}

public enum DesktopSettledGeometryInputPath {
    public static func validate(rawArgument: String) throws -> URL {
        guard NSString(string: rawArgument).isAbsolutePath else {
            throw DesktopSettledGeometryInputPathError.unsafeInput
        }
        let input = URL(fileURLWithPath: rawArgument).standardizedFileURL
        guard input.isFileURL,
              input.path.hasPrefix("/"),
              input.lastPathComponent == "settled-geometry.json" else {
            throw DesktopSettledGeometryInputPathError.unsafeInput
        }
        return input
    }
}

public enum DesktopSettledGeometryValidationStatus: String, Codable, Equatable, Sendable {
    case stable
}

public enum DesktopSettledGeometryValidationError: Error, Equatable, Sendable {
    case invalidContract
    case invalidSequence(index: Int)
    case invalidNavigationAction(index: Int)
    case notQuiescent(index: Int)
    case insufficientSamples(index: Int)
    case invalidCadence(index: Int)
    case nonfiniteFrame(checkpoint: Int, sample: Int)
    case contentSizeMismatch(checkpoint: Int, sample: Int)
    case duplicateRegion(checkpoint: Int, sample: Int, region: DesktopSettledGeometryRegion)
    case missingRegion(checkpoint: Int, sample: Int, region: DesktopSettledGeometryRegion)
    case unexpectedRegion(checkpoint: Int, sample: Int, region: DesktopSettledGeometryRegion)
    case regionOutsideWindow(checkpoint: Int, sample: Int, region: DesktopSettledGeometryRegion)
    case sidebarDetailOverlap(checkpoint: Int, sample: Int)
    case reposScrollOutsideDetail(checkpoint: Int, sample: Int)
    case reposSentinelOutsideScrollWidth(checkpoint: Int, sample: Int)
    case unstableCheckpoint(checkpoint: Int, region: DesktopSettledGeometryRegion?)
    case unstableTransition(checkpoint: Int, region: DesktopSettledGeometryRegion?)
}

public enum DesktopSettledGeometryValidator {
    private static let genericRegions: Set<DesktopSettledGeometryRegion> = [.chrome, .sidebar, .detail]
    private static let overviewRegions: Set<DesktopSettledGeometryRegion> = [
        .chrome, .sidebar, .detail, .overviewSentinel
    ]
    private static let reposRegions: Set<DesktopSettledGeometryRegion> = [
        .chrome, .sidebar, .detail, .reposOuterScroll, .reposBottomSentinel
    ]

    public static func validate(
        _ trace: DesktopSettledGeometryTrace
    ) throws -> DesktopSettledGeometryValidationStatus {
        guard trace.schemaVersion == 1,
              trace.fixtureId == "tab-overview",
              trace.fixtureId.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
              trace.pid > 0,
              trace.windowNumber > 0,
              trace.coordinateSpace == .globalTopLeft,
              trace.requestedContentSize == .init(width: 1040, height: 680),
              trace.tolerancePoints.isFinite,
              trace.tolerancePoints > 0,
              trace.tolerancePoints <= 1,
              trace.sampleIntervalMilliseconds == 100,
              trace.checkpoints.count == trace.scenario.sections.count else {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        try validateNavigationActions(trace.navigationActions, scenario: trace.scenario)

        var settledCheckpoints: [[DesktopSettledGeometrySample]] = []
        for (checkpointIndex, checkpoint) in trace.checkpoints.enumerated() {
            guard checkpoint.index == checkpointIndex,
                  checkpoint.section == trace.scenario.sections[checkpointIndex] else {
                throw DesktopSettledGeometryValidationError.invalidSequence(index: checkpointIndex)
            }
            guard checkpoint.ready else {
                throw DesktopSettledGeometryValidationError.invalidContract
            }
            guard checkpoint.quiescent else {
                throw DesktopSettledGeometryValidationError.notQuiescent(index: checkpointIndex)
            }
            guard checkpoint.acquisitionMilliseconds >= 0,
                  checkpoint.acquisitionMilliseconds <= 5_000 else {
                throw DesktopSettledGeometryValidationError.invalidContract
            }
            guard checkpoint.samples.count >= 3 else {
                throw DesktopSettledGeometryValidationError.insufficientSamples(index: checkpointIndex)
            }
            try validateCadence(
                checkpoint.samples,
                checkpoint: checkpointIndex,
                interval: trace.sampleIntervalMilliseconds,
                acquisitionMilliseconds: checkpoint.acquisitionMilliseconds
            )
            try validateSamples(
                checkpoint.samples,
                section: checkpoint.section,
                checkpoint: checkpointIndex,
                requestedContentSize: trace.requestedContentSize,
                tolerance: trace.tolerancePoints
            )
            try validateCheckpointStability(
                checkpoint.samples,
                checkpoint: checkpointIndex,
                tolerance: trace.tolerancePoints
            )
            settledCheckpoints.append(checkpoint.samples)
        }
        try validateTransitionStability(settledCheckpoints, tolerance: trace.tolerancePoints)
        return .stable
    }

    private static func validateNavigationActions(
        _ actions: [DesktopSettledGeometryNavigationAction],
        scenario: DesktopSettledGeometryScenario
    ) throws {
        let transitions = Array(zip(scenario.sections, scenario.sections.dropFirst()))
        guard actions.count == transitions.count else {
            throw DesktopSettledGeometryValidationError.invalidNavigationAction(
                index: min(actions.count, transitions.count)
            )
        }
        for (index, transition) in transitions.enumerated() {
            let action = actions[index]
            guard action.index == index,
                  action.fromSection == transition.0,
                  action.toSection == transition.1,
                  action.controlIdentifier == "neondiff-sidebar-section-\(transition.1.rawValue)",
                  action.actionAdvertised,
                  action.attemptCount == 1,
                  action.performResult == .success else {
                throw DesktopSettledGeometryValidationError.invalidNavigationAction(index: index)
            }
        }
    }

    private static func validateCadence(
        _ samples: [DesktopSettledGeometrySample],
        checkpoint: Int,
        interval: Int,
        acquisitionMilliseconds: Int
    ) throws {
        guard let first = samples.first,
              let last = samples.last,
              first.elapsedMilliseconds >= 0,
              first.elapsedMilliseconds <= 25,
              last.elapsedMilliseconds <= acquisitionMilliseconds else {
            throw DesktopSettledGeometryValidationError.invalidCadence(index: checkpoint)
        }
        guard samples.allSatisfy({
            $0.elapsedMilliseconds >= 0
                && $0.elapsedMilliseconds <= acquisitionMilliseconds
        }) else {
            throw DesktopSettledGeometryValidationError.invalidCadence(index: checkpoint)
        }
        for pair in zip(samples, samples.dropFirst()) {
            let subtraction = pair.1.elapsedMilliseconds.subtractingReportingOverflow(
                pair.0.elapsedMilliseconds
            )
            guard !subtraction.overflow,
                  subtraction.partialValue >= interval - 10,
                  subtraction.partialValue <= interval + 25 else {
                throw DesktopSettledGeometryValidationError.invalidCadence(index: checkpoint)
            }
        }
    }

    private static func validateSamples(
        _ samples: [DesktopSettledGeometrySample],
        section: DesktopSection,
        checkpoint: Int,
        requestedContentSize: DesktopEvaluationContentSize,
        tolerance: Double
    ) throws {
        let required = section == .repos ? reposRegions : overviewRegions
        for (sampleIndex, sample) in samples.enumerated() {
            guard sample.windowFrame.isFiniteAndNonempty,
                  sample.contentFrame.isFiniteAndNonempty else {
                throw DesktopSettledGeometryValidationError.nonfiniteFrame(
                    checkpoint: checkpoint,
                    sample: sampleIndex
                )
            }
            guard sample.windowFrame.contains(sample.contentFrame, tolerance: tolerance) else {
                throw DesktopSettledGeometryValidationError.invalidContract
            }
            guard abs(sample.contentFrame.width - Double(requestedContentSize.width)) <= tolerance,
                  abs(sample.contentFrame.height - Double(requestedContentSize.height)) <= tolerance else {
                throw DesktopSettledGeometryValidationError.contentSizeMismatch(
                    checkpoint: checkpoint,
                    sample: sampleIndex
                )
            }
            var byID: [DesktopSettledGeometryRegion: DesktopSettledGeometryFrame] = [:]
            for region in sample.regions {
                guard region.frame.isFiniteAndNonempty else {
                    throw DesktopSettledGeometryValidationError.nonfiniteFrame(
                        checkpoint: checkpoint,
                        sample: sampleIndex
                    )
                }
                guard byID.updateValue(region.frame, forKey: region.id) == nil else {
                    throw DesktopSettledGeometryValidationError.duplicateRegion(
                        checkpoint: checkpoint,
                        sample: sampleIndex,
                        region: region.id
                    )
                }
            }
            for region in required where byID[region] == nil {
                throw DesktopSettledGeometryValidationError.missingRegion(
                    checkpoint: checkpoint,
                    sample: sampleIndex,
                    region: region
                )
            }
            if let unexpected = Set(byID.keys).subtracting(required).first {
                throw DesktopSettledGeometryValidationError.unexpectedRegion(
                    checkpoint: checkpoint,
                    sample: sampleIndex,
                    region: unexpected
                )
            }
            for region in genericRegions.union([.overviewSentinel, .reposOuterScroll]) {
                guard let frame = byID[region] else { continue }
                guard sample.windowFrame.contains(frame, tolerance: tolerance) else {
                    throw DesktopSettledGeometryValidationError.regionOutsideWindow(
                        checkpoint: checkpoint,
                        sample: sampleIndex,
                        region: region
                    )
                }
            }
            guard let sidebar = byID[.sidebar], let detail = byID[.detail] else {
                throw DesktopSettledGeometryValidationError.invalidContract
            }
            guard !sidebar.overlaps(detail, byMoreThan: tolerance) else {
                throw DesktopSettledGeometryValidationError.sidebarDetailOverlap(
                    checkpoint: checkpoint,
                    sample: sampleIndex
                )
            }
            if section == .repos {
                guard let scroll = byID[.reposOuterScroll],
                      let sentinel = byID[.reposBottomSentinel] else {
                    throw DesktopSettledGeometryValidationError.invalidContract
                }
                guard detail.contains(scroll, tolerance: tolerance) else {
                    throw DesktopSettledGeometryValidationError.reposScrollOutsideDetail(
                        checkpoint: checkpoint,
                        sample: sampleIndex
                    )
                }
                guard scroll.containsHorizontally(sentinel, tolerance: tolerance) else {
                    throw DesktopSettledGeometryValidationError.reposSentinelOutsideScrollWidth(
                        checkpoint: checkpoint,
                        sample: sampleIndex
                    )
                }
            }
        }
    }

    private static func validateCheckpointStability(
        _ samples: [DesktopSettledGeometrySample],
        checkpoint: Int,
        tolerance: Double
    ) throws {
        let baseline = samples[0]
        let baselineByID = Dictionary(uniqueKeysWithValues: baseline.regions.map { ($0.id, $0.frame) })
        for sample in samples.dropFirst() {
            if sample.windowFrame.differs(from: baseline.windowFrame, byMoreThan: tolerance)
                || sample.contentFrame.differs(from: baseline.contentFrame, byMoreThan: tolerance) {
                throw DesktopSettledGeometryValidationError.unstableCheckpoint(
                    checkpoint: checkpoint,
                    region: nil
                )
            }
            let byID = Dictionary(uniqueKeysWithValues: sample.regions.map { ($0.id, $0.frame) })
            for (region, frame) in baselineByID {
                guard let current = byID[region],
                      !current.differs(from: frame, byMoreThan: tolerance) else {
                    throw DesktopSettledGeometryValidationError.unstableCheckpoint(
                        checkpoint: checkpoint,
                        region: region
                    )
                }
            }
        }
    }

    private static func validateTransitionStability(
        _ checkpoints: [[DesktopSettledGeometrySample]],
        tolerance: Double
    ) throws {
        guard let baseline = checkpoints.first?.first else {
            throw DesktopSettledGeometryValidationError.invalidContract
        }
        let baselineByID = Dictionary(uniqueKeysWithValues: baseline.regions.map { ($0.id, $0.frame) })
        for (checkpoint, samples) in checkpoints.enumerated().dropFirst() {
            for sample in samples {
                if sample.windowFrame.differs(from: baseline.windowFrame, byMoreThan: tolerance)
                    || sample.contentFrame.differs(from: baseline.contentFrame, byMoreThan: tolerance) {
                    throw DesktopSettledGeometryValidationError.unstableTransition(
                        checkpoint: checkpoint,
                        region: nil
                    )
                }
                let byID = Dictionary(uniqueKeysWithValues: sample.regions.map { ($0.id, $0.frame) })
                for region in genericRegions {
                    guard let original = baselineByID[region],
                          let current = byID[region],
                          !current.differs(from: original, byMoreThan: tolerance) else {
                        throw DesktopSettledGeometryValidationError.unstableTransition(
                            checkpoint: checkpoint,
                            region: region
                        )
                    }
                }
                if let original = baselineByID[.overviewSentinel],
                   let current = byID[.overviewSentinel],
                   current.differs(from: original, byMoreThan: tolerance) {
                    throw DesktopSettledGeometryValidationError.unstableTransition(
                        checkpoint: checkpoint,
                        region: .overviewSentinel
                    )
                }
            }
        }
    }
}

public enum DesktopSettledGeometryCheckStatus: String, Codable, Equatable, Sendable {
    case stable
    case failed
}

public enum DesktopSettledGeometryCheckCategory: String, Codable, Equatable, Sendable {
    case none
    case input
    case contract
    case sequence
    case geometry
}

public struct DesktopSettledGeometryCheckResult: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let ok: Bool
    public let status: DesktopSettledGeometryCheckStatus
    public let category: DesktopSettledGeometryCheckCategory
    public let reasonCode: String

    public init(
        schemaVersion: Int = 1,
        ok: Bool,
        status: DesktopSettledGeometryCheckStatus,
        category: DesktopSettledGeometryCheckCategory,
        reasonCode: String
    ) {
        self.schemaVersion = schemaVersion
        self.ok = ok
        self.status = status
        self.category = category
        self.reasonCode = reasonCode
    }

    public static let stable = Self(ok: true, status: .stable, category: .none, reasonCode: "none")

    public static func inputFailure(_ reasonCode: String) -> Self {
        .init(ok: false, status: .failed, category: .input, reasonCode: reasonCode)
    }

    public static func failure(_ error: DesktopSettledGeometryValidationError) -> Self {
        switch error {
        case .invalidContract:
            failed(.contract, "invalid-contract")
        case .invalidSequence:
            failed(.sequence, "invalid-sequence")
        case .invalidNavigationAction:
            failed(.sequence, "invalid-navigation-action")
        case .notQuiescent:
            failed(.sequence, "not-quiescent")
        case .insufficientSamples:
            failed(.geometry, "insufficient-samples")
        case .invalidCadence:
            failed(.geometry, "invalid-cadence")
        case .nonfiniteFrame:
            failed(.contract, "nonfinite-frame")
        case .contentSizeMismatch:
            failed(.geometry, "content-size-mismatch")
        case .duplicateRegion:
            failed(.contract, "duplicate-region")
        case .missingRegion:
            failed(.contract, "missing-region")
        case .unexpectedRegion:
            failed(.contract, "unexpected-region")
        case .regionOutsideWindow:
            failed(.geometry, "region-outside-window")
        case .sidebarDetailOverlap:
            failed(.geometry, "sidebar-detail-overlap")
        case .reposScrollOutsideDetail:
            failed(.geometry, "repos-scroll-outside-detail")
        case .reposSentinelOutsideScrollWidth:
            failed(.geometry, "repos-sentinel-outside-scroll-width")
        case .unstableCheckpoint:
            failed(.geometry, "unstable-checkpoint")
        case .unstableTransition:
            failed(.geometry, "unstable-transition")
        }
    }

    private static func failed(
        _ category: DesktopSettledGeometryCheckCategory,
        _ reasonCode: String
    ) -> Self {
        .init(ok: false, status: .failed, category: category, reasonCode: reasonCode)
    }
}

public enum DesktopSettledGeometryScenarioAdvance: Equatable, Sendable {
    case navigate(DesktopSection)
    case complete
}

public enum DesktopSettledGeometryScenarioError: Error, Equatable, Sendable {
    case unexpectedSection(expected: DesktopSection, actual: DesktopSection)
    case alreadyComplete
}

public struct DesktopSettledGeometryScenarioCoordinator: Sendable {
    public let scenario: DesktopSettledGeometryScenario
    private var nextIndex = 0

    public init(scenario: DesktopSettledGeometryScenario) {
        self.scenario = scenario
    }

    public var expectedSection: DesktopSection? {
        scenario.sections.indices.contains(nextIndex) ? scenario.sections[nextIndex] : nil
    }

    public var isComplete: Bool { expectedSection == nil }

    public mutating func recordQuiescent(
        section: DesktopSection
    ) throws -> DesktopSettledGeometryScenarioAdvance {
        guard let expectedSection else {
            throw DesktopSettledGeometryScenarioError.alreadyComplete
        }
        guard section == expectedSection else {
            throw DesktopSettledGeometryScenarioError.unexpectedSection(
                expected: expectedSection,
                actual: section
            )
        }
        nextIndex += 1
        if let next = self.expectedSection {
            return .navigate(next)
        }
        return .complete
    }
}
