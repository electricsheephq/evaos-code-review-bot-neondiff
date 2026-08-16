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

    func fileExists(at url: URL) -> Bool {
        fileManager.fileExists(atPath: url.standardizedFileURL.path)
    }

    func pathsReferToSameFile(_ lhs: URL, _ rhs: URL) -> Bool {
        let lhsURL = lhs.standardizedFileURL.resolvingSymlinksInPath()
        let rhsURL = rhs.standardizedFileURL.resolvingSymlinksInPath()
        if lhsURL.path.caseInsensitiveCompare(rhsURL.path) == .orderedSame {
            return true
        }
        guard let lhsAttributes = try? fileManager.attributesOfItem(
            atPath: lhsURL.path
        ),
        let rhsAttributes = try? fileManager.attributesOfItem(
            atPath: rhsURL.path
        ),
        let lhsSystem = lhsAttributes[.systemNumber] as? NSNumber,
        let rhsSystem = rhsAttributes[.systemNumber] as? NSNumber,
        let lhsFile = lhsAttributes[.systemFileNumber] as? NSNumber,
        let rhsFile = rhsAttributes[.systemFileNumber] as? NSNumber
        else {
            return false
        }
        return lhsSystem == rhsSystem && lhsFile == rhsFile
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
