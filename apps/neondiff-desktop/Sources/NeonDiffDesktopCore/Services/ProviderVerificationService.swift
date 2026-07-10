import Foundation

public enum ProviderVerificationState: String, Equatable, Sendable {
    case healthy
    case configuredUnverified = "configured_unverified"
    case blocked
}

public struct ProviderVerificationSnapshot: Equatable, Sendable {
    public let ok: Bool
    public let command: String
    public let providerId: String
    public let checkedAt: String
    public let state: ProviderVerificationState
    public let mode: String
    public let detail: String
    public let troubleshooting: [String]

    public var isVerified: Bool {
        ok && state == .healthy
    }

    public init(
        ok: Bool,
        command: String,
        providerId: String,
        checkedAt: String,
        state: ProviderVerificationState,
        mode: String,
        detail: String,
        troubleshooting: [String]
    ) {
        self.ok = ok
        self.command = command
        self.providerId = providerId
        self.checkedAt = checkedAt
        self.state = state
        self.mode = mode
        self.detail = detail
        self.troubleshooting = troubleshooting
    }
}

public enum ProviderVerificationError: Error, LocalizedError {
    case missingKeychainSecret
    case secretTooLarge(maxBytes: Int)
    case invalidArguments
    case secretInArguments
    case secretInProcessOutput
    case malformedEnvelope
    case invalidEnvelope

    public var errorDescription: String? {
        switch self {
        case .missingKeychainSecret:
            "No stored provider API key was found in Keychain"
        case .secretTooLarge(let maxBytes):
            "Stored provider API key exceeds the \(maxBytes)-byte verification limit"
        case .invalidArguments:
            "Provider verification requires the strict stdin-only CLI command"
        case .secretInArguments:
            "Provider verification refused a command containing secret material"
        case .secretInProcessOutput:
            "Provider verification rejected process output containing secret material"
        case .malformedEnvelope:
            "Provider verification returned malformed JSON"
        case .invalidEnvelope:
            "Provider verification returned an invalid redacted result"
        }
    }
}

public enum ProviderVerificationParser {
    public static func parse(result: CLIRunResult) throws -> ProviderVerificationSnapshot {
        let data = Data(result.stdout.utf8)
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data)
        } catch {
            throw ProviderVerificationError.malformedEnvelope
        }

        guard let envelope = object as? [String: Any], !containsSecretLikeKey(object) else {
            throw ProviderVerificationError.invalidEnvelope
        }
        guard
            strictBoolean(envelope["redacted"]) == true,
            let ok = strictBoolean(envelope["ok"]),
            let command = nonEmptyString(envelope["command"]),
            command == "providers verify",
            let providerId = nonEmptyString(envelope["providerId"]),
            let checkedAt = nonEmptyString(envelope["checkedAt"]),
            let stateText = nonEmptyString(envelope["state"]),
            let state = ProviderVerificationState(rawValue: stateText),
            let mode = nonEmptyString(envelope["mode"]),
            ["metadata_only", "openai_compatible_models"].contains(mode),
            let detail = nonEmptyString(envelope["detail"]),
            let troubleshooting = nonEmptyStringArray(envelope["troubleshooting"])
        else {
            throw ProviderVerificationError.invalidEnvelope
        }

        switch state {
        case .healthy:
            guard ok, result.exitCode == 0, mode == "openai_compatible_models" else {
                throw ProviderVerificationError.invalidEnvelope
            }
        case .configuredUnverified:
            guard result.exitCode != 0, mode == "metadata_only" else {
                throw ProviderVerificationError.invalidEnvelope
            }
        case .blocked:
            guard !ok, result.exitCode != 0 else {
                throw ProviderVerificationError.invalidEnvelope
            }
        }

        return ProviderVerificationSnapshot(
            ok: ok,
            command: command,
            providerId: providerId,
            checkedAt: checkedAt,
            state: state,
            mode: mode,
            detail: detail,
            troubleshooting: troubleshooting
        )
    }

    private static func strictBoolean(_ value: Any?) -> Bool? {
        guard let number = value as? NSNumber, CFGetTypeID(number) == CFBooleanGetTypeID() else {
            return nil
        }
        return number.boolValue
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func nonEmptyStringArray(_ value: Any?) -> [String]? {
        guard let values = value as? [Any] else { return nil }
        var strings: [String] = []
        for value in values {
            guard let string = nonEmptyString(value) else { return nil }
            strings.append(string)
        }
        return strings
    }

    private static func containsSecretLikeKey(_ value: Any) -> Bool {
        if let dictionary = value as? [String: Any] {
            for (key, nestedValue) in dictionary {
                let normalized = key
                    .lowercased()
                    .filter { $0.isLetter || $0.isNumber }
                if normalized == "apikey"
                    || normalized == "authorization"
                    || normalized == "credential"
                    || normalized == "credentials"
                    || normalized.contains("password")
                    || normalized.hasSuffix("secret")
                    || normalized == "token"
                    || normalized.hasSuffix("token")
                {
                    return true
                }
                if containsSecretLikeKey(nestedValue) { return true }
            }
            return false
        }
        if let array = value as? [Any] {
            return array.contains(where: containsSecretLikeKey)
        }
        return false
    }
}

public final class ProviderVerificationService {
    private static let maximumSecretBytes = 64 * 1024

    private let keychain: DesktopSecretStoring
    private let cli: NeonDiffCLIClienting

    public init(keychain: DesktopSecretStoring, cli: NeonDiffCLIClienting) {
        self.keychain = keychain
        self.cli = cli
    }

    public func verify(
        account: String,
        arguments: [String],
        timeout: TimeInterval
    ) throws -> ProviderVerificationSnapshot {
        guard let secret = try keychain.readSecret(account: account), !secret.isEmpty else {
            throw ProviderVerificationError.missingKeychainSecret
        }

        let secretData = Data(secret.utf8)
        guard secretData.count <= Self.maximumSecretBytes else {
            throw ProviderVerificationError.secretTooLarge(maxBytes: Self.maximumSecretBytes)
        }
        guard Self.hasStrictStandardInputCommand(arguments) else {
            throw ProviderVerificationError.invalidArguments
        }
        guard !arguments.contains(where: { $0.contains(secret) }) else {
            throw ProviderVerificationError.secretInArguments
        }

        let result = try cli.run(
            arguments: arguments,
            standardInput: secretData,
            timeout: timeout
        )
        guard !result.stdout.contains(secret), !result.stderr.contains(secret) else {
            throw ProviderVerificationError.secretInProcessOutput
        }
        return try ProviderVerificationParser.parse(result: result)
    }

    private static func hasStrictStandardInputCommand(_ arguments: [String]) -> Bool {
        guard arguments.count >= 4, Array(arguments.prefix(2)) == ["providers", "verify"] else {
            return false
        }
        guard arguments.indices.contains(where: { index in
            arguments[index] == "--api-key-stdin"
                && arguments.indices.contains(index + 1)
                && arguments[index + 1] == "true"
        }) else {
            return false
        }

        let forbiddenFlags = ["--api-key", "--secret", "--password", "--token", "--authorization"]
        return !arguments.contains(where: { argument in
            forbiddenFlags.contains { forbidden in
                argument == forbidden || argument.hasPrefix("\(forbidden)=")
            }
        })
    }
}
