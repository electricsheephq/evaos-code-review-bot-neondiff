import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite struct ProviderKeyScopingTests {
    @Test func selectedProviderNeverReusesAnotherOrLegacyKey() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .selectedProviderNeverReusesAnotherOrLegacyKey,
            function: #function
        )
        defer { legacy.verifyComplete() }
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

        legacy.expect(!fixture.model.providers.providerKeyStored, "selecting provider B does not reuse provider A's key state")

        fixture.applyProviderBReadback(providerB)
        legacy.expect(fixture.model.providers.selectedProviderId == providerB.id, "apply/readback selects provider B")
        legacy.expect(!fixture.model.providers.providerKeyStored, "applied provider B remains missing until B key is stored")
        legacy.expect(!fixture.model.canVerifyProviderKey, "provider B Verify stays disabled without a B-scoped key")

        let callsBeforeMissingBVerify = fixture.cli.calls.count
        fixture.model.verifyProviderKey()
        legacy.expect(fixture.cli.calls.count == callsBeforeMissingBVerify, "provider B cannot launch verification with provider A's key")

        fixture.model.pendingProviderKey = fixture.providerBSecret
        fixture.model.storeProviderKey()
        legacy.expect(fixture.keychain.values[fixture.providerBAccount] == fixture.providerBSecret, "provider B key is stored under the B-scoped account")
        legacy.expect(fixture.keychain.values[fixture.providerAAccount] == fixture.providerASecret, "storing provider B preserves provider A's scoped key")
        legacy.expect(fixture.model.providers.providerKeyStored, "provider B stored state refreshes after explicit storage")
        legacy.expect(fixture.model.canVerifyProviderKey, "provider B Verify enables after B key storage")

        fixture.cli.result = fixture.healthyResult(providerId: providerB.id, revision: fixture.providerBRevision)
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(callsBeforeMissingBVerify + 1)
        await fixture.waitForVerificationToFinish()

        legacy.expect(fixture.cli.calls.last?.arguments.contains("provider-b") == true, "provider B verification stays bound to provider B")
        legacy.expect(fixture.cli.calls.last?.standardInput == fixtureData(fixture.providerBSecret), "provider B verification receives only B's scoped key")
        legacy.expect(fixture.model.providerVerification?.providerId == "provider-b", "provider B result installs only for B")
    }

    @Test func clearingAndInvalidIdentifiersFailClosed() throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .clearingAndInvalidIdentifiersFailClosed,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded()
        fixture.model.clearProviderKey()

        legacy.expect(fixture.keychain.values[fixture.providerAAccount] == nil, "Clear Key deletes only the selected provider account")
        legacy.expect(!fixture.model.providers.providerKeyStored, "Clear Key refreshes selected-provider state")
        legacy.expect(!fixture.model.canVerifyProviderKey, "Clear Key disables Verify")

        fixture.keychain.values["provider/glm/api-key"] = "legacy-unscoped-value"
        let callsBeforeLegacyVerify = fixture.cli.calls.count
        fixture.model.verifyProviderKey()
        legacy.expect(fixture.cli.calls.count == callsBeforeLegacyVerify, "legacy unscoped key is never auto-sent to the selected provider")
        legacy.expect(!fixture.model.providers.providerKeyStored, "legacy unscoped key cannot restore scoped stored state")

        fixture.model.providers.selectedProviderId = "../provider-b"
        fixture.model.pendingProviderKey = "must-not-store"
        fixture.model.storeProviderKey()
        legacy.expect(!fixture.keychain.values.values.contains("must-not-store"), "invalid provider id cannot create a Keychain item")
        legacy.expect(!fixture.model.providers.providerKeyStored, "invalid provider id remains fail closed")
        legacy.expect(fixture.model.lastError == "Select a valid provider before storing an API key.", "invalid provider id reports a fixed non-secret error")
    }
}
