import Foundation

public struct AppcastDryRun {
    public var fixture: URL
    public var output: URL?

    public init(fixture: URL, output: URL?) {
        self.fixture = fixture
        self.output = output
    }

    public func run() throws -> String {
        let manifest = try AppcastManifest.load(from: fixture)
        let xml = try AppcastSerializer.serialize(manifest)
        if let output {
            let directory = output.deletingLastPathComponent()
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try xml.write(to: output, atomically: true, encoding: .utf8)
        }
        return xml
    }
}
