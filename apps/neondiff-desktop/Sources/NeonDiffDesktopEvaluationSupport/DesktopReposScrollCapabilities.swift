import Foundation

public enum DesktopReposScrollCapabilityContractError: Error, Equatable, Sendable {
    case invalidOperatingSystemVersion
    case missingBoundaryActionNames
    case unexpectedBoundaryActionNames
    case missingScrollBarActionNames
    case unexpectedScrollBarActionNames
    case missingIncrementPageActionNames
    case unexpectedIncrementPageActionNames
    case missingActionName
}

public enum DesktopReposScrollCapabilitiesValidationError: Error, Equatable, Sendable {
    case invalidContract
}

public struct DesktopReposIncrementPageCandidate: Equatable, Sendable {
    public let role: String?
    public let subrole: String?

    public init(role: String?, subrole: String?) {
        self.role = role
        self.subrole = subrole
    }
}

public enum DesktopReposIncrementPageSelection: Equatable, Sendable {
    case directChild(index: Int)
    case unsupported
}

public enum DesktopReposIncrementPageSelectionError: Error, Equatable, Sendable {
    case missingRole
    case missingSubrole
    case invalidIncrementPageRole
    case duplicateIncrementPage
}

public enum DesktopReposIncrementPageSelectionContract {
    public static let buttonRole = "AXButton"
    public static let incrementPageSubrole = "AXIncrementPage"

    public static func select(
        directChildren: [DesktopReposIncrementPageCandidate]
    ) throws -> DesktopReposIncrementPageSelection {
        var incrementPageIndices: [Int] = []
        for (index, child) in directChildren.enumerated() {
            guard let role = child.role else {
                throw DesktopReposIncrementPageSelectionError.missingRole
            }
            guard let subrole = child.subrole else {
                throw DesktopReposIncrementPageSelectionError.missingSubrole
            }
            guard subrole == incrementPageSubrole else { continue }
            guard role == buttonRole else {
                throw DesktopReposIncrementPageSelectionError.invalidIncrementPageRole
            }
            incrementPageIndices.append(index)
        }
        switch incrementPageIndices.count {
        case 0:
            return .unsupported
        case 1:
            return .directChild(index: incrementPageIndices[0])
        default:
            throw DesktopReposIncrementPageSelectionError.duplicateIncrementPage
        }
    }
}

public struct DesktopReposScrollCapabilities: Codable, Equatable, Sendable {
    public let schemaVersion: Int
    public let fixture: DesktopReposReachabilityFixture
    public let requestedContentSize: DesktopEvaluationContentSize
    public let osMajorVersion: Int
    public let acquisition: DesktopReposReachabilityAcquisition
    public let scrollToVisibleActionAvailable: Bool
    public let boundaryAdvertisesScrollToVisible: Bool?
    public let outerVerticalScrollBarResolved: Bool?
    public let outerVerticalScrollBarAdvertisesIncrement: Bool?
    public let outerVerticalIncrementPageResolved: Bool?
    public let outerVerticalIncrementPageAdvertisesPress: Bool?

    public init(
        schemaVersion: Int = 1,
        fixture: DesktopReposReachabilityFixture = .tabRepos,
        requestedContentSize: DesktopEvaluationContentSize = .init(width: 1040, height: 680),
        osMajorVersion: Int,
        acquisition: DesktopReposReachabilityAcquisition,
        scrollToVisibleActionAvailable: Bool,
        boundaryAdvertisesScrollToVisible: Bool?,
        outerVerticalScrollBarResolved: Bool?,
        outerVerticalScrollBarAdvertisesIncrement: Bool?,
        outerVerticalIncrementPageResolved: Bool?,
        outerVerticalIncrementPageAdvertisesPress: Bool?
    ) {
        self.schemaVersion = schemaVersion
        self.fixture = fixture
        self.requestedContentSize = requestedContentSize
        self.osMajorVersion = osMajorVersion
        self.acquisition = acquisition
        self.scrollToVisibleActionAvailable = scrollToVisibleActionAvailable
        self.boundaryAdvertisesScrollToVisible = boundaryAdvertisesScrollToVisible
        self.outerVerticalScrollBarResolved = outerVerticalScrollBarResolved
        self.outerVerticalScrollBarAdvertisesIncrement = outerVerticalScrollBarAdvertisesIncrement
        self.outerVerticalIncrementPageResolved = outerVerticalIncrementPageResolved
        self.outerVerticalIncrementPageAdvertisesPress = outerVerticalIncrementPageAdvertisesPress
    }

    public static func failed(
        osMajorVersion: Int,
        reason: DesktopReposReachabilityAcquisitionFailureReason
    ) -> Self {
        Self(
            fixture: .tabRepos,
            requestedContentSize: .init(width: 1040, height: 680),
            osMajorVersion: osMajorVersion,
            acquisition: .init(status: .failed, failureReason: reason),
            scrollToVisibleActionAvailable: osMajorVersion >= 26,
            boundaryAdvertisesScrollToVisible: nil,
            outerVerticalScrollBarResolved: nil,
            outerVerticalScrollBarAdvertisesIncrement: nil,
            outerVerticalIncrementPageResolved: nil,
            outerVerticalIncrementPageAdvertisesPress: nil
        )
    }

