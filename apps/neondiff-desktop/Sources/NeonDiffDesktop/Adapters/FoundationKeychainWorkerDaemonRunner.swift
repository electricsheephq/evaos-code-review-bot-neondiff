import Darwin
import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

enum FoundationKeychainWorkerDaemonRunner {
    private static let appIDPreferenceKey = "neondiff.byoGitHubAppId"

    static func runAndExitIfRequested(
        arguments: [String] = Array(CommandLine.arguments.dropFirst()),
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser
    ) {
        guard arguments.first
            == DesktopKeychainWorkerLaunchAgentContract.headlessFlag
        else {
            return
        }
        let status: Int32
        do {
            status = try run(
                arguments: arguments,
                homeDirectory: homeDirectory
            )
        } catch {
            status = 78
        }
        exit(status)
    }

    private static func run(
        arguments: [String],
        homeDirectory: URL
    ) throws -> Int32 {
        guard let request =
            DesktopKeychainWorkerLaunchAgentContract
                .parseHeadlessArguments(
                    arguments,
                    homeDirectory: homeDirectory
                ),
              UserDefaults.standard.string(forKey: appIDPreferenceKey)
                == request.appID,
              isSafeConfig(
                URL(filePath: request.configPath),
                homeDirectory: homeDirectory
              ),
              let context =
                FoundationTrustedBundledWorker.executionContext(),
              context.environmentOverrides.isEmpty,
              context.configPath.isEmpty,
              let workerPath = context.executablePath,
              context.argumentPrefix.isEmpty
        else {
            throw WorkerDaemonRunnerError.invalidInvocation
        }

        let secretStore = KeychainSecretStore()
        guard let stored = try secretStore.readSecret(
            account: BYOGitHubAppKeychainAccount.privateKey,
            allowUserInteraction: false
        ),
        let licenseKey = try secretStore.readSecret(
            account: "license/default",
            allowUserInteraction: false
        ) else {
            throw WorkerDaemonRunnerError.keychainUnavailable
        }
        var standardInput = try DesktopRuntimeCredentialEnvelope(
            appID: request.appID,
            privateKey: stored,
            licenseKey: licenseKey
        ).encodedData()
        defer {
            standardInput.resetBytes(in: 0..<standardInput.count)
        }

        let process = Process()
        process.executableURL = URL(filePath: workerPath)
        process.arguments =
            [
                "daemon",
                "--config", request.configPath,
                "--runtime-credentials-stdin", "true"
            ]
        process.environment = boundedEnvironment(homeDirectory: homeDirectory)
        process.currentDirectoryURL =
            URL(filePath: request.configPath).deletingLastPathComponent()
        process.standardOutput = FileHandle.nullDevice
        process.standardError = FileHandle.nullDevice
        let inputPipe = Pipe()
        process.standardInput = inputPipe
        try process.run()
        guard FoundationTrustedBundledWorker.runningProcessIsTrusted(
            process.processIdentifier
        ) else {
            process.terminate()
            process.waitUntilExit()
            throw WorkerDaemonRunnerError.untrustedWorker
        }
        do {
            try inputPipe.fileHandleForWriting.write(
                contentsOf: standardInput
            )
            try inputPipe.fileHandleForWriting.close()
            standardInput.resetBytes(in: 0..<standardInput.count)
        } catch {
            process.terminate()
            throw WorkerDaemonRunnerError.stdinFailed
        }
        process.waitUntilExit()
        return process.terminationStatus
    }

    private static func boundedEnvironment(
        homeDirectory: URL
    ) -> [String: String] {
        let username = NSUserName()
        return [
            "HOME": homeDirectory.path,
            "USER": username,
            "LOGNAME": username,
            "PATH":
                "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
            "NODE_OPTIONS": "--use-system-ca",
            "TMPDIR": NSTemporaryDirectory()
        ]
    }

    private static func isSafeConfig(
        _ configURL: URL,
        homeDirectory: URL
    ) -> Bool {
        let standardized = configURL.standardizedFileURL
        guard (try? DesktopKeychainWorkerLaunchAgentRequest(
            appID: "1",
            configPath: standardized.path,
            launchdLabel: "com.example.neondiff",
            homeDirectory: homeDirectory
        )) != nil,
        standardized.resolvingSymlinksInPath().path == standardized.path
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
    }
}

private enum WorkerDaemonRunnerError: Error {
    case invalidInvocation
    case keychainUnavailable
    case stdinFailed
    case untrustedWorker
}
