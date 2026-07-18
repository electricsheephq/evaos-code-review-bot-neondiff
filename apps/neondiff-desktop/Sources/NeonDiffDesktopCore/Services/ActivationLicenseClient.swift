import Foundation

// Issue #612 — the native license-client seam.
//
// The NeonDiff Activation Key is Keychain-only. When activating, it crosses to
// the local CLI over BOUNDED STDIN and never through argv, environment, config,
// logs, screenshots, accessibility, analytics, or crash evidence. The CLI is the
// production-approved secure path — it rejects `--license-key`/`--license-key-env`
// and reads exactly one bounded key from stdin (`--license-key-stdin true`). The
// client parses the CLI's redacted `LicenseStatusResult` JSON, the same wire the
// production license lifecycle (PR #574) emits, and maps it to activation states.

/// A NeonDiff Activation Key held for the lifetime of a single activation call.
/// Not `Codable`; its `description` is redacted so it can never be logged or
/// serialized. Only `standardInputData()` exposes the bytes, and only for the
/// bounded stdin pipe to the CLI.
public struct ActivationKeyMaterial: Sendable, CustomStringConvertible, CustomDebugStringConvertible {
    private let raw: String

    public init(_ raw: String) {
        self.raw = raw
    }

    public var isEmpty: Bool {
        raw.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    /// A safe-to-display prefix + mask (`NDL-••••`). The packet permits a
    /// redacted prefix + status; nothing more of the key ever leaves this type.
    public var redactedPrefix: String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "••••" }
        let prefix = String(trimmed.prefix(4))
        return "\(prefix)••••"
    }

    /// The only accessor for the raw bytes — for the bounded stdin pipe only.
    public func standardInputData() -> Data {
        Data(raw.utf8)
    }

    public var description: String { "\(ActivationTerminology.activationKey) \(redactedPrefix)" }
    public var debugDescription: String { description }
}

public enum ActivationEntitlementStatus: String, Sendable, Equatable {
    case active
    case expired
    case revoked
    case invalid
    case scopeMismatch
}

/// A redacted summary of an entitlement — never carries raw key material.
public struct ActivationEntitlementSummary: Sendable, Equatable {
    public let status: ActivationEntitlementStatus
    public let repoVisibilityScope: String
    public let privateRepoAllowed: Bool?
    public let updateEntitlement: Bool
    public let expiresAt: String?
    public let plan: String?
    public let seats: Int?

    public init(
        status: ActivationEntitlementStatus,
        repoVisibilityScope: String,
        privateRepoAllowed: Bool?,
        updateEntitlement: Bool,
        expiresAt: String?,
        plan: String?,
        seats: Int?
    ) {
        self.status = status
        self.repoVisibilityScope = repoVisibilityScope
        self.privateRepoAllowed = privateRepoAllowed
        self.updateEntitlement = updateEntitlement
        self.expiresAt = expiresAt
        self.plan = plan
        self.seats = seats
    }

    /// Whether this entitlement actually grants private-repo review. Mirrors the
    /// server review gate (`src/license.ts` `entitlementCoversRepoVisibility`): a
    /// public-only scope, or `privateRepoAllowed == false`, does NOT cover private
    /// repos even when the response status is `active`.
    public var coversPrivateRepos: Bool {
        if privateRepoAllowed == false { return false }
        return repoVisibilityScope == "all" || repoVisibilityScope == "private"
    }
}

/// The classified outcome of an activation/validation call.
public enum ActivationClientOutcome: Sendable, Equatable {
    case active(ActivationEntitlementSummary)
    case expired(ActivationEntitlementSummary?)
    case revoked(ActivationEntitlementSummary?)
    case invalid
    case scopeConflict
    case offline
    case serviceError
    case malformed
}

