import Foundation

package protocol DesktopURLOpener: Sendable {
    @MainActor func open(_ url: URL) -> Bool
}
