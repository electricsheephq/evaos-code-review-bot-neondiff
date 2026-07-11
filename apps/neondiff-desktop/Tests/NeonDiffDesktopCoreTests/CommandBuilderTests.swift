import Testing

@MainActor
@Suite(.serialized) struct CommandBuilderTests {
@Test func onboardingFlowContracts() async throws {
    assertLegacyCoreCheckScenario(
        .onboardingFlowContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runOnboardingFlowContracts() }
    )
}

@Test func cliResolutionAndStandardInputContracts() async throws {
    assertLegacyCoreCheckScenario(
        .cliResolutionAndStandardInputContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runCliResolutionAndStandardInputContracts() }
    )
}

@Test func cliCancellationContracts() async throws {
    assertLegacyCoreCheckScenario(
        .cliCancellationContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runCliCancellationContracts() }
    )
}

@Test func cliStandardInputTimeoutContracts() async throws {
    assertLegacyCoreCheckScenario(
        .cliStandardInputTimeoutContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runCliStandardInputTimeoutContracts() }
    )
}

@Test func cliCleanupDeadlineAndOutputContracts() async throws {
    assertLegacyCoreCheckScenario(
        .cliCleanupDeadlineAndOutputContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runCliCleanupDeadlineAndOutputContracts() }
    )
}
}
