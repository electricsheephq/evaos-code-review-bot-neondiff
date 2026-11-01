import Testing
@testable import NeonDiffDesktopCore

// Issue #1203: the "Public repositories only" path completes the license step without a key.
@Suite struct OnboardingPublicFreeTests {
    @Test func publicPathCompletesTheLicenseStepWithoutAKey() {
        var flow = OnboardingFlow(providerKeyStored: true)
        flow.currentStep = .license
        flow.mode = .publicReposOnly
        flow.licenseActivation = .servicePending
        #expect(flow.canAdvance(activationState: .publicFreeSkip))
        flow.advance(activationState: .publicFreeSkip)
        #expect(flow.currentStep == .done)
    }

    @Test func publicModeStillNeedsTheFreeActivationState() {
        var flow = OnboardingFlow(providerKeyStored: true)
        flow.currentStep = .license
        flow.mode = .publicReposOnly
        flow.licenseActivation = .servicePending
        #expect(!flow.canAdvance(activationState: .purchaseRequired))
        #expect(!flow.canAdvance)
        flow.advance()
        #expect(flow.currentStep == .license)
    }

    @Test func privatePathCannotSkipActivation() {
        var flow = OnboardingFlow(providerKeyStored: true)
        flow.currentStep = .license
        flow.mode = .privateRepos
        flow.licenseActivation = .servicePending
        #expect(!flow.canAdvance(activationState: .publicFreeSkip))
        flow.licenseActivation = .activated
        #expect(flow.canAdvance)
    }
}
