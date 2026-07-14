import Foundation

public enum DesktopReposReachabilityFixture: String, Codable, Equatable, Sendable {
    case tabRepos = "tab-repos"
}

public enum DesktopReposReachabilityTarget: String, Codable, Equatable, Sendable {
    case tabRepos1040x680 = "tab-repos-1040x680"

    public static func requireSupported(
        fixtureId: String,
        contentWidth: Double,
        contentHeight: Double
    ) throws -> Self {
        guard fixtureId == DesktopReposReachabilityFixture.tabRepos.rawValue,
              contentWidth == 1040,
              contentHeight == 680 else {
            throw DesktopReposReachabilityTargetError.unsupportedTarget
        }
        return .tabRepos1040x680
    }
}

public enum DesktopReposReachabilityTargetError: LocalizedError, Equatable, Sendable {
    case unsupportedTarget

    public var errorDescription: String? {
        "Repositories reachability capture requires tab-repos at 1040x680."
    }
}

public enum DesktopReposReachabilityAcquisitionStatus: String, Codable, Equatable, Sendable {
    case complete
    case failed
}

public enum DesktopReposReachabilityAcquisitionFailureReason: String, Codable, Error, Equatable, Sendable {
    case cannotComplete = "cannot-complete"
    case invalidElement = "invalid-element"
    case permissionDenied = "permission-denied"
    case invalidType = "invalid-type"
    case attributeUnavailable = "attribute-unavailable"
    case pidMismatch = "pid-mismatch"
    case windowMismatch = "window-mismatch"
    case semanticMissing = "semantic-missing"
    case semanticDuplicate = "semantic-duplicate"
    case semanticChanged = "semantic-changed"
    case timeout
    case ancestryUnavailable = "ancestry-unavailable"
    case ancestryCycle = "ancestry-cycle"
    case ancestryLimit = "ancestry-limit"
    case messagingTimeoutUnavailable = "messaging-timeout-unavailable"
}

public struct DesktopReposReachabilityAcquisition: Codable, Equatable, Sendable {
    public let status: DesktopReposReachabilityAcquisitionStatus
    public let failureReason: DesktopReposReachabilityAcquisitionFailureReason?

    public init(
        status: DesktopReposReachabilityAcquisitionStatus,
        failureReason: DesktopReposReachabilityAcquisitionFailureReason?
    ) {
        self.status = status
        self.failureReason = failureReason
    }

    private enum CodingKeys: String, CodingKey {
        case status
        case failureReason
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.contains(.failureReason) else {
            throw DecodingError.keyNotFound(
                CodingKeys.failureReason,
                .init(
                    codingPath: decoder.codingPath,
                    debugDescription: "Acquisition failureReason must be explicit."
                )
            )
        }
        status = try container.decode(DesktopReposReachabilityAcquisitionStatus.self, forKey: .status)
        failureReason = try container.decodeIfPresent(
            DesktopReposReachabilityAcquisitionFailureReason.self,
            forKey: .failureReason
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(status, forKey: .status)
        if let failureReason {
            try container.encode(failureReason, forKey: .failureReason)
        } else {
            try container.encodeNil(forKey: .failureReason)
        }
    }
}

public enum DesktopReposReachabilityRegion: String, Codable, CaseIterable, Equatable, Sendable {
    case table
    case applyAllowlist = "apply-allowlist"
    case boundaryBody = "boundary-body"
}

public enum DesktopReposReachabilitySamplingContract {
    public static let minimumStableSampleCount = 3
    public static let minimumCadenceMilliseconds = 50
    public static let maximumCadenceMilliseconds = 150

    public static func hasStableCadence(_ elapsedMilliseconds: [Int]) -> Bool {
        guard elapsedMilliseconds.count >= minimumStableSampleCount,
              let first = elapsedMilliseconds.first,
              first >= 0 else {
            return false
        }
        return zip(elapsedMilliseconds, elapsedMilliseconds.dropFirst()).allSatisfy { prior, current in
            guard current > prior else { return false }
            let cadence = current - prior
            return cadence >= minimumCadenceMilliseconds
                && cadence <= maximumCadenceMilliseconds
        }
    }
}

public struct DesktopReposVerticalScrollBarCandidate: Equatable, Sendable {
    public let role: String?
    public let orientation: String?

