import Foundation
import NeonDiffDesktopAppCore

enum LaunchAgentLocalBotConfigurationDiscovery {
    static let defaultLabel = "com.electricsheephq.evaos-code-review-bot"

    static func discover(
        label: String = defaultLabel,
        fileManager: FileManager = .default
    ) -> [DesktopLocalBotConfiguration] {
        let launchAgentURL = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
            .appendingPathComponent("\(label).plist")
            .standardizedFileURL
        guard let data = try? Data(contentsOf: launchAgentURL, options: .mappedIfSafe),
              let configuration = DesktopLaunchAgentBotConfigurationParser.parse(
                  data: data,
                  expectedLabel: label,
                  configExists: { fileManager.fileExists(atPath: $0.path) }
              )
        else {
            return []
        }
        return [configuration]
    }
}
