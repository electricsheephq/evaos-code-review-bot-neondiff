import Foundation
import NeonDiffDesktopCore

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    guard condition() else {
        fputs("check failed: \(message)\n", stderr)
        exit(1)
    }
    return true
}

final class ModelCheckSecretStore: DesktopSecretStoring {
    var values: [String: String] = [:]

    func setSecret(_ secret: String, account: String) throws { values[account] = secret }
    func readSecret(account: String) throws -> String? { values[account] }
    func containsSecret(account: String) -> Bool { values[account] != nil }
    func deleteSecret(account: String) throws { values.removeValue(forKey: account) }
}

enum ModelCheckTransportError: Error {
    case unavailable
}

final class ControlledProviderVerificationCLI: NeonDiffCLIClienting {
    private let lock = NSLock()
    private let releaseGate = DispatchSemaphore(value: 0)
    private var storedCallCount = 0
    private var storedArguments: [String] = []
    private var storedStandardInput: Data?
    private var storedResult: CLIRunResult
    private var storedError: Error?
    private var storedBlocksUntilReleased = false
    private var storedReleased = false

    init(result: CLIRunResult) {
        storedResult = result
    }

    var callCount: Int { lock.withLock { storedCallCount } }
    var arguments: [String] { lock.withLock { storedArguments } }
    var standardInput: Data? { lock.withLock { storedStandardInput } }

    var result: CLIRunResult {
        get { lock.withLock { storedResult } }
        set { lock.withLock { storedResult = newValue } }
    }

    var error: Error? {
        get { lock.withLock { storedError } }
        set { lock.withLock { storedError = newValue } }
    }

    var blocksUntilReleased: Bool {
        get { lock.withLock { storedBlocksUntilReleased } }
        set { lock.withLock { storedBlocksUntilReleased = newValue } }
    }

    func release() {
        lock.withLock { storedReleased = true }
        releaseGate.signal()
    }

    func run(arguments: [String], standardInput: Data?, timeout: TimeInterval) throws -> CLIRunResult {
        let shouldBlock = lock.withLock { () -> Bool in
            storedCallCount += 1
            storedArguments = arguments
            storedStandardInput = standardInput
            return storedBlocksUntilReleased
        }
        if shouldBlock {
            _ = releaseGate.wait(timeout: .now() + 5)
        }
        return try lock.withLock {
            if let storedError { throw storedError }
            return storedResult
        }
    }

    func runCancellable(arguments: [String], standardInput: Data?, timeout: TimeInterval) async throws -> CLIRunResult {
        let shouldBlock = lock.withLock { () -> Bool in
            storedCallCount += 1
            storedArguments = arguments
            storedStandardInput = standardInput
            return storedBlocksUntilReleased
        }
        if shouldBlock {
            while !lock.withLock({ storedReleased }) {
                try Task.checkCancellation()
                try await Task.sleep(nanoseconds: 5_000_000)
            }
        }
        try Task.checkCancellation()
        return try lock.withLock {
            if let storedError { throw storedError }
            return storedResult
        }
    }

    func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        fatalError("provider verification must not launch a detached process")
    }
}

struct ModelFixture {
    let model: NeonDiffDesktopModel
    let cli: ControlledProviderVerificationCLI
    let keychain: ModelCheckSecretStore
}

let providerAccount = "provider/zcode-glm/api-key"
let fixtureSecret = "fixture-provider-value"
let healthyJSON = #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:00:00.000Z","providerId":"zcode-glm","state":"healthy","mode":"openai_compatible_models","detail":"Verified with redacted metadata.","redacted":true,"troubleshooting":[]}"#
let loadedRevision = String(repeating: "a", count: 64)
let providerConfigInspectJSON = #"{"ok":true,"command":"config inspect","revision":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"pilotRepos":[],"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://provider.example/v1","model":"fixture-model","authMode":"api-key-env"}}},"desktop":{}}}"#

