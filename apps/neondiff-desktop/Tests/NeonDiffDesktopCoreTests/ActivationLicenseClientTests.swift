import Foundation
import Testing
@testable import NeonDiffDesktopCore

// Issue #612 — the license-client seam. The native client passes the NeonDiff
// Activation Key to the CLI over BOUNDED STDIN (never argv/env/config/logs) and
// parses the CLI's redacted `LicenseStatusResult` JSON — the same wire the
// production license lifecycle (PR #574) emits. These fixtures reproduce the
// entitlement contract: success / expiry / revocation / replay-conflict /
// timeout / offline. No live license-API mutation.
@Suite struct ActivationLicenseClientTests {
    /// Records how the client invoked the CLI so the stdin-only invariant can be
    /// proven, and returns a canned fixture result (or throws a canned error).
    private final class StubCLI: NeonDiffCLIClienting, @unchecked Sendable {
        let fixture: Result<CLIRunResult, Error>
        private(set) var lastArguments: [String] = []
        private(set) var lastStandardInput: Data?

        init(_ fixture: Result<CLIRunResult, Error>) { self.fixture = fixture }

        func run(arguments: [String], standardInput: Data?, timeout: TimeInterval) throws -> CLIRunResult {
            lastArguments = arguments
            lastStandardInput = standardInput
            return try fixture.get()
        }

        func launchDetached(arguments: [String]) throws -> CLILaunchResult {
            throw NeonDiffCLIError.launchFailed("not used")
        }
    }

    private func client(_ fixture: Result<CLIRunResult, Error>) -> (CLIActivationLicenseClient, StubCLI) {
        let stub = StubCLI(fixture)
        return (CLIActivationLicenseClient(cli: stub, configPath: "config.local.json"), stub)
    }

    private func success(_ json: String) -> Result<CLIRunResult, Error> {
        .success(CLIRunResult(exitCode: 0, stdout: json, stderr: ""))
    }

    private func failure(exitCode: Int32, _ json: String) -> Result<CLIRunResult, Error> {
        .success(CLIRunResult(exitCode: exitCode, stdout: json, stderr: ""))
    }

    private let activeJSON = """
    {"command":"license activate","ok":true,"status":"active","source":"api","checkedAt":"2026-07-15T00:00:00.000Z",
     "entitlement":{"status":"active","repoVisibilityScope":"private","privateRepoAllowed":true,
     "updateEntitlement":true,"expiresAt":"2027-01-01T00:00:00.000Z","plan":"team","seats":3},
     "detail":"license API returned active entitlement"}
    """

    @Test func successActivationParsesActiveEntitlement() async throws {
        let (client, _) = client(success(activeJSON))
        let outcome = try await client.activate(key: ActivationKeyMaterial("NDL-REALKEY-0123456789"))
        guard case let .active(summary) = outcome else {
            Issue.record("expected .active, got \(outcome)"); return
        }
        #expect(summary.status == .active)
        #expect(summary.repoVisibilityScope == "private")
        #expect(summary.privateRepoAllowed == true)
        #expect(summary.plan == "team")
        #expect(summary.seats == 3)
    }

    @Test func keyIsPassedOverStdinNeverArgv() async throws {
        let (client, stub) = client(success(activeJSON))
        let key = ActivationKeyMaterial("NDL-REALKEY-0123456789")
        _ = try await client.activate(key: key)
        // The raw key crosses only over bounded stdin.
        #expect(stub.lastStandardInput == Data("NDL-REALKEY-0123456789".utf8))
        // ...and NEVER through argv.
        for arg in stub.lastArguments {
            #expect(!arg.contains("NDL-REALKEY-0123456789"), "raw key leaked into argv: \(arg)")
        }
        #expect(stub.lastArguments.contains("--license-key-stdin"))
        #expect(stub.lastArguments.contains("--json"))
        #expect(!stub.lastArguments.contains("--license-key"))
    }

    @Test func expiryFixtureMapsToExpired() async throws {
        let json = #"{"command":"license activate","ok":false,"status":"expired","source":"api","checkedAt":"x","detail":"license API returned 402: expired"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        let outcome = try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789"))
        #expect(outcome == .expired(nil))
    }