    public init(role: String?, orientation: String?) {
        self.role = role
        self.orientation = orientation
    }
}

public enum DesktopReposVerticalScrollBarSelection: Equatable, Sendable {
    case convenienceAttribute
    case directChild(index: Int)
    case unsupported
}

public enum DesktopReposVerticalScrollBarSelectionError: Error, Equatable, Sendable {
    case missingRole
    case invalidRole
    case missingOrientation
    case invalidOrientation
    case ambiguousVerticalChildren
}

public enum DesktopReposVerticalScrollBarSelectionContract {
    public static let scrollBarRole = "AXScrollBar"
    public static let verticalOrientation = "AXVerticalOrientation"
    public static let horizontalOrientation = "AXHorizontalOrientation"

    public static func select(
        convenienceCandidate: DesktopReposVerticalScrollBarCandidate?,
        directChildren: [DesktopReposVerticalScrollBarCandidate]
    ) throws -> DesktopReposVerticalScrollBarSelection {
        if let convenienceCandidate {
            guard let role = convenienceCandidate.role else {
                throw DesktopReposVerticalScrollBarSelectionError.missingRole
            }
            guard role == scrollBarRole else {
                throw DesktopReposVerticalScrollBarSelectionError.invalidRole
            }
            guard let orientation = convenienceCandidate.orientation else {
                throw DesktopReposVerticalScrollBarSelectionError.missingOrientation
            }
            guard orientation == verticalOrientation else {
                throw DesktopReposVerticalScrollBarSelectionError.invalidOrientation
            }
            return .convenienceAttribute
        }

        var verticalIndices: [Int] = []
        for (index, child) in directChildren.enumerated() {
            guard let role = child.role else {
                throw DesktopReposVerticalScrollBarSelectionError.missingRole
            }
            guard role == scrollBarRole else { continue }
            guard let orientation = child.orientation else {
                throw DesktopReposVerticalScrollBarSelectionError.missingOrientation
            }
            switch orientation {
            case verticalOrientation:
                verticalIndices.append(index)
            case horizontalOrientation:
                continue
            default:
                throw DesktopReposVerticalScrollBarSelectionError.invalidOrientation
            }
        }

        guard verticalIndices.count <= 1 else {
            throw DesktopReposVerticalScrollBarSelectionError.ambiguousVerticalChildren
        }
        guard let index = verticalIndices.first else { return .unsupported }
        return .directChild(index: index)
    }
}

public enum DesktopReposReachabilitySemanticContract {
    public static let tableRole = "AXOutline"
    public static let boundaryIdentifier = "neondiff-repos-boundary"
    public static let boundaryValue = "Repo changes are written through config patch only; the desktop does not post reviews or bypass daemon gates."
    public static let applyAllowlistIdentifier = "neondiff-repo-apply-patch"
    public static let applyAllowlistValue = "Apply Allowlist"

    public static func matchesTable(role: String?) -> Bool {
        role == tableRole
    }

    public static func matchesApplyAllowlist(
        isButton: Bool,
        identifier: String?,
        title: String?,
        description: String?,
        value: String?
    ) -> Bool {
        isButton
            && (identifier == applyAllowlistIdentifier
                || [title, description, value].compactMap({ $0 }).contains(applyAllowlistValue))
    }

    public static func matchesBoundaryBody(
        isStaticText: Bool,
        identifier: String?,
        description: String?,
        value: String?
    ) -> Bool {
        isStaticText
            && (identifier == boundaryIdentifier
                || [description, value].compactMap({ $0 }).contains(boundaryValue))
    }

