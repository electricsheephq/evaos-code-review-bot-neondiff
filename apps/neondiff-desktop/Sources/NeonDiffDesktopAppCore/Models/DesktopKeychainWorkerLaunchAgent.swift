import Foundation
import NeonDiffDesktopCore

package struct DesktopKeychainWorkerLaunchAgentRequest:
    Equatable,
    Sendable
{
    package let appID: String
    package let licenseMachineID: String
    package let configPath: String
    package let launchdLabel: String

    package init(
        appID: String,
        licenseMachineID: String,
        configPath: String,
        launchdLabel: String,
        homeDirectory: URL
    ) throws {
        guard appID.range(
            of: #"^[1-9][0-9]{0,19}$"#,
            options: .regularExpression
        ) != nil else {
            throw DesktopKeychainWorkerLaunchAgentError.invalidAppID
        }
        guard launchdLabel.range(
            of: #"^[A-Za-z0-9][A-Za-z0-9.-]{2,127}$"#,
            options: .regularExpression
        ) != nil else {
            throw DesktopKeychainWorkerLaunchAgentError.invalidLaunchdLabel
        }
        guard licenseMachineID.range(
            of: #"^[A-Za-z0-9_-]{43}$"#,
            options: .regularExpression
        ) != nil else {
            throw DesktopKeychainWorkerLaunchAgentError.invalidLicenseMachineID
        }
        let normalizedConfig = URL(filePath: configPath).standardizedFileURL
        guard Self.isAccountBotConfig(
            normalizedConfig,
            homeDirectory: homeDirectory
        ) else {
            throw DesktopKeychainWorkerLaunchAgentError.invalidConfigPath
        }
        self.appID = appID
        self.licenseMachineID = licenseMachineID
        self.configPath = normalizedConfig.path
        self.launchdLabel = launchdLabel
    }

    private static func isAccountBotConfig(
        _ configURL: URL,
        homeDirectory: URL
    ) -> Bool {
        let expectedRoot = homeDirectory
            .appending(
                path: "Library/Application Support/NeonDiffDesktop/Accounts",
                directoryHint: .isDirectory
            )
            .standardizedFileURL
        let components = configURL.pathComponents
        let rootComponents = expectedRoot.pathComponents
        guard components.count == rootComponents.count + 4,
              Array(components.prefix(rootComponents.count)) == rootComponents
        else {
            return false
        }
        let suffix = Array(components.suffix(4))
        return !suffix[0].isEmpty
            && suffix[0] != "_unselected"
            && suffix[1] == "Bots"
            && suffix[2].range(
                of: #"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"#,
                options: .regularExpression
            ) != nil
            && suffix[3] == "config.local.json"
    }
}

package enum DesktopKeychainWorkerLaunchAgentError:
    Error,
    LocalizedError
{
    case invalidAppID
    case invalidConfigPath
    case invalidLaunchdLabel
    case invalidLicenseMachineID
    case invalidAppExecutable
    case serializationFailed

    package var errorDescription: String? {
        switch self {
        case .invalidAppID:
            "The customer-owned GitHub App ID is invalid."
        case .invalidConfigPath:
            "The local worker config must be the selected account bot config."
        case .invalidLaunchdLabel:
            "The local worker LaunchAgent label is invalid."
        case .invalidLicenseMachineID:
            "The local worker license device identity is invalid."
        case .invalidAppExecutable:
            "The signed NeonDiff app executable path is invalid."
        case .serializationFailed:
            "The secret-free worker LaunchAgent could not be serialized."
        }
    }
}

package enum DesktopKeychainWorkerLaunchAgentRestartOutcome: Equatable {
    case accepted
    case launchctlRejected
    case notReady
}

