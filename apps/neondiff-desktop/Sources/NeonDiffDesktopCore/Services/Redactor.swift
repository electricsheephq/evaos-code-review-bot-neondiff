import Foundation

public enum NeonDiffRedactor {
    private static let patterns: [(String, NSRegularExpression.Options)] = [
        (#"\bgh[pousr]_[A-Za-z0-9_]{20,}\b"#, []),
        (#"\bgithub_pat_[A-Za-z0-9_]{40,}\b"#, []),
        (#"\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b"#, [.caseInsensitive]),
        (#"https?://[^/\s@]+@[^/\s]+"#, [.caseInsensitive]),
        (#"[?&](?:access[_-]?token|auth[_-]?token|api[_-]?key|token|secret|session|cookie)=[A-Za-z0-9._~+/=-]{16,}"#, [.caseInsensitive]),
        (#"\b(?:api[_-]?key|license[_-]?key|licenseKey|license|token|secret|password|cookie|session)\b\s*[:=]\s*["']?[A-Za-z0-9._~+/=-]{12,}"#, [.caseInsensitive]),
        (#""(?:api[_-]?key|license[_-]?key|licenseKey|license|token|secret|password|cookie|session)"\s*:\s*"[^"]{8,}""#, [.caseInsensitive]),
        (#"\b(?:LIC|NDL|NEONDIFF)[_-][A-Za-z0-9][A-Za-z0-9_-]{11,}\b"#, [.caseInsensitive]),
        (#"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----)?"#, [])
    ]

    public static func redact(_ input: String) -> String {
        var output = input
        for (pattern, options) in patterns {
            guard let expression = try? NSRegularExpression(pattern: pattern, options: options) else { continue }
            let range = NSRange(output.startIndex..<output.endIndex, in: output)
            output = expression.stringByReplacingMatches(
                in: output,
                options: [],
                range: range,
                withTemplate: "[redacted-secret]"
            )
        }
        return output
    }
}
