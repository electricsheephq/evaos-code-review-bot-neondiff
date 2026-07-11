import Testing

@MainActor
@Suite(.serialized) struct ProviderVerificationServiceTests {
@Test func unexpectedVerificationSuccessIsReportedAsTestFailure() {
    #expect(throws: CoreChecksTestSupportError.self) {
        _ = try captureProviderVerificationFailure("fault-injected unexpected success") {}
    }
}

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
