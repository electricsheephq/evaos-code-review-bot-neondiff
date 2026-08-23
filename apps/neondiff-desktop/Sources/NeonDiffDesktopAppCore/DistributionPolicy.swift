import NeonDiffDesktopCore

// Mac GA is BYO. Managed public-free remains milestone-20-owned.
package enum DesktopDistributionPolicy: String, Equatable, Sendable {
    case byo, managed, mixed, unavailable
}

package struct DesktopBYOActivationProof: Equatable, Sendable {
    package let currentAccountBound: Bool
    package let githubAppVerified: Bool
    package let repositoryBound: Bool
    package let apiEntitlementActive: Bool
    package init(currentAccountBound: Bool, githubAppVerified: Bool, repositoryBound: Bool, apiEntitlementActive: Bool) {
        self.currentAccountBound = currentAccountBound
        self.githubAppVerified = githubAppVerified
        self.repositoryBound = repositoryBound
        self.apiEntitlementActive = apiEntitlementActive
    }
    package var isComplete: Bool { currentAccountBound && githubAppVerified && repositoryBound && apiEntitlementActive }
}

package enum DesktopDistributionBlockReason: Equatable, Sendable {
    case distributionMarkerInvalid, visibilityUnavailable
    case activeExactEntitlementRequired, managedPublicFreeUnavailable
}

package enum DesktopDistributionAccess: Equatable, Sendable {
    case allowed
    case blocked(reason: DesktopDistributionBlockReason)
}

package enum DesktopDistributionPolicyBoundary {
    package static func resolve(byoEnabled: Bool, managedBrokerConfigured: Bool) -> DesktopDistributionPolicy {
        switch (byoEnabled, managedBrokerConfigured) {
        case (true, false): .byo
        case (false, true): .managed
        case (true, true): .mixed
        case (false, false): .unavailable
        }
    }

    package static func evaluate(policy: DesktopDistributionPolicy, proof: DesktopBYOActivationProof) -> DesktopDistributionAccess {
        guard policy == .byo else { return .blocked(reason: .distributionMarkerInvalid) }
        return proof.isComplete ? .allowed : .blocked(reason: .activeExactEntitlementRequired)
    }

    // Visibility must be broker-authoritative; managed public-free is not in GA.
    package static func evaluate(policy: DesktopDistributionPolicy, visibility: GitHubBrokerRepositoryVisibility?, proof: DesktopBYOActivationProof) -> DesktopDistributionAccess {
        guard let visibility, visibility != .unknown else { return .blocked(reason: .visibilityUnavailable) }
        switch policy {
        case .byo: return evaluate(policy: policy, proof: proof)
        case .managed where visibility == .public: return .blocked(reason: .managedPublicFreeUnavailable)
        case .managed: return proof.isComplete ? .allowed : .blocked(reason: .activeExactEntitlementRequired)
        case .mixed, .unavailable: return .blocked(reason: .distributionMarkerInvalid)
        }
    }
}
