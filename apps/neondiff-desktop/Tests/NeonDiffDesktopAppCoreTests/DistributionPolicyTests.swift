import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@Suite struct DistributionPolicyTests {
    private let completeProof = DesktopBYOActivationProof(
        currentAccountBound: true, githubAppVerified: true,
        repositoryBound: true, apiEntitlementActive: true
    )
    @Test func distributionMarkersResolveToOneExplicitPolicy() {
        for (flags, policy) in [
            ((true, false), DesktopDistributionPolicy.byo),
            ((false, true), .managed), ((true, true), .mixed), ((false, false), .unavailable)
        ] {
            #expect(DesktopDistributionPolicyBoundary.resolve(byoEnabled: flags.0, managedBrokerConfigured: flags.1) == policy)
        }
    }
    @Test func byoPublicAndPrivateRequireExactActiveEntitlement() {
        let missingEntitlement = DesktopBYOActivationProof(currentAccountBound: true, githubAppVerified: true, repositoryBound: true, apiEntitlementActive: false)
        for visibility in [GitHubBrokerRepositoryVisibility.public, .private, .internal] {
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: visibility, proof: completeProof) == .allowed)
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: visibility, proof: missingEntitlement) == .blocked(reason: .activeExactEntitlementRequired))
        }
    }
    @Test func missingUnknownAndMixedMarkersFailClosed() {
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: nil, proof: completeProof) == .blocked(reason: .visibilityUnavailable))
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: .unknown, proof: completeProof) == .blocked(reason: .visibilityUnavailable))
        let missingAccount = DesktopBYOActivationProof(currentAccountBound: false, githubAppVerified: true, repositoryBound: true, apiEntitlementActive: true)
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .byo, visibility: .private, proof: missingAccount) == .blocked(reason: .activeExactEntitlementRequired))
        for policy in [DesktopDistributionPolicy.mixed, .unavailable] {
            #expect(DesktopDistributionPolicyBoundary.evaluate(policy: policy, visibility: .private, proof: completeProof) == .blocked(reason: .distributionMarkerInvalid))
        }
    }
    @Test func managedPublicFreeAndLegacyRestoreStayPolicyBound() {
        #expect(DesktopDistributionPolicyBoundary.evaluate(policy: .managed, visibility: .public, proof: completeProof) == .blocked(reason: .managedPublicFreeUnavailable))
        #expect(DesktopDistributionPolicyBoundary.migrateRestoredActivationState(.publicFreeSkip, policy: .managed) == .publicFreeSkip)
        for policy in [DesktopDistributionPolicy.byo, .mixed, .unavailable] {
            #expect(DesktopDistributionPolicyBoundary.migrateRestoredActivationState(.publicFreeSkip, policy: policy) == .purchaseRequired)
        }
    }
}
