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
    static func serializedTextContainsForbiddenValue(
        _ text: String,
        forbiddenValue: String
    ) -> Bool {
        guard !text.isEmpty else { return false }
        var budget = ForbiddenValueScanBudget()
        return scanSerializedText(
            text,
            forbiddenValue: forbiddenValue,
            escapedBodies: escapedJSONBodies(forbiddenValue),
            depth: 0,
            budget: &budget
        )
    }

    public static func parse(
        result: CLIRunResult,
        forbiddenValue: String? = nil
    ) throws -> ProviderVerificationSnapshot {
        if let forbiddenValue,
           serializedTextContainsForbiddenValue(result.stdout, forbiddenValue: forbiddenValue)
        {
            throw ProviderVerificationError.secretInProcessOutput
        }
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

    private struct ForbiddenValueScanBudget {
        static let maximumDepth = 32
        static let maximumNodes = 4_096
        static let maximumBytes = 2 * 1024 * 1024

        var remainingNodes = maximumNodes
        var remainingBytes = maximumBytes

        mutating func consumeNode(depth: Int, byteCount: Int = 0) -> Bool {
            guard depth <= Self.maximumDepth,
                  remainingNodes > 0,
                  byteCount <= remainingBytes
            else {
                return false
            }
            remainingNodes -= 1
            remainingBytes -= byteCount
            return true
        }
    }

    private static func scanSerializedText(
        _ text: String,
        forbiddenValue: String,
        escapedBodies: Set<String>,
        depth: Int,
        budget: inout ForbiddenValueScanBudget
    ) -> Bool {
        guard budget.consumeNode(depth: depth, byteCount: text.utf8.count) else { return true }
        if text.contains(forbiddenValue) { return true }

        var looselyDecoded = text
        for _ in 0..<3 {
            let next = looselyDecodeJSONEscapes(looselyDecoded)
            if next.contains(forbiddenValue) { return true }
            if next == looselyDecoded { break }
            looselyDecoded = next
        }
        if escapedBodies.contains(where: { !$0.isEmpty && text.contains($0) }) {
            return true
        }
        if exceedsJSONStructuralBudget(
            text,
            maximumDepth: ForbiddenValueScanBudget.maximumDepth,
            maximumNodes: ForbiddenValueScanBudget.maximumNodes
        ) {
            return true
        }
        guard let decoded = try? JSONSerialization.jsonObject(
            with: Data(text.utf8),
            options: [.fragmentsAllowed]
        ) else {
            return false
        }
        return scanDecodedValue(
            decoded,
            forbiddenValue: forbiddenValue,
            escapedBodies: escapedBodies,
            depth: depth + 1,
            budget: &budget
        )
    }

    private static func scanDecodedValue(
        _ value: Any,
        forbiddenValue: String,
        escapedBodies: Set<String>,
        depth: Int,
        budget: inout ForbiddenValueScanBudget
    ) -> Bool {
        if let string = value as? String {
            return scanSerializedText(
                string,
                forbiddenValue: forbiddenValue,
                escapedBodies: escapedBodies,
                depth: depth,
                budget: &budget
            )
        }
        guard budget.consumeNode(depth: depth) else { return true }
        if let dictionary = value as? [String: Any] {
            for (key, nestedValue) in dictionary {
                if scanSerializedText(
                    key,
                    forbiddenValue: forbiddenValue,
                    escapedBodies: escapedBodies,
                    depth: depth + 1,
                    budget: &budget
                ) || scanDecodedValue(
                    nestedValue,
                    forbiddenValue: forbiddenValue,
                    escapedBodies: escapedBodies,
                    depth: depth + 1,
                    budget: &budget
                ) {
                    return true
                }
            }
            return false
        }
        if let array = value as? [Any] {
            for nestedValue in array {
                if scanDecodedValue(
                    nestedValue,
                    forbiddenValue: forbiddenValue,
                    escapedBodies: escapedBodies,
                    depth: depth + 1,
                    budget: &budget
                ) {
                    return true
                }
            }
        }
        return false
    }

    private static func exceedsJSONStructuralBudget(
        _ text: String,
        maximumDepth: Int,
        maximumNodes: Int
    ) -> Bool {
        var depth = 0
        var structuralNodes = 1
        var insideString = false
        var escaped = false
        for scalar in text.unicodeScalars {
            if insideString {
                if escaped {
                    escaped = false
                } else if scalar.value == 0x5C {
                    escaped = true
                } else if scalar.value == 0x22 {
                    insideString = false
                }
                continue
            }
            if scalar.value == 0x22 {
                insideString = true
            } else if scalar.value == 0x7B || scalar.value == 0x5B {
                depth += 1
                structuralNodes += 1
                if depth > maximumDepth { return true }
            } else if scalar.value == 0x7D || scalar.value == 0x5D {
                depth = max(0, depth - 1)
            } else if scalar.value == 0x2C || scalar.value == 0x3A {
                structuralNodes += 1
            }
            if structuralNodes > maximumNodes { return true }
        }
        return false
    }

    private static func escapedJSONBodies(_ value: String) -> Set<String> {
        var bodies: Set<String> = []
        if let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
           let literal = String(data: data, encoding: .utf8),
           literal.count >= 2
        {
            bodies.insert(String(literal.dropFirst().dropLast()))
        }
        for escapeNonASCII in [false, true] {
            for uppercaseHex in [false, true] {
                for escapeSlash in [false, true] {
                    bodies.insert(jsonEscapedBody(
                        value,
                        escapeNonASCII: escapeNonASCII,
                        uppercaseHex: uppercaseHex,
                        escapeSlash: escapeSlash
                    ))
                }
            }
        }
        return bodies
    }

    private static func jsonEscapedBody(
        _ value: String,
        escapeNonASCII: Bool,
        uppercaseHex: Bool,
        escapeSlash: Bool
    ) -> String {
        var escaped = ""
        for scalar in value.unicodeScalars {
            switch scalar.value {
            case 0x08: escaped += "\\b"
            case 0x09: escaped += "\\t"
            case 0x0A: escaped += "\\n"
            case 0x0C: escaped += "\\f"
            case 0x0D: escaped += "\\r"
            case 0x22: escaped += "\\\""
            case 0x2F where escapeSlash: escaped += "\\/"
            case 0x5C: escaped += "\\\\"
            case 0x00...0x1F:
                escaped += unicodeEscape(scalar.value, uppercaseHex: uppercaseHex)
            case 0x80... where escapeNonASCII:
                if scalar.value <= 0xFFFF {
                    escaped += unicodeEscape(scalar.value, uppercaseHex: uppercaseHex)
                } else {
                    let supplementary = scalar.value - 0x10000
                    let high = 0xD800 + (supplementary >> 10)
                    let low = 0xDC00 + (supplementary & 0x3FF)
                    escaped += unicodeEscape(high, uppercaseHex: uppercaseHex)
                    escaped += unicodeEscape(low, uppercaseHex: uppercaseHex)
                }
            default:
                escaped.unicodeScalars.append(scalar)
            }
        }
        return escaped
    }

    private static func unicodeEscape(_ value: UInt32, uppercaseHex: Bool) -> String {
        let format = uppercaseHex ? "\\u%04X" : "\\u%04x"
        return String(format: format, value)
    }

    private static func looselyDecodeJSONEscapes(_ value: String) -> String {
        let scalars = Array(value.unicodeScalars)
        var output = ""
        var index = 0
        while index < scalars.count {
            guard scalars[index].value == 0x5C, index + 1 < scalars.count else {
                output.unicodeScalars.append(scalars[index])
                index += 1
                continue
            }

            let escaped = scalars[index + 1].value
            let mapped: UInt32?
            switch escaped {
            case 0x22, 0x2F, 0x5C: mapped = escaped
            case 0x62: mapped = 0x08
            case 0x66: mapped = 0x0C
            case 0x6E: mapped = 0x0A
            case 0x72: mapped = 0x0D
            case 0x74: mapped = 0x09
            default: mapped = nil
            }
            if let mapped, let scalar = Unicode.Scalar(mapped) {
                output.unicodeScalars.append(scalar)
                index += 2
                continue
            }

            if escaped == 0x75, let first = jsonHexValue(scalars, start: index + 2) {
                if (0xD800...0xDBFF).contains(first),
                   index + 11 < scalars.count,
                   scalars[index + 6].value == 0x5C,
                   scalars[index + 7].value == 0x75,
                   let second = jsonHexValue(scalars, start: index + 8),
                   (0xDC00...0xDFFF).contains(second)
                {
                    let codePoint = 0x10000 + ((first - 0xD800) << 10) + (second - 0xDC00)
                    if let scalar = Unicode.Scalar(codePoint) {
                        output.unicodeScalars.append(scalar)
                        index += 12
                        continue
                    }
                } else if let scalar = Unicode.Scalar(first) {
                    output.unicodeScalars.append(scalar)
                    index += 6
                    continue
                }
            }

            output.unicodeScalars.append(scalars[index])
            index += 1
        }
        return output
    }

    private static func jsonHexValue(_ scalars: [Unicode.Scalar], start: Int) -> UInt32? {
        guard start + 3 < scalars.count else { return nil }
        var value: UInt32 = 0
        for scalar in scalars[start..<(start + 4)] {
            let digit: UInt32
            switch scalar.value {
            case 0x30...0x39: digit = scalar.value - 0x30
            case 0x41...0x46: digit = scalar.value - 0x41 + 10
            case 0x61...0x66: digit = scalar.value - 0x61 + 10
            default: return nil
            }
            value = (value << 4) | digit
        }
        return value
    }
}