@MainActor
func makeFixture(result: CLIRunResult, blocked: Bool = false) throws -> ModelFixture {
    let defaults = UserDefaults(suiteName: "neondiff-model-checks-\(UUID().uuidString)")!
    let keychain = ModelCheckSecretStore()
    try keychain.setSecret(fixtureSecret, account: providerAccount)
    let cli = ControlledProviderVerificationCLI(result: result)
    cli.blocksUntilReleased = blocked
    let service = ProviderVerificationService(keychain: keychain, cli: cli)
    let model = NeonDiffDesktopModel(
        userDefaults: defaults,
        keychain: keychain,
        providerVerificationService: service
    )
    model.applyCLIResultForTesting(
        CLIRunResult(exitCode: 0, stdout: providerConfigInspectJSON, stderr: ""),
        fallbackCommand: "config inspect",
        configPath: model.configPath,
        launchdLabel: model.launchdLabel,
        isConfigInspectCommand: true
    )
    return ModelFixture(model: model, cli: cli, keychain: keychain)
}

func healthySnapshot() -> ProviderVerificationSnapshot {
    ProviderVerificationSnapshot(
        ok: true,
        command: "providers verify",
        providerId: "zcode-glm",
        checkedAt: "2026-07-10T12:00:00.000Z",
        state: .healthy,
        mode: "openai_compatible_models",
        detail: "Previously verified.",
        troubleshooting: []
    )
}

@MainActor
func waitUntil(
    _ message: String,
    timeout: TimeInterval = 2,
    predicate: @escaping @MainActor () -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while !predicate(), Date() < deadline {
        try? await Task.sleep(nanoseconds: 5_000_000)
    }
    check(predicate(), message)
}

@main
struct NeonDiffDesktopModelChecks {
    @MainActor
    static func main() async throws {
        try checkVisualProofFixtureUsesSavedRegistryAuthority()
        try await checkHealthyConcurrencyAndSecretBoundary()
        try await checkStructuredNonhealthyResults()
        try await checkProviderMutationRejectsStaleResult()
        try await checkConfigMutationRejectsStaleResult()
        try await checkKeyMutationRejectsStaleResult()
        try await checkProviderScopedKeyIsolation()
        try checkProviderKeyClearAndInvalidIdentifierFailClosed()
        try await checkFailuresClearPriorState()
        try await checkWrongProviderHealthyRejected()
        try await checkCleanupTimeoutLatchesRestartRequirement()
        try checkDirtyApplyReadbackGate()
        try checkSuccessfulConfigWriteInvalidatesPriorState()
        print("NeonDiffDesktopModelChecks passed")
    }

    @MainActor
    private static func checkVisualProofFixtureUsesSavedRegistryAuthority() throws {
        setenv("NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE", "provider-verification", 1)
        defer { unsetenv("NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE") }
        let defaults = UserDefaults(suiteName: "neondiff-model-visual-fixture-\(UUID().uuidString)")!
        let model = NeonDiffDesktopModel(userDefaults: defaults, keychain: ModelCheckSecretStore())

        check(model.providers.selectedProviderId == "zcode-glm", "visual fixture selects the saved registry provider")
        check(model.providers.registryTargets.count == 1, "visual fixture seeds one saved registry target")
        check(model.providers.selectedRegistryTarget?.displayName == "Z.AI GLM", "visual fixture exposes registry display metadata")
        check(model.providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true, "visual fixture target is verification eligible")
        check(model.providers.providerKeyStored, "visual fixture exposes provider-scoped Keychain state")
        check(model.canVerifyProviderKey, "visual fixture renders an enabled Verify action")
        check(model.providers.openAICompatibleEndpoint != model.providers.selectedProviderBaseUrl, "legacy endpoint is not the registry authority")
        check(model.providerVerification?.providerId == model.providers.selectedProviderId, "visual fixture result is bound to the selected registry provider")
    }

