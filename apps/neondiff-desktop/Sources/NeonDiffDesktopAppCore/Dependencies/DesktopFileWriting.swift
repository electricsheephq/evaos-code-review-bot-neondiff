import Foundation

package protocol DesktopFileWriting: Sendable {
    var applicationSupportDirectory: URL { get }
    func write(_ data: Data, to url: URL) throws
}