    public static func failureReason(
        tableCount: Int,
        applyAllowlistCount: Int,
        boundaryBodyCount: Int
    ) -> DesktopReposReachabilityAcquisitionFailureReason? {
        let counts = [tableCount, applyAllowlistCount, boundaryBodyCount]
        if counts.contains(where: { $0 > 1 }) { return .semanticDuplicate }
        if counts.contains(where: { $0 != 1 }) { return .semanticMissing }
        return nil
    }
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
    /// The outermost Boundary ancestor scroll area's settled AX frame.
    public let outerClip: DesktopReposReachabilityFrame
    /// Number of Boundary ancestor scroll areas from Boundary to the window.
    public let boundaryScrollAncestorCount: Int
    public let regions: [DesktopReposReachabilityRegionFrame]

    public init(
        elapsedMilliseconds: Int,
        viewport: DesktopReposReachabilityFrame,
        outerClip: DesktopReposReachabilityFrame,
        boundaryScrollAncestorCount: Int,
        regions: [DesktopReposReachabilityRegionFrame]
    ) {
        self.elapsedMilliseconds = elapsedMilliseconds
        self.viewport = viewport
        self.outerClip = outerClip
        self.boundaryScrollAncestorCount = boundaryScrollAncestorCount
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

public enum DesktopReposScrollMechanism: String, Codable, Equatable, Sendable {
    case incrementPagePress = "increment-page-press"
}

public enum DesktopReposScrollActionResult: String, Codable, Equatable, Sendable {
    case success
    case cannotComplete = "cannot-complete"
    case actionUnsupported = "action-unsupported"
    case invalidElement = "invalid-element"
    case permissionDenied = "permission-denied"
    case otherError = "other-error"
}

public struct DesktopReposIncrementPagePressObservation: Codable, Equatable, Sendable {
    public let actionAdvertised: Bool
    public let attemptCount: Int
    public let performResult: DesktopReposScrollActionResult?
    public let outerClipBefore: DesktopReposReachabilityFrame
    public let outerClipAfter: DesktopReposReachabilityFrame?

    public init(
        actionAdvertised: Bool,
        attemptCount: Int,
        performResult: DesktopReposScrollActionResult?,
        outerClipBefore: DesktopReposReachabilityFrame,
        outerClipAfter: DesktopReposReachabilityFrame?
    ) {
        self.actionAdvertised = actionAdvertised
        self.attemptCount = attemptCount
        self.performResult = performResult
        self.outerClipBefore = outerClipBefore
        self.outerClipAfter = outerClipAfter
    }

    private enum CodingKeys: String, CodingKey {
        case actionAdvertised, attemptCount, performResult, outerClipBefore, outerClipAfter
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        actionAdvertised = try container.decode(Bool.self, forKey: .actionAdvertised)
        attemptCount = try container.decode(Int.self, forKey: .attemptCount)
        performResult = try container.decodeIfPresent(DesktopReposScrollActionResult.self, forKey: .performResult)
        outerClipBefore = try container.decode(DesktopReposReachabilityFrame.self, forKey: .outerClipBefore)
        outerClipAfter = try container.decodeIfPresent(DesktopReposReachabilityFrame.self, forKey: .outerClipAfter)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(actionAdvertised, forKey: .actionAdvertised)
        try container.encode(attemptCount, forKey: .attemptCount)
        if let performResult { try container.encode(performResult, forKey: .performResult) }
        else { try container.encodeNil(forKey: .performResult) }
        try container.encode(outerClipBefore, forKey: .outerClipBefore)
        if let outerClipAfter { try container.encode(outerClipAfter, forKey: .outerClipAfter) }
        else { try container.encodeNil(forKey: .outerClipAfter) }
    }
}

public struct DesktopReposScrollInteraction: Codable, Equatable, Sendable {
    public let mechanism: DesktopReposScrollMechanism
    public let incrementPagePress: DesktopReposIncrementPagePressObservation?
    public let valueMutation: DesktopReposOuterScrollObservation?

    public init(
        mechanism: DesktopReposScrollMechanism,
        incrementPagePress: DesktopReposIncrementPagePressObservation?,
        valueMutation: DesktopReposOuterScrollObservation?
    ) {
        self.mechanism = mechanism
        self.incrementPagePress = incrementPagePress
        self.valueMutation = valueMutation
    }

    private enum CodingKeys: String, CodingKey { case mechanism, incrementPagePress, valueMutation }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        mechanism = try container.decode(DesktopReposScrollMechanism.self, forKey: .mechanism)
        incrementPagePress = try container.decodeIfPresent(
            DesktopReposIncrementPagePressObservation.self,
            forKey: .incrementPagePress
        )
        valueMutation = try container.decodeIfPresent(DesktopReposOuterScrollObservation.self, forKey: .valueMutation)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(mechanism, forKey: .mechanism)
        if let incrementPagePress { try container.encode(incrementPagePress, forKey: .incrementPagePress) }
        else { try container.encodeNil(forKey: .incrementPagePress) }
        if let valueMutation { try container.encode(valueMutation, forKey: .valueMutation) }
        else { try container.encodeNil(forKey: .valueMutation) }
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
    public let acquisition: DesktopReposReachabilityAcquisition
    public let preScrollSamples: [DesktopReposReachabilitySample]
    public let scrollInteraction: DesktopReposScrollInteraction?
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
        acquisition: DesktopReposReachabilityAcquisition,
        preScrollSamples: [DesktopReposReachabilitySample],
        scrollInteraction: DesktopReposScrollInteraction?,
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
        self.acquisition = acquisition
        self.preScrollSamples = preScrollSamples
        self.scrollInteraction = scrollInteraction
        self.postScrollSamples = postScrollSamples
    }

    private enum CodingKeys: String, CodingKey {
        case schemaVersion
        case fixture
        case ready
        case quiescent
        case requestedContentSize
        case sampleIntervalMilliseconds
        case preScrollAcquisitionMilliseconds
        case postScrollAcquisitionMilliseconds
        case tolerancePoints
        case acquisition
        case preScrollSamples
        case scrollInteraction
        case postScrollSamples
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        fixture = try container.decode(DesktopReposReachabilityFixture.self, forKey: .fixture)
        ready = try container.decode(Bool.self, forKey: .ready)
        quiescent = try container.decode(Bool.self, forKey: .quiescent)
        requestedContentSize = try container.decode(DesktopEvaluationContentSize.self, forKey: .requestedContentSize)
        sampleIntervalMilliseconds = try container.decode(Int.self, forKey: .sampleIntervalMilliseconds)
        preScrollAcquisitionMilliseconds = try container.decode(Int.self, forKey: .preScrollAcquisitionMilliseconds)
        postScrollAcquisitionMilliseconds = try container.decode(Int.self, forKey: .postScrollAcquisitionMilliseconds)
        tolerancePoints = try container.decode(Double.self, forKey: .tolerancePoints)
        acquisition = try container.decode(DesktopReposReachabilityAcquisition.self, forKey: .acquisition)
        preScrollSamples = try container.decode([DesktopReposReachabilitySample].self, forKey: .preScrollSamples)
        scrollInteraction = try container.decodeIfPresent(DesktopReposScrollInteraction.self, forKey: .scrollInteraction)
        postScrollSamples = try container.decode([DesktopReposReachabilitySample].self, forKey: .postScrollSamples)
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(fixture, forKey: .fixture)
        try container.encode(ready, forKey: .ready)
        try container.encode(quiescent, forKey: .quiescent)
        try container.encode(requestedContentSize, forKey: .requestedContentSize)
        try container.encode(sampleIntervalMilliseconds, forKey: .sampleIntervalMilliseconds)
        try container.encode(preScrollAcquisitionMilliseconds, forKey: .preScrollAcquisitionMilliseconds)
        try container.encode(postScrollAcquisitionMilliseconds, forKey: .postScrollAcquisitionMilliseconds)
        try container.encode(tolerancePoints, forKey: .tolerancePoints)
        try container.encode(acquisition, forKey: .acquisition)
        try container.encode(preScrollSamples, forKey: .preScrollSamples)
        if let scrollInteraction {
            try container.encode(scrollInteraction, forKey: .scrollInteraction)
        } else {
            try container.encodeNil(forKey: .scrollInteraction)
        }
        try container.encode(postScrollSamples, forKey: .postScrollSamples)
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
                  "postScrollAcquisitionMilliseconds", "acquisition", "preScrollSamples", "scrollInteraction",
                  "postScrollSamples"
              ], required: [
                  "schemaVersion", "fixture", "ready", "quiescent", "requestedContentSize",
                  "sampleIntervalMilliseconds", "preScrollAcquisitionMilliseconds", "tolerancePoints",
                  "postScrollAcquisitionMilliseconds", "acquisition", "preScrollSamples", "scrollInteraction",
                  "postScrollSamples"
              ]),
              let acquisition = root["acquisition"] as? [String: Any],
              hasAllowedAndRequired(
                  acquisition,
                  allowed: ["status", "failureReason"],
                  required: ["status", "failureReason"]
              ),
              let size = root["requestedContentSize"] as? [String: Any],
              hasOnly(size, ["width", "height"]),
              let pre = root["preScrollSamples"] as? [Any],
              let post = root["postScrollSamples"] as? [Any],
              pre.allSatisfy(validateSample),
              post.allSatisfy(validateSample) else {
            return false
        }
        if let interaction = root["scrollInteraction"], !(interaction is NSNull) {
            guard let dictionary = interaction as? [String: Any],
                  hasOnly(dictionary, ["mechanism", "incrementPagePress", "valueMutation"]),
                  dictionary["valueMutation"] is NSNull,
                  let press = dictionary["incrementPagePress"] as? [String: Any],
                  hasOnly(press, [
                      "actionAdvertised", "attemptCount", "performResult", "outerClipBefore", "outerClipAfter"
                  ]),
                  validateFrame(press["outerClipBefore"]),
                  (press["outerClipAfter"] is NSNull || validateFrame(press["outerClipAfter"])) else {
                return false
            }
        }
        return true
    }

