import Testing

@MainActor
@Suite(.serialized) struct ProviderRegistryTests {
@Test func providerRegistryParsingAndPatchContracts() async throws {
    assertLegacyCoreCheckScenario(
        .providerRegistryParsingAndPatchContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runProviderRegistryParsingAndPatchContracts() }
    )
}
}
