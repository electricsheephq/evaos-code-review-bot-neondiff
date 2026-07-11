import Testing

@MainActor
@Suite struct CoreChecksMigrationLedgerTests {
    @Test func inventoryDigestDistinguishesEmbeddedNewlinesFromMessageBoundaries() {
        #expect(coreChecksSHA256(["a\nb", "c"]) != coreChecksSHA256(["a", "b\nc"]))
    }

    @Test func everyLegacyAssertionExecutesThroughItsNamedScenario() async throws {
        let aggregate = LegacyCoreChecksAggregate()

        try await LegacyCoreChecksExecution.$aggregate.withValue(aggregate) {
            let command = CommandBuilderTests()
            try await command.onboardingFlowContracts()
            try await command.cliResolutionAndStandardInputContracts()
            try await command.cliCancellationContracts()
            try await command.cliStandardInputTimeoutContracts()
            try await command.cliCleanupDeadlineAndOutputContracts()

            let github = GitHubDeviceAuthTests()
            try await github.githubDeviceFlowTransportContracts()
            try await github.detachedCommandLaunchContracts()
            try await github.githubRecoveryRepositoryAndRateLimitContracts()

            try await ConfigParsingTests().configInspectAndPatchContracts()
            try await ProviderRegistryTests().providerRegistryParsingAndPatchContracts()

            let verification = ProviderVerificationServiceTests()
            try await verification.providerVerificationTransportAndStrictEnvelopeContracts()
            try await RedactorTests().canonicalRedactorCorpusContracts()
            try await verification.providerVerificationEscapingAndBudgetContracts()
        }

        aggregate.verifyComplete()
    }
}
