import Foundation
import NeonDiffDesktopCore

package protocol DesktopDashboardLaunching: Sendable {
    func launch(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL?
    ) async throws -> CLILaunchResult
}
