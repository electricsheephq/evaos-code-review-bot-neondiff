import Testing

@MainActor
@Suite(.serialized) struct GitHubDeviceAuthTests {
@Test func githubDeviceFlowTransportContracts() async throws {
    assertLegacyCoreCheckScenario(
        .githubDeviceFlowTransportContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runGithubDeviceFlowTransportContracts() }
    )
}

@Test func detachedCommandLaunchContracts() async throws {
    assertLegacyCoreCheckScenario(
        .detachedCommandLaunchContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runDetachedCommandLaunchContracts() }
    )
}

@Test func githubRecoveryRepositoryAndRateLimitContracts() async throws {
    assertLegacyCoreCheckScenario(
        .githubRecoveryRepositoryAndRateLimitContracts,
        function: #function,
        try await LegacyCoreChecksScenarioGate.shared.run { try await runGithubRecoveryRepositoryAndRateLimitContracts() }
    )
}
}
