import Testing
@testable import NeonDiffDesktopAppCore

@MainActor
@Suite struct ProviderVisualFixtureTests {
    @Test func savedRegistryFixtureIsTheVisualAuthority() throws {
        let fixture = try ProviderModelFixture.makeUnloaded()
        fixture.model.applyProviderVerificationVisualProofFixture()

        #expect(fixture.model.providers.selectedProviderId == "zcode-glm") // visual fixture selects the saved registry provider
        #expect(fixture.model.providers.registryTargets.count == 1) // visual fixture seeds one saved registry target
        #expect(fixture.model.providers.selectedRegistryTarget?.displayName == "Z.AI GLM") // visual fixture exposes registry display metadata
        #expect(fixture.model.providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true) // visual fixture target is verification eligible
        #expect(fixture.model.providers.providerKeyStored) // visual fixture exposes provider-scoped Keychain state
        #expect(fixture.model.canVerifyProviderKey) // visual fixture renders an enabled Verify action
        #expect(fixture.model.providers.openAICompatibleEndpoint != fixture.model.providers.selectedProviderBaseUrl) // legacy endpoint is not the registry authority
        #expect(fixture.model.providerVerification?.providerId == fixture.model.providers.selectedProviderId) // visual fixture result is bound to the selected registry provider
    }
}
