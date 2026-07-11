import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopDashboardLauncher: DesktopDashboardLaunching {
    func launch(
        executablePath: String,
        arguments: [String],
        workingDirectory: URL?
    ) async throws -> CLILaunchResult {
        try await Task.detached(priority: .userInitiated) {
            let client = NeonDiffCLIClient(
                executablePath: executablePath,
                workingDirectory: workingDirectory
            )
            return try client.launchDetached(arguments: arguments)
        }.value
    }
}
