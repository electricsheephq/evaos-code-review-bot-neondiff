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

@_spi(Testing) public enum CanonicalSecretScanner {
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
        pattern: CanonicalSensitiveCookieRule.generated.sensitiveNameSource
    )

    @_spi(Testing) public static func containsSecretLikeText(_ input: String) -> Bool {
        if let namedCredential = rules.first(where: { $0.id == "named-credential" }),
           let expression = namedCredential.expression {
            let rawRange = NSRange(input.startIndex..<input.endIndex, in: input)
            if expression.firstMatch(in: input, range: rawRange) != nil { return true }
        }
        let protected = protectSafeLiterals(input)
        if containsSensitiveCookieHeader(protected) { return true }
        let range = NSRange(protected.startIndex..<protected.endIndex, in: protected)
        return rules.contains { rule in
            if rule.id == "named-credential" { return false }
            guard let expression = rule.expression else { return true }
            return expression.firstMatch(in: protected, range: range) != nil
        }
    }

    private static func containsSensitiveCookieHeader(_ input: String) -> Bool {
        input.components(separatedBy: .newlines)
            .contains { containsSensitiveCookieHeaderLine($0) }
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
            let matches = expression.matches(in: text, range: range)
            let mutable = NSMutableString(string: text)
            for match in matches.reversed() {
                let before = (text as NSString).substring(to: match.range.location)
                let afterStart = match.range.location + match.range.length
                let after = (text as NSString).substring(from: afterStart)
                guard !isAssignmentPosition(before: before, after: after) else { continue }
                mutable.replaceCharacters(in: match.range, with: "__NEONDIFF_SAFE_ENV_\(index)__")
            }
            return mutable as String
        }
    }

    private static func isAssignmentPosition(before: String, after: String) -> Bool {
        let whitespace = #"[\u0009-\u000D \u00A0\u1680\u2000-\u200A\u2028\u2029\u202F\u205F\u3000\uFEFF]*"#
        let quote = #"[\"'`]?"#
        let afterPattern = "^\(quote)\(whitespace)[:=]"
        let credentialName = #"(?:(?:[Nn][Ee][Oo][Nn][Dd][Ii][Ff][Ff][_-][Pp][Rr][Oo][Vv][Ii][Dd][Ee][Rr][_-])?[Aa][Pp][Ii][_-]?[Kk][Ee][Yy]|[Tt][Oo][Kk][Ee][Nn]|[Ss][Ee][Cc][Rr][Ee][Tt]|[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd]|[Cc][Oo][Oo][Kk][Ii][Ee]|[Ss][Ee][Ss][Ss][Ii][Oo][Nn])"#
        let beforePattern = "\(credentialName)\(quote)\(whitespace)[:=]\(whitespace)\(quote)$"
        return regexMatches(afterPattern, text: after) || regexMatches(beforePattern, text: before)
    }

    private static func regexMatches(_ pattern: String, text: String) -> Bool {
        guard let expression = try? NSRegularExpression(pattern: pattern) else { return true }
        let range = NSRange(text.startIndex..<text.endIndex, in: text)
        return expression.firstMatch(in: text, range: range) != nil
    }
}
