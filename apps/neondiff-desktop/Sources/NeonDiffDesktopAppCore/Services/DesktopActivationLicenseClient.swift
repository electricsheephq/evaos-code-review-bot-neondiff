import Foundation
import NeonDiffDesktopCore

// Issue #612 — AppCore adapter that runs the license CLI through the app's
// injected `DesktopCLIExecuting` while keeping the same secure contract as
// `CLIActivationLicenseClient`: the NeonDiff Activation Key crosses only over
// bounded stdin, argv carries no secret, and the CLI's redacted JSON is
// classified by the shared Core parser.
package struct DesktopActivationLicenseClient: ActivationLicenseClienting {
    private let cli: any DesktopCLIExecuting
    private let executablePath: String
    private let configPath: String
    private let timeout: TimeInterval

    package init(
        cli: any DesktopCLIExecuting,
        executablePath: String,
        configPath: String,
        timeout: TimeInterval = 20
    ) {
        self.cli = cli
        self.executablePath = executablePath
        self.configPath = configPath
        self.timeout = timeout
    }

    package func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        await run(key: key)
    }

    package func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        // Activation is idempotent for the same machine and re-checks the live
        // API entitlement without creating local raw-key state.
        await run(key: key)
    }

    private func run(key: ActivationKeyMaterial) async -> ActivationClientOutcome {
        let arguments = [
            "license", "activate",
            "--config", configPath,
            "--license-storage", "keychain",
            "--license-key-stdin", "true",
            "--persist-local-state", "false",
            "--json"
        ]
        do {
            let result = try await cli.run(
                executablePath: executablePath,
                arguments: arguments,
                standardInput: key.standardInputData(),
                timeout: timeout
            )
            return CLIActivationLicenseClient.classify(stdout: result.stdout)
        } catch let error as NeonDiffCLIError {
            switch error {
            case .timedOut, .cancelled, .cleanupTimedOut:
                return .offline
            case .launchFailed, .standardInputTooLarge, .outputTooLarge:
                return .serviceError
            }
        } catch {
            // Any transport failure is treated as an offline, retryable outcome.
            return .offline
        }
    }
}
