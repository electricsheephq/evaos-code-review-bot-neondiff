import Foundation

/// Public, non-secret coordinates for an existing local NeonDiff worker.
///
/// This never contains a private-key path or value. Server-authoritative
/// account and installation data must still intersect the App ID before the
/// config can be attached to a selectable bot.
package struct DesktopLocalBotConfiguration: Equatable, Sendable {
    package let appID: Int64
    package let configPath: String

    package init(appID: Int64, configPath: String) {
        self.appID = appID
        self.configPath = configPath
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
        configExists: (URL) -> Bool
    ) -> DesktopLocalBotConfiguration? {
        guard let propertyList = try? PropertyListSerialization.propertyList(
            from: data,
            options: [],
            format: nil
        ),
        let root = propertyList as? [String: Any],
        root["Label"] as? String == expectedLabel,
        let environment = root["EnvironmentVariables"] as? [String: Any],
        let arguments = root["ProgramArguments"] as? [String]
        else {
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

        let configIndexes = arguments.indices.filter { index in
            arguments[index] == "--config"
                && arguments.index(after: index) < arguments.endIndex
        }
        guard configIndexes.count == 1,
              let configIndex = configIndexes.first
        else {
            return nil
        }
        let rawConfigPath = arguments[arguments.index(after: configIndex)]
        guard rawConfigPath.hasPrefix("/") else { return nil }
        let configURL = URL(filePath: rawConfigPath).standardizedFileURL
        guard configExists(configURL) else { return nil }

        return DesktopLocalBotConfiguration(
            appID: appID,
            configPath: configURL.path
        )
    }
}
