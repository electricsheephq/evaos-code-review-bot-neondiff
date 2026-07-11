import Testing

enum LegacyModelHarnessScenario: String, CaseIterable, Sendable {
    case savedRegistryFixtureIsTheVisualAuthority
    case selectedProviderNeverReusesAnotherOrLegacyKey
    case clearingAndInvalidIdentifiersFailClosed
    case wrongProviderHealthyResultIsRejectedWithoutOutputLeakage
    case cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation
    case dirtyEditRequiresExactPreviewAndConfirmedApplyReadback
    case concurrentVerifyClicksLaunchOneStdinOnlyOperation
    case configuredUnverifiedAndBlockedRemainNonhealthy
    case providerMutationCancelsAndRejectsStaleCompletion
    case configMutationCancelsAndRejectsStaleCompletion
    case keyMutationCancelsAndRejectsStaleCompletion
    case wrongCommandAndTransportFailuresClearPriorStateRedacted
    case successfulLiveConfigWriteInvalidatesVerification
    case onlyOwningProviderPatchResponseConsumesPendingProof
}

struct LegacyModelHarnessMapping: Equatable, Sendable {
    let message: String
    let scenario: LegacyModelHarnessScenario
}

let modelHarnessMigrationLedger: [LegacyModelHarnessMapping] = [
    .init(message: "visual fixture selects the saved registry provider", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture seeds one saved registry target", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture exposes registry display metadata", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture target is verification eligible", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture exposes provider-scoped Keychain state", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture renders an enabled Verify action", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "legacy endpoint is not the registry authority", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "visual fixture result is bound to the selected registry provider", scenario: .savedRegistryFixtureIsTheVisualAuthority),
    .init(message: "selecting provider B does not reuse provider A's key state", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "apply/readback selects provider B", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "applied provider B remains missing until B key is stored", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B Verify stays disabled without a B-scoped key", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B cannot launch verification with provider A's key", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B key is stored under the B-scoped account", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "storing provider B preserves provider A's scoped key", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B stored state refreshes after explicit storage", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B Verify enables after B key storage", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B verification stays bound to provider B", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B verification receives only B's scoped key", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "provider B result installs only for B", scenario: .selectedProviderNeverReusesAnotherOrLegacyKey),
    .init(message: "Clear Key deletes only the selected provider account", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "Clear Key refreshes selected-provider state", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "Clear Key disables Verify", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "legacy unscoped key is never auto-sent to the selected provider", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "legacy unscoped key cannot restore scoped stored state", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "invalid provider id cannot create a Keychain item", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "invalid provider id remains fail closed", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "invalid provider id reports a fixed non-secret error", scenario: .clearingAndInvalidIdentifiersFailClosed),
    .init(message: "healthy output for another provider cannot install", scenario: .wrongProviderHealthyResultIsRejectedWithoutOutputLeakage),
    .init(message: "wrong-provider rejection does not expose provider output", scenario: .wrongProviderHealthyResultIsRejectedWithoutOutputLeakage),
    .init(message: "unproven cleanup latches a restart-required state", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "cleanup timeout cannot retain verification output", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "cleanup timeout blocks another verification", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "cleanup timeout blocks provider and config mutation", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "cleanup timeout cannot launch a second verification process", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "retry remains on the fixed restart-required status", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "restart latch blocks config and CLI process mutation", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "restart latch does not mutate provider key state", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "restart latch reports only the fixed redacted operator status", scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation),
    .init(message: "saved loaded eligible provider enables Verify", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "dirty provider edits disable Verify", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "dirty provider edit enables preview", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "provider Preview uses the loaded compare-and-swap revision", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "preview-only provider settings cannot be verified", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "exact successful preview enables Apply", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "provider Apply remains bound to the previewed revision", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "provider Apply uses the confirmed reversible config patch contract", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "exact live apply/readback enables Verify", scenario: .dirtyEditRequiresExactPreviewAndConfirmedApplyReadback),
    .init(message: "verification exposes progress", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "Verify action disables during progress", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "Verify action exposes progress title", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "concurrent Verify clicks launch one operation", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "Verify uses the exact stdin and explicit hosted-consent arguments", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "provider secret stays out of argv", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "provider secret travels only over stdin", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "healthy exact result is visible as verified", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "retained result is redacted", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "command display is redacted", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "Verify title resets after completion", scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation),
    .init(message: "configured_unverified remains visible", scenario: .configuredUnverifiedAndBlockedRemainNonhealthy),
    .init(message: "configured_unverified is never verified", scenario: .configuredUnverifiedAndBlockedRemainNonhealthy),
    .init(message: "blocked remains visible", scenario: .configuredUnverifiedAndBlockedRemainNonhealthy),
    .init(message: "blocked is never verified", scenario: .configuredUnverifiedAndBlockedRemainNonhealthy),
    .init(message: "context mutation keeps verification busy while cleanup runs", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "cancellation exposes a redacted busy state", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "cancellation status remains visible until cleanup completes", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "provider/config editors remain disabled during cleanup", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "cancelling verification cannot launch a second process", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "provider mutation rejects stale healthy completion", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "provider mutation explains invalidation", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "cancellation clears only after the async operation terminates", scenario: .providerMutationCancelsAndRejectsStaleCompletion),
    .init(message: "config mutation rejects stale healthy completion", scenario: .configMutationCancelsAndRejectsStaleCompletion),
    .init(message: "config mutation explains invalidation", scenario: .configMutationCancelsAndRejectsStaleCompletion),
    .init(message: "key mutation rejects stale healthy completion", scenario: .keyMutationCancelsAndRejectsStaleCompletion),
    .init(message: "key mutation explains invalidation", scenario: .keyMutationCancelsAndRejectsStaleCompletion),
    .init(message: "wrong command clears prior state", scenario: .wrongCommandAndTransportFailuresClearPriorStateRedacted),
    .init(message: "wrong-command status is redacted", scenario: .wrongCommandAndTransportFailuresClearPriorStateRedacted),
    .init(message: "transport error clears prior state", scenario: .wrongCommandAndTransportFailuresClearPriorStateRedacted),
    .init(message: "transport error remains redacted", scenario: .wrongCommandAndTransportFailuresClearPriorStateRedacted),
    .init(message: "successful live config write invalidates prior verification", scenario: .successfulLiveConfigWriteInvalidatesVerification),
    .init(message: "successful live config write explains invalidation", scenario: .successfulLiveConfigWriteInvalidatesVerification),
    .init(message: "provider patch proof records an active owning invocation", scenario: .onlyOwningProviderPatchResponseConsumesPendingProof),
    .init(message: "an unrelated completion and rejected overlap cannot consume the active provider proof", scenario: .onlyOwningProviderPatchResponseConsumesPendingProof),
    .init(message: "only the owning provider patch response completes the operation", scenario: .onlyOwningProviderPatchResponseConsumesPendingProof),
    .init(message: "the owning provider patch response consumes its exact proof", scenario: .onlyOwningProviderPatchResponseConsumesPendingProof),
]

enum LegacyModelHarnessExecution {
    @TaskLocal static var aggregate: LegacyModelHarnessAggregate?
}

@MainActor
final class LegacyModelHarnessAggregate: @unchecked Sendable {
    private var scenarioCounts: [LegacyModelHarnessScenario: Int] = [:]
    private var messageCounts: [String: Int] = [:]

    func recordScenario(_ scenario: LegacyModelHarnessScenario) {
        scenarioCounts[scenario, default: 0] += 1
    }

    func recordMessage(_ message: String) {
        messageCounts[message, default: 0] += 1
    }

    func verifyComplete() {
        #expect(LegacyModelHarnessScenario.allCases.count == 14)
        #expect(modelHarnessMigrationLedger.count == 85)
        #expect(Set(modelHarnessMigrationLedger.map(\.message)).count == 85)
        #expect(scenarioCounts.count == 14)
        #expect(messageCounts.count == 85)
        for scenario in LegacyModelHarnessScenario.allCases {
            #expect(scenarioCounts[scenario] == 1, Comment("scenario \(scenario.rawValue) must execute exactly once"))
        }
        for mapping in modelHarnessMigrationLedger {
            #expect(messageCounts[mapping.message] == 1, Comment(rawValue: mapping.message))
        }
    }
}

@MainActor
final class LegacyModelHarnessAssertionContext {
    private let scenario: LegacyModelHarnessScenario
    private let expectedMessages: Set<String>
    private var messageCounts: [String: Int] = [:]

    init(scenario: LegacyModelHarnessScenario, function: String) {
        self.scenario = scenario
        expectedMessages = Set(
            modelHarnessMigrationLedger
                .filter { $0.scenario == scenario }
                .map(\.message)
        )
        let currentFunction = String(function.prefix { $0 != "(" })
        #expect(currentFunction == scenario.rawValue, Comment("scenario mapping must match the executing test function"))
        #expect(!expectedMessages.isEmpty, Comment("scenario must retain at least one legacy assertion"))
        LegacyModelHarnessExecution.aggregate?.recordScenario(scenario)
    }

    func expect(
        _ condition: @autoclosure () -> Bool,
        _ message: String
    ) {
        #expect(expectedMessages.contains(message), Comment("unmapped legacy assertion: \(message)"))
        messageCounts[message, default: 0] += 1
        #expect(messageCounts[message] == 1, Comment("duplicated legacy assertion: \(message)"))
        LegacyModelHarnessExecution.aggregate?.recordMessage(message)
        #expect(condition(), Comment(rawValue: message))
    }

    func verifyComplete() {
        #expect(messageCounts.count == expectedMessages.count, Comment("scenario \(scenario.rawValue) must execute every mapped assertion"))
        for message in expectedMessages {
            #expect(messageCounts[message] == 1, Comment(rawValue: message))
        }
    }
}
