import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct FoundationDesktopCLIExecutor: DesktopCLIExecuting {
    private let localBotConfigurations: [DesktopLocalBotConfiguration]
    private let localBotExecutionContextProvider:
        @Sendable () -> [DesktopLocalBotExecutionContext]
    private let defaultWorkingDirectory: URL?
    private let trustedBundledWorker:
        DesktopLocalBotExecutionContext?
    private let trustedProcessValidator:
        @Sendable (Int32) -> Bool

    init(
        localBotConfigurations: [DesktopLocalBotConfiguration] = [],
        localBotExecutionContexts: [DesktopLocalBotExecutionContext] = [],
        localBotExecutionContextProvider:
            (@Sendable () -> [DesktopLocalBotExecutionContext])? = nil,
        defaultWorkingDirectory: URL? =
            NeonDiffCLIResolver.defaultWorkingDirectory(),
        trustedBundledWorker:
            DesktopLocalBotExecutionContext? = nil,
        trustedProcessValidator:
            @escaping @Sendable (Int32) -> Bool = { _ in false }
    ) {
        self.localBotConfigurations = localBotConfigurations
        self.localBotExecutionContextProvider =
            localBotExecutionContextProvider ?? { localBotExecutionContexts }
        self.defaultWorkingDirectory = defaultWorkingDirectory
        self.trustedBundledWorker = trustedBundledWorker
        self.trustedProcessValidator = trustedProcessValidator
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
        let requiresTrustedWorker =
            DesktopTrustedBundledWorkerContract.requiresTrustedWorker(
                arguments: arguments,
                hasStandardInput: standardInput != nil
            )
        if requiresTrustedWorker, executablePath != "neondiff" {
            throw NeonDiffCLIError.launchFailed(
                "Credential input is accepted only by the signed bundled NeonDiff worker"
            )
        }
        let trustedContext: DesktopLocalBotExecutionContext?
        if requiresTrustedWorker {
            guard let trustedBundledWorker else {
                throw NeonDiffCLIError.launchFailed(
                    "The signed bundled NeonDiff worker is unavailable"
                )
            }
            trustedContext = trustedBundledWorker
        } else {
            trustedContext = nil
        }
        let environmentOverrides =
            trustedContext?.environmentOverrides
            ?? DesktopLocalBotExecutionContextResolver.resolve(
                executablePath: executablePath,
                arguments: arguments,
                executionContexts: localBotExecutionContexts
            )
        let resolvedExecutablePath =
            trustedContext?.executablePath
            ?? DesktopLocalBotExecutionContextResolver.resolveExecutablePath(
                executablePath: executablePath,
                arguments: arguments,
                executionContexts: localBotExecutionContexts
            )
            ?? executablePath
        let resolvedArguments: [String]
        if let trustedContext {
            resolvedArguments =
                trustedContext.argumentPrefix + arguments
        } else {
            resolvedArguments =
                DesktopLocalBotExecutionContextResolver.resolveArguments(
                    executablePath: executablePath,
                    arguments: arguments,
                    executionContexts: localBotExecutionContexts
                )
        }
        let processValidator: @Sendable (Int32) -> Bool
        if requiresTrustedWorker {
            processValidator = trustedProcessValidator
        } else {
            processValidator = { _ in true }
        }
        let client = NeonDiffCLIClient(
            executablePath: resolvedExecutablePath,
            workingDirectory: workingDirectory,
            environmentOverrides: environmentOverrides,
            processStartedValidator: processValidator
        )
        return try await client.runCancellable(
            arguments: resolvedArguments,
            standardInput: standardInput,
            timeout: timeout
        )
    }
}
