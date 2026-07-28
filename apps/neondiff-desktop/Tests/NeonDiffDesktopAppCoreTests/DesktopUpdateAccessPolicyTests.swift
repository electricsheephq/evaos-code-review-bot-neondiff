import Foundation
import Testing
@testable import NeonDiffDesktopAppCore

@Suite struct DesktopUpdateAccessPolicyTests {
    @Test func currentLaunchPaidActivationAllowsBetaUpdates() {
        let access = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: false,
            accountEntitlement: nil,
            activationVerifiedThisLaunch: true,
            activationIsActive: true,
            activationUpdateEntitlement: true,
            managedPublicRepositoryVerified: false
        )

        #expect(access == .allowed(channel: .beta))
    }

    @Test func activeActivationWithoutUpdateEntitlementFailsClosed() {
        let access = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: false,
            accountEntitlement: nil,
            activationVerifiedThisLaunch: true,
            activationIsActive: true,
            activationUpdateEntitlement: false,
            managedPublicRepositoryVerified: false
        )

        #expect(access == .blocked(reason: .entitlementRequired))
    }

    @Test func currentServerInternalAdminEntitlementAllowsBetaUpdates() {
        let access = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: true,
            accountEntitlement: .internalAdmin,
            activationVerifiedThisLaunch: false,
            activationIsActive: false,
            managedPublicRepositoryVerified: false
        )

        #expect(access == .allowed(channel: .beta))
    }

    @Test func paidAndTrialSnapshotsRequireCurrentActivation() {
        for entitlement in [DesktopAccountEntitlement.paid, .trial] {
            let access = DesktopUpdateAccessPolicy.evaluate(
                productionBoundaryVerified: true,
                accountCatalogCurrent: true,
                accountEntitlement: entitlement,
                activationVerifiedThisLaunch: false,
                activationIsActive: false,
                managedPublicRepositoryVerified: false
            )

            #expect(access == .blocked(reason: .verificationRequired))
        }
    }

    @Test func staleAccountSnapshotFailsClosedWithoutCurrentActivation() {
        let access = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: false,
            accountEntitlement: .paid,
            activationVerifiedThisLaunch: false,
            activationIsActive: false,
            managedPublicRepositoryVerified: false
        )

        #expect(access == .blocked(reason: .verificationRequired))
    }

    @Test func publicFreeRequiresVerifiedManagedPublicRepository() {
        let allowed = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: true,
            accountEntitlement: .publicFree,
            activationVerifiedThisLaunch: false,
            activationIsActive: false,
            managedPublicRepositoryVerified: true
        )
        let blocked = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: true,
            accountCatalogCurrent: true,
            accountEntitlement: .publicFree,
            activationVerifiedThisLaunch: false,
            activationIsActive: false,
            managedPublicRepositoryVerified: false
        )

        #expect(allowed == .allowed(channel: .beta))
        #expect(blocked == .blocked(reason: .entitlementRequired))
    }

    @Test func missingProductionBoundaryFailsClosed() {
        let access = DesktopUpdateAccessPolicy.evaluate(
            productionBoundaryVerified: false,
            accountCatalogCurrent: true,
            accountEntitlement: .internalAdmin,
            activationVerifiedThisLaunch: true,
            activationIsActive: true,
            managedPublicRepositoryVerified: true
        )

        #expect(access == .blocked(reason: .productionUnavailable))
    }

    @Test func sparkleErrorsMapToDistinctCustomerStates() {
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 1001) == .noUpdate)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 1000) == .feedInvalid)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 1002) == .feedInvalid)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 2001) == .networkError)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 3001) == .signatureError)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 3002) == .signatureError)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 4007) == .cancelled)
        #expect(DesktopUpdateCycleResult.classify(sparkleErrorCode: 9999) == .failed)
    }

    @Test func accountCatalogFreshnessIsBoundedAndRejectsFutureProof() {
        let now = Date(timeIntervalSince1970: 10_000)

        #expect(DesktopUpdateAccessPolicy.accountCatalogIsCurrent(
            verifiedAt: now.addingTimeInterval(-299),
            now: now
        ))
        #expect(!DesktopUpdateAccessPolicy.accountCatalogIsCurrent(
            verifiedAt: now.addingTimeInterval(-301),
            now: now
        ))
        #expect(!DesktopUpdateAccessPolicy.accountCatalogIsCurrent(
            verifiedAt: now.addingTimeInterval(1),
            now: now
        ))
    }
}
