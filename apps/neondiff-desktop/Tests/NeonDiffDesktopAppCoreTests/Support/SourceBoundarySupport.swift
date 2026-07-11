import Foundation

func withSourceBoundaryDirectoryFixture(
    _ body: (URL, URL) throws -> Void
) throws {
    let root = FileManager.default.temporaryDirectory
        .appendingPathComponent(UUID().uuidString, isDirectory: true)
    let fakeSource = root.appendingPathComponent("Fake.swift", isDirectory: true)
    defer { try? FileManager.default.removeItem(at: root) }
    try FileManager.default.createDirectory(at: fakeSource, withIntermediateDirectories: true)
    try body(root, fakeSource)
}

func sourceBoundaryPackageRoot() -> URL {
    URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
        .deletingLastPathComponent()
}

func sourceBoundarySwiftFiles(below directory: URL) -> [URL] {
    guard let enumerator = FileManager.default.enumerator(
        at: directory,
        includingPropertiesForKeys: [.isRegularFileKey],
        options: [.skipsHiddenFiles]
    ) else {
        return []
    }

    return enumerator.compactMap { element in
        guard let url = element as? URL, url.pathExtension == "swift" else { return nil }
        guard (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true else { return nil }
        return url
    }
}

func sourceBoundaryText(at url: URL) throws -> String {
    try String(contentsOf: url, encoding: .utf8)
}

func sourceBoundaryFileExists(_ url: URL) -> Bool {
    (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true
}