    public func validated() throws -> Self {
        guard schemaVersion == 1,
              fixture == .tabRepos,
              requestedContentSize == .init(width: 1040, height: 680),
              (1...100).contains(osMajorVersion),
              scrollToVisibleActionAvailable == (osMajorVersion >= 26) else {
            throw DesktopReposScrollCapabilitiesValidationError.invalidContract
        }

        switch acquisition.status {
        case .complete:
            guard acquisition.failureReason == nil,
                  let boundaryAdvertisesScrollToVisible,
                  let outerVerticalScrollBarResolved,
                  let outerVerticalScrollBarAdvertisesIncrement,
                  let outerVerticalIncrementPageResolved,
                  let outerVerticalIncrementPageAdvertisesPress,
                  scrollToVisibleActionAvailable || !boundaryAdvertisesScrollToVisible,
                  outerVerticalScrollBarResolved || !outerVerticalScrollBarAdvertisesIncrement,
                  outerVerticalScrollBarResolved || !outerVerticalIncrementPageResolved,
                  outerVerticalIncrementPageResolved || !outerVerticalIncrementPageAdvertisesPress else {
                throw DesktopReposScrollCapabilitiesValidationError.invalidContract
            }
        case .failed:
            guard acquisition.failureReason != nil,
                  boundaryAdvertisesScrollToVisible == nil,
                  outerVerticalScrollBarResolved == nil,
                  outerVerticalScrollBarAdvertisesIncrement == nil,
                  outerVerticalIncrementPageResolved == nil,
                  outerVerticalIncrementPageAdvertisesPress == nil else {
                throw DesktopReposScrollCapabilitiesValidationError.invalidContract
            }
        }
        return self
    }

    public static func decode(data: Data) throws -> Self {
        do {
            guard data.count <= 4_096,
                  let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
                  Set(object.keys) == Set(CodingKeys.allCases.map(\.rawValue)),
                  let acquisition = object[CodingKeys.acquisition.rawValue] as? [String: Any],
                  Set(acquisition.keys) == Set(["status", "failureReason"]),
                  let requestedContentSize = object[CodingKeys.requestedContentSize.rawValue] as? [String: Any],
                  Set(requestedContentSize.keys) == Set(["width", "height"]) else {
                throw DesktopReposScrollCapabilitiesValidationError.invalidContract
            }
            return try JSONDecoder().decode(Self.self, from: data).validated()
        } catch let error as DesktopReposScrollCapabilitiesValidationError {
            throw error
        } catch {
            throw DesktopReposScrollCapabilitiesValidationError.invalidContract
        }
    }

    private enum CodingKeys: String, CodingKey, CaseIterable {
        case schemaVersion
        case fixture
        case requestedContentSize
        case osMajorVersion
        case acquisition
        case scrollToVisibleActionAvailable
        case boundaryAdvertisesScrollToVisible
        case outerVerticalScrollBarResolved
        case outerVerticalScrollBarAdvertisesIncrement
        case outerVerticalIncrementPageResolved
        case outerVerticalIncrementPageAdvertisesPress
    }

    public init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        guard container.allKeys.count == CodingKeys.allCases.count,
              CodingKeys.allCases.allSatisfy(container.contains) else {
            throw DesktopReposScrollCapabilitiesValidationError.invalidContract
        }
        schemaVersion = try container.decode(Int.self, forKey: .schemaVersion)
        fixture = try container.decode(DesktopReposReachabilityFixture.self, forKey: .fixture)
        requestedContentSize = try container.decode(
            DesktopEvaluationContentSize.self,
            forKey: .requestedContentSize
        )
        osMajorVersion = try container.decode(Int.self, forKey: .osMajorVersion)
        acquisition = try container.decode(DesktopReposReachabilityAcquisition.self, forKey: .acquisition)
        scrollToVisibleActionAvailable = try container.decode(Bool.self, forKey: .scrollToVisibleActionAvailable)
        boundaryAdvertisesScrollToVisible = try container.decodeIfPresent(
            Bool.self,
            forKey: .boundaryAdvertisesScrollToVisible
        )
        outerVerticalScrollBarResolved = try container.decodeIfPresent(
            Bool.self,
            forKey: .outerVerticalScrollBarResolved
        )
        outerVerticalScrollBarAdvertisesIncrement = try container.decodeIfPresent(
            Bool.self,
            forKey: .outerVerticalScrollBarAdvertisesIncrement
        )
        outerVerticalIncrementPageResolved = try container.decodeIfPresent(
            Bool.self,
            forKey: .outerVerticalIncrementPageResolved
        )
        outerVerticalIncrementPageAdvertisesPress = try container.decodeIfPresent(
            Bool.self,
            forKey: .outerVerticalIncrementPageAdvertisesPress
        )
    }

    public func encode(to encoder: Encoder) throws {
        var container = encoder.container(keyedBy: CodingKeys.self)
        try container.encode(schemaVersion, forKey: .schemaVersion)
        try container.encode(fixture, forKey: .fixture)
        try container.encode(requestedContentSize, forKey: .requestedContentSize)
        try container.encode(osMajorVersion, forKey: .osMajorVersion)
        try container.encode(acquisition, forKey: .acquisition)
        try container.encode(scrollToVisibleActionAvailable, forKey: .scrollToVisibleActionAvailable)
        if let boundaryAdvertisesScrollToVisible {
            try container.encode(boundaryAdvertisesScrollToVisible, forKey: .boundaryAdvertisesScrollToVisible)
        } else {
            try container.encodeNil(forKey: .boundaryAdvertisesScrollToVisible)
        }
        if let outerVerticalScrollBarResolved {
            try container.encode(outerVerticalScrollBarResolved, forKey: .outerVerticalScrollBarResolved)
        } else {
            try container.encodeNil(forKey: .outerVerticalScrollBarResolved)
        }
        if let outerVerticalScrollBarAdvertisesIncrement {
            try container.encode(
                outerVerticalScrollBarAdvertisesIncrement,
                forKey: .outerVerticalScrollBarAdvertisesIncrement
            )
        } else {
            try container.encodeNil(forKey: .outerVerticalScrollBarAdvertisesIncrement)
        }
        if let outerVerticalIncrementPageResolved {
            try container.encode(
                outerVerticalIncrementPageResolved,
                forKey: .outerVerticalIncrementPageResolved
            )
        } else {
            try container.encodeNil(forKey: .outerVerticalIncrementPageResolved)
        }
        if let outerVerticalIncrementPageAdvertisesPress {
            try container.encode(
                outerVerticalIncrementPageAdvertisesPress,
                forKey: .outerVerticalIncrementPageAdvertisesPress
            )
        } else {
            try container.encodeNil(forKey: .outerVerticalIncrementPageAdvertisesPress)
        }
    }
}