    private static func validateSample(_ object: Any) -> Bool {
        guard let sample = object as? [String: Any],
              hasOnly(sample, [
                  "elapsedMilliseconds", "viewport", "outerClip", "boundaryScrollAncestorCount", "regions"
              ]),
              validateFrame(sample["viewport"]),
              validateFrame(sample["outerClip"]),
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
    case acquisitionFailed(DesktopReposReachabilityAcquisitionFailureReason)
    case insufficientSamples(DesktopReposReachabilityValidationPhase)
    case nonfiniteFrame(DesktopReposReachabilityValidationPhase, Int)
    case duplicateRegion(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)
    case missingRegion(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)
    case excessiveDrift(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion?)
    case missingScrollInteraction
    case actionNotAdvertised
    case actionPerformFailed(DesktopReposScrollActionResult)
    case unstableWindow
    case unstableOuterClip
    case unstableScrollAncestry
    case outerClipOutsideWindow
    case boundaryInitiallyInsideOuterClip
    case noUpwardMovement
    case nonRigidMovement
    case pressInsufficient(DesktopReposReachabilityRegion)
    case regionOutsideViewport(DesktopReposReachabilityValidationPhase, Int, DesktopReposReachabilityRegion)

    public var errorDescription: String? {
        switch self {
        case .invalidContract:
            return "Reachability trace contract is invalid."
        case .acquisitionFailed(let reason):
            return "Reachability trace acquisition failed: \(reason.rawValue)."
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
        case .missingScrollInteraction:
            return "Reachability trace has no scroll interaction."
        case .actionNotAdvertised:
            return "Reachability trace increment-page press was not advertised."
        case .actionPerformFailed(let result):
            return "Reachability trace increment-page press failed: \(result.rawValue)."
        case .unstableWindow:
            return "Reachability trace window changed across the scroll interaction."
        case .unstableOuterClip:
            return "Reachability trace outer clip changed across the scroll interaction."
        case .unstableScrollAncestry:
            return "Reachability trace Boundary scroll ancestry changed across the scroll interaction."
        case .outerClipOutsideWindow:
            return "Reachability trace outer clip is outside the verified window."
        case .boundaryInitiallyInsideOuterClip:
            return "Reachability trace Boundary did not begin below the outer clip."
        case .noUpwardMovement:
            return "Reachability trace increment-page press produced no upward movement."
        case .nonRigidMovement:
            return "Reachability trace regions did not move as one rigid page."
        case .pressInsufficient(let region):
            return "Reachability trace press-insufficient: \(region.rawValue) remains outside the outer clip."
        case .regionOutsideViewport(let phase, let index, let region):
            return "Reachability trace \(region.rawValue) is outside the viewport in \(phase.rawValue) sample \(index)."
        }
    }
}

public enum DesktopReposReachabilityCheckStatus: String, Codable, Equatable, Sendable {
    case reachable
    case failed
}

public enum DesktopReposReachabilityCheckCategory: String, Codable, Equatable, Sendable {
    case none
    case input
    case contract
    case acquisition
    case action
    case geometry
}

public struct DesktopReposReachabilityCheckResult: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let ok: Bool
    public let status: DesktopReposReachabilityCheckStatus
    public let category: DesktopReposReachabilityCheckCategory
    public let reasonCode: String