public final class ProviderVerificationService {
    private static let maximumSecretBytes = 64 * 1024
    private static let ecmaScriptTrimCharacters = CharacterSet(
        charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
            + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
            + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
    )

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
        guard let storedSecret = try keychain.readSecret(account: account) else {
            throw ProviderVerificationError.missingKeychainSecret
        }
        let secret = storedSecret.trimmingCharacters(in: Self.ecmaScriptTrimCharacters)
        guard !secret.isEmpty else { throw ProviderVerificationError.missingKeychainSecret }

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
        guard !ProviderVerificationParser.serializedTextContainsForbiddenValue(
            result.stderr,
            forbiddenValue: secret
        ) else {
            throw ProviderVerificationError.secretInProcessOutput
        }
        return try ProviderVerificationParser.parse(result: result, forbiddenValue: secret)
    }

    public func verifyCancellable(
        account: String,
        arguments: [String],
        timeout: TimeInterval
    ) async throws -> ProviderVerificationSnapshot {
        try Task.checkCancellation()
        guard let storedSecret = try keychain.readSecret(account: account) else {
            throw ProviderVerificationError.missingKeychainSecret
        }
        try Task.checkCancellation()
        let secret = storedSecret.trimmingCharacters(in: Self.ecmaScriptTrimCharacters)
        guard !secret.isEmpty else { throw ProviderVerificationError.missingKeychainSecret }
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
        try Task.checkCancellation()
        let result = try await cli.runCancellable(
            arguments: arguments,
            standardInput: secretData,
            timeout: timeout
        )
        try Task.checkCancellation()
        guard !ProviderVerificationParser.serializedTextContainsForbiddenValue(
            result.stderr,
            forbiddenValue: secret
        ) else {
            throw ProviderVerificationError.secretInProcessOutput
        }
        return try ProviderVerificationParser.parse(result: result, forbiddenValue: secret)
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
