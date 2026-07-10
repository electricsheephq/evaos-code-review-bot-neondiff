import Foundation

struct Rule: Decodable {
    let id: String
    let source: String
    let ignoreCase: Bool
}

struct CookieRule: Decodable {
    let id: String
    let prefix: String
    let sensitiveNameSource: String
    let maximumAttributes: Int
}

struct Fixture: Decodable {
    let id: String
    let variant: String
    let text: String
}

struct Request: Decodable {
    let rules: [Rule]
    let cookie: CookieRule
    let fixtures: [Fixture]
}

struct Result: Encodable {
    let id: String
    let variant: String
    let matched: Bool
}

struct Response: Encodable {
    let results: [Result]
}

let ecmaWhitespace = CharacterSet(charactersIn: "\u{0009}\u{000A}\u{000B}\u{000C}\u{000D}\u{0020}\u{00A0}\u{1680}\u{2000}\u{2001}\u{2002}\u{2003}\u{2004}\u{2005}\u{2006}\u{2007}\u{2008}\u{2009}\u{200A}\u{2028}\u{2029}\u{202F}\u{205F}\u{3000}\u{FEFF}")

let data = FileHandle.standardInput.readDataToEndOfFile()
let request = try JSONDecoder().decode(Request.self, from: data)
let expressions = try Dictionary(uniqueKeysWithValues: request.rules.map { rule in
    let options: NSRegularExpression.Options = rule.ignoreCase ? [.caseInsensitive] : []
    return (rule.id, try NSRegularExpression(pattern: rule.source, options: options))
})
let cookieName = try NSRegularExpression(pattern: request.cookie.sensitiveNameSource)

let results = request.fixtures.map { fixture in
    let matched: Bool
    if fixture.id == request.cookie.id {
        matched = matchesCookie(fixture.text, rule: request.cookie, nameExpression: cookieName)
    } else if let expression = expressions[fixture.id] {
        let range = NSRange(fixture.text.startIndex..<fixture.text.endIndex, in: fixture.text)
        matched = expression.firstMatch(in: fixture.text, range: range) != nil
    } else {
        matched = false
    }
    return Result(id: fixture.id, variant: fixture.variant, matched: matched)
}
FileHandle.standardOutput.write(try JSONEncoder().encode(Response(results: results)))

func matchesCookie(_ input: String, rule: CookieRule, nameExpression: NSRegularExpression) -> Bool {
    input.components(separatedBy: .newlines).contains { line in
        let trimmed = line.drop { character in
            character.unicodeScalars.allSatisfy(ecmaWhitespace.contains)
        }
        guard trimmed.lowercased().hasPrefix(rule.prefix) else { return false }
        guard let colon = line.firstIndex(of: ":") else { return false }
        let attributes = line[line.index(after: colon)...].split(separator: ";", omittingEmptySubsequences: false)
        if attributes.count > rule.maximumAttributes { return true }
        return attributes.contains { attribute in
            guard let equals = attribute.firstIndex(of: "=") else { return false }
            let name = attribute[..<equals].trimmingCharacters(in: ecmaWhitespace)
            let value = attribute[attribute.index(after: equals)...].trimmingCharacters(in: ecmaWhitespace)
            guard !name.isEmpty, !value.isEmpty else { return false }
            let range = NSRange(name.startIndex..<name.endIndex, in: name)
            return nameExpression.firstMatch(in: name, range: range) != nil
        }
    }
}
