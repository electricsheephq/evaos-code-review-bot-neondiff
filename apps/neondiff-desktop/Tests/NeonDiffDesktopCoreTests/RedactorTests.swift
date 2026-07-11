import Testing

@MainActor
@Suite(.serialized) struct RedactorTests {
@Test func canonicalRedactorCorpusContracts() async throws {
    assertLegacyCoreCheckScenario(
        .canonicalRedactorCorpusContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runCanonicalRedactorCorpusContracts() }
    )
}
}
