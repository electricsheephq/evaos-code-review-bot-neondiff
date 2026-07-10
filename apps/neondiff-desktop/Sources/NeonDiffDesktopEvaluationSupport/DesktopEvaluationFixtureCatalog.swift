import Foundation

public struct DesktopEvaluationFixtureCatalog: Equatable, Sendable {
    public struct Entry: Codable, Equatable, Sendable {
        public let id: String
        public let file: String
    }

    public let schemaVersion: Int
    public let entries: [Entry]
    public let fixtures: [DesktopEvaluationFixture]

    private struct Document: Codable {
        let schemaVersion: Int
        let entries: [Entry]
    }

    public static func load(from catalogURL: URL) throws -> DesktopEvaluationFixtureCatalog {
        guard catalogURL.isFileURL, catalogURL.path.hasPrefix("/") else {
            throw DesktopEvaluationFixtureError.invalidValue("catalog path")
        }
        let data = try Data(contentsOf: catalogURL, options: [.mappedIfSafe])
        guard data.count <= 64 * 1024 else {
            throw DesktopEvaluationFixtureError.oversized
        }
        let object = try JSONSerialization.jsonObject(with: data, options: [])
        guard let root = object as? [String: Any] else {
            throw DesktopEvaluationFixtureError.invalidJSON
        }
        if let unknown = root.keys.sorted().first(where: { !["schemaVersion", "entries"].contains($0) }) {
            throw DesktopEvaluationFixtureError.unknownField(path: "catalog", field: unknown)
        }
        let document: Document
        do {
            document = try JSONDecoder().decode(Document.self, from: data)
        } catch {
            throw DesktopEvaluationFixtureError.invalidValue("catalog schema")
        }
        guard document.schemaVersion == 1 else {
            throw DesktopEvaluationFixtureError.unsupportedSchemaVersion(document.schemaVersion)
        }
        guard !document.entries.isEmpty else {
            throw DesktopEvaluationFixtureError.invalidValue("catalog entries")
        }

        let directory = catalogURL.deletingLastPathComponent().standardizedFileURL
        var seenIds = Set<String>()
        var seenFiles = Set<String>()
        var fixtures: [DesktopEvaluationFixture] = []
        for entry in document.entries {
            guard entry.id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
                  entry.file.range(of: #"^[a-z0-9][a-z0-9-]{0,63}\.json$"#, options: .regularExpression) != nil,
                  seenIds.insert(entry.id).inserted,
                  seenFiles.insert(entry.file).inserted else {
                throw DesktopEvaluationFixtureError.invalidValue("catalog entry")
            }
            let fixtureURL = directory.appendingPathComponent(entry.file).standardizedFileURL
            guard fixtureURL.deletingLastPathComponent() == directory else {
                throw DesktopEvaluationFixtureError.invalidValue("catalog fixture path")
            }
            let values = try fixtureURL.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
            guard values.isRegularFile == true, values.isSymbolicLink != true else {
                throw DesktopEvaluationFixtureError.invalidValue("catalog fixture file")
            }
            let fixture = try DesktopEvaluationFixture.decode(data: Data(contentsOf: fixtureURL, options: [.mappedIfSafe]))
            guard fixture.id == entry.id else {
                throw DesktopEvaluationFixtureError.invalidValue("catalog fixture id mismatch")
            }
            fixtures.append(fixture)
        }
        return DesktopEvaluationFixtureCatalog(
            schemaVersion: document.schemaVersion,
            entries: document.entries,
            fixtures: fixtures
        )
    }
}
