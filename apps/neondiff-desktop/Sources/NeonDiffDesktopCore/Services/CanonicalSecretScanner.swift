import Foundation

struct CanonicalSecretRule {
    let id: String
    let source: String
    let ignoreCase: Bool
}

struct CanonicalSensitiveCookieRule {
    let id: String
    let prefix: String
    let sensitiveNameSource: String
    let maximumAttributes: Int
}

enum CanonicalSecretScanner {
    private static let ecmaScriptWhitespace = CharacterSet(
        charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}"
            + "\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}"
            + "\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}"
    )
    private struct CompiledRule {
        let id: String
        let expression: NSRegularExpression?
    }

    private static let rules = CanonicalSecretRule.generated.map { rule in
        CompiledRule(
            id: rule.id,
            expression: try? NSRegularExpression(
                pattern: rule.source,
                options: rule.ignoreCase ? [.caseInsensitive] : []
            )
        )
    }
    private static let sensitiveCookieNameExpression = try? NSRegularExpression(
        pattern: CanonicalSensitiveCookieRule.generated.sensitiveNameSource,
        options: [.caseInsensitive]
    )

    static func containsSecretLikeText(_ input: String) -> Bool {
        let protected = protectSafeLiterals(input)
        if containsSensitiveCookieHeader(protected) { return true }
        let range = NSRange(protected.startIndex..<protected.endIndex, in: protected)
        return rules.contains { rule in
            guard let expression = rule.expression else { return true }
            return expression.firstMatch(in: protected, range: range) != nil
        }
    }

    private static func containsSensitiveCookieHeader(_ input: String) -> Bool {
        input.split(separator: "\n", omittingEmptySubsequences: false)
            .contains { containsSensitiveCookieHeaderLine(String($0)) }
    }

    private static func containsSensitiveCookieHeaderLine(_ line: String) -> Bool {
        let trimmed = line.drop { character in
            character.unicodeScalars.allSatisfy(Self.ecmaScriptWhitespace.contains)
        }
        let cookieRule = CanonicalSensitiveCookieRule.generated
        guard trimmed.lowercased().hasPrefix(cookieRule.prefix) else { return false }
        guard let colon = line.firstIndex(of: ":") else { return false }
        let attributes = line[line.index(after: colon)...].split(
            separator: ";",
            omittingEmptySubsequences: false
        )
        if attributes.count > cookieRule.maximumAttributes { return true }
        guard let expression = sensitiveCookieNameExpression else { return true }
        for attribute in attributes {
            guard let equals = attribute.firstIndex(of: "=") else { continue }
            let name = attribute[..<equals].trimmingCharacters(in: .whitespacesAndNewlines)
            let value = attribute[attribute.index(after: equals)...]
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !name.isEmpty, !value.isEmpty else { continue }
            let range = NSRange(name.startIndex..<name.endIndex, in: name)
            if expression.firstMatch(in: name, range: range) != nil { return true }
        }
        return false
    }

    private static func protectSafeLiterals(_ input: String) -> String {
        CanonicalSecretSafeLiterals.generated.enumerated().reduce(input) { text, item in
            let (index, literal) = item
            let escaped = NSRegularExpression.escapedPattern(for: literal)
            guard let expression = try? NSRegularExpression(
                pattern: "(?<![A-Za-z0-9_])\(escaped)(?![A-Za-z0-9_])"
            ) else {
                return text
            }
            let range = NSRange(text.startIndex..<text.endIndex, in: text)
            return expression.stringByReplacingMatches(
                in: text,
                range: range,
                withTemplate: "__NEONDIFF_SAFE_ENV_\(index)__"
            )
        }
    }
}
