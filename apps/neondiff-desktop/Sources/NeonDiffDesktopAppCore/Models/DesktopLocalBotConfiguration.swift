import Foundation

/// Public, non-secret coordinates for an existing local NeonDiff worker.
///
/// This never contains a private-key path or value. Server-authoritative
/// account and installation data must still intersect the App ID before the
/// config can be attached to a selectable bot.
package struct DesktopLocalBotConfiguration: Equatable, Sendable {
    package let appID: Int64
    package let configPath: String
    package let workingDirectory: String?

    package init(
        appID: Int64,
        configPath: String,
        workingDirectory: String? = nil
    ) {
        self.appID = appID
        self.configPath = configPath
        self.workingDirectory = workingDirectory
    }
}

/// Process-only coordinates for invoking an already-configured local worker.
///
/// The private-key path is never exposed to the model or UI. The desktop
/// composition root may pass these normalized environment overrides only to
/// an exact `--config` invocation that matches this context.
package struct DesktopLocalBotExecutionContext: Equatable, Sendable {
    package let configPath: String
    package let executablePath: String?
    package let argumentPrefix: [String]
    package let environmentOverrides: [String: String]

    package init(
        configPath: String,
        executablePath: String? = nil,
        argumentPrefix: [String] = [],
        environmentOverrides: [String: String]
    ) {
        self.configPath = configPath
        self.executablePath = executablePath
        self.argumentPrefix = argumentPrefix
        self.environmentOverrides = environmentOverrides
    }
}

package enum DesktopLocalWorkerReviewCompatibility: Equatable, Sendable {
    case unknown
    case checking
    case compatible(packageVersion: String?)
    case incompatible

    package var isCompatible: Bool {
        if case .compatible = self { return true }
        return false
    }
}

package struct DesktopLocalWorkerReviewCapabilityReport: Decodable, Equatable, Sendable {
    package struct LicenseBoundary: Decodable, Equatable, Sendable {
        package let packageVersion: String?
    }

    package struct Usage: Decodable, Equatable, Sendable {
        package struct Flag: Decodable, Equatable, Sendable {
            package let name: String
        }

        package let command: String
        package let flags: [Flag]
    }

    package let ok: Bool
    package let command: String
    package let licenseBoundary: LicenseBoundary?
    package let usage: Usage

    package var supportsExactDryToLiveReview: Bool {
        guard ok,
              command == "review-pr",
              usage.command == "review-pr"
        else {
            return false
        }
        let names = Set(usage.flags.map(\.name))
        return names.isSuperset(of: [
            "--expected-config-revision",
            "--zcode"
        ])
    }

    package static func parse(_ stdout: String) -> Self? {
        guard let data = stdout.data(using: .utf8) else { return nil }
        return try? JSONDecoder().decode(Self.self, from: data)
    }
}

