import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ProviderVerificationStateMachineTests {
    @Test func concurrentVerifyClicksLaunchOneStdinOnlyOperation() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .concurrentVerifyClicksLaunchOneStdinOnlyOperation,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded(blocked: true)

        fixture.model.verifyProviderKey()
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)

        legacy.expect(fixture.model.isProviderVerificationInProgress, "verification exposes progress")
        legacy.expect(!fixture.model.canVerifyProviderKey, "Verify action disables during progress")
        legacy.expect(fixture.model.providerVerificationButtonTitle == "Verifying…", "Verify action exposes progress title")

        fixture.cli.release()
        await fixture.waitForVerificationToFinish()

        legacy.expect(fixture.cli.calls.count == 1, "concurrent Verify clicks launch one operation")
        legacy.expect(
            fixture.cli.calls[0].arguments == [
                "providers", "verify", "--config", "config.local.json", "--provider", "zcode-glm",
                "--expected-config-revision", ProviderModelFixture.loadedRevision, "--api-key-stdin", "true",
                "--allow-remote-smoke", "true", "--json"
            ],
            "Verify uses the exact stdin and explicit hosted-consent arguments"
        )
        legacy.expect(!fixture.cli.calls[0].arguments.joined().contains(fixture.providerASecret), "provider secret stays out of argv")
        legacy.expect(fixture.cli.calls[0].standardInput == fixtureData(fixture.providerASecret), "provider secret travels only over stdin")
        legacy.expect(fixture.model.providerVerification?.isVerified == true, "healthy exact result is visible as verified")
        legacy.expect(!String(reflecting: fixture.model.providerVerification).contains(fixture.providerASecret), "retained result is redacted")
        #expect(!String(reflecting: fixture.model).contains(fixture.providerASecret))
        legacy.expect(!fixture.model.lastCommandLine.contains(fixture.providerASecret), "command display is redacted")
        legacy.expect(fixture.model.providerVerificationButtonTitle == "Verify API Key", "Verify title resets after completion")
        #expect(!fixture.model.providerVerificationStatus.contains(fixture.providerASecret))
        #expect(fixture.model.lastError?.contains(fixture.providerASecret) != true)
        #expect(!String(reflecting: fixture.cli.calls[0].arguments).contains(fixture.providerASecret))
    }

    @Test func configuredUnverifiedAndBlockedRemainNonhealthy() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .configuredUnverifiedAndBlockedRemainNonhealthy,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let configured = CLIRunResult(
            exitCode: 1,
            stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:01:00.000Z","providerId":"zcode-glm","state":"configured_unverified","mode":"metadata_only","detail":"Metadata only.","redacted":true,"troubleshooting":["Choose an API-key provider."],"configRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            stderr: ""
        )
        let fixture = try ProviderModelFixture.makeLoaded(result: configured)

        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification?.state == .configuredUnverified, "configured_unverified remains visible")
        legacy.expect(fixture.model.providerVerification?.isVerified == false, "configured_unverified is never verified")

        fixture.cli.result = CLIRunResult(
            exitCode: 1,
            stdout: #"{"ok":false,"command":"providers verify","checkedAt":"2026-07-10T12:02:00.000Z","providerId":"zcode-glm","state":"blocked","mode":"openai_compatible_models","detail":"Provider verification failed.","redacted":true,"troubleshooting":["Check provider credentials."],"configRevision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}"#,
            stderr: "provider verification did not prove health"
        )
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(2)
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification?.state == .blocked, "blocked remains visible")
        legacy.expect(fixture.model.providerVerification?.isVerified == false, "blocked is never verified")
    }

    @Test func providerMutationCancelsAndRejectsStaleCompletion() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .providerMutationCancelsAndRejectsStaleCompletion,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded(blocked: true)
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)

        fixture.model.providers.zcodeModel = "changed-model"
        legacy.expect(fixture.model.isProviderVerificationCancelling, "context mutation keeps verification busy while cleanup runs")
        legacy.expect(fixture.model.providerVerificationButtonTitle == "Cancelling…", "cancellation exposes a redacted busy state")
        legacy.expect(fixture.model.providerVerificationStatus.contains("Cancelling"), "cancellation status remains visible until cleanup completes")
        legacy.expect(!fixture.model.canEditProviderConfiguration, "provider/config editors remain disabled during cleanup")
        fixture.model.verifyProviderKey()
        legacy.expect(fixture.cli.calls.count == 1, "cancelling verification cannot launch a second process")

        fixture.cli.release()
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "provider mutation rejects stale healthy completion")
        legacy.expect(fixture.model.providerVerificationStatus.contains("changed"), "provider mutation explains invalidation")
        legacy.expect(!fixture.model.isProviderVerificationCancelling, "cancellation clears only after the async operation terminates")
    }

    @Test func configMutationCancelsAndRejectsStaleCompletion() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .configMutationCancelsAndRejectsStaleCompletion,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded(blocked: true)
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)

        fixture.model.configPath = "changed-config.json"
        fixture.cli.release()
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "config mutation rejects stale healthy completion")
        legacy.expect(fixture.model.providerVerificationStatus.contains("changed"), "config mutation explains invalidation")
    }

    @Test func keyMutationCancelsAndRejectsStaleCompletion() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .keyMutationCancelsAndRejectsStaleCompletion,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded(blocked: true)
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)

        fixture.model.pendingProviderKey = "replacement-fixture-value"
        fixture.model.storeProviderKey()
        fixture.cli.release()
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "key mutation rejects stale healthy completion")
        legacy.expect(fixture.model.providerVerificationStatus.contains("changed"), "key mutation explains invalidation")
    }

    @Test func wrongCommandAndTransportFailuresClearPriorStateRedacted() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .wrongCommandAndTransportFailuresClearPriorStateRedacted,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let wrongCommand = ProviderModelFixture.healthyResult(
            providerId: "zcode-glm",
            revision: ProviderModelFixture.loadedRevision
        ).stdout.replacingOccurrences(of: "providers verify", with: "dashboard verify-provider")
        let fixture = try ProviderModelFixture.makeLoaded(
            result: CLIRunResult(exitCode: 0, stdout: wrongCommand, stderr: "")
        )
        fixture.model.providerVerification = healthyProviderSnapshot()
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "wrong command clears prior state")
        legacy.expect(!fixture.model.providerVerificationStatus.contains(fixture.providerASecret), "wrong-command status is redacted")

        fixture.model.providerVerification = healthyProviderSnapshot()
        fixture.cli.error = ProviderFixtureTransportError.unavailable("transport exposed \(fixture.providerASecret)")
        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(2)
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "transport error clears prior state")
        legacy.expect(fixture.model.lastError?.contains(fixture.providerASecret) != true, "transport error remains redacted")
    }

    @Test func wrongProviderHealthyResultIsRejectedWithoutOutputLeakage() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .wrongProviderHealthyResultIsRejectedWithoutOutputLeakage,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded(
            result: ProviderModelFixture.healthyResult(
                providerId: "other-provider",
                revision: ProviderModelFixture.loadedRevision
            )
        )
        fixture.model.providerVerification = healthyProviderSnapshot()

        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForVerificationToFinish()
        legacy.expect(fixture.model.providerVerification == nil, "healthy output for another provider cannot install")
        legacy.expect(fixture.model.lastError?.contains("other-provider") != true, "wrong-provider rejection does not expose provider output")
    }

    @Test func cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation() async throws {
        let legacy = LegacyModelHarnessAssertionContext(
            scenario: .cleanupTimeoutLatchesRestartAndBlocksRetryOrMutation,
            function: #function
        )
        defer { legacy.verifyComplete() }
        let fixture = try ProviderModelFixture.makeLoaded()
        fixture.cli.error = NeonDiffCLIError.cleanupTimedOut

        fixture.model.verifyProviderKey()
        await fixture.cli.waitUntilCallCount(1)
        await fixture.waitForVerificationToFinish()
        let restartMessage = fixture.model.providerVerificationSafetyLatchMessage
        legacy.expect(restartMessage?.contains("Restart NeonDiff") == true, "unproven cleanup latches a restart-required state")
        legacy.expect(fixture.model.providerVerification == nil, "cleanup timeout cannot retain verification output")
        legacy.expect(!fixture.model.canVerifyProviderKey, "cleanup timeout blocks another verification")
        legacy.expect(!fixture.model.canEditProviderConfiguration, "cleanup timeout blocks provider and config mutation")

        let callsBeforeRetry = fixture.cli.calls.count
        fixture.model.verifyProviderKey()
        legacy.expect(fixture.cli.calls.count == callsBeforeRetry, "cleanup timeout cannot launch a second verification process")
        legacy.expect(fixture.model.providerVerificationStatus == restartMessage, "retry remains on the fixed restart-required status")

        let commandBeforeBlockedMutation = fixture.model.lastCommandLine
        fixture.model.inspectConfig()
        fixture.model.previewProviderConfigPatch()
        fixture.model.applyProviderConfigPatch()
        fixture.model.pendingProviderKey = "must-not-store"
        fixture.model.storeProviderKey()
        legacy.expect(fixture.model.lastCommandLine == commandBeforeBlockedMutation, "restart latch blocks config and CLI process mutation")
        legacy.expect(fixture.model.providers.providerKeyStored, "restart latch does not mutate provider key state")
        legacy.expect(fixture.model.lastError == restartMessage, "restart latch reports only the fixed redacted operator status")
    }
}
