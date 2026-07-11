import Foundation
import NeonDiffDesktopCore

package protocol DesktopCLIExecuting: Sendable {
    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult
}