public enum DesktopReposScrollCapabilityContract {
    public static func evaluate(
        osMajorVersion: Int,
        boundaryActionNames: [String]?,
        verticalScrollBarResolved: Bool,
        scrollBarActionNames: [String]?,
        incrementPageResolved: Bool,
        incrementPageActionNames: [String]?,
        scrollToVisibleActionName: String?,
        incrementActionName: String,
        pressActionName: String
    ) throws -> DesktopReposScrollCapabilities {
        guard (1...100).contains(osMajorVersion) else {
            throw DesktopReposScrollCapabilityContractError.invalidOperatingSystemVersion
        }
        guard !incrementActionName.isEmpty, !pressActionName.isEmpty else {
            throw DesktopReposScrollCapabilityContractError.missingActionName
        }

        let incrementPageAdvertisesPress: Bool
        if incrementPageResolved {
            guard let incrementPageActionNames else {
                throw DesktopReposScrollCapabilityContractError.missingIncrementPageActionNames
            }
            incrementPageAdvertisesPress = incrementPageActionNames.contains(pressActionName)
        } else {
            guard incrementPageActionNames == nil else {
                throw DesktopReposScrollCapabilityContractError.unexpectedIncrementPageActionNames
            }
            incrementPageAdvertisesPress = false
        }

        let scrollToVisibleAvailable = osMajorVersion >= 26
        let boundaryAdvertisesScrollToVisible: Bool
        if scrollToVisibleAvailable {
            guard let boundaryActionNames else {
                throw DesktopReposScrollCapabilityContractError.missingBoundaryActionNames
            }
            guard let scrollToVisibleActionName, !scrollToVisibleActionName.isEmpty else {
                throw DesktopReposScrollCapabilityContractError.missingActionName
            }
            boundaryAdvertisesScrollToVisible = boundaryActionNames.contains(scrollToVisibleActionName)
        } else {
            guard boundaryActionNames == nil else {
                throw DesktopReposScrollCapabilityContractError.unexpectedBoundaryActionNames
            }
            boundaryAdvertisesScrollToVisible = false
        }

        let advertisesIncrement: Bool
        if verticalScrollBarResolved {
            guard let scrollBarActionNames else {
                throw DesktopReposScrollCapabilityContractError.missingScrollBarActionNames
            }
            advertisesIncrement = scrollBarActionNames.contains(incrementActionName)
        } else {
            guard scrollBarActionNames == nil else {
                throw DesktopReposScrollCapabilityContractError.unexpectedScrollBarActionNames
            }
            advertisesIncrement = false
        }

        return try DesktopReposScrollCapabilities(
            fixture: .tabRepos,
            requestedContentSize: .init(width: 1040, height: 680),
            osMajorVersion: osMajorVersion,
            acquisition: .init(status: .complete, failureReason: nil),
            scrollToVisibleActionAvailable: scrollToVisibleAvailable,
            boundaryAdvertisesScrollToVisible: boundaryAdvertisesScrollToVisible,
            outerVerticalScrollBarResolved: verticalScrollBarResolved,
            outerVerticalScrollBarAdvertisesIncrement: advertisesIncrement,
            outerVerticalIncrementPageResolved: incrementPageResolved,
            outerVerticalIncrementPageAdvertisesPress: incrementPageAdvertisesPress
        ).validated()
    }
}
