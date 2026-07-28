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

package enum DesktopLaunchAgentBotConfigurationParser {
    private static let supportedAppIDKeys = [
        "NEONDIFF_GITHUB_APP_ID",
        "EVAOS_REVIEW_BOT_APP_ID"
    ]

    package static func parse(
        data: Data,
        expectedLabel: String,
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
            workingDirectory: workingDirectoryURL
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
            workingDirectory: workingDirectoryURL
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

private func approvedNeonDiffDaemonInvocation(
    _ arguments: [String],
    workingDirectory: URL
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
    return URL(filePath: arguments[1]).standardizedFileURL.path == bundledCLI
        && arguments[2] == "daemon"
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
        matchingContext(
            executablePath: executablePath,
            arguments: arguments,
            executionContexts: executionContexts,
            commandAccess: .executableReuse
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
        ) else {
            return arguments
        }
        return context.argumentPrefix + arguments
    }

    private enum CommandAccess {
        case credentialEnvironment
        case executableReuse

        func allows(_ arguments: [String]) -> Bool {
            let credentialCommand = arguments.first == "review-pr"
                || Array(arguments.prefix(2)) == ["doctor", "github"]
            switch self {
            case .credentialEnvironment:
                return credentialCommand
            case .executableReuse:
                return credentialCommand
                    || Array(arguments.prefix(2)) == ["config", "inspect"]
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
            URL(filePath: $0.configPath).standardizedFileURL.path == configPath
        }
        guard matches.count == 1 else { return nil }
        return matches[0]
    }
}