    @MainActor
    private static func checkProviderScopedKeyIsolation() async throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""))
        let providerB = ProviderRegistryTarget(
            id: "provider-b",
            displayName: "Provider B",
            enabled: true,
            adapter: "openai-compatible",
            authMode: "api-key-env",
            baseUrl: "https://provider-b.example/v1",
            model: "provider-b-model"
        )
        fixture.model.providers.registryTargets.append(providerB)
        fixture.model.providers.selectedProviderId = providerB.id
        check(!fixture.model.providers.providerKeyStored, "selecting provider B does not reuse provider A's key state")

        let previewBJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"provider-b","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://provider.example/v1","model":"fixture-model","authMode":"api-key-env"},"provider-b":{"enabled":true,"adapter":"openai-compatible","displayName":"Provider B","baseUrl":"https://provider-b.example/v1","model":"provider-b-model","authMode":"api-key-env"}}}}}"#
        let appliedBJSON = #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"provider-b","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://provider.example/v1","model":"fixture-model","authMode":"api-key-env"},"provider-b":{"enabled":true,"adapter":"openai-compatible","displayName":"Provider B","baseUrl":"https://provider-b.example/v1","model":"provider-b-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: previewBJSON, stderr: ""),
            mode: .preview
        )
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: appliedBJSON, stderr: ""),
            mode: .apply
        )
        check(fixture.model.providers.selectedProviderId == providerB.id, "apply/readback selects provider B")
        check(!fixture.model.providers.providerKeyStored, "applied provider B remains missing until B key is stored")
        check(!fixture.model.canVerifyProviderKey, "provider B Verify stays disabled without a B-scoped key")
        let callsBeforeMissingBVerify = fixture.cli.callCount
        fixture.model.verifyProviderKey()
        check(fixture.cli.callCount == callsBeforeMissingBVerify, "provider B cannot launch verification with provider A's key")

        let providerBSecret = "fixture-provider-b-value"
        fixture.model.pendingProviderKey = providerBSecret
        fixture.model.storeProviderKey()
        check(fixture.keychain.values["provider/provider-b/api-key"] == providerBSecret, "provider B key is stored under the B-scoped account")
        check(fixture.keychain.values[providerAccount] == fixtureSecret, "storing provider B preserves provider A's scoped key")
        check(fixture.model.providers.providerKeyStored, "provider B stored state refreshes after explicit storage")
        check(fixture.model.canVerifyProviderKey, "provider B Verify enables after B key storage")

        fixture.cli.result = CLIRunResult(
            exitCode: 0,
            stdout: healthyJSON.replacingOccurrences(of: "zcode-glm", with: "provider-b"),
            stderr: ""
        )
        fixture.model.verifyProviderKey()
        await waitUntil("provider B verification completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.cli.arguments.contains("provider-b"), "provider B verification stays bound to provider B")
        check(fixture.cli.standardInput == Data(providerBSecret.utf8), "provider B verification receives only B's scoped key")
        check(fixture.model.providerVerification?.providerId == "provider-b", "provider B result installs only for B")
    }

    @MainActor
    private static func checkProviderKeyClearAndInvalidIdentifierFailClosed() throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""))
        fixture.model.clearProviderKey()
        check(fixture.keychain.values[providerAccount] == nil, "Clear Key deletes only the selected provider account")
        check(!fixture.model.providers.providerKeyStored, "Clear Key refreshes selected-provider state")
        check(!fixture.model.canVerifyProviderKey, "Clear Key disables Verify")

        fixture.keychain.values["provider/glm/api-key"] = "legacy-unscoped-value"
        let callsBeforeLegacyVerify = fixture.cli.callCount
        fixture.model.verifyProviderKey()
        check(fixture.cli.callCount == callsBeforeLegacyVerify, "legacy unscoped key is never auto-sent to the selected provider")
        check(!fixture.model.providers.providerKeyStored, "legacy unscoped key cannot restore scoped stored state")

        fixture.model.providers.selectedProviderId = "../provider-b"
        fixture.model.pendingProviderKey = "must-not-store"
        fixture.model.storeProviderKey()
        check(!fixture.keychain.values.values.contains("must-not-store"), "invalid provider id cannot create a Keychain item")
        check(!fixture.model.providers.providerKeyStored, "invalid provider id remains fail closed")
        check(fixture.model.lastError == "Select a valid provider before storing an API key.", "invalid provider id reports a fixed non-secret error")
    }

    @MainActor
    private static func checkWrongProviderHealthyRejected() async throws {
        let wrongProviderJSON = healthyJSON.replacingOccurrences(of: #""providerId":"zcode-glm""#, with: #""providerId":"other-provider""#)
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: wrongProviderJSON, stderr: ""))
        fixture.model.providerVerification = healthySnapshot()
        fixture.model.verifyProviderKey()
        await waitUntil("wrong-provider verification completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "healthy output for another provider cannot install")
        check(fixture.model.lastError?.contains("other-provider") != true, "wrong-provider rejection does not expose provider output")
    }

    @MainActor
    private static func checkCleanupTimeoutLatchesRestartRequirement() async throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""))
        fixture.cli.error = NeonDiffCLIError.cleanupTimedOut
        fixture.model.verifyProviderKey()
        await waitUntil("cleanup-timeout verification completes") { !fixture.model.isProviderVerificationInProgress }
        let restartMessage = fixture.model.providerVerificationSafetyLatchMessage
        check(restartMessage?.contains("Restart NeonDiff") == true, "unproven cleanup latches a restart-required state")
        check(fixture.model.providerVerification == nil, "cleanup timeout cannot retain verification output")
        check(!fixture.model.canVerifyProviderKey, "cleanup timeout blocks another verification")
        check(!fixture.model.canEditProviderConfiguration, "cleanup timeout blocks provider and config mutation")

        let callsBeforeRetry = fixture.cli.callCount
        fixture.model.verifyProviderKey()
        check(fixture.cli.callCount == callsBeforeRetry, "cleanup timeout cannot launch a second verification process")
        check(fixture.model.providerVerificationStatus == restartMessage, "retry remains on the fixed restart-required status")

        let commandBeforeBlockedMutation = fixture.model.lastCommandLine
        fixture.model.inspectConfig()
        fixture.model.previewProviderConfigPatch()
        fixture.model.applyProviderConfigPatch()
        fixture.model.pendingProviderKey = "must-not-store"
        fixture.model.storeProviderKey()
        check(fixture.model.lastCommandLine == commandBeforeBlockedMutation, "restart latch blocks config and CLI process mutation")
        check(fixture.model.providers.providerKeyStored, "restart latch does not mutate provider key state")
        check(fixture.model.lastError == restartMessage, "restart latch reports only the fixed redacted operator status")
    }

    @MainActor
    private static func checkDirtyApplyReadbackGate() throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""))
        check(fixture.model.canVerifyProviderKey, "saved loaded eligible provider enables Verify")
        fixture.model.providers.selectedProviderBaseUrl = "https://edited.example/v1"
        check(!fixture.model.canVerifyProviderKey, "dirty provider edits disable Verify")
        check(fixture.model.canPreviewProviderConfig, "dirty provider edit enables preview")
        check(fixture.model.providerPatchPreviewCommand.commandLine.contains("--expected-revision") && fixture.model.providerPatchPreviewCommand.commandLine.contains(loadedRevision), "provider Preview uses the loaded compare-and-swap revision")

        let previewJSON = #"{"ok":true,"command":"config patch","dryRun":true,"wrote":false,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://edited.example/v1","model":"fixture-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: previewJSON, stderr: ""),
            mode: .preview
        )
        check(!fixture.model.canVerifyProviderKey, "preview-only provider settings cannot be verified")
        check(fixture.model.canApplyProviderConfig, "exact successful preview enables Apply")
        check(fixture.model.providerPatchApplyCommand.commandLine.contains("--expected-revision") && fixture.model.providerPatchApplyCommand.commandLine.contains(loadedRevision), "provider Apply remains bound to the previewed revision")
        check(fixture.model.providerPatchApplyCommand.commandLine.contains("--confirm true"), "provider Apply uses the confirmed reversible config patch contract")

        let afterRevision = String(repeating: "b", count: 64)
        let applyJSON = #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","revisionAfter":"\#(afterRevision)","config":{"zcode":{"model":"GLM-5.2","cliPath":"zcode","appConfigPath":"zcode.json"},"providers":{"defaultProviderId":"zcode-glm","providers":{"zcode-glm":{"enabled":true,"adapter":"openai-compatible","displayName":"Fixture provider","baseUrl":"https://edited.example/v1","model":"fixture-model","authMode":"api-key-env"}}}}}"#
        fixture.model.applyProviderPatchResultForTesting(
            CLIRunResult(exitCode: 0, stdout: applyJSON, stderr: ""),
            mode: .apply
        )
        check(fixture.model.canVerifyProviderKey, "exact live apply/readback enables Verify")
    }

    @MainActor
    private static func checkHealthyConcurrencyAndSecretBoundary() async throws {
        let fixture = try makeFixture(
            result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""),
            blocked: true
        )
        fixture.model.verifyProviderKey()
        fixture.model.verifyProviderKey()
        await waitUntil("verification call starts once") { fixture.cli.callCount == 1 }
        check(fixture.model.isProviderVerificationInProgress, "verification exposes progress")
        check(!fixture.model.canVerifyProviderKey, "Verify action disables during progress")
        check(fixture.model.providerVerificationButtonTitle == "Verifying…", "Verify action exposes progress title")

        fixture.cli.release()
        await waitUntil("healthy verification completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.cli.callCount == 1, "concurrent Verify clicks launch one operation")
        check(fixture.cli.arguments == [
            "providers", "verify", "--config", "config.local.json", "--provider", "zcode-glm",
            "--expected-config-revision", loadedRevision, "--api-key-stdin", "true",
            "--allow-remote-smoke", "true", "--json"
        ], "Verify uses the exact stdin and explicit hosted-consent arguments")
        check(!fixture.cli.arguments.joined().contains(fixtureSecret), "provider secret stays out of argv")
        check(fixture.cli.standardInput == Data(fixtureSecret.utf8), "provider secret travels only over stdin")
        check(fixture.model.providerVerification?.isVerified == true, "healthy exact result is visible as verified")
        check(!String(reflecting: fixture.model.providerVerification).contains(fixtureSecret), "retained result is redacted")
        check(!fixture.model.lastCommandLine.contains(fixtureSecret), "command display is redacted")
        check(fixture.model.providerVerificationButtonTitle == "Verify API Key", "Verify title resets after completion")
    }

    @MainActor
    private static func checkStructuredNonhealthyResults() async throws {
        let fixture = try makeFixture(result: CLIRunResult(
            exitCode: 1,
            stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:01:00.000Z","providerId":"zcode-glm","state":"configured_unverified","mode":"metadata_only","detail":"Metadata only.","redacted":true,"troubleshooting":["Choose an API-key provider."]}"#,
            stderr: ""
        ))
        fixture.model.verifyProviderKey()
        await waitUntil("configured-unverified verification completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification?.state == .configuredUnverified, "configured_unverified remains visible")
        check(fixture.model.providerVerification?.isVerified == false, "configured_unverified is never verified")

        fixture.cli.result = CLIRunResult(
            exitCode: 1,
            stdout: #"{"ok":false,"command":"providers verify","checkedAt":"2026-07-10T12:02:00.000Z","providerId":"zcode-glm","state":"blocked","mode":"openai_compatible_models","detail":"Provider verification failed.","redacted":true,"troubleshooting":["Check provider credentials."]}"#,
            stderr: "provider verification did not prove health"
        )
        fixture.model.verifyProviderKey()
        await waitUntil("blocked verification completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification?.state == .blocked, "blocked remains visible")
        check(fixture.model.providerVerification?.isVerified == false, "blocked is never verified")
    }

    @MainActor
    private static func checkProviderMutationRejectsStaleResult() async throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""), blocked: true)
        fixture.model.verifyProviderKey()
        await waitUntil("provider mutation fixture starts") { fixture.cli.callCount == 1 }
        fixture.model.providers.zcodeModel = "changed-model"
        check(fixture.model.isProviderVerificationCancelling, "context mutation keeps verification busy while cleanup runs")
        check(fixture.model.providerVerificationButtonTitle == "Cancelling…", "cancellation exposes a redacted busy state")
        check(fixture.model.providerVerificationStatus.contains("Cancelling"), "cancellation status remains visible until cleanup completes")
        check(!fixture.model.canEditProviderConfiguration, "provider/config editors remain disabled during cleanup")
        fixture.model.verifyProviderKey()
        check(fixture.cli.callCount == 1, "cancelling verification cannot launch a second process")
        fixture.cli.release()
        await waitUntil("provider mutation fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "provider mutation rejects stale healthy completion")
        check(fixture.model.providerVerificationStatus.contains("changed"), "provider mutation explains invalidation")
        check(!fixture.model.isProviderVerificationCancelling, "cancellation clears only after the async operation terminates")
    }

    @MainActor
    private static func checkConfigMutationRejectsStaleResult() async throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""), blocked: true)
        fixture.model.verifyProviderKey()
        await waitUntil("config mutation fixture starts") { fixture.cli.callCount == 1 }
        fixture.model.configPath = "changed-config.json"
        fixture.cli.release()
        await waitUntil("config mutation fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "config mutation rejects stale healthy completion")
        check(fixture.model.providerVerificationStatus.contains("changed"), "config mutation explains invalidation")
    }

    @MainActor
    private static func checkKeyMutationRejectsStaleResult() async throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""), blocked: true)
        fixture.model.verifyProviderKey()
        await waitUntil("key mutation fixture starts") { fixture.cli.callCount == 1 }
        fixture.model.pendingProviderKey = "replacement-fixture-value"
        fixture.model.storeProviderKey()
        fixture.cli.release()
        await waitUntil("key mutation fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "key mutation rejects stale healthy completion")
        check(fixture.model.providerVerificationStatus.contains("changed"), "key mutation explains invalidation")
    }

    @MainActor
    private static func checkFailuresClearPriorState() async throws {
        let wrongCommand = healthyJSON.replacingOccurrences(of: "providers verify", with: "dashboard verify-provider")
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: wrongCommand, stderr: ""))
        fixture.model.providerVerification = healthySnapshot()
        fixture.model.verifyProviderKey()
        await waitUntil("wrong-command fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "wrong command clears prior state")
        check(!fixture.model.providerVerificationStatus.contains(fixtureSecret), "wrong-command status is redacted")

        fixture.model.providerVerification = healthySnapshot()
        fixture.cli.error = ModelCheckTransportError.unavailable
        fixture.model.verifyProviderKey()
        await waitUntil("transport fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "transport error clears prior state")
        check(fixture.model.lastError?.contains(fixtureSecret) != true, "transport error remains redacted")
    }

    @MainActor
    private static func checkSuccessfulConfigWriteInvalidatesPriorState() throws {
        let fixture = try makeFixture(result: CLIRunResult(exitCode: 0, stdout: healthyJSON, stderr: ""))
        fixture.model.providerVerification = healthySnapshot()
        let before = String(repeating: "b", count: 64)
        let after = String(repeating: "c", count: 64)
        let patchJSON = #"{"ok":true,"command":"config patch","dryRun":false,"wrote":true,"revisionBefore":"\#(before)","revisionAfter":"\#(after)","config":{"pilotRepos":[]}}"#
        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: patchJSON, stderr: ""),
            fallbackCommand: "neondiff config patch",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false
        )
        check(fixture.model.providerVerification == nil, "successful live config write invalidates prior verification")
        check(fixture.model.providerVerificationStatus.contains("changed"), "successful live config write explains invalidation")
    }
}
