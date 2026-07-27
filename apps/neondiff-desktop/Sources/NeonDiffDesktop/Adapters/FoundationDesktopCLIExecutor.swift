import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopCLIExecutor: DesktopCLIExecuting {
    private let localBotConfigurations: [DesktopLocalBotConfiguration]
    private let localBotExecutionContexts: [DesktopLocalBotExecutionContext]
    private let defaultWorkingDirectory: URL?

    init(
        localBotConfigurations: [DesktopLocalBotConfiguration] = [],
        localBotExecutionContexts: [DesktopLocalBotExecutionContext] = [],
        defaultWorkingDirectory: URL? = NeonDiffCLIResolver.defaultWorkingDirectory()
    ) {
        self.localBotConfigurations = localBotConfigurations
        self.localBotExecutionContexts = localBotExecutionContexts
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
        let environmentOverrides = DesktopLocalBotExecutionContextResolver.resolve(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: localBotExecutionContexts
        )
        let resolvedExecutablePath =
            DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: executablePath,
                arguments: arguments,
                executionContexts: localBotExecutionContexts
            ) ?? executablePath
        let client = NeonDiffCLIClient(
            executablePath: resolvedExecutablePath,
            workingDirectory: workingDirectory,
            environmentOverrides: environmentOverrides
        )
        return try await client.runCancellable(
            arguments: arguments,
            standardInput: standardInput,
            timeout: timeout
        )
    }
}
