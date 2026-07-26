import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopCLIExecutor: DesktopCLIExecuting {
    private let localBotConfigurations: [DesktopLocalBotConfiguration]
    private let defaultWorkingDirectory: URL?

    init(
        localBotConfigurations: [DesktopLocalBotConfiguration] = [],
        defaultWorkingDirectory: URL? = NeonDiffCLIResolver.defaultWorkingDirectory()
    ) {
        self.localBotConfigurations = localBotConfigurations
        self.defaultWorkingDirectory = defaultWorkingDirectory
    }

    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        let workingDirectory = DesktopLocalBotWorkingDirectoryResolver.resolve(
            arguments: arguments,
            localBotConfigurations: localBotConfigurations,
            fallback: defaultWorkingDirectory
        )
        let client = NeonDiffCLIClient(
            executablePath: executablePath,
            workingDirectory: workingDirectory
        )
        return try await client.runCancellable(
            arguments: arguments,
            standardInput: standardInput,
            timeout: timeout
        )
    }
}
