import Darwin
import Foundation
import NeonDiffDesktopAppCore

struct FoundationKeychainWorkerLaunchAgentManager:
    DesktopKeychainWorkerLaunchAgentManaging,
    @unchecked Sendable
{
    private let appExecutableURL: URL
    private let homeDirectory: URL
    private let trustedBundledWorker:
        @Sendable () -> DesktopLocalBotExecutionContext?

    init(
        appExecutableURL: URL,
        homeDirectory: URL = FileManager.default.homeDirectoryForCurrentUser,
        trustedBundledWorker:
            @escaping @Sendable () -> DesktopLocalBotExecutionContext?
    ) {
        self.appExecutableURL = appExecutableURL.standardizedFileURL
        self.homeDirectory = homeDirectory.standardizedFileURL
        self.trustedBundledWorker = trustedBundledWorker
    }

    func preview(
        request: DesktopKeychainWorkerLaunchAgentRequest,
        preservedRepositoryCount: Int
    ) async throws -> String {
        let trustedBundledWorker = try validate(request)
        guard let sealedWorkerPath = trustedBundledWorker.executablePath else {
            throw WorkerLaunchAgentRuntimeError.invalidCoordinates
        }
        return DesktopKeychainWorkerLaunchAgentContract.redactedPreviewText(
            request: request,
            appExecutableURL: appExecutableURL,
            sealedWorkerPath: sealedWorkerPath,
            homeDirectory: homeDirectory,
            preservedRepositoryCount: preservedRepositoryCount
        )
    }

    func installAndStart(
        request: DesktopKeychainWorkerLaunchAgentRequest
    ) async throws -> String {
        try await Task.detached {
            _ = try validate(request)
            let data =
                try DesktopKeychainWorkerLaunchAgentContract.propertyListData(
                    request: request,
                    appExecutableURL: appExecutableURL
                )
            let launchAgentsDirectory = homeDirectory.appending(
                path: "Library/LaunchAgents",
                directoryHint: .isDirectory
            )
            let plistURL = launchAgentsDirectory.appending(
                path: "\(request.launchdLabel).plist",
                directoryHint: .notDirectory
            )
            let fileManager = FileManager.default
            try fileManager.createDirectory(
                at: launchAgentsDirectory,
                withIntermediateDirectories: true,
                attributes: [.posixPermissions: 0o700]
            )

            let previousData: Data?
            if entryExists(plistURL) {
                let existing = try Data(
                    contentsOf: plistURL,
                    options: .mappedIfSafe
                )
                guard DesktopKeychainWorkerLaunchAgentContract
                    .propertyListMatchesRequest(
                        existing,
                        request: request,
                        homeDirectory: homeDirectory,
                        appExecutableIsSafe: { $0 == appExecutableURL },
                        configExists: isSafeConfig
                    )
                else {
                    throw WorkerLaunchAgentRuntimeError
                        .conflictingLaunchAgent
                }
                previousData = existing
            } else {
                previousData = nil
            }

            try writeAtomically(data, to: plistURL)
            do {
            try restartLaunchAgent(
                    label: request.launchdLabel,
                    plistURL: plistURL
                )
            } catch {
                if let previousData {
                    try? writeAtomically(previousData, to: plistURL)
                    try? restartLaunchAgent(
                        label: request.launchdLabel,
                        plistURL: plistURL
                    )
                } else {
                    try? bootoutLaunchAgent(label: request.launchdLabel)
                    try? fileManager.removeItem(at: plistURL)
                }
                throw error
            }
            return "Installed and started the Keychain-backed local review worker without placing its private key in the LaunchAgent."
        }.value
    }

    private func validate(
        _ request: DesktopKeychainWorkerLaunchAgentRequest
    ) throws -> DesktopLocalBotExecutionContext {
        guard let trustedBundledWorker = trustedBundledWorker(),
              isSafeAppExecutable(appExecutableURL),
              isSafeConfig(URL(filePath: request.configPath)),
              trustedBundledWorker.executablePath
                == "/Applications/NeonDiff.app/Contents/Helpers/NeonDiffWorker",
              trustedBundledWorker.argumentPrefix.isEmpty,
              trustedBundledWorker.environmentOverrides.isEmpty
        else {
            throw WorkerLaunchAgentRuntimeError.invalidCoordinates
        }
        return trustedBundledWorker
    }

    private func isSafeAppExecutable(_ url: URL) -> Bool {
        guard url.path
            == "/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop"
        else {
            return false
        }
        var entry = stat()
        guard lstat(url.path, &entry) == 0,
              (entry.st_mode & S_IFMT) == S_IFREG,
              entry.st_uid == 0 || entry.st_uid == getuid(),
              (entry.st_mode & 0o022) == 0
        else {
            return false
        }
        return FileManager.default.isExecutableFile(atPath: url.path)
    }

    private func isSafeConfig(_ url: URL) -> Bool {
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
    }
}

private enum WorkerLaunchAgentRuntimeError: Error, LocalizedError {
    case conflictingLaunchAgent
    case invalidCoordinates
    case launchctlFailed
    case launchctlTimedOut
    case launchctlNotReady
    case writeFailed