package enum DesktopKeychainWorkerLaunchAgentContract {
    package static let headlessFlag = "--neondiff-worker-daemon"
    package static let restartObservationAttempts = 120
    package static let restartObservationIntervalMicroseconds: UInt32 = 250_000

    package static func restartCommands(
        domain: String,
        label: String,
        plistPath: String,
        isLoaded: Bool
    ) -> [[String]] {
        let target = "\(domain)/\(label)"
        var commands: [[String]] = []
        if isLoaded {
            commands.append(["bootout", target])
        }
        commands.append(["bootstrap", domain, plistPath])
        return commands
    }

    package static func restartOutcome(
        bootstrapStatus: Int32,
        stablePIDObserved: Bool
    ) -> DesktopKeychainWorkerLaunchAgentRestartOutcome {
        if stablePIDObserved {
            return .accepted
        }
        return bootstrapStatus == 0 ? .notReady : .launchctlRejected
    }

    package static func headlessArguments(
        request: DesktopKeychainWorkerLaunchAgentRequest
    ) -> [String] {
        [
            headlessFlag,
            "--config", request.configPath,
            "--launchd-label", request.launchdLabel,
            "--github-app-id", request.appID,
            "--license-machine-id", request.licenseMachineID
        ]
    }

    package static func sealedWorkerDaemonArguments(
        request: DesktopKeychainWorkerLaunchAgentRequest
    ) -> [String] {
        [
            "daemon",
            "--config", request.configPath,
            "--runtime-credentials-stdin", "true",
            "--dry-run", "false"
        ]
    }

    package static func redactedPreviewText(
        request: DesktopKeychainWorkerLaunchAgentRequest,
        appExecutableURL: URL,
        sealedWorkerPath: String,
        homeDirectory: URL,
        preservedRepositoryCount: Int
    ) -> String {
        let plistPath = homeDirectory
            .appending(
                path: "Library/LaunchAgents/\(request.launchdLabel).plist",
                directoryHint: .notDirectory
            )
            .standardizedFileURL
            .path
        let redactedArguments = [
            headlessFlag,
            "--config", request.configPath,
            "--launchd-label", request.launchdLabel,
            "--github-app-id", "[stored App ID]",
            "--license-machine-id", "[stored device ID]"
        ].joined(separator: " ")
        let repositoryLabel = preservedRepositoryCount == 1
            ? "repository"
            : "repositories"

        return """
        Ready to install and start the secret-free local review worker.
        LaunchAgent: \(plistPath)
        Program: \(appExecutableURL.standardizedFileURL.path)
        ProgramArguments: \(redactedArguments)
        Sealed worker: \(sealedWorkerPath)
        EnvironmentVariables: none
        Launch policy: RunAtLoad=true; KeepAlive=true; ProcessType=Background; Session=Aqua; stdout=/dev/null; stderr=/dev/null.
        Credentials: Keychain-only at runtime; no secret values in the plist, arguments, or environment.
        Repository allowlist: preserved unchanged (\(preservedRepositoryCount) configured \(repositoryLabel)); no config write.
        Mutation: write only the selected user LaunchAgent, then restart that exact service.
        """
    }

    package static func propertyListData(
        request: DesktopKeychainWorkerLaunchAgentRequest,
        appExecutableURL: URL
    ) throws -> Data {
        let executable = appExecutableURL.standardizedFileURL
        guard executable.path.hasPrefix("/"),
              executable.lastPathComponent == "NeonDiffDesktop"
        else {
            throw DesktopKeychainWorkerLaunchAgentError.invalidAppExecutable
        }
        let propertyList: [String: Any] = [
            "Label": request.launchdLabel,
            "ProgramArguments":
                [executable.path] + headlessArguments(request: request),
            "RunAtLoad": true,
            "KeepAlive": true,
            "ProcessType": "Background",
            "LimitLoadToSessionType": "Aqua",
            "ThrottleInterval": 10,
            "StandardOutPath": "/dev/null",
            "StandardErrorPath": "/dev/null"
        ]
        do {
            return try PropertyListSerialization.data(
                fromPropertyList: propertyList,
                format: .xml,
                options: 0
            )
        } catch {
            throw DesktopKeychainWorkerLaunchAgentError.serializationFailed
        }
    }

    package static func parsePropertyList(
        _ data: Data,
        expectedLabel: String,
        homeDirectory: URL,
        appExecutableIsSafe: (URL) -> Bool,
        configExists: (URL) -> Bool,
        legacyLicenseMachineID: String? = nil
    ) -> DesktopKeychainWorkerLaunchAgentRequest? {
        guard let object = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let root = object as? [String: Any],
        Set(root.keys) == [
            "Label",
            "ProgramArguments",
            "RunAtLoad",
            "KeepAlive",
            "ProcessType",
            "LimitLoadToSessionType",
            "ThrottleInterval",
            "StandardOutPath",
            "StandardErrorPath"
        ],
        root["Label"] as? String == expectedLabel,
        root["RunAtLoad"] as? Bool == true,
        root["KeepAlive"] as? Bool == true,
        root["ProcessType"] as? String == "Background",
        root["LimitLoadToSessionType"] as? String == "Aqua",
        root["ThrottleInterval"] as? Int == 10,
        root["StandardOutPath"] as? String == "/dev/null",
        root["StandardErrorPath"] as? String == "/dev/null",
        let programArguments = root["ProgramArguments"] as? [String],
        [8, 10].contains(programArguments.count),
        let executablePath = programArguments.first,
        executablePath.hasPrefix("/")
        else {
            return nil
        }
        let executable = URL(filePath: executablePath).standardizedFileURL
        let headlessArguments = Array(programArguments.dropFirst())
        let request = parseHeadlessArguments(
            headlessArguments,
            homeDirectory: homeDirectory
        ) ?? legacyLicenseMachineID.flatMap {
            parseLegacyHeadlessArguments(
                headlessArguments,
                licenseMachineID: $0,
                homeDirectory: homeDirectory
            )
        }
        guard appExecutableIsSafe(executable),
              let request,
              request.launchdLabel == expectedLabel,
              configExists(URL(filePath: request.configPath))
        else {
            return nil
        }
        return request
    }

    package static func propertyListMatchesRequest(
        _ data: Data,
        request: DesktopKeychainWorkerLaunchAgentRequest,
        homeDirectory: URL,
        appExecutableIsSafe: (URL) -> Bool,
        configExists: (URL) -> Bool
    ) -> Bool {
        parsePropertyList(
            data,
            expectedLabel: request.launchdLabel,
            homeDirectory: homeDirectory,
            appExecutableIsSafe: appExecutableIsSafe,
            configExists: configExists,
            legacyLicenseMachineID: request.licenseMachineID
        ) == request
    }

    package static func parseHeadlessArguments(
        _ arguments: [String],
        homeDirectory: URL
    ) -> DesktopKeychainWorkerLaunchAgentRequest? {
        guard arguments.count == 9,
              arguments[0] == headlessFlag,
              arguments[1] == "--config",
              arguments[3] == "--launchd-label",
              arguments[5] == "--github-app-id",
              arguments[7] == "--license-machine-id"
        else {
            return nil
        }
        return try? DesktopKeychainWorkerLaunchAgentRequest(
            appID: arguments[6],
            licenseMachineID: arguments[8],
            configPath: arguments[2],
            launchdLabel: arguments[4],
            homeDirectory: homeDirectory
        )
    }

    private static func parseLegacyHeadlessArguments(
        _ arguments: [String],
        licenseMachineID: String,
        homeDirectory: URL
    ) -> DesktopKeychainWorkerLaunchAgentRequest? {
        guard arguments.count == 7,
              arguments[0] == headlessFlag,
              arguments[1] == "--config",
              arguments[3] == "--launchd-label",
              arguments[5] == "--github-app-id"
        else {
            return nil
        }
        return try? DesktopKeychainWorkerLaunchAgentRequest(
            appID: arguments[6],
            licenseMachineID: licenseMachineID,
            configPath: arguments[2],
            launchdLabel: arguments[4],
            homeDirectory: homeDirectory
        )
    }

    package static func runningPID(
        launchctlPrint: String
    ) -> Int32? {
        let lines = launchctlPrint.split(
            whereSeparator: \.isNewline
        ).map {
            $0.trimmingCharacters(in: .whitespaces)
        }
        guard lines.contains("state = running") else { return nil }
        let pidLines = lines.filter { $0.hasPrefix("pid = ") }
        guard pidLines.count == 1,
              let rawPID = pidLines.first?.dropFirst("pid = ".count),
              let pid = Int32(rawPID),
              pid > 0
        else {
            return nil
        }
        return pid
    }
}

