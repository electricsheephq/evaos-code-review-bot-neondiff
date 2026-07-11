import Testing
@testable import NeonDiffDesktopAppCore

@MainActor
@Suite struct ProviderVisualFixtureTests {
    @Test func savedRegistryFixtureIsTheVisualAuthority() throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .savedRegistryFixtureIsTheVisualAuthority,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeUnloaded()
        fixture.model.applyProviderVerificationVisualProofFixture()

        legacy.expect(fixture.model.providers.selectedProviderId == "zcode-glm", "visual fixture selects the saved registry provider")
        legacy.expect(fixture.model.providers.registryTargets.count == 1, "visual fixture seeds one saved registry target")
        legacy.expect(fixture.model.providers.selectedRegistryTarget?.displayName == "Z.AI GLM", "visual fixture exposes registry display metadata")
        legacy.expect(fixture.model.providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true, "visual fixture target is verification eligible")
        legacy.expect(fixture.model.providers.providerKeyStored, "visual fixture exposes provider-scoped Keychain state")
        legacy.expect(fixture.model.canVerifyProviderKey, "visual fixture renders an enabled Verify action")
        legacy.expect(fixture.model.providers.openAICompatibleEndpoint != fixture.model.providers.selectedProviderBaseUrl, "legacy endpoint is not the registry authority")
        legacy.expect(fixture.model.providerVerification?.providerId == fixture.model.providers.selectedProviderId, "visual fixture result is bound to the selected registry provider")
    }
}
