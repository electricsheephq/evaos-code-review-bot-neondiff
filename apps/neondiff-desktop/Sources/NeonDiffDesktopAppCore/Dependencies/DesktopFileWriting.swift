import Foundation

package protocol DesktopFileWriting: Sendable {
    var applicationSupportDirectory: URL { get }
    func fileExists(at url: URL) -> Bool
    func write(_ data: Data, to url: URL) throws
}