public enum ActivationLicenseOutcomeMapping {
    /// The event that carries an outcome into the state machine from
    /// `activation_pending`.
    public static func event(for outcome: ActivationClientOutcome) -> ActivationEvent {
        switch outcome {
        case .active: return .activationSucceeded
        case .expired: return .activationExpired
        case .revoked: return .activationRevoked
        case .invalid: return .activationInvalid
        case .scopeConflict: return .activationScopeConflict
        case .offline: return .activationOffline
        case .serviceError, .malformed: return .activationServiceError
        }
    }
}

public protocol ActivationLicenseClienting: Sendable {
    func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome
    func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome
}

public final class CLIActivationLicenseClient: ActivationLicenseClienting, @unchecked Sendable {
    private let cli: any NeonDiffCLIClienting
    private let configPath: String
    private let timeout: TimeInterval

    public init(cli: any NeonDiffCLIClienting, configPath: String, timeout: TimeInterval = 20) {
        self.cli = cli
        self.configPath = configPath
        self.timeout = timeout
    }

    public func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        try await run(key: key)
    }

    public func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        // The server activation endpoint is idempotent for the same machine.
        // Repeating it revalidates current entitlement without requiring a
        // second local key/cache copy.
        try await run(key: key)
    }

    private func run(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        // The key crosses ONLY over bounded stdin; argv carries no secret.
        let arguments = [
            "license", "activate",
            "--config", configPath,
            "--license-storage", "keychain",
            "--license-key-stdin", "true",
            "--persist-local-state", "false",
            "--json"
        ]
        do {
            let result = try await cli.runCancellable(
                arguments: arguments,
                standardInput: key.standardInputData(),
                timeout: timeout
            )
            return Self.classify(stdout: result.stdout)
        } catch let error as NeonDiffCLIError {
            switch error {
            case .timedOut, .cancelled, .cleanupTimedOut:
                return .offline
            case .launchFailed, .standardInputTooLarge, .outputTooLarge:
                return .serviceError
            }
        }
    }

    /// Parse the CLI's redacted `LicenseStatusResult` JSON into an outcome.
    /// Shared by the AppCore CLI adapter so both paths classify identically.
    public static func classify(stdout: String) -> ActivationClientOutcome {
        guard let data = stdout.data(using: .utf8),
              let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let status = root["status"] as? String
        else {
            return .serviceError
        }

        switch status {
        case "active":
            let summary = parseEntitlement(root["entitlement"]) ?? ActivationEntitlementSummary(
                status: .active, repoVisibilityScope: "all", privateRepoAllowed: nil,
                updateEntitlement: false, expiresAt: nil, plan: nil, seats: nil
            )
            return .active(summary)
        case "expired":
            return .expired(parseEntitlement(root["entitlement"]))
        case "revoked":
            return .revoked(parseEntitlement(root["entitlement"]))
        case "invalid", "missing", "unsupported_client":
            return .invalid
        case "scope_mismatch":
            return .scopeConflict
        case "network":
            return .offline
        case "server", "rate_limited", "clock_skew":
            return .serviceError
        default:
            return .serviceError
        }
    }

    private static func parseEntitlement(_ value: Any?) -> ActivationEntitlementSummary? {
        guard let record = value as? [String: Any],
              let statusString = record["status"] as? String,
              let status = ActivationEntitlementStatus(rawValue: normalizeStatus(statusString)),
              let scope = record["repoVisibilityScope"] as? String
        else {
            return nil
        }
        return ActivationEntitlementSummary(
            status: status,
            repoVisibilityScope: scope,
            privateRepoAllowed: record["privateRepoAllowed"] as? Bool,
            updateEntitlement: record["updateEntitlement"] as? Bool ?? false,
            expiresAt: record["expiresAt"] as? String,
            plan: record["plan"] as? String,
            seats: (record["seats"] as? NSNumber)?.intValue
        )
    }

    private static func normalizeStatus(_ raw: String) -> String {
        raw == "scope_mismatch" ? "scopeMismatch" : raw
    }
}
