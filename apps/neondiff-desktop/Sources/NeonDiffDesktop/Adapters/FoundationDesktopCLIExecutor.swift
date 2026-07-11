import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopCLIExecutor: DesktopCLIExecuting {
    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        let client = NeonDiffCLIClient(
            executablePath: executablePath,
            workingDirectory: NeonDiffCLIResolver.defaultWorkingDirectory()
        )
        return try await client.runCancellable(
            arguments: arguments,
            standardInput: standardInput,
            timeout: timeout
        )
    }
}