package enum DesktopTrustedBundledWorkerContract {
    package static let expectedBundlePath = "/Applications/NeonDiff.app"
    package static let workerRelativePath =
        "Contents/Helpers/NeonDiffWorker"

    package static func requiresTrustedWorker(
        arguments: [String],
        hasStandardInput: Bool
    ) -> Bool {
        if Array(arguments.prefix(2)) == ["license", "status"],
           arguments.contains("--license-machine-id")
        {
            return true
        }
        guard hasStandardInput else { return false }
        return [
            "--runtime-credentials-stdin",
            "--github-app-private-key-stdin",
            "--license-key-stdin"
        ].contains { arguments.contains($0) }
    }

    package static func executionContext(
        appBundleURL: URL,
        appSignatureIsValid: (URL) -> Bool,
        sealedFileIsValid: (URL) -> Bool
    ) -> DesktopLocalBotExecutionContext? {
        let bundle = appBundleURL.standardizedFileURL
        guard bundle.path == expectedBundlePath,
              bundle.resolvingSymlinksInPath().path == bundle.path,
              appSignatureIsValid(bundle)
        else {
            return nil
        }
        let worker = bundle.appending(
            path: workerRelativePath,
            directoryHint: .notDirectory
        ).standardizedFileURL
        guard sealedFileIsValid(worker)
        else {
            return nil
        }
        return DesktopLocalBotExecutionContext(
            configPath: "",
            executablePath: worker.path,
            argumentPrefix: [],
            environmentOverrides: [:]
        )
    }

}