package enum DesktopLaunchAgentBotConfigurationParser {
    private static let supportedAppIDKeys = [
        "NEONDIFF_GITHUB_APP_ID",
        "EVAOS_REVIEW_BOT_APP_ID"
    ]

    package static func parse(
        data: Data,
        expectedLabel: String,
        installedWorkerRoot: URL? = nil,
        configExists: (URL) -> Bool,
        workingDirectoryExists: (URL) -> Bool
    ) -> DesktopLocalBotConfiguration? {
        guard let propertyList = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let root = propertyList as? [String: Any],
        root["Label"] as? String == expectedLabel,
        let environment = root["EnvironmentVariables"] as? [String: Any],
        let arguments = root["ProgramArguments"] as? [String],
        let rawWorkingDirectory = root["WorkingDirectory"] as? String,
        rawWorkingDirectory.hasPrefix("/")
        else {
            return nil
        }
        let workingDirectoryURL = URL(filePath: rawWorkingDirectory)
            .standardizedFileURL
        guard approvedNeonDiffDaemonInvocation(
            arguments,
            workingDirectory: workingDirectoryURL,
            installedWorkerRoot: installedWorkerRoot
        ) else {
            return nil
        }

        let presentAppIDs = supportedAppIDKeys.compactMap { key -> String? in
            guard let value = environment[key] else { return nil }
            return value as? String
        }
        let presentAppIDKeyCount = supportedAppIDKeys.filter {
            environment[$0] != nil
        }.count
        guard !presentAppIDs.isEmpty,
              presentAppIDs.count == presentAppIDKeyCount
        else {
            return nil
        }
        let normalizedAppIDs = presentAppIDs.compactMap { raw -> Int64? in
            guard !raw.isEmpty,
                  raw.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
                  let value = Int64(raw),
                  value > 0
            else {
                return nil
            }
            return value
        }
        guard normalizedAppIDs.count == presentAppIDs.count,
              Set(normalizedAppIDs).count == 1,
              let appID = normalizedAppIDs.first
        else {
            return nil
        }

        let configIndexes = arguments.indices.filter {
            arguments[$0] == "--config"
        }
        guard configIndexes.count == 1,
              let configIndex = configIndexes.first,
              arguments.index(after: configIndex) < arguments.endIndex
        else {
            return nil
        }
        let rawConfigPath = arguments[arguments.index(after: configIndex)]
        guard rawConfigPath.hasPrefix("/") else { return nil }
        let configURL = URL(filePath: rawConfigPath).standardizedFileURL
        guard configExists(configURL) else { return nil }

        guard workingDirectoryExists(workingDirectoryURL) else { return nil }

        return DesktopLocalBotConfiguration(
            appID: appID,
            configPath: configURL.path,
            workingDirectory: workingDirectoryURL.path
        )
    }
}

package enum DesktopLaunchAgentExecutionContextParser {
    private static let appIDKeys = [
        "NEONDIFF_GITHUB_APP_ID",
        "EVAOS_REVIEW_BOT_APP_ID"
    ]
    private static let privateKeyPathKeys = [
        "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH",
        "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH"
    ]

    package static func parse(
        data: Data,
        expectedLabel: String,
        installedWorkerRoot: URL? = nil,
        privateKeyPathIsSafe: (URL) -> Bool
    ) -> DesktopLocalBotExecutionContext? {
        guard let propertyList = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let root = propertyList as? [String: Any],
        root["Label"] as? String == expectedLabel,
        let environment = root["EnvironmentVariables"] as? [String: Any],
        let arguments = root["ProgramArguments"] as? [String],
        let rawWorkingDirectory = root["WorkingDirectory"] as? String,
        rawWorkingDirectory.hasPrefix("/")
        else {
            return nil
        }
        let workingDirectoryURL = URL(filePath: rawWorkingDirectory)
            .standardizedFileURL
        guard approvedNeonDiffDaemonInvocation(
            arguments,
            workingDirectory: workingDirectoryURL,
            installedWorkerRoot: installedWorkerRoot
        ) else {
            return nil
        }

        let appIDs = values(
            for: appIDKeys,
            in: environment
        )
        guard let appID = oneConsistentValue(appIDs),
              !appID.isEmpty,
              appID.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              Int64(appID).map({ $0 > 0 }) == true
        else {
            return nil
        }

        let privateKeyPaths = values(
            for: privateKeyPathKeys,
            in: environment
        )
        guard let rawPrivateKeyPath = oneConsistentValue(privateKeyPaths),
              rawPrivateKeyPath.hasPrefix("/")
        else {
            return nil
        }
        let privateKeyURL = URL(filePath: rawPrivateKeyPath).standardizedFileURL
        guard privateKeyPathIsSafe(privateKeyURL) else { return nil }

        let configIndexes = arguments.indices.filter {
            arguments[$0] == "--config"
        }
        guard configIndexes.count == 1,
              let configIndex = configIndexes.first,
              arguments.index(after: configIndex) < arguments.endIndex
        else {
            return nil
        }
        let rawConfigPath = arguments[arguments.index(after: configIndex)]
        guard rawConfigPath.hasPrefix("/") else { return nil }
        let configPath = URL(filePath: rawConfigPath).standardizedFileURL.path

        var environmentOverrides = [
            "NEONDIFF_GITHUB_APP_ID": appID,
            "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH": privateKeyURL.path
        ]
        if let rawNodeOptions = environment["NODE_OPTIONS"] {
            guard let nodeOptions = rawNodeOptions as? String,
                  nodeOptions == "--use-system-ca"
            else {
                return nil
            }
            environmentOverrides["NODE_OPTIONS"] = nodeOptions
        }

        let executableName = URL(filePath: arguments[0]).lastPathComponent
        let directExecutablePath: String?
        let argumentPrefix: [String]
        if executableName == "neondiff" {
            directExecutablePath = arguments[0] == "neondiff"
                ? nil
                : URL(filePath: arguments[0]).standardizedFileURL.path
            argumentPrefix = []
        } else {
            directExecutablePath = arguments[0].hasPrefix("/")
                ? URL(filePath: arguments[0]).standardizedFileURL.path
                : arguments[0]
            let sourceRunner = workingDirectoryURL
                .appendingPathComponent("node_modules/tsx/dist/cli.mjs")
                .standardizedFileURL.path
            if arguments.count >= 4,
               URL(filePath: arguments[1]).standardizedFileURL.path == sourceRunner,
               arguments[2] == "src/cli.ts"
            {
                argumentPrefix = [sourceRunner, "src/cli.ts"]
            } else {
                argumentPrefix = [
                    URL(filePath: arguments[1]).standardizedFileURL.path
                ]
            }
        }
        return DesktopLocalBotExecutionContext(
            configPath: configPath,
            executablePath: directExecutablePath,
            argumentPrefix: argumentPrefix,
            environmentOverrides: environmentOverrides
        )
    }

    private static func values(
        for keys: [String],
        in environment: [String: Any]
    ) -> [String]? {
        let presentKeys = keys.filter { environment[$0] != nil }
        guard !presentKeys.isEmpty else { return nil }
        let values = presentKeys.compactMap { environment[$0] as? String }
        guard values.count == presentKeys.count else { return nil }
        return values
    }

    private static func oneConsistentValue(_ values: [String]?) -> String? {
        guard let values,
              Set(values).count == 1
        else {
            return nil
        }
        return values.first
    }
}