    public init(
        schemaVersion: Int = 1,
        ok: Bool,
        status: DesktopReposReachabilityCheckStatus,
        category: DesktopReposReachabilityCheckCategory,
        reasonCode: String
    ) {
        self.schemaVersion = schemaVersion
        self.ok = ok
        self.status = status
        self.category = category
        self.reasonCode = reasonCode
    }

    public static let reachable = Self(
        ok: true,
        status: .reachable,
        category: .none,
        reasonCode: "none"
    )

    public static func inputFailure(_ reasonCode: String) -> Self {
        Self(ok: false, status: .failed, category: .input, reasonCode: reasonCode)
    }

    public static func failure(_ error: DesktopReposReachabilityValidationError) -> Self {
        switch error {
        case .invalidContract:
            return failed(.contract, "invalid-contract")
        case .acquisitionFailed(let reason):
            return failed(.acquisition, "acquisition-\(reason.rawValue)")
        case .insufficientSamples(let phase):
            return failed(.geometry, "insufficient-\(phase.rawValue)-samples")
        case .nonfiniteFrame:
            return failed(.contract, "nonfinite-frame")
        case .duplicateRegion:
            return failed(.contract, "duplicate-region")
        case .missingRegion:
            return failed(.contract, "missing-region")
        case .excessiveDrift:
            return failed(.geometry, "excessive-drift")
        case .missingScrollInteraction:
            return failed(.contract, "missing-scroll-interaction")
        case .actionNotAdvertised:
            return failed(.action, "action-not-advertised")
        case .actionPerformFailed(let result):
            return failed(.action, "action-perform-\(result.rawValue)")
        case .unstableWindow:
            return failed(.geometry, "unstable-window")
        case .unstableOuterClip:
            return failed(.geometry, "unstable-outer-clip")
        case .unstableScrollAncestry:
            return failed(.geometry, "unstable-scroll-ancestry")
        case .outerClipOutsideWindow:
            return failed(.geometry, "outer-clip-outside-window")
        case .boundaryInitiallyInsideOuterClip:
            return failed(.geometry, "boundary-initially-inside-outer-clip")
        case .noUpwardMovement:
            return failed(.geometry, "no-upward-movement")
        case .nonRigidMovement:
            return failed(.geometry, "non-rigid-movement")
        case .pressInsufficient(let region):
            return failed(.geometry, "press-insufficient-\(region.rawValue)")
        case .regionOutsideViewport:
            return failed(.geometry, "region-outside-viewport")
        }
    }