package protocol DesktopKeychainWorkerLaunchAgentManaging: Sendable {
    func preview(
        request: DesktopKeychainWorkerLaunchAgentRequest,
        preservedRepositoryCount: Int
    ) async throws -> String

    func installAndStart(
        request: DesktopKeychainWorkerLaunchAgentRequest
    ) async throws -> String
}

package struct UnavailableDesktopKeychainWorkerLaunchAgentManager:
    DesktopKeychainWorkerLaunchAgentManaging
{
    package init() {}

    package func preview(
        request: DesktopKeychainWorkerLaunchAgentRequest,
        preservedRepositoryCount: Int
    ) async throws -> String {
        throw DesktopKeychainWorkerLaunchAgentError.invalidAppExecutable
    }

    package func installAndStart(
        request: DesktopKeychainWorkerLaunchAgentRequest
    ) async throws -> String {
        throw DesktopKeychainWorkerLaunchAgentError.invalidAppExecutable
    }
}

package struct DesktopLocalBotDiscoverySnapshot: Sendable {
    package let configurations: [DesktopLocalBotConfiguration]
    package let executionContexts: [DesktopLocalBotExecutionContext]

    package init(
        configurations: [DesktopLocalBotConfiguration],
        executionContexts: [DesktopLocalBotExecutionContext]
    ) {
        self.configurations = configurations
        self.executionContexts = executionContexts
    }
}

package struct DesktopRuntimeCredentialEnvelope: Sendable {
    private let appID: String
    private let privateKey: String
    private let licenseKey: String
    private let licenseMachineID: String

    package init(
        appID: String,
        privateKey: String,
        licenseKey: String,
        licenseMachineID: String
    ) throws {
        self.appID = try BYOGitHubAppCredentialValidator
            .normalizedAppId(appID)
        self.privateKey = try Self.normalizedPrivateKey(privateKey)
        guard licenseKey.range(
            of: #"^nd_live_[A-Za-z0-9_-]{8,}$"#,
            options: .regularExpression
        ) != nil else {
            throw DesktopRuntimeCredentialEnvelopeError.invalidLicenseKey
        }
        self.licenseKey = licenseKey
        guard licenseMachineID.range(
            of: #"^[A-Za-z0-9_-]{43}$"#,
            options: .regularExpression
        ) != nil else {
            throw DesktopRuntimeCredentialEnvelopeError
                .invalidLicenseMachineID
        }
        self.licenseMachineID = licenseMachineID
    }

    package func encodedData() throws -> Data {
        try JSONSerialization.data(
            withJSONObject: [
                "schemaVersion": 2,
                "githubAppId": appID,
                "githubPrivateKey": privateKey,
                "licenseKey": licenseKey,
                "licenseMachineId": licenseMachineID
            ],
            options: []
        )
    }

    private static func normalizedPrivateKey(_ value: String) throws -> String {
        do {
            return try BYOGitHubAppCredentialValidator
                .normalizedPrivateKey(value)
        } catch {
            let encoded = Array(
                value.trimmingCharacters(in: .whitespacesAndNewlines).utf8
            )
            guard !encoded.isEmpty,
                  encoded.count.isMultiple(of: 2),
                  encoded.count
                    <= BYOGitHubAppCredentialValidator.maximumPrivateKeyBytes * 2
            else {
                throw error
            }

            var decoded: [UInt8] = []
            decoded.reserveCapacity(encoded.count / 2)
            for index in stride(from: 0, to: encoded.count, by: 2) {
                guard let high = hexadecimalNibble(encoded[index]),
                      let low = hexadecimalNibble(encoded[index + 1])
                else {
                    throw error
                }
                decoded.append((high << 4) | low)
            }
            guard let decodedValue = String(bytes: decoded, encoding: .utf8)
            else {
                throw error
            }
            return try BYOGitHubAppCredentialValidator
                .normalizedPrivateKey(decodedValue)
        }
    }

    private static func hexadecimalNibble(_ byte: UInt8) -> UInt8? {
        switch byte {
        case 48 ... 57:
            byte - 48
        case 65 ... 70:
            byte - 55
        case 97 ... 102:
            byte - 87
        default:
            nil
        }
    }
}

package enum DesktopRuntimeCredentialEnvelopeError:
    Error,
    LocalizedError
{
    case invalidLicenseKey
    case invalidLicenseMachineID

    package var errorDescription: String? {
        switch self {
        case .invalidLicenseKey:
            "The API-backed NeonDiff activation credential is invalid."
        case .invalidLicenseMachineID:
            "The API-backed NeonDiff activation device identity is invalid."
        }
    }
}
