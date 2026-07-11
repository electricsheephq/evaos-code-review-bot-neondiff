import Testing

@MainActor
@Suite(.serialized) struct ProviderVerificationServiceTests {
@Test func providerVerificationTransportAndStrictEnvelopeContracts() async throws {
    assertLegacyCoreCheckScenario(
        .providerVerificationTransportAndStrictEnvelopeContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runProviderVerificationTransportAndStrictEnvelopeContracts() }
    )
}

@Test func providerVerificationEscapingAndBudgetContracts() async throws {
    assertLegacyCoreCheckScenario(
        .providerVerificationEscapingAndBudgetContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runProviderVerificationEscapingAndBudgetContracts() }
    )
}
}
