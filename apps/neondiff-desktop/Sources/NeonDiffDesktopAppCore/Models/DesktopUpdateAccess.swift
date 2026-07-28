import Foundation

package enum DesktopUpdateChannel: String, Equatable, Sendable {
    case beta
    case stable
}

package enum DesktopUpdateBlockReason: String, Equatable, Sendable {
    case productionUnavailable
    case verificationRequired
    case entitlementRequired

    package var customerMessage: String {
        switch self {
        case .productionUnavailable:
            "Updates are unavailable in this build. Install a signed NeonDiff release with production activation enabled."
        case .verificationRequired:
            "Verify your current NeonDiff account or activation before checking for updates."
        case .entitlementRequired:
            "An active NeonDiff entitlement is required for this update channel."
        }
    }
}

package enum DesktopUpdateAccess: Equatable, Sendable {
    case allowed(channel: DesktopUpdateChannel)
    case blocked(reason: DesktopUpdateBlockReason)

    package var allowedChannel: DesktopUpdateChannel? {
        guard case .allowed(let channel) = self else { return nil }
        return channel
    }

    package var customerMessage: String {
        switch self {
        case .allowed:
            "Signed NeonDiff updates are available for this account."
        case .blocked(let reason):
            reason.customerMessage
        }
    }
}

package enum DesktopUpdateAccessPolicy {
    package static func evaluate(
        productionBoundaryVerified: Bool,
        accountCatalogCurrent: Bool,
        accountEntitlement: DesktopAccountEntitlement?,
        activationVerifiedThisLaunch: Bool,
        activationIsActive: Bool,
        activationUpdateEntitlement: Bool = false,
        managedPublicRepositoryVerified: Bool
    ) -> DesktopUpdateAccess {
        guard productionBoundaryVerified else {
            return .blocked(reason: .productionUnavailable)
        }

        if activationVerifiedThisLaunch && activationIsActive {
            return activationUpdateEntitlement
                ? .allowed(channel: .beta)
                : .blocked(reason: .entitlementRequired)
        }

        guard accountCatalogCurrent else {
            return .blocked(reason: .verificationRequired)
        }

        switch accountEntitlement {
        case .internalAdmin:
            return .allowed(channel: .beta)
        case .paid, .trial:
            return .blocked(reason: .verificationRequired)
        case .publicFree where managedPublicRepositoryVerified:
            return .allowed(channel: .beta)
        case .publicFree, .some(.none), nil:
            return .blocked(reason: .entitlementRequired)
        }
    }

    package static func accountCatalogIsCurrent(
        verifiedAt: Date?,
        now: Date,
        maximumAge: TimeInterval = 300
    ) -> Bool {
        guard let verifiedAt else { return false }
        let age = now.timeIntervalSince(verifiedAt)
        return age >= 0 && age <= maximumAge
    }
}

package enum DesktopUpdateCycleResult: Equatable, Sendable {
    case noUpdate
    case feedInvalid
    case networkError
    case signatureError
    case cancelled
    case failed

    package static func classify(sparkleErrorCode: Int) -> DesktopUpdateCycleResult {
        switch sparkleErrorCode {
        case 1001:
            .noUpdate
        case 1000, 1002:
            .feedInvalid
        case 2001:
            .networkError
        case 3001, 3002:
            .signatureError
        case 4007:
            .cancelled
        default:
            .failed
        }
    }
}
