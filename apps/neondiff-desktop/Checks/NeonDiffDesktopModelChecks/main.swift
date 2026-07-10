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

    func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        fatalError("provider verification must not launch a detached process")
    }
}

struct ModelFixture {
    let model: NeonDiffDesktopModel
    let cli: ControlledProviderVerificationCLI
}

let providerAccount = "provider/glm/api-key"
let fixtureSecret = "fixture-provider-value"
let healthyJSON = #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:00:00.000Z","providerId":"zcode-glm","state":"healthy","mode":"openai_compatible_models","detail":"Verified with redacted metadata.","redacted":true,"troubleshooting":[]}"#

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
    return ModelFixture(model: model, cli: cli)
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
        try await checkHealthyConcurrencyAndSecretBoundary()
        try await checkStructuredNonhealthyResults()
        try await checkProviderMutationRejectsStaleResult()
        try await checkConfigMutationRejectsStaleResult()
        try await checkKeyMutationRejectsStaleResult()
        try await checkFailuresClearPriorState()
        try checkSuccessfulConfigWriteInvalidatesPriorState()
        print("NeonDiffDesktopModelChecks passed")
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
            "providers", "verify", "--config", "config.local.json", "--api-key-stdin", "true",
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
            stdout: #"{"ok":true,"command":"providers verify","checkedAt":"2026-07-10T12:01:00.000Z","providerId":"github-copilot","state":"configured_unverified","mode":"metadata_only","detail":"Metadata only.","redacted":true,"troubleshooting":["Choose an API-key provider."]}"#,
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
        fixture.cli.release()
        await waitUntil("provider mutation fixture completes") { !fixture.model.isProviderVerificationInProgress }
        check(fixture.model.providerVerification == nil, "provider mutation rejects stale healthy completion")
        check(fixture.model.providerVerificationStatus.contains("changed"), "provider mutation explains invalidation")
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
