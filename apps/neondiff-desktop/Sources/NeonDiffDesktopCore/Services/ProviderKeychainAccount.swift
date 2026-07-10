import Foundation

public enum ProviderKeychainAccount {
    public static func account(providerId: String) -> String? {
        guard isValidProviderId(providerId) else { return nil }
        return "provider/\(providerId)/api-key"
    }

    private static func isValidProviderId(_ value: String) -> Bool {
        guard !value.isEmpty,
              value != ".",
              value != "..",
              value.range(of: #"^[A-Za-z0-9_.:-]+$"#, options: .regularExpression) != nil,
              NeonDiffRedactor.redact(value) == value
        else {
            return false
        }
        return !secretLikePatterns.contains { pattern in
            value.range(of: pattern, options: [.regularExpression, .caseInsensitive]) != nil
        }
    }

    private static let secretLikePatterns = [
        #"\bgh[pousr]_[A-Za-z0-9_]{8,}\b"#,
        #"\bgithub_pat_[A-Za-z0-9_]{8,}\b"#,
        #"\bsk-[A-Za-z0-9_-]{8,}\b"#,
        #"\b(?:AKIA|ASIA)[0-9A-Z]{16}\b"#,
        #"\bxox[baprs]-[A-Za-z0-9-]{10,}\b"#,
        #"\b(?:NEONDIFF|NDL|LIC)[_-][A-Za-z0-9][A-Za-z0-9_-]{11,}\b"#,
        #"\b[A-Za-z0-9]{3,}[-_](?:secret|token|password|cookie)[-_][A-Za-z0-9_-]{3,}\b"#
    ]
}