package enum DesktopInstalledWorkerExecutionContextParser {
    private struct Installation: Decodable {
        let schemaVersion: Int
        let installationKind: String
        let launchdLabel: String
        let nodePath: String
        let candidateHead: String
        let packageVersion: String
        let manifestSHA256: String
    }

    package static func parse(
        data: Data,
        expectedLabel: String,
        installedWorkerRoot: URL,
        resolveCLI: (URL) -> URL?,
        cliIsSafe: (URL) -> Bool,
        nodeIsExecutable: (URL) -> Bool
    ) -> DesktopLocalBotExecutionContext? {
        let allowedKeys: Set<String> = [
            "schemaVersion",
            "installationKind",
            "launchdLabel",
            "nodePath",
            "candidateHead",
            "packageVersion",
            "manifestSHA256"
        ]
        guard let object = try? JSONSerialization.jsonObject(with: data),
              let dictionary = object as? [String: Any],
              Set(dictionary.keys) == allowedKeys,
              let installation = try? JSONDecoder().decode(
            Installation.self,
            from: data
        ),
        installation.schemaVersion == 1,
        installation.installationKind == "credential-free-cli",
        installation.launchdLabel == expectedLabel,
        ["/opt/homebrew/bin/node", "/usr/local/bin/node"].contains(
            installation.nodePath
        ),
        isLowercaseHex(installation.candidateHead, count: 40),
        installation.packageVersion.range(
            of: #"^1\.1\.0-beta\.[1-9][0-9]{0,3}$"#,
            options: .regularExpression
        ) != nil,
        isLowercaseHex(installation.manifestSHA256, count: 64)
        else {
            return nil
        }
        let nodeURL = URL(filePath: installation.nodePath).standardizedFileURL
        guard nodeIsExecutable(nodeURL) else { return nil }

        let candidateCLI = installedWorkerRoot
            .appendingPathComponent(
                "current/node_modules/neondiff/dist/src/cli.js"
            )
            .standardizedFileURL
        let versionID = "\(installation.packageVersion)-\(installation.candidateHead.prefix(12))"
        let expectedResolvedCLI = installedWorkerRoot
            .appendingPathComponent("versions/\(versionID)", isDirectory: true)
            .appendingPathComponent("node_modules/neondiff/dist/src/cli.js")
            .standardizedFileURL
        guard let resolvedCLI = resolveCLI(candidateCLI),
              resolvedCLI.standardizedFileURL == expectedResolvedCLI,
              cliIsSafe(resolvedCLI)
        else {
            return nil
        }
        return DesktopLocalBotExecutionContext(
            configPath: "",
            executablePath: nodeURL.path,
            argumentPrefix: [candidateCLI.path],
            environmentOverrides: [:]
        )
    }

    private static func isLowercaseHex(_ value: String, count: Int) -> Bool {
        value.utf8.count == count
            && value.utf8.allSatisfy {
                ($0 >= 48 && $0 <= 57) || ($0 >= 97 && $0 <= 102)
            }
    }
}

