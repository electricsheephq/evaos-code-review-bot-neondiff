import Testing

@MainActor
@Suite(.serialized) struct ConfigParsingTests {
@Test func configInspectAndPatchContracts() async throws {
    assertLegacyCoreCheckScenario(
        .configInspectAndPatchContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runConfigInspectAndPatchContracts() }
    )
}
}