    private static func failed(
        _ category: DesktopReposReachabilityCheckCategory,
        _ reasonCode: String
    ) -> Self {
        Self(ok: false, status: .failed, category: category, reasonCode: reasonCode)
    }
}

public enum DesktopReposReachabilityValidator {
    public static func validate(
        _ trace: DesktopReposReachabilityTrace
    ) throws -> DesktopReposReachabilityValidationStatus {
        guard trace.schemaVersion == 2,
              trace.fixture == .tabRepos,
              trace.requestedContentSize == DesktopEvaluationContentSize(width: 1040, height: 680),
              trace.sampleIntervalMilliseconds == 100,
              trace.preScrollAcquisitionMilliseconds >= 0,
              trace.postScrollAcquisitionMilliseconds >= 0,
              trace.tolerancePoints.isFinite,
              trace.tolerancePoints > 0,
              trace.tolerancePoints <= 1 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        switch (trace.acquisition.status, trace.acquisition.failureReason) {
        case (.complete, nil):
            break
        case (.failed, .some(let reason)):
            throw DesktopReposReachabilityValidationError.acquisitionFailed(reason)
        case (.complete, .some), (.failed, nil):
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let press = try validateInteraction(trace.scrollInteraction)
        guard trace.ready,
              trace.quiescent,
              trace.preScrollAcquisitionMilliseconds <= 5_000,
              trace.postScrollAcquisitionMilliseconds <= 5_000 else {
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
        try validateSamples(
            trace.postScrollSamples,
            phase: .postScroll,
            tolerance: trace.tolerancePoints
        )
        guard let lastPostScrollSample = trace.postScrollSamples.last,
              trace.postScrollAcquisitionMilliseconds >= lastPostScrollSample.elapsedMilliseconds else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        try validateBehaviorGeometry(
            pre: trace.preScrollSamples,
            post: trace.postScrollSamples,
            press: press,
            tolerance: trace.tolerancePoints
        )
        return .reachable
    }

    private static func validateSamples(
        _ samples: [DesktopReposReachabilitySample],
        phase: DesktopReposReachabilityValidationPhase,
        tolerance: Double
    ) throws {
        guard samples.count >= DesktopReposReachabilitySamplingContract.minimumStableSampleCount else {
            throw DesktopReposReachabilityValidationError.insufficientSamples(phase)
        }
        guard DesktopReposReachabilitySamplingContract.hasStableCadence(
            samples.map(\.elapsedMilliseconds)
        ) else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        guard let finalSample = samples.last, finalSample.elapsedMilliseconds <= 5_000 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let baseline = samples[0]
        for (index, sample) in samples.enumerated() {
            guard sample.viewport.isFiniteAndNonempty,
                  sample.outerClip.isFiniteAndNonempty,
                  sample.boundaryScrollAncestorCount > 0 else {
                throw DesktopReposReachabilityValidationError.nonfiniteFrame(phase, index)
            }
            guard sample.viewport.contains(sample.outerClip) else {
                throw DesktopReposReachabilityValidationError.outerClipOutsideWindow
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
            if sample.outerClip.differs(from: baseline.outerClip, byMoreThan: tolerance) {
                throw DesktopReposReachabilityValidationError.unstableOuterClip
            }
            if sample.boundaryScrollAncestorCount != baseline.boundaryScrollAncestorCount {
                throw DesktopReposReachabilityValidationError.unstableScrollAncestry
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

    private static func validateInteraction(
        _ interaction: DesktopReposScrollInteraction?
    ) throws -> DesktopReposIncrementPagePressObservation {
        guard let interaction else {
            throw DesktopReposReachabilityValidationError.missingScrollInteraction
        }
        guard interaction.mechanism == .incrementPagePress,
              interaction.valueMutation == nil,
              let press = interaction.incrementPagePress,
              press.outerClipBefore.isFiniteAndNonempty else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        if !press.actionAdvertised {
            guard press.attemptCount == 0,
                  press.performResult == nil,
                  press.outerClipAfter == nil else {
                throw DesktopReposReachabilityValidationError.invalidContract
            }
            throw DesktopReposReachabilityValidationError.actionNotAdvertised
        }
        guard press.attemptCount == 1 else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        guard let result = press.performResult else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        guard result == .success else {
            throw DesktopReposReachabilityValidationError.actionPerformFailed(result)
        }
        guard let after = press.outerClipAfter, after.isFiniteAndNonempty else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        return press
    }

    private static func validateBehaviorGeometry(
        pre: [DesktopReposReachabilitySample],
        post: [DesktopReposReachabilitySample],
        press: DesktopReposIncrementPagePressObservation,
        tolerance: Double
    ) throws {
        guard let beforeSample = pre.last, let afterSample = post.first,
              let clipAfter = press.outerClipAfter else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        if exceedsEnvelopeTolerance((pre + post).map(\.viewport), tolerance: tolerance) {
            throw DesktopReposReachabilityValidationError.unstableWindow
        }
        let allClips = [press.outerClipBefore, clipAfter] + (pre + post).map(\.outerClip)
        if exceedsEnvelopeTolerance(allClips, tolerance: tolerance) {
            throw DesktopReposReachabilityValidationError.unstableOuterClip
        }
        if Set((pre + post).map(\.boundaryScrollAncestorCount)).count != 1 {
            throw DesktopReposReachabilityValidationError.unstableScrollAncestry
        }
        guard beforeSample.viewport.contains(press.outerClipBefore),
              afterSample.viewport.contains(clipAfter) else {
            throw DesktopReposReachabilityValidationError.outerClipOutsideWindow
        }
        guard let beforeBoundary = frame(.boundaryBody, in: beforeSample),
              !beforeSample.outerClip.contains(beforeBoundary) else {
            throw DesktopReposReachabilityValidationError.boundaryInitiallyInsideOuterClip
        }
        let beforeByID = Dictionary(uniqueKeysWithValues: beforeSample.regions.map { ($0.id, $0.frame) })
        let afterByID = Dictionary(uniqueKeysWithValues: afterSample.regions.map { ($0.id, $0.frame) })
        guard let referenceBefore = beforeByID[.table], let referenceAfter = afterByID[.table] else {
            throw DesktopReposReachabilityValidationError.invalidContract
        }
        let delta = referenceAfter.y - referenceBefore.y
        guard delta < -1 else {
            throw DesktopReposReachabilityValidationError.noUpwardMovement
        }
        for id in DesktopReposReachabilityRegion.allCases {
            guard let lhs = beforeByID[id], let rhs = afterByID[id],
                  abs(rhs.x - lhs.x) <= tolerance,
                  abs(rhs.width - lhs.width) <= tolerance,
                  abs(rhs.height - lhs.height) <= tolerance,
                  abs((rhs.y - lhs.y) - delta) <= tolerance else {
                throw DesktopReposReachabilityValidationError.nonRigidMovement
            }
        }
        for id in [DesktopReposReachabilityRegion.applyAllowlist, .boundaryBody] {
            for sample in post {
                guard let region = frame(id, in: sample), sample.outerClip.contains(region) else {
                    throw DesktopReposReachabilityValidationError.pressInsufficient(id)
                }
            }
        }
    }

    private static func frame(
        _ id: DesktopReposReachabilityRegion,
        in sample: DesktopReposReachabilitySample
    ) -> DesktopReposReachabilityFrame? {
        sample.regions.first(where: { $0.id == id })?.frame
    }

    private static func exceedsEnvelopeTolerance(
        _ frames: [DesktopReposReachabilityFrame],
        tolerance: Double
    ) -> Bool {
        let components = [
            frames.map(\.x),
            frames.map(\.y),
            frames.map(\.width),
            frames.map(\.height)
        ]
        return components.contains { values in
            guard let minimum = values.min(), let maximum = values.max() else { return true }
            return maximum - minimum > tolerance
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
