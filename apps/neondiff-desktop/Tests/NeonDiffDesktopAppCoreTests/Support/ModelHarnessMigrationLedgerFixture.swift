import Foundation

struct ModelHarnessMigrationLedgerEntry: Equatable, Sendable {
    let message: String
    let testFunction: String
    let fileName: String
}

let modelHarnessMigrationLedger: [ModelHarnessMigrationLedgerEntry] = [
    .init(message: "visual fixture selects the saved registry provider", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture seeds one saved registry target", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture exposes registry display metadata", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture target is verification eligible", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture exposes provider-scoped Keychain state", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture renders an enabled Verify action", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "legacy endpoint is not the registry authority", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "visual fixture result is bound to the selected registry provider", testFunction: "savedRegistryFixtureIsTheVisualAuthority", fileName: "ProviderVisualFixtureTests.swift"),
    .init(message: "selecting provider B does not reuse provider A's key state", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "apply/readback selects provider B", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "applied provider B remains missing until B key is stored", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B Verify stays disabled without a B-scoped key", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B cannot launch verification with provider A's key", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B key is stored under the B-scoped account", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "storing provider B preserves provider A's scoped key", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B stored state refreshes after explicit storage", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B Verify enables after B key storage", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B verification stays bound to provider B", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B verification receives only B's scoped key", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "provider B result installs only for B", testFunction: "selectedProviderNeverReusesAnotherOrLegacyKey", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "Clear Key deletes only the selected provider account", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "Clear Key refreshes selected-provider state", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "Clear Key disables Verify", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "legacy unscoped key is never auto-sent to the selected provider", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "legacy unscoped key cannot restore scoped stored state", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "invalid provider id cannot create a Keychain item", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "invalid provider id remains fail closed", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "invalid provider id reports a fixed non-secret error", testFunction: "clearingAndInvalidIdentifiersFailClosed", fileName: "ProviderKeyScopingTests.swift"),
    .init(message: "healthy output for another provider cannot install", testFunction: "wrongProviderHealthyResultIsRejectedWithoutOutputLeakage", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "wrong-provider rejection does not expose provider output", testFunction: "wrongProviderHealthyResultIsRejectedWithoutOutputLeakage", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "unproven cleanup latches a restart-required state", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cleanup timeout cannot retain verification output", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cleanup timeout blocks another verification", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cleanup timeout blocks provider and config mutation", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cleanup timeout cannot launch a second verification process", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "retry remains on the fixed restart-required status", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "restart latch blocks config and CLI process mutation", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "restart latch does not mutate provider key state", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "restart latch reports only the fixed redacted operator status", testFunction: "cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "saved loaded eligible provider enables Verify", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "dirty provider edits disable Verify", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "dirty provider edit enables preview", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "provider Preview uses the loaded compare-and-swap revision", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "preview-only provider settings cannot be verified", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "exact successful preview enables Apply", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "provider Apply remains bound to the previewed revision", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "provider Apply uses the confirmed reversible config patch contract", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "exact live apply/readback enables Verify", testFunction: "dirtyEditRequiresExactPreviewAndConfirmedApplyReadback", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "verification exposes progress", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "Verify action disables during progress", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "Verify action exposes progress title", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "concurrent Verify clicks launch one operation", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "Verify uses the exact stdin and explicit hosted-consent arguments", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "provider secret stays out of argv", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "provider secret travels only over stdin", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "healthy exact result is visible as verified", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "retained result is redacted", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "command display is redacted", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "Verify title resets after completion", testFunction: "concurrentVerifyClicksLaunchOneStdinOnlyOperation", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "configured_unverified remains visible", testFunction: "configuredUnverifiedAndBlockedRemainNonhealthy", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "configured_unverified is never verified", testFunction: "configuredUnverifiedAndBlockedRemainNonhealthy", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "blocked remains visible", testFunction: "configuredUnverifiedAndBlockedRemainNonhealthy", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "blocked is never verified", testFunction: "configuredUnverifiedAndBlockedRemainNonhealthy", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "context mutation keeps verification busy while cleanup runs", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cancellation exposes a redacted busy state", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cancellation status remains visible until cleanup completes", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "provider/config editors remain disabled during cleanup", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cancelling verification cannot launch a second process", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "provider mutation rejects stale healthy completion", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "provider mutation explains invalidation", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "cancellation clears only after the async operation terminates", testFunction: "providerMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "config mutation rejects stale healthy completion", testFunction: "configMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "config mutation explains invalidation", testFunction: "configMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "key mutation rejects stale healthy completion", testFunction: "keyMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "key mutation explains invalidation", testFunction: "keyMutationCancelsAndRejectsStaleCompletion", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "wrong command clears prior state", testFunction: "wrongCommandAndTransportFailuresClearPriorStateRedacted", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "wrong-command status is redacted", testFunction: "wrongCommandAndTransportFailuresClearPriorStateRedacted", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "transport error clears prior state", testFunction: "wrongCommandAndTransportFailuresClearPriorStateRedacted", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "transport error remains redacted", testFunction: "wrongCommandAndTransportFailuresClearPriorStateRedacted", fileName: "ProviderVerificationStateMachineTests.swift"),
    .init(message: "successful live config write invalidates prior verification", testFunction: "successfulLiveConfigWriteInvalidatesVerification", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "successful live config write explains invalidation", testFunction: "successfulLiveConfigWriteInvalidatesVerification", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "provider patch proof records an active owning invocation", testFunction: "onlyOwningProviderPatchResponseConsumesPendingProof", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "an unrelated completion and rejected overlap cannot consume the active provider proof", testFunction: "onlyOwningProviderPatchResponseConsumesPendingProof", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "only the owning provider patch response completes the operation", testFunction: "onlyOwningProviderPatchResponseConsumesPendingProof", fileName: "ProviderConfigurationPatchTests.swift"),
    .init(message: "the owning provider patch response consumes its exact proof", testFunction: "onlyOwningProviderPatchResponseConsumesPendingProof", fileName: "ProviderConfigurationPatchTests.swift"),
]

func modelHarnessMigrationSource(fileName: String) throws -> String {
    let supportDirectory = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
    let testsDirectory = supportDirectory.deletingLastPathComponent()
    return try String(
        contentsOf: testsDirectory.appendingPathComponent(fileName),
        encoding: .utf8
    )
}

func modelHarnessFunctionBody(
    _ function: String,
    in source: String
) -> Substring? {
    guard let start = source.range(of: "@Test func \(function)")?.lowerBound else { return nil }
    let suffix = source[start...]
    guard let next = suffix.dropFirst().range(of: "@Test func ")?.lowerBound else { return suffix }
    return suffix[..<next]
}
