import Foundation

public enum DesktopReposReachabilityFixture: String, Codable, Equatable, Sendable {
    case tabRepos = "tab-repos"
}

public enum DesktopReposReachabilityRegion: String, Codable, CaseIterable, Equatable, Sendable {
    case table
    case applyAllowlist = "apply-allowlist"
    case boundaryBody = "boundary-body"
}

public struct DesktopReposReachabilityFrame: Codable, Equatable, Sendable {
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
        [x, y, width, height, x + width, y + height].allSatisfy(\.isFinite)
            && width > 0
            && height > 0
    }

    fileprivate func contains(_ other: Self) -> Bool {
        other.x >= x
            && other.y >= y
            && other.x + other.width <= x + width
            && other.y + other.height <= y + height
    }

    fileprivate func differs(from other: Self, byMoreThan tolerance: Double) -> Bool {
        zip(values, other.values).contains { abs($0 - $1) > tolerance }
    }

    private var values: [Double] { [x, y, width, height] }
}

public struct DesktopReposReachabilityRegionFrame: Codable, Equatable, Sendable {
    public let id: DesktopReposReachabilityRegion
    public let frame: DesktopReposReachabilityFrame

    public init(id: DesktopReposReachabilityRegion, frame: DesktopReposReachabilityFrame) {
        self.id = id
        self.frame = frame
    }
}

public struct DesktopReposReachabilitySample: Codable, Equatable, Sendable {
    /// Milliseconds from the beginning of this sampling phase. Frames and the
    /// viewport use the Accessibility screen-coordinate space.
    public let elapsedMilliseconds: Int
    /// The verified Accessibility window frame, in AX screen coordinates.
    public let viewport: DesktopReposReachabilityFrame
    public let regions: [DesktopReposReachabilityRegionFrame]

    public init(
        elapsedMilliseconds: Int,
        viewport: DesktopReposReachabilityFrame,
        regions: [DesktopReposReachabilityRegionFrame]
    ) {
        self.elapsedMilliseconds = elapsedMilliseconds
        self.viewport = viewport
        self.regions = regions
    }
}

public struct DesktopReposOuterScrollObservation: Codable, Equatable, Sendable {
    public let verticalScrollBarSupported: Bool
    public let minimumValue: Double?
    public let maximumValue: Double?
    public let valueBeforeScroll: Double?
    public let valueAfterScroll: Double?
    public let setToMaximumSucceeded: Bool

    public init(
        verticalScrollBarSupported: Bool,
        minimumValue: Double?,
        maximumValue: Double?,
        valueBeforeScroll: Double?,
        valueAfterScroll: Double?,
        setToMaximumSucceeded: Bool
    ) {
        self.verticalScrollBarSupported = verticalScrollBarSupported
        self.minimumValue = minimumValue
        self.maximumValue = maximumValue
        self.valueBeforeScroll = valueBeforeScroll
        self.valueAfterScroll = valueAfterScroll
        self.setToMaximumSucceeded = setToMaximumSucceeded
    }
}