    @Test func revocationFixtureMapsToRevoked() async throws {
        let json = #"{"command":"license activate","ok":false,"status":"revoked","source":"api","checkedAt":"x","detail":"license API returned 403: revoked"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        let outcome = try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789"))
        #expect(outcome == .revoked(nil))
    }

    @Test func invalidFixtureMapsToInvalid() async throws {
        let json = #"{"command":"license activate","ok":false,"status":"invalid","source":"api","checkedAt":"x","detail":"license API returned 404: invalid"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .invalid)
    }

    @Test func replayConflictFixtureMapsToScopeConflict() async throws {
        // Single-activation seat exhausted by another machine (409 scope_mismatch).
        let json = #"{"command":"license activate","ok":false,"status":"scope_mismatch","source":"api","checkedAt":"x","detail":"license API returned 409: scope_mismatch"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .scopeConflict)
    }

    @Test func networkFixtureMapsToOffline() async throws {
        let json = #"{"command":"license activate","ok":false,"status":"network","source":"none","checkedAt":"x","detail":"license API network failure"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .offline)
    }

    @Test func serverFixtureMapsToServiceError() async throws {
        let json = #"{"command":"license activate","ok":false,"status":"server","source":"none","checkedAt":"x","detail":"license API returned 500"}"#
        let (client, _) = client(failure(exitCode: 1, json))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .serviceError)
    }

    @Test func timeoutErrorMapsToOffline() async throws {
        let (client, _) = client(.failure(NeonDiffCLIError.timedOut))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .offline)
    }

    @Test func launchFailureMapsToServiceError() async throws {
        let (client, _) = client(.failure(NeonDiffCLIError.launchFailed("neondiff not found")))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .serviceError)
    }

    @Test func malformedOutputMapsToServiceError() async throws {
        let (client, _) = client(success("not json at all"))
        #expect(try await client.activate(key: ActivationKeyMaterial("NDL-K-0123456789")) == .serviceError)
    }

    @Test func outcomeEventsDriveTheStateMachine() {
        // The client's outcome→event mapping must move activation_pending to the
        // matching terminal state — the seam that wires the client to the machine.
        let cases: [(ActivationClientOutcome, ActivationState)] = [
            (.active(.init(status: .active, repoVisibilityScope: "private", privateRepoAllowed: true, updateEntitlement: true, expiresAt: nil, plan: nil, seats: nil)), .active),
            (.expired(nil), .expired),
            (.revoked(nil), .revoked),
            (.invalid, .invalid),
            (.scopeConflict, .invalid),
            (.offline, .offline),
            (.serviceError, .serviceError),
            (.malformed, .serviceError)
        ]
        for (outcome, expected) in cases {
            let event = ActivationLicenseOutcomeMapping.event(for: outcome)
            #expect(ActivationStateMachine.reduce(.activationPending, on: event) == expected,
                    "outcome \(outcome) should land in \(expected.rawValue)")
        }
    }

    @Test func entitlementScopeCoverageMatchesServerGate() {
        func summary(scope: String, privateAllowed: Bool?) -> ActivationEntitlementSummary {
            .init(status: .active, repoVisibilityScope: scope, privateRepoAllowed: privateAllowed,
                  updateEntitlement: true, expiresAt: nil, plan: nil, seats: nil)
        }
        #expect(summary(scope: "private", privateAllowed: nil).coversPrivateRepos)
        #expect(summary(scope: "all", privateAllowed: nil).coversPrivateRepos)
        #expect(summary(scope: "private", privateAllowed: true).coversPrivateRepos)
        // Public-only or explicit privateRepoAllowed=false does NOT cover private.
        #expect(!summary(scope: "public", privateAllowed: nil).coversPrivateRepos)
        #expect(!summary(scope: "all", privateAllowed: false).coversPrivateRepos)
        #expect(!summary(scope: "private", privateAllowed: false).coversPrivateRepos)
    }

    @Test func keyMaterialNeverExposesRawSecret() {
        let key = ActivationKeyMaterial("NDL-SUPER-SECRET-0123456789")
        #expect(!key.description.contains("SUPER-SECRET"))
        #expect(!key.debugDescription.contains("SUPER-SECRET"))
        #expect(!key.redactedPrefix.contains("SECRET"))
        #expect(key.redactedPrefix.contains("•"))
        #expect(!key.isEmpty)
        #expect(ActivationKeyMaterial("   ").isEmpty)
    }
}
