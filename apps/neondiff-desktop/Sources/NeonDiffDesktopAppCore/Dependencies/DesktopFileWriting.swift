import Foundation

package protocol DesktopFileWriting: Sendable {
    var applicationSupportDirectory: URL { get }
    func fileExists(at url: URL) -> Bool
    func pathsReferToSameFile(_ lhs: URL, _ rhs: URL) -> Bool
    func write(_ data: Data, to url: URL) throws
}

package extension DesktopFileWriting {
    func pathsReferToSameFile(_ lhs: URL, _ rhs: URL) -> Bool {
        let lhsPath = lhs
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
        let rhsPath = rhs
            .standardizedFileURL
            .resolvingSymlinksInPath()
            .path
        return lhsPath.caseInsensitiveCompare(rhsPath) == .orderedSame
    }
}
