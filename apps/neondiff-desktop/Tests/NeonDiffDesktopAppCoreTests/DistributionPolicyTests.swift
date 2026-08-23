import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct DistributionPolicyTests {
    private let completeProof = DesktopBYOActivationProof(
        currentAccountBound: true, githubAppVerified: true,
        repositoryBound: true, apiEntitlementActive: true
    )

    @Test func distributionMarkersResolveToOneExplicitPolicy() {
        #expect(DesktopDistributionPolicyBoundary.resolve(byoEnabled: true, managedBrokerConfigured: false) == .byo)
        #expect(DesktopDistributionPolicyBoundary.resolve(byoEnabled: false, managedBrokerConfigured: true) == .managed)
        #expect(DesktopDistributionPolicyBoundary.resolve(byoEnabled: true, managedBrokerConfigured: true) == .mixed)
        #expect(DesktopDistributionPolicyBoundary.resolve(byoEnabled: false, managedBrokerConfigured: false) == .unavailable)
    }

    @Test func byoPublicAndPrivateRequireExactActiveEntitlement() {
        let missingEntitlement = DesktopBYOActivationProof(
            currentAccountBound: true, githubAppVerified: true,
            repositoryBound: true, apiEntitlementActive: false
        )
        for visibility in [GitHubBrokerRepositoryVisibility.public, .private, .internal] {
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: visibility, proof: completeProof) == .allowed)
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: visibility, proof: missingEntitlement) == .blocked(reason: .activeExactEntitlementRequired))
        }
    }

    @Test func missingUnknownAndMixedMarkersFailClosed() {
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: nil, proof: completeProof) == .blocked(reason: .visibilityUnavailable))
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: .unknown, proof: completeProof) == .blocked(reason: .visibilityUnavailable))
        let missingAccount = DesktopBYOActivationProof(
            currentAccountBound: false, githubAppVerified: true,
            repositoryBound: true, apiEntitlementActive: true
        )
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: .private, proof: missingAccount) == .blocked(reason: .activeExactEntitlementRequired))
        for policy in [DesktopDistributionPolicy.mixed, .unavailable] {
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: policy, visibility: .private, proof: completeProof) == .blocked(reason: .distributionMarkerInvalid))
        }
    }

    @Test func managedPublicFreeIsUnavailableUntilManagedMilestone() {
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .managed, visibility: .public, proof: completeProof) == .blocked(reason: .managedPublicFreeUnavailable))
    }

    @Test func legacyPublicFreeRestoreIsOnlyPreservedForManagedPolicy() {
        #expect(DesktopDistributionPolicyBoundary.migrateRestoredActivationState(.publicFreeSkip, policy: .managed) == .publicFreeSkip)
        for policy in [DesktopDistributionPolicy.byo, .mixed, .unavailable] {
            #expect(DesktopDistributionPolicyBoundary.migrateRestoredActivationState(.publicFreeSkip, policy: policy) == .purchaseRequired)
        }
    }
}