private func approvedNeonDiffDaemonInvocation(
    _ arguments: [String],
    workingDirectory: URL,
    installedWorkerRoot: URL?
) -> Bool {
    guard !arguments.isEmpty else { return false }
    let executableName = URL(filePath: arguments[0]).lastPathComponent
    if executableName == "neondiff" {
        guard arguments[0] == "neondiff" || arguments[0].hasPrefix("/") else {
            return false
        }
        return arguments.count >= 2 && arguments[1] == "daemon"
    }
    guard executableName == "node", arguments.count >= 3 else {
        return false
    }

    let sourceRunner = workingDirectory
        .appendingPathComponent("node_modules/tsx/dist/cli.mjs")
        .standardizedFileURL.path
    if arguments.count >= 4,
       URL(filePath: arguments[1]).standardizedFileURL.path == sourceRunner,
       arguments[2] == "src/cli.ts",
       arguments[3] == "daemon"
    {
        return true
    }

    let bundledCLI = workingDirectory
        .appendingPathComponent("dist/src/cli.js")
        .standardizedFileURL.path
    let candidateCLI = URL(filePath: arguments[1]).standardizedFileURL
    guard arguments[2] == "daemon" else { return false }
    if candidateCLI.path == bundledCLI {
        return true
    }
    guard let installedWorkerRoot else { return false }
    let installedCLI = installedWorkerRoot
        .appendingPathComponent("current/node_modules/neondiff/dist/src/cli.js")
        .standardizedFileURL
    return candidateCLI == installedCLI
}

package enum DesktopLocalBotWorkingDirectoryResolver {
    package static func resolve(
        arguments: [String],
        localBotConfigurations: [DesktopLocalBotConfiguration],
        fallback: URL?
    ) -> URL? {
        let configIndexes = arguments.indices.filter {
            arguments[$0] == "--config"
        }
        guard configIndexes.count == 1,
              let configIndex = configIndexes.first,
              arguments.index(after: configIndex) < arguments.endIndex
        else {
            return fallback
        }

        let rawConfigPath = arguments[arguments.index(after: configIndex)]
        guard rawConfigPath.hasPrefix("/") else { return fallback }
        let configPath = URL(filePath: rawConfigPath).standardizedFileURL.path
        let matches = localBotConfigurations.filter {
            URL(filePath: $0.configPath).standardizedFileURL.path == configPath
                && $0.workingDirectory != nil
        }
        guard matches.count == 1,
              let workingDirectory = matches[0].workingDirectory
        else {
            return fallback
        }
        return URL(filePath: workingDirectory).standardizedFileURL
    }
}

