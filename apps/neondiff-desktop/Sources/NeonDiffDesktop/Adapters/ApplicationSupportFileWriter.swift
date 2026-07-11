import Foundation
import NeonDiffDesktopAppCore

final class ApplicationSupportFileWriter: DesktopFileWriting, @unchecked Sendable {
    let applicationSupportDirectory: URL
    private let fileManager: FileManager

    init(fileManager: FileManager = .default) {
        self.fileManager = fileManager
        let baseDirectory = fileManager.urls(
            for: .applicationSupportDirectory,
            in: .userDomainMask
        ).first ?? fileManager.temporaryDirectory
        applicationSupportDirectory = baseDirectory
            .appendingPathComponent("NeonDiffDesktop", isDirectory: true)
            .standardizedFileURL
    }

    func write(_ data: Data, to url: URL) throws {
        let destination = url.standardizedFileURL
        let rootPath = applicationSupportDirectory.path
        guard destination.path.hasPrefix(rootPath + "/") else {
            throw ApplicationSupportFileWriterError.destinationOutsideApplicationSupport
        }
        try fileManager.createDirectory(
            at: applicationSupportDirectory,
            withIntermediateDirectories: true
        )
        try data.write(to: destination, options: [.atomic])
    }
}

private enum ApplicationSupportFileWriterError: LocalizedError {
    case destinationOutsideApplicationSupport

    var errorDescription: String? {
        "File destination is outside NeonDiffDesktop application support"
    }
}
