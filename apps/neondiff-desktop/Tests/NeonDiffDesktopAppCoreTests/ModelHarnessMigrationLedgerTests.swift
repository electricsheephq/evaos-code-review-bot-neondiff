import Testing

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ModelHarnessMigrationLedgerTests {
    @Test func everyLegacyAssertionExecutesExactlyOnceInItsNamedScenario() async throws {
        let aggregate = LegacyModelHarnessAggregate()

        try await LegacyModelHarnessExecution.$aggregate.withValue(aggregate) {
            try ProviderVisualFixtureTests().savedRegistryFixtureIsTheVisualAuthority()

            let keyScoping = ProviderKeyScopingTests()
            try await keyScoping.selectedProviderNeverReusesAnotherOrLegacyKey()
            try keyScoping.clearingAndInvalidIdentifiersFailClosed()

            let verification = ProviderVerificationStateMachineTests()
            try await verification.concurrentVerifyClicksLaunchOneStdinOnlyOperation()
            try await verification.configuredUnverifiedAndBlockedRemainNonhealthy()
            try await verification.providerMutationCancelsAndRejectsStaleCompletion()
            try await verification.configMutationCancelsAndRejectsStaleCompletion()
            try await verification.keyMutationCancelsAndRejectsStaleCompletion()
            try await verification.wrongCommandAndTransportFailuresClearPriorStateRedacted()
            try await verification.wrongProviderHealthyResultIsRejectedWithoutOutputLeakage()
            try await verification.cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation()

            let patching = ProviderConfigurationPatchTests()
            try patching.dirtyEditRequiresExactPreviewAndConfirmedApplyReadback()
            try patching.successfulLiveConfigWriteInvalidatesVerification()
            try patching.onlyOwningProviderPatchResponseConsumesPendingProof()
        }

        aggregate.verifyComplete()
    }
}