public struct DesktopReposReachabilityTrace: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let fixture: DesktopReposReachabilityFixture
    public let ready: Bool
    public let quiescent: Bool
    public let requestedContentSize: DesktopEvaluationContentSize
    public let sampleIntervalMilliseconds: Int
    public let preScrollAcquisitionMilliseconds: Int
    public let postScrollAcquisitionMilliseconds: Int
    public let tolerancePoints: Double
    public let preScrollSamples: [DesktopReposReachabilitySample]
    public let outerScroll: DesktopReposOuterScrollObservation?
    public let postScrollSamples: [DesktopReposReachabilitySample]

    public init(
        schemaVersion: Int,
        fixture: DesktopReposReachabilityFixture,
        ready: Bool,
        quiescent: Bool,
        requestedContentSize: DesktopEvaluationContentSize,
        sampleIntervalMilliseconds: Int,
        preScrollAcquisitionMilliseconds: Int,
        postScrollAcquisitionMilliseconds: Int,
        tolerancePoints: Double,
        preScrollSamples: [DesktopReposReachabilitySample],
        outerScroll: DesktopReposOuterScrollObservation?,
        postScrollSamples: [DesktopReposReachabilitySample]
    ) {
        self.schemaVersion = schemaVersion
        self.fixture = fixture
        self.ready = ready
        self.quiescent = quiescent
        self.requestedContentSize = requestedContentSize
        self.sampleIntervalMilliseconds = sampleIntervalMilliseconds
        self.preScrollAcquisitionMilliseconds = preScrollAcquisitionMilliseconds
        self.postScrollAcquisitionMilliseconds = postScrollAcquisitionMilliseconds
        self.tolerancePoints = tolerancePoints
        self.preScrollSamples = preScrollSamples
        self.outerScroll = outerScroll
        self.postScrollSamples = postScrollSamples
    }

    public static func decode(data: Data) throws -> Self {
        guard data.count <= 256 * 1024 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        guard validateShape(object) else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let trace: Self
        do {
            trace = try JSONDecoder().decode(Self.self, from: data)
        } catch {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        _ = try DesktopReposReachabilityValidator.validate(trace)
        return trace
    }

    private static func validateShape(_ object: Any) -> Bool {
        guard let root = object as? [String: Any],
              hasAllowedAndRequired(root, allowed: [
                  "schemaVersion", "fixture", "ready", "quiescent", "requestedContentSize",
                  "sampleIntervalMilliseconds", "preScrollAcquisitionMilliseconds", "tolerancePoints",
                  "postScrollAcquisitionMilliseconds", "preScrollSamples", "outerScroll", "postScrollSamples"
              ], required: [
                  "schemaVersion", "fixture", "ready", "quiescent", "requestedContentSize",
                  "sampleIntervalMilliseconds", "preScrollAcquisitionMilliseconds", "tolerancePoints",
                  "postScrollAcquisitionMilliseconds", "preScrollSamples", "postScrollSamples"
              ]),
              let size = root["requestedContentSize"] as? [String: Any],
              hasOnly(size, ["width", "height"]),
              let pre = root["preScrollSamples"] as? [Any],
              let post = root["postScrollSamples"] as? [Any],
              pre.allSatisfy(validateSample),
              post.allSatisfy(validateSample) else {
            return false
        }
        if let scroll = root["outerScroll"], !(scroll is NSNull) {
            guard let dictionary = scroll as? [String: Any],
                  hasAllowedAndRequired(dictionary, allowed: [
                      "verticalScrollBarSupported", "minimumValue", "maximumValue", "valueBeforeScroll",
                      "valueAfterScroll", "setToMaximumSucceeded"
                  ], required: ["verticalScrollBarSupported", "setToMaximumSucceeded"]) else {
                return false
            }
        }
        return true
    }

    private static func validateSample(_ object: Any) -> Bool {
        guard let sample = object as? [String: Any],
              hasOnly(sample, ["elapsedMilliseconds", "viewport", "regions"]),
              validateFrame(sample["viewport"]),
              let regions = sample["regions"] as? [Any] else {
            return false
        }
        return regions.allSatisfy { object in
            guard let region = object as? [String: Any],
                  hasOnly(region, ["id", "frame"]),
                  validateFrame(region["frame"]) else {
                return false
            }
            return true
        }
    }

    private static func validateFrame(_ object: Any?) -> Bool {
        guard let frame = object as? [String: Any] else { return false }
        return hasOnly(frame, ["x", "y", "width", "height"])
    }

    private static func hasOnly(_ object: [String: Any], _ keys: Set<String>) -> Bool {
        Set(object.keys) == keys
    }

    private static func hasAllowedAndRequired(
        _ object: [String: Any],
        allowed: Set<String>,
        required: Set<String>
    ) -> Bool {
        let keys = Set(object.keys)
        return keys.isSubset(of: allowed) && required.isSubset(of: keys)
    }
}