package enum DesktopLocalBotExecutionContextResolver {
    package static func resolve(
        executablePath: String,
        arguments: [String],
        executionContexts: [DesktopLocalBotExecutionContext]
    ) -> [String: String] {
        matchingContext(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: executionContexts,
            commandAccess: .credentialEnvironment
        )?.environmentOverrides ?? [:]
    }

    package static func resolveExecutablePath(
        executablePath: String,
        arguments: [String],
        executionContexts: [DesktopLocalBotExecutionContext]
    ) -> String? {
        (
            matchingContext(
                executablePath: executablePath,
                arguments: arguments,
                executionContexts: executionContexts,
                commandAccess: .executableReuse
            )
            ?? unboundManagedWorkerContext(
                executablePath: executablePath,
                arguments: arguments,
                executionContexts: executionContexts
            )
        )?.executablePath
    }

    package static func resolveArguments(
        executablePath: String,
        arguments: [String],
        executionContexts: [DesktopLocalBotExecutionContext]
    ) -> [String] {
        guard let context = matchingContext(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: executionContexts,
            commandAccess: .executableReuse
        ) ?? unboundManagedWorkerContext(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: executionContexts
        ) else {
            return arguments
        }
        return context.argumentPrefix + arguments
    }

    private enum CommandAccess {
        case credentialEnvironment
        case executableReuse

        func allows(_ arguments: [String]) -> Bool {
            let reviewHelpCommand = arguments.first == "review-pr"
                && arguments.contains("--help")
            let credentialCommand = (
                arguments.first == "review-pr" && !reviewHelpCommand
            )
                || Array(arguments.prefix(2)) == ["doctor", "github"]
            switch self {
            case .credentialEnvironment:
                return credentialCommand
            case .executableReuse:
                return credentialCommand
                    || reviewHelpCommand
                    || Array(arguments.prefix(2)) == ["config", "inspect"]
                    || Array(arguments.prefix(2)) == ["license", "status"]
                    || (
                        arguments.count >= 2
                            && arguments[0] == "daemon"
                            && ["start", "stop", "status"]
                                .contains(arguments[1])
                    )
            }
        }
    }

    private static func matchingContext(
        executablePath: String,
        arguments: [String],
        executionContexts: [DesktopLocalBotExecutionContext],
        commandAccess: CommandAccess
    ) -> DesktopLocalBotExecutionContext? {
        guard executablePath == "neondiff" else { return nil }
        guard commandAccess.allows(arguments) else { return nil }
        let configIndexes = arguments.indices.filter {
            arguments[$0] == "--config"
        }
        guard configIndexes.count == 1,
              let configIndex = configIndexes.first,
              arguments.index(after: configIndex) < arguments.endIndex
        else {
            return nil
        }

        let rawConfigPath = arguments[arguments.index(after: configIndex)]
        guard rawConfigPath.hasPrefix("/") else { return nil }
        let configPath = URL(filePath: rawConfigPath).standardizedFileURL.path
        let matches = executionContexts.filter {
            !$0.configPath.isEmpty
                && URL(filePath: $0.configPath).standardizedFileURL.path
                    == configPath
        }
        guard matches.count == 1 else { return nil }
        return matches[0]
    }

    /// A newly created account bot has an isolated config path, so it cannot
    /// match the existing LaunchAgent config that proved the local worker.
    /// Reuse only the exact installer-managed worker executable for the
    /// bounded first-run commands that do not borrow the existing bot's
    /// credential environment. The separate `resolve` method intentionally
    /// remains exact-config-only.
    private static func unboundManagedWorkerContext(
        executablePath: String,
        arguments: [String],
        executionContexts: [DesktopLocalBotExecutionContext]
    ) -> DesktopLocalBotExecutionContext? {
        guard executablePath == "neondiff",
              isSupportedUnboundCommand(arguments),
              isIsolatedAccountBotConfig(arguments)
        else {
            return nil
        }
        let trusted = executionContexts.filter(isTrustedBundledWorker)
        if trusted.count == 1 {
            return trusted[0]
        }
        guard trusted.isEmpty else { return nil }
        let installed = executionContexts.filter(isInstallerManagedWorker)
        guard installed.count == 1 else { return nil }
        return installed[0]
    }

    private static func isSupportedUnboundCommand(_ arguments: [String]) -> Bool {
        if arguments.count == 3,
           arguments[0] == "init",
           arguments[1] == "--config"
        {
            return true
        }
        if arguments.count == 4,
           Array(arguments.prefix(2)) == ["config", "inspect"],
           arguments[2] == "--config"
        {
            return true
        }
        if Array(arguments.prefix(2)) == ["config", "patch"] {
            return isSupportedConfigPatch(arguments)
        }
        if arguments.count == 6,
           Array(arguments.prefix(2)) == ["daemon", "status"],
           arguments[2] == "--config",
           arguments[4] == "--launchd-label",
           !arguments[5].isEmpty
        {
            return true
        }
        guard arguments.count == 9,
              Array(arguments.prefix(2)) == ["doctor", "github"],
              arguments[2] == "--config",
              arguments[4] == "--github-app-id",
              !arguments[5].isEmpty,
              arguments[5].utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              Int64(arguments[5]).map({ $0 > 0 }) == true,
              arguments[6] == "--github-app-private-key-stdin",
              arguments[7] == "true",
              arguments[8] == "--json"
        else {
            return false
        }
        return true
    }

    private static func isSupportedConfigPatch(_ arguments: [String]) -> Bool {
        guard arguments.count >= 8,
              arguments.count.isMultiple(of: 2)
        else {
            return false
        }

        var values: [String: String] = [:]
        var index = 2
        while index < arguments.count {
            let flag = arguments[index]
            let value = arguments[index + 1]
            guard [
                "--config",
                "--input",
                "--dry-run",
                "--expected-revision",
                "--confirm"
            ].contains(flag),
            values[flag] == nil,
            !value.isEmpty
            else {
                return false
            }
            values[flag] = value
            index += 2
        }

        guard values["--config"] != nil,
              values["--input"].map({ $0.hasPrefix("/") }) == true,
              let dryRun = values["--dry-run"],
              dryRun == "true" || dryRun == "false"
        else {
            return false
        }
        if dryRun == "true" {
            return values["--confirm"] == nil
        }
        return values["--confirm"] == "true"
    }

    private static func isIsolatedAccountBotConfig(_ arguments: [String]) -> Bool {
        let configIndexes = arguments.indices.filter {
            arguments[$0] == "--config"
        }
        guard configIndexes.count == 1,
              let index = configIndexes.first,
              arguments.index(after: index) < arguments.endIndex
        else {
            return false
        }
        let rawPath = arguments[arguments.index(after: index)]
        guard rawPath.hasPrefix("/") else { return false }
        let components = URL(filePath: rawPath).standardizedFileURL.pathComponents
        guard components.count >= 8 else { return false }
        let suffix = Array(components.suffix(8))
        return suffix[0] == "Library"
            && suffix[1] == "Application Support"
            && suffix[2] == "NeonDiffDesktop"
            && suffix[3] == "Accounts"
            && !suffix[4].isEmpty
            && suffix[4] != "_unselected"
            && suffix[5] == "Bots"
            && !suffix[6].isEmpty
            && suffix[7] == "config.local.json"
    }

    private static func isTrustedBundledWorker(
        _ context: DesktopLocalBotExecutionContext
    ) -> Bool {
        guard let executablePath = context.executablePath,
              executablePath
                == "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
              context.argumentPrefix.isEmpty,
              context.environmentOverrides.isEmpty
        else {
            return false
        }
        return true
    }

    private static func isInstallerManagedWorker(
        _ context: DesktopLocalBotExecutionContext
    ) -> Bool {
        guard let executablePath = context.executablePath,
              executablePath.hasPrefix("/"),
              URL(filePath: executablePath).lastPathComponent == "node",
              context.argumentPrefix.count == 1
        else {
            return false
        }
        let components = URL(
            filePath: context.argumentPrefix[0]
        ).standardizedFileURL.pathComponents
        guard components.count >= 11 else { return false }
        let suffix = Array(components.suffix(11))
        return suffix[0] == "Library"
            && suffix[1] == "Application Support"
            && suffix[2] == "NeonDiffDesktop"
            && suffix[3] == "Workers"
            && !suffix[4].isEmpty
            && suffix[5] == "current"
            && suffix[6] == "node_modules"
            && suffix[7] == "neondiff"
            && suffix[8] == "dist"
            && suffix[9] == "src"
            && suffix[10] == "cli.js"
    }
}
