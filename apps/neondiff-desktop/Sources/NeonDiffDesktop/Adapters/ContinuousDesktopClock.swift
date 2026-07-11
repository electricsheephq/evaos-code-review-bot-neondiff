import Foundation
import NeonDiffDesktopAppCore

struct ContinuousDesktopClock: DesktopClock {
    private let monotonicClock = ContinuousClock()

    var now: Date { Date() }

    func sleep(for duration: Duration) async throws {
        try await monotonicClock.sleep(for: duration)
    }
}