public enum DesktopReposReachabilityValidationStatus: String, Codable, Equatable, Sendable {
    case reachable
}

public enum DesktopReposReachabilityValidationPhase: String, Codable, Equatable, Sendable {
    case preScroll = "pre-scroll"
    case postScroll = "post-scroll"
}

public enum DesktopReposReachabilityValidationError: LocalizedError, Equatable, Sendable {
    case invalidContract
    case insufficientSamples(DesktopReposReachabilityValidationPhase)
    case nonfiniteFrame(DesktopReposReachabilityValidationPhase, Int)
    case duplicateRegion(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)
    case missingRegion(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)
    case excessiveDrift(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion?)
    case missingOuterScroll
    case unsupportedOuterScroll
    case regionOutsideViewport(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)

    public var errorDescription: String? {
        switch self {
        case .invalidContract:
            return "Reachability trace contract is invalid."
        case .insufficientSamples(let phase):
            return "Reachability trace has fewer than three \(phase.rawValue) samples."
        case .nonfiniteFrame(let phase, let index):
            return "Reachability trace has invalid geometry in \(phase.rawValue) sample \(index)."
        case .duplicateRegion(let phase, let index, let region):
            return "Reachability trace repeats \(region.rawValue) in \(phase.rawValue) sample \(index)."
        case .missingRegion(let phase, let index, let region):
            return "Reachability trace is missing \(region.rawValue) in \(phase.rawValue) sample \(index)."
        case .excessiveDrift(let phase, let index, let region):
            let name = region?.rawValue ?? "viewport"
            return "Reachability trace \(name) drift exceeds tolerance in \(phase.rawValue) sample \(index)."
        case .missingOuterScroll:
            return "Reachability trace has no outer scroll area."
        case .unsupportedOuterScroll:
            return "Reachability trace outer scroll area cannot be set to its maximum."
        case .regionOutsideViewport(let phase, let index, let region):
            return "Reachability trace \(region.rawValue) is outside the viewport in \(phase.rawValue) sample \(index)."
        }
    }
}

public enum DesktopReposReachabilityValidator {
    public static func validate(
        _ trace: DesktopReposReachabilityTrace
    ) throws -> DesktopReposReachabilityValidationStatus {
        guard trace.schemaVersion == 1,
              trace.fixture == .tabRepos,
              trace.ready,
              trace.quiescent,
              trace.requestedContentSize == DesktopEvaluationContentSize(width: 1040, height: 680),
              trace.sampleIntervalMilliseconds == 100,
              trace.preScrollAcquisitionMilliseconds >= 0,
              trace.preScrollAcquisitionMilliseconds <= 5_000,
              trace.postScrollAcquisitionMilliseconds >= 0,
              trace.postScrollAcquisitionMilliseconds <= 5_000,
              trace.tolerancePoints.isFinite,
              trace.tolerancePoints > 0,
              trace.tolerancePoints <= 1 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }

        try validateSamples(
            trace.preScrollSamples,
            phase: .preScroll,
            tolerance: trace.tolerancePoints
        )
        guard let lastPreScrollSample = trace.preScrollSamples.last,
              trace.preScrollAcquisitionMilliseconds >= lastPreScrollSample.elapsedMilliseconds else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        try validateScroll(trace.outerScroll)
        try validateSamples(
            trace.postScrollSamples,
            phase: .postScroll,
            tolerance: trace.tolerancePoints
        )
        guard let lastPostScrollSample = trace.postScrollSamples.last,
              trace.postScrollAcquisitionMilliseconds >= lastPostScrollSample.elapsedMilliseconds else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        try requireVisible(.applyAllowlist, in: trace.postScrollSamples, phase: .postScroll)
        try requireVisible(.boundaryBody, in: trace.postScrollSamples, phase: .postScroll)
        return .reachable
    }

    private static func validateSamples(
        _ samples: [DesktopReposReachabilitySample],
        phase: DesktopReposReachabilityValidationPhase,
        tolerance: Double
    ) throws {
        guard samples.count >= 3 else {
            throw DesktopReposReachabilityValidationError.insufficientSamples(phase)
        }
        guard let finalSample = samples.last, finalSample.elapsedMilliseconds <= 5_000 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let baseline = samples[0]
        var priorElapsed = -1
        for (index, sample) in samples.enumerated() {
            guard sample.elapsedMilliseconds >= 0, sample.elapsedMilliseconds > priorElapsed else {
                throw DesktopReposReachabilityValidationError.invalidContract
            }
            if index > 0 {
                let cadence = sample.elapsedMilliseconds - priorElapsed
                guard cadence >= 50, cadence <= 150 else {
                    throw DesktopReposReachabilityValidationError.invalidContract
                }
            }
            priorElapsed = sample.elapsedMilliseconds
            guard sample.viewport.isFiniteAndNonempty else {
                throw DesktopReposReachabilityValidationError.nonfiniteFrame(phase, index)
            }
            var byID: [DesktopReposReachabilityRegion: DesktopReposReachabilityFrame] = [:]
            for region in sample.regions {
                guard region.frame.isFiniteAndNonempty else {
                    throw DesktopReposReachabilityValidationError.nonfiniteFrame(phase, index)
                }
                guard byID.updateValue(region.frame, forKey: region.id) == nil else {
                    throw DesktopReposReachabilityValidationError.duplicateRegion(phase, index, region.id)
                }
            }
            for id in DesktopReposReachabilityRegion.allCases where byID[id] == nil {
                throw DesktopReposReachabilityValidationError.missingRegion(phase, index, id)
            }
            guard index > 0 else { continue }
            if sample.viewport.differs(from: baseline.viewport, byMoreThan: tolerance) {
                throw DesktopReposReachabilityValidationError.excessiveDrift(phase, index, nil)
            }
            let baselineByID = Dictionary(uniqueKeysWithValues: baseline.regions.map { ($0.id, $0.frame) })
            for id in DesktopReposReachabilityRegion.allCases {
                guard let frame = byID[id], let baselineFrame = baselineByID[id] else {
                    throw DesktopReposReachabilityValidationError.missingRegion(phase, index, id)
                }
                if frame.differs(from: baselineFrame, byMoreThan: tolerance) {
                    throw DesktopReposReachabilityValidationError.excessiveDrift(phase, index, id)
                }
            }
        }
    }

    private static func validateScroll(_ scroll: DesktopReposOuterScrollObservation?) throws {
        let scalarEpsilon = 0.001
        guard let scroll else {
            throw DesktopReposReachabilityValidationError.missingOuterScroll
        }
        guard scroll.verticalScrollBarSupported,
              scroll.setToMaximumSucceeded,
              let minimum = scroll.minimumValue,
              let maximum = scroll.maximumValue,
              let before = scroll.valueBeforeScroll,
              let after = scroll.valueAfterScroll,
              minimum.isFinite,
              maximum.isFinite,
              before.isFinite,
              after.isFinite,
              maximum > minimum,
              abs(before - minimum) <= scalarEpsilon,
              abs(maximum - after) <= scalarEpsilon else {
            throw DesktopReposReachabilityValidationError.unsupportedOuterScroll
        }
    }

    private static func requireVisible(
        _ id: DesktopReposReachabilityRegion,
        in samples: [DesktopReposReachabilitySample],
        phase: DesktopReposReachabilityValidationPhase
    ) throws {
        for (index, sample) in samples.enumerated() {
            guard let region = sample.regions.first(where: { $0.id == id }) else {
                throw DesktopReposReachabilityValidationError.missingRegion(phase, index, id)
            }
            guard sample.viewport.contains(region.frame) else {
                throw DesktopReposReachabilityValidationError.regionOutsideViewport(phase, index, id)
            }
        }
    }
}
