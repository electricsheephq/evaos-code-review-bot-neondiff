import Foundation

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
        return url
    }
}

func sourceBoundaryText(at url: URL) throws -> String {
    try String(contentsOf: url, encoding: .utf8)
}

func sourceBoundaryFileExists(_ url: URL) -> Bool {
    FileManager.default.fileExists(atPath: url.path)
}
