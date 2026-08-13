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
        let installedWorkerRoot = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(
                "Library/Application Support/NeonDiffDesktop/Workers",
                isDirectory: true
            )
            .appendingPathComponent(label, isDirectory: true)
            .standardizedFileURL
        let launchAgentData = try? Data(
            contentsOf: launchAgentURL,
            options: .mappedIfSafe
        )
        if launchAgentData == nil, entryExists(launchAgentURL) {
            return Snapshot(configurations: [], executionContexts: [])
        }
        guard let data = launchAgentData else {
            let installationURL = installedWorkerRoot
                .appendingPathComponent("installation.json")
            guard isSafeInstallationFile(installationURL),
                  let installationData = try? Data(
                    contentsOf: installationURL,
                    options: .mappedIfSafe
                  ),
                  let context =
                    DesktopInstalledWorkerExecutionContextParser.parse(
                        data: installationData,
                        expectedLabel: label,
                        installedWorkerRoot: installedWorkerRoot,
                        resolveCLI: {
                            let resolved = $0.resolvingSymlinksInPath()
                            return resolved == $0 ? nil : resolved
                        },
                        cliIsSafe: {
                            isSafeInstalledCLI($0, fileManager: fileManager)
                        },
                        nodeIsExecutable: {
                            isExecutableRegularFile($0, fileManager: fileManager)
                        }
                    )
            else {
                return Snapshot(configurations: [], executionContexts: [])
            }
            return Snapshot(
                configurations: [],
                executionContexts: [context]
            )
        }
        let configuration = DesktopLaunchAgentBotConfigurationParser.parse(
            data: data,
            expectedLabel: label,
            installedWorkerRoot: installedWorkerRoot,
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
            installedWorkerRoot: installedWorkerRoot,
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

    private static func isSafeInstallationFile(_ url: URL) -> Bool {
        var entry = stat()
        return lstat(url.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && entry.st_uid == getuid()
            && (entry.st_mode & 0o077) == 0
            && entry.st_size > 0
            && entry.st_size <= 1024 * 1024
    }

    private static func entryExists(_ url: URL) -> Bool {
        var entry = stat()
        return lstat(url.path, &entry) == 0
    }

    private static func isSafeInstalledCLI(
        _ url: URL,
        fileManager: FileManager
    ) -> Bool {
        var entry = stat()
        return lstat(url.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && entry.st_uid == getuid()
            && (entry.st_mode & 0o022) == 0
            && entry.st_size > 0
            && entry.st_size <= 50 * 1024 * 1024
            && fileManager.isReadableFile(atPath: url.path)
    }

    private static func isExecutableRegularFile(
        _ url: URL,
        fileManager: FileManager
    ) -> Bool {
        let resolved = url.resolvingSymlinksInPath()
        var entry = stat()
        return lstat(resolved.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && fileManager.isExecutableFile(atPath: resolved.path)
    }
}
