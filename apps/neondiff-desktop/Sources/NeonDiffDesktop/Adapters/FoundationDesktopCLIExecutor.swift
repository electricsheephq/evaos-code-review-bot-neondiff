import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopCLIExecutor: DesktopCLIExecuting {
    private let localBotConfigurations: [DesktopLocalBotConfiguration]
    private let localBotExecutionContextProvider:
        @Sendable () -> [DesktopLocalBotExecutionContext]
    private let defaultWorkingDirectory: URL?

    init(
        localBotConfigurations: [DesktopLocalBotConfiguration] = [],
        localBotExecutionContexts: [DesktopLocalBotExecutionContext] = [],
        localBotExecutionContextProvider:
            (@Sendable () -> [DesktopLocalBotExecutionContext])? = nil,
        defaultWorkingDirectory: URL? = NeonDiffCLIResolver.defaultWorkingDirectory()
    ) {
        self.localBotConfigurations = localBotConfigurations
        self.localBotExecutionContextProvider =
            localBotExecutionContextProvider ?? { localBotExecutionContexts }
        self.defaultWorkingDirectory = defaultWorkingDirectory
    }

    func run(
        executablePath: String,
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval
    ) async throws -> CLIRunResult {
        let localBotExecutionContexts = localBotExecutionContextProvider()
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
        let resolvedArguments = DesktopLocalBotExecutionContextResolver.resolveArguments(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: localBotExecutionContexts
        )
        let client = NeonDiffCLIClient(
            executablePath: resolvedExecutablePath,
            workingDirectory: workingDirectory,
            environmentOverrides: environmentOverrides
        )
        return try await client.runCancellable(
            arguments: resolvedArguments,
            standardInput: standardInput,
            timeout: timeout
        )
    }
}
