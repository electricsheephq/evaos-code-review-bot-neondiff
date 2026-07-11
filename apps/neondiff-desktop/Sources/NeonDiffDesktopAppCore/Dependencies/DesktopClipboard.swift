import Foundation

package protocol DesktopClipboard: Sendable {
    @MainActor func write(_ string: String) -> Bool
}