    var errorDescription: String? {
        switch self {
        case .conflictingLaunchAgent:
            "The existing LaunchAgent does not match the selected Keychain-only NeonDiff worker."
        case .invalidCoordinates:
            "The signed app, account config, or sealed worker could not be validated."
        case .launchctlFailed:
            "launchd did not accept the secret-free NeonDiff worker service."
        case .launchctlTimedOut:
            "launchd did not finish the worker operation in time."
        case .launchctlNotReady:
            "The Keychain-backed local worker did not remain running."
        case .writeFailed:
            "The secret-free NeonDiff LaunchAgent could not be written safely."
        }
    }
}

private func entryExists(_ url: URL) -> Bool {
    var entry = stat()
    return lstat(url.path, &entry) == 0
}

private func writeAtomically(_ data: Data, to destination: URL) throws {
    let temporary = destination.deletingLastPathComponent().appending(
        path: ".\(destination.lastPathComponent).\(UUID().uuidString).tmp",
        directoryHint: .notDirectory
    )
    let descriptor = open(
        temporary.path,
        O_WRONLY | O_CREAT | O_EXCL | O_CLOEXEC,
        S_IRUSR | S_IWUSR
    )
    guard descriptor >= 0 else {
        throw WorkerLaunchAgentRuntimeError.writeFailed
    }
    var writeError: Error?
    data.withUnsafeBytes { rawBuffer in
        guard let baseAddress = rawBuffer.baseAddress else { return }
        var offset = 0
        while offset < rawBuffer.count {
            let result = Darwin.write(
                descriptor,
                baseAddress.advanced(by: offset),
                rawBuffer.count - offset
            )
            if result <= 0 {
                writeError = WorkerLaunchAgentRuntimeError.writeFailed
                break
            }
            offset += result
        }
    }
    if fsync(descriptor) != 0 {
        writeError = WorkerLaunchAgentRuntimeError.writeFailed
    }
    close(descriptor)
    if let writeError {
        unlink(temporary.path)
        throw writeError
    }
    guard rename(temporary.path, destination.path) == 0 else {
        unlink(temporary.path)
        throw WorkerLaunchAgentRuntimeError.writeFailed
    }
}

private func restartLaunchAgent(label: String, plistURL: URL) throws {
    let domain = "gui/\(getuid())"
    let target = "\(domain)/\(label)"
    let status = try runLaunchctl(["print", target], acceptsFailure: true)
    let commands = DesktopKeychainWorkerLaunchAgentContract.restartCommands(
        domain: domain,
        label: label,
        plistPath: plistURL.path,
        isLoaded: status == 0
    )
    guard let bootstrapCommand = commands.last else {
        throw WorkerLaunchAgentRuntimeError.launchctlFailed
    }
    for command in commands.dropLast() {
        _ = try runLaunchctl(command)
    }
    let bootstrapStatus = try runLaunchctl(
        bootstrapCommand,
        acceptsFailure: true
    )
    var previousPID: Int32?
    var stablePIDObserved = false
    for _ in 0..<DesktopKeychainWorkerLaunchAgentContract
        .restartObservationAttempts
    {
        usleep(
            DesktopKeychainWorkerLaunchAgentContract
                .restartObservationIntervalMicroseconds
        )
        let sample = try runLaunchctlCapture(
            ["print", target],
            acceptsFailure: true
        )
        guard sample.status == 0,
              let pid =
                DesktopKeychainWorkerLaunchAgentContract.runningPID(
                    launchctlPrint: sample.output
                )
        else {
            previousPID = nil
            continue
        }
        if previousPID == pid {
            stablePIDObserved = true
            break
        }
        previousPID = pid
    }
    switch DesktopKeychainWorkerLaunchAgentContract.restartOutcome(
        bootstrapStatus: bootstrapStatus,
        stablePIDObserved: stablePIDObserved
    ) {
    case .accepted:
        return
    case .launchctlRejected:
        throw WorkerLaunchAgentRuntimeError.launchctlFailed
    case .notReady:
        throw WorkerLaunchAgentRuntimeError.launchctlNotReady
    }
}

private func bootoutLaunchAgent(label: String) throws {
    let target = "gui/\(getuid())/\(label)"
    _ = try runLaunchctl(["bootout", target])
}

@discardableResult
private func runLaunchctl(
    _ arguments: [String],
    acceptsFailure: Bool = false
) throws -> Int32 {
    try runLaunchctlCapture(
        arguments,
        acceptsFailure: acceptsFailure
    ).status
}

private func runLaunchctlCapture(
    _ arguments: [String],
    acceptsFailure: Bool = false
) throws -> (status: Int32, output: String) {
    let process = Process()
    process.executableURL = URL(filePath: "/bin/launchctl")
    process.arguments = arguments
    let output = Pipe()
    process.standardOutput = output
    process.standardError = FileHandle.nullDevice
    do {
        try process.run()
    } catch {
        if acceptsFailure { return (1, "") }
        throw WorkerLaunchAgentRuntimeError.launchctlFailed
    }
    let semaphore = DispatchSemaphore(value: 0)
    process.terminationHandler = { _ in semaphore.signal() }
    guard semaphore.wait(timeout: .now() + 15) == .success else {
        process.terminate()
        throw WorkerLaunchAgentRuntimeError.launchctlTimedOut
    }
    if !acceptsFailure, process.terminationStatus != 0 {
        throw WorkerLaunchAgentRuntimeError.launchctlFailed
    }
    let data = output.fileHandleForReading.readDataToEndOfFile()
    return (
        process.terminationStatus,
        String(decoding: data, as: UTF8.self)
    )
}
