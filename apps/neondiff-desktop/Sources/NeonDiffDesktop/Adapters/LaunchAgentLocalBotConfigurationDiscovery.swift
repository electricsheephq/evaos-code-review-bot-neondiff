import Foundation
import NeonDiffDesktopAppCore
import Darwin

enum LaunchAgentLocalBotConfigurationDiscovery {
    static let defaultLabel = "com.electricsheephq.evaos-code-review-bot"

    struct Snapshot {
        let configurations: [DesktopLocalBotConfiguration]
        let executionContexts: [DesktopLocalBotExecutionContext]
    }

    static func discoverSnapshot(
        label: String = defaultLabel,
        fileManager: FileManager = .default
    ) -> Snapshot {
        let launchAgentURL = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent("Library/LaunchAgents", isDirectory: true)
            .appendingPathComponent("\(label).plist")
            .standardizedFileURL
        guard let data = try? Data(contentsOf: launchAgentURL, options: .mappedIfSafe) else {
            return Snapshot(configurations: [], executionContexts: [])
        }
        let configuration = DesktopLaunchAgentBotConfigurationParser.parse(
            data: data,
            expectedLabel: label,
            configExists: { fileManager.fileExists(atPath: $0.path) },
            workingDirectoryExists: {
                var isDirectory: ObjCBool = false
                return fileManager.fileExists(
                    atPath: $0.path,
                    isDirectory: &isDirectory
                ) && isDirectory.boolValue
            }
        )
        let context = DesktopLaunchAgentExecutionContextParser.parse(
            data: data,
            expectedLabel: label,
            privateKeyPathIsSafe: { url in
                isSafePrivateKeyFile(url, fileManager: fileManager)
            }
        )
        return Snapshot(
            configurations: configuration.map { [$0] } ?? [],
            executionContexts: context.map { [$0] } ?? []
        )
    }

    static func discover(
        label: String = defaultLabel,
        fileManager: FileManager = .default
    ) -> [DesktopLocalBotConfiguration] {
        discoverSnapshot(label: label, fileManager: fileManager).configurations
    }

    static func discoverExecutionContexts(
        label: String = defaultLabel,
        fileManager: FileManager = .default
    ) -> [DesktopLocalBotExecutionContext] {
        discoverSnapshot(label: label, fileManager: fileManager).executionContexts
    }

    private static func isSafePrivateKeyFile(
        _ url: URL,
        fileManager: FileManager
    ) -> Bool {
        var statBuffer = stat()
        guard lstat(url.path, &statBuffer) == 0,
              (statBuffer.st_mode & S_IFMT) == S_IFREG,
              statBuffer.st_uid == getuid(),
              (statBuffer.st_mode & 0o077) == 0,
              statBuffer.st_size > 0,
              statBuffer.st_size <= 64 * 1024,
              fileManager.isReadableFile(atPath: url.path)
        else {
            return false
        }
        return true
    }
}
