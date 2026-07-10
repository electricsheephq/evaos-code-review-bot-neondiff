import Foundation

struct Fixture: Decodable {
    let id: String
    let variant: String
    let text: String
    let expected: Bool
}

struct Request: Decodable {
    let fixtures: [Fixture]
}

struct Result: Encodable {
    let id: String
    let variant: String
    let expected: Bool
    let matched: Bool
}

struct Response: Encodable {
    let results: [Result]
}

@main
enum FoundationScannerRunner {
    static func main() throws {
        let data = FileHandle.standardInput.readDataToEndOfFile()
        let request = try JSONDecoder().decode(Request.self, from: data)
        let results = request.fixtures.map { fixture in
            Result(
                id: fixture.id,
                variant: fixture.variant,
                expected: fixture.expected,
                matched: CanonicalSecretScanner.containsSecretLikeText(fixture.text)
            )
        }
        FileHandle.standardOutput.write(try JSONEncoder().encode(Response(results: results)))
    }
}
