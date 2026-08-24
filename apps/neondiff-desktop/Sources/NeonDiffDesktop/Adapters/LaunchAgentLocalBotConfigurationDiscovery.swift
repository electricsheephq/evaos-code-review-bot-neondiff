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
        fileManager: FileManager = .default,
        trustedBundledWorker: DesktopLocalBotExecutionContext? = nil
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
            .resolvingSymlinksInPath()
        let launchAgentData = try? Data(
            contentsOf: launchAgentURL,
            options: .mappedIfSafe
        )
        if launchAgentData == nil, entryExists(launchAgentURL) {
            return Snapshot(configurations: [], executionContexts: [])
        }
        guard let data = launchAgentData else {
            guard let context = discoverInstalledWorkerExecutionContext(
                label: label,
                fileManager: fileManager
            )
            else {
                return Snapshot(configurations: [], executionContexts: [])
            }
            return Snapshot(
                configurations: [],
                executionContexts: [context]
            )
        }
        if let request =
            DesktopKeychainWorkerLaunchAgentContract.parsePropertyList(
                data,
                expectedLabel: label,
                homeDirectory: fileManager.homeDirectoryForCurrentUser,
                appExecutableIsSafe: {
                    isSafeAppExecutable($0, fileManager: fileManager)
                },
                configExists: {
                    isSafeConfigFile($0, fileManager: fileManager)
                }
           ),
           let appID = Int64(request.appID),
           let sealedContext =
                trustedBundledWorker
                    ?? FoundationTrustedBundledWorker.executionContext() {
            return Snapshot(
                configurations: [
                    DesktopLocalBotConfiguration(
                        appID: appID,
                        configPath: request.configPath,
                        workingDirectory: URL(
                            filePath: request.configPath
                        ).deletingLastPathComponent().path
                    )
                ],
                executionContexts: [
                    DesktopLocalBotExecutionContext(
                        configPath: request.configPath,
                        executablePath:
                            sealedContext.executablePath,
                        argumentPrefix:
                            sealedContext.argumentPrefix,
                        environmentOverrides: [:]
                    )
                ]
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

    static func discoverInstalledWorkerExecutionContext(
        label: String = defaultLabel,
        fileManager: FileManager = .default
    ) -> DesktopLocalBotExecutionContext? {
        let installedWorkerRoot = fileManager.homeDirectoryForCurrentUser
            .appendingPathComponent(
                "Library/Application Support/NeonDiffDesktop/Workers",
                isDirectory: true
            )
            .appendingPathComponent(label, isDirectory: true)
            .standardizedFileURL
            .resolvingSymlinksInPath()
        let installationURL = installedWorkerRoot
            .appendingPathComponent("installation.json")
        guard isSafeInstallationFile(installationURL),
              let installationData = try? Data(
                contentsOf: installationURL,
                options: .mappedIfSafe
              )
        else {
            return nil
        }
        return DesktopInstalledWorkerExecutionContextParser.parse(
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

    private static func isSafeAppExecutable(
        _ url: URL,
        fileManager: FileManager
    ) -> Bool {
        guard url.path
            == "/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop"
        else {
            return false
        }
        var entry = stat()
        return lstat(url.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && (entry.st_uid == 0 || entry.st_uid == getuid())
            && (entry.st_mode & 0o022) == 0
            && fileManager.isExecutableFile(atPath: url.path)
    }

    private static func isSafeConfigFile(
        _ url: URL,
        fileManager: FileManager
    ) -> Bool {
        let standardized = url.standardizedFileURL
        guard standardized.resolvingSymlinksInPath().path
            == standardized.path
        else {
            return false
        }
        var entry = stat()
        return lstat(standardized.path, &entry) == 0
            && (entry.st_mode & S_IFMT) == S_IFREG
            && entry.st_uid == getuid()
            && (entry.st_mode & 0o022) == 0
            && entry.st_size > 0
            && entry.st_size <= 10 * 1024 * 1024
            && fileManager.isReadableFile(atPath: url.path)
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
