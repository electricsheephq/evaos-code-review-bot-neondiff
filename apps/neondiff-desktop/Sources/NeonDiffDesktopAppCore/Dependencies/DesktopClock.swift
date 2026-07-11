import Foundation

package protocol DesktopClock: Sendable {
    var now: Date { get }
    func sleep(for duration: Duration) async throws
}
