import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite struct ProviderKeyScopingTests {
    @Test func selectedProviderNeverReusesAnotherOrLegacyKey() async throws {
        let fixture = try ProviderModelFixture.makeLoaded()
        let providerB = ProviderRegistryTarget(
            id: "provider-b",
            displayName: "Provider B",
            enabled: true,
            adapter: "openai-compatible",
            authMode: "api-key-env",
            baseUrl: "https://provider-b.example/v1",
            model: "provider-b-model"
        )
        fixture.model.providers.registryTargets.append(providerB)
        fixture.model.providers.selectedProviderId = providerB.id

        #expect(!fixture.model.providers.providerKeyStored) // selecting provider B does not reuse provider A's key state

        fixture.applyProviderBReadback(providerB)
        #expect(fixture.model.providers.selectedProviderId == providerB.id) // apply/readback selects provider B
        #expect(!fixture.model.providers.providerKeyStored) // applied provider B remains missing until B key is stored
        #expect(!fixture.model.canVerifyProviderKey) // provider B Verify stays disabled without a B-scoped key

        let callsBeforeMissingBVerify = fixture.cli.calls.count
        fixture.model.verifyProviderKey()
        #expect(fixture.cli.calls.count == callsBeforeMissingBVerify) // provider B cannot launch verification with provider A's key

        fixture.model.pendingProviderKey = fixture.providerBSecret
        fixture.model.storeProviderKey()
        #expect(fixture.keychain.values[fixture.providerBAccount] == fixture.providerBSecret) // provider B key is stored under the B-scoped account
        #expect(fixture.keychain.values[fixture.providerAAccount] == fixture.providerASecret) // storing provider B preserves provider A's scoped key
        #expect(fixture.model.providers.providerKeyStored) // provider B stored state refreshes after explicit storage
        #expect(fixture.model.canVerifyProviderKey) // provider B Verify enables after B key storage

        fixture.cli.result = fixture.healthyResult(providerId: providerB.id, revision: fixture.providerBRevision)
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(callsBeforeMissingBVerify + 1)
        await fixture.waitForVerificationToFinish()

        #expect(fixture.cli.calls.last?.arguments.contains("provider-b") == true) // provider B verification stays bound to provider B
        #expect(fixture.cli.calls.last?.standardInput == fixtureData(fixture.providerBSecret)) // provider B verification receives only B's scoped key
        #expect(fixture.model.providerVerification?.providerId == "provider-b") // provider B result installs only for B
    }

    @Test func clearingAndInvalidIdentifiersFailClosed() throws {
        let fixture = try ProviderModelFixture.makeLoaded()
        fixture.model.clearProviderKey()

        #expect(fixture.keychain.values[fixture.providerAAccount] == nil) // Clear Key deletes only the selected provider account
        #expect(!fixture.model.providers.providerKeyStored) // Clear Key refreshes selected-provider state
        #expect(!fixture.model.canVerifyProviderKey) // Clear Key disables Verify

        fixture.keychain.values["provider/glm/api-key"] = "legacy-unscoped-value"
        let callsBeforeLegacyVerify = fixture.cli.calls.count
        fixture.model.verifyProviderKey()
        #expect(fixture.cli.calls.count == callsBeforeLegacyVerify) // legacy unscoped key is never auto-sent to the selected provider
        #expect(!fixture.model.providers.providerKeyStored) // legacy unscoped key cannot restore scoped stored state

        fixture.model.providers.selectedProviderId = "../provider-b"
        fixture.model.pendingProviderKey = "must-not-store"
        fixture.model.storeProviderKey()
        #expect(!fixture.keychain.values.values.contains("must-not-store")) // invalid provider id cannot create a Keychain item
        #expect(!fixture.model.providers.providerKeyStored) // invalid provider id remains fail closed
        #expect(fixture.model.lastError == "Select a valid provider before storing an API key.") // invalid provider id reports a fixed non-secret error
    }
}
