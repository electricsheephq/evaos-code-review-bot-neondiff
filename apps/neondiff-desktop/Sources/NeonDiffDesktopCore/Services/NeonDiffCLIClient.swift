import Foundation
import Darwin

public struct CLIRunResult: Equatable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

    public init(exitCode: Int32, stdout: String, stderr: String) {
        self.exitCode = exitCode
        self.stdout = stdout
        self.stderr = stderr
    }

    public var redactedStdout: String { NeonDiffRedactor.redact(stdout) }
    public var redactedStderr: String { NeonDiffRedactor.redact(stderr) }
}

public struct CLILaunchResult: Equatable {
    public var processIdentifier: Int32
    public var executablePath: String
    public var arguments: [String]

    public init(processIdentifier: Int32, executablePath: String, arguments: [String]) {
        self.processIdentifier = processIdentifier
        self.executablePath = executablePath
        self.arguments = arguments
    }
}

public enum NeonDiffCLIError: Error, LocalizedError {
    case timedOut
    case cancelled
    case cleanupTimedOut
    case launchFailed(String)
    case standardInputTooLarge(maxBytes: Int)
    case outputTooLarge(stream: String, maxBytes: Int)

    public var errorDescription: String? {
        switch self {
        case .timedOut: "NeonDiff CLI command timed out"
        case .cancelled: "NeonDiff CLI command was cancelled after bounded process cleanup"
        case .cleanupTimedOut: "NeonDiff CLI process cleanup did not complete within the bounded termination window"
        case .launchFailed(let message): message
        case .standardInputTooLarge(let maxBytes): "NeonDiff CLI standard input exceeds the \(maxBytes)-byte limit"
        case .outputTooLarge(let stream, let maxBytes): "NeonDiff CLI \(stream) exceeds the \(maxBytes)-byte collection limit"
        }
    }
}

public protocol NeonDiffCLIClienting {
    func run(arguments: [String], standardInput: Data?, timeout: TimeInterval) throws -> CLIRunResult
    func runCancellable(arguments: [String], standardInput: Data?, timeout: TimeInterval) async throws -> CLIRunResult
    func launchDetached(arguments: [String]) throws -> CLILaunchResult
}

public extension NeonDiffCLIClienting {
    func run(arguments: [String], timeout: TimeInterval = 15) throws -> CLIRunResult {
        try run(arguments: arguments, standardInput: nil, timeout: timeout)
    }

    func runCancellable(arguments: [String], standardInput: Data?, timeout: TimeInterval) async throws -> CLIRunResult {
        try Task.checkCancellation()
        return try run(arguments: arguments, standardInput: standardInput, timeout: timeout)
    }
}

public final class NeonDiffCLICancellation: @unchecked Sendable {
    private let lock = NSLock()
    private var cancelled = false

    public init() {}
    public func cancel() { lock.withLock { cancelled = true } }
    public var isCancelled: Bool { lock.withLock { cancelled } }
}

public final class NeonDiffCLIClient: NeonDiffCLIClienting, @unchecked Sendable {
    private let executablePath: String
    private let workingDirectory: URL?
    private let standardInputPipeFactory: () -> Pipe
    private let monotonicNow: () -> DispatchTime
    private let standardInputWriter: (Int32, UnsafeRawPointer?, Int) -> Int
    private let beforeProcessLaunch: () -> Void
    private let afterProcessLaunch: () -> Void

    public init(executablePath: String, workingDirectory: URL? = nil) {
        self.executablePath = executablePath
        self.workingDirectory = workingDirectory
        self.standardInputPipeFactory = { Pipe() }
        self.monotonicNow = { DispatchTime.now() }
        self.standardInputWriter = { descriptor, buffer, count in
            Darwin.write(descriptor, buffer, count)
        }
        self.beforeProcessLaunch = {}
        self.afterProcessLaunch = {}
    }

    @_spi(Testing) public init(
        executablePath: String,
        workingDirectory: URL? = nil,
        standardInputPipeFactory: @escaping () -> Pipe = { Pipe() },
        monotonicNow: @escaping () -> DispatchTime = { DispatchTime.now() },
        standardInputWriter: @escaping (Int32, UnsafeRawPointer?, Int) -> Int = { descriptor, buffer, count in
            Darwin.write(descriptor, buffer, count)
        },
        beforeProcessLaunch: @escaping () -> Void = {},
        afterProcessLaunch: @escaping () -> Void = {}
    ) {
        self.executablePath = executablePath
        self.workingDirectory = workingDirectory
        self.standardInputPipeFactory = standardInputPipeFactory
        self.monotonicNow = monotonicNow
        self.standardInputWriter = standardInputWriter
        self.beforeProcessLaunch = beforeProcessLaunch
        self.afterProcessLaunch = afterProcessLaunch
    }

    public func run(
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval = 15
    ) throws -> CLIRunResult {
        try run(arguments: arguments, standardInput: standardInput, timeout: timeout, cancellation: nil)
    }

    public func runCancellable(
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval = 15
    ) async throws -> CLIRunResult {
        let cancellation = NeonDiffCLICancellation()
        return try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                DispatchQueue.global(qos: .userInitiated).async { [self] in
                    do {
                        continuation.resume(returning: try run(
                            arguments: arguments,
                            standardInput: standardInput,
                            timeout: timeout,
                            cancellation: cancellation
                        ))
                    } catch {
                        continuation.resume(throwing: error)
                    }
                }
            }
        } onCancel: {
            cancellation.cancel()
        }
    }

    private func run(
        arguments: [String],
        standardInput: Data?,
        timeout: TimeInterval,
        cancellation: NeonDiffCLICancellation?
    ) throws -> CLIRunResult {
        if cancellation?.isCancelled == true { throw NeonDiffCLIError.cancelled }
        let deadline = monotonicNow() + max(timeout, 0)
        let maximumStandardInputBytes = 64 * 1024
        if let standardInput, standardInput.count > maximumStandardInputBytes {
            throw NeonDiffCLIError.standardInputTooLarge(maxBytes: maximumStandardInputBytes)
        }

        let process = Process()
        if let resolvedExecutable = NeonDiffCLIResolver.resolveExecutablePath(executablePath, workingDirectory: workingDirectory) {
            process.executableURL = resolvedExecutable
            process.arguments = arguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [executablePath] + arguments
        }
        process.environment = guiSafeEnvironment()
        if let workingDirectory {
            process.currentDirectoryURL = workingDirectory
        }

        let stdout = Pipe()
        let stderr = Pipe()
        let stdin = standardInput.map { _ in standardInputPipeFactory() }
        process.standardOutput = stdout
        process.standardError = stderr
        process.standardInput = stdin

        let stdinWriteHandle = stdin?.fileHandleForWriting
        if let stdinWriteHandle {
            let descriptor = stdinWriteHandle.fileDescriptor
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0,
                  fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0,
                  fcntl(descriptor, F_SETNOSIGPIPE, 1) == 0
            else {
                try? stdinWriteHandle.close()
                throw NeonDiffCLIError.launchFailed("Failed to configure bounded NeonDiff CLI standard input")
            }
        }

        for outputHandle in [stdout.fileHandleForReading, stderr.fileHandleForReading] {
            let descriptor = outputHandle.fileDescriptor
            let flags = fcntl(descriptor, F_GETFL)
            guard flags >= 0, fcntl(descriptor, F_SETFL, flags | O_NONBLOCK) == 0 else {
                try? stdinWriteHandle?.close()
                try? stdout.fileHandleForReading.close()
                try? stderr.fileHandleForReading.close()
                throw NeonDiffCLIError.launchFailed("Failed to configure bounded NeonDiff CLI output collection")
            }
        }

        var stdoutData = Data()
        var stderrData = Data()

        let stateChanged = DispatchSemaphore(value: 0)
        let terminationObserved = DispatchSemaphore(value: 0)
        let stateLock = NSLock()
        var processFinished = false
        process.terminationHandler = { _ in
            stateLock.lock()
            processFinished = true
            stateLock.unlock()
            terminationObserved.signal()
            stateChanged.signal()
        }

        beforeProcessLaunch()
        if cancellation?.isCancelled == true {
            try? stdinWriteHandle?.close()
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
            throw NeonDiffCLIError.cancelled
        }
        do {
            try process.run()
        } catch {
            try? stdin?.fileHandleForWriting.close()
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
            throw NeonDiffCLIError.launchFailed("Failed to launch NeonDiff CLI at \(executablePath): \(error.localizedDescription)")
        }
        afterProcessLaunch()

        var inputOffset = 0
        var inputClosed = standardInput == nil
        var outputClosed = false
        var stdoutReachedEnd = false
        var stderrReachedEnd = false
        let maximumOutputBytes = 1024 * 1024

        func closeStandardInput() {
            guard !inputClosed, let stdinWriteHandle else { return }
            inputClosed = true
            try? stdinWriteHandle.close()
        }

        func closeOutputHandles() {
            guard !outputClosed else { return }
            outputClosed = true
            try? stdout.fileHandleForReading.close()
            try? stderr.fileHandleForReading.close()
        }

        func failAtDeadline() throws -> Never {
            closeStandardInput()
            closeOutputHandles()
            try terminateAndReap(process, terminationObserved: terminationObserved)
            throw NeonDiffCLIError.timedOut
        }

        func failIfCancelled() throws {
            guard cancellation?.isCancelled == true else { return }
            closeStandardInput()
            closeOutputHandles()
            try terminateAndReap(process, terminationObserved: terminationObserved)
            throw NeonDiffCLIError.cancelled
        }

        func drainOutput(
            handle: FileHandle,
            stream: String,
            data: inout Data,
            reachedEnd: inout Bool
        ) throws {
            try failIfCancelled()
            guard !reachedEnd else { return }
            switch drainNonblockingOutput(
                descriptor: handle.fileDescriptor,
                data: &data,
                maxBytes: maximumOutputBytes,
                deadline: deadline,
                monotonicNow: monotonicNow,
                isCancelled: { cancellation?.isCancelled == true }
            ) {
            case .open:
                return
            case .endOfFile:
                reachedEnd = true
            case .deadlineExceeded:
                try failAtDeadline()
            case .cancelled:
                try failIfCancelled()
                throw NeonDiffCLIError.cancelled
            case .tooLarge:
                closeStandardInput()
                closeOutputHandles()
                try terminateAndReap(process, terminationObserved: terminationObserved)
                throw NeonDiffCLIError.outputTooLarge(stream: stream, maxBytes: maximumOutputBytes)
            case .failed:
                closeStandardInput()
                closeOutputHandles()
                try terminateAndReap(process, terminationObserved: terminationObserved)
                throw NeonDiffCLIError.launchFailed("Failed to collect bounded NeonDiff CLI \(stream)")
            }
        }

        if standardInput?.isEmpty == true {
            closeStandardInput()
        }

        while true {
            try failIfCancelled()
            if monotonicNow() >= deadline {
                try failAtDeadline()
            }

            try drainOutput(
                handle: stdout.fileHandleForReading,
                stream: "stdout",
                data: &stdoutData,
                reachedEnd: &stdoutReachedEnd
            )
            try drainOutput(
                handle: stderr.fileHandleForReading,
                stream: "stderr",
                data: &stderrData,
                reachedEnd: &stderrReachedEnd
            )

            stateLock.lock()
            let processFinishedSnapshot = processFinished
            stateLock.unlock()

            if processFinishedSnapshot && inputClosed {
                break
            }
            if processFinishedSnapshot {
                closeStandardInput()
                closeOutputHandles()
                try terminateAndReap(process, terminationObserved: terminationObserved)
                throw NeonDiffCLIError.launchFailed("Failed to send bounded standard input to the NeonDiff CLI")
            }

            if !inputClosed, let standardInput, let stdinWriteHandle {
                try failIfCancelled()
                if monotonicNow() >= deadline {
                    try failAtDeadline()
                }
                let remainingCount = standardInput.count - inputOffset
                let written = standardInput.withUnsafeBytes { bytes -> Int in
                    guard let baseAddress = bytes.baseAddress else { return 0 }
                    return standardInputWriter(
                        stdinWriteHandle.fileDescriptor,
                        baseAddress.advanced(by: inputOffset),
                        remainingCount
                    )
                }
                if written > 0 {
                    try failIfCancelled()
                    inputOffset += written
                    if inputOffset == standardInput.count {
                        closeStandardInput()
                    }
                    continue
                }
                if written == -1 && errno == EINTR {
                    continue
                }
                if written != -1 || (errno != EAGAIN && errno != EWOULDBLOCK) {
                    closeStandardInput()
                    closeOutputHandles()
                    try terminateAndReap(process, terminationObserved: terminationObserved)
                    throw NeonDiffCLIError.launchFailed("Failed to send bounded standard input to the NeonDiff CLI")
                }
            }

            let waitNow = monotonicNow()
            try failIfCancelled()
            if waitNow >= deadline {
                try failAtDeadline()
            }

            let remainingNanoseconds = deadline.uptimeNanoseconds - waitNow.uptimeNanoseconds
            let remainingMilliseconds = max(1, Int((remainingNanoseconds + 999_999) / 1_000_000))
            var descriptors: [pollfd] = []
            if !stdoutReachedEnd {
                descriptors.append(pollfd(fd: stdout.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0))
            }
            if !stderrReachedEnd {
                descriptors.append(pollfd(fd: stderr.fileHandleForReading.fileDescriptor, events: Int16(POLLIN), revents: 0))
            }
            if !inputClosed, let stdinWriteHandle {
                descriptors.append(pollfd(fd: stdinWriteHandle.fileDescriptor, events: Int16(POLLOUT), revents: 0))
            }
            if descriptors.isEmpty {
                _ = stateChanged.wait(timeout: deadline)
            } else {
                let pollResult = descriptors.withUnsafeMutableBufferPointer { buffer in
                    Darwin.poll(buffer.baseAddress, nfds_t(buffer.count), Int32(min(remainingMilliseconds, 10)))
                }
                try failIfCancelled()
                if pollResult == -1 && errno != EINTR {
                    closeStandardInput()
                    closeOutputHandles()
                    try terminateAndReap(process, terminationObserved: terminationObserved)
                    throw NeonDiffCLIError.launchFailed("Failed while waiting for bounded NeonDiff CLI I/O")
                }
            }
        }

        try drainOutput(
            handle: stdout.fileHandleForReading,
            stream: "stdout",
            data: &stdoutData,
            reachedEnd: &stdoutReachedEnd
        )
        try drainOutput(
            handle: stderr.fileHandleForReading,
            stream: "stderr",
            data: &stderrData,
            reachedEnd: &stderrReachedEnd
        )
        closeOutputHandles()
        let stdoutText = String(data: stdoutData, encoding: .utf8) ?? ""
        let stderrText = String(data: stderrData, encoding: .utf8) ?? ""
        return CLIRunResult(exitCode: process.terminationStatus, stdout: stdoutText, stderr: stderrText)
    }

    public func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        let process = Process()
        guard let resolvedExecutable = NeonDiffCLIResolver.resolveExecutablePath(executablePath, workingDirectory: workingDirectory) else {
            throw NeonDiffCLIError.launchFailed("Could not find executable NeonDiff CLI at \(executablePath). Set an absolute CLI path or install the `neondiff` command in a GUI-visible bin directory.")
        }
        let commandLine = ([resolvedExecutable.path] + arguments).map(shellQuote).joined(separator: " ")
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-lc",
            "\(commandLine) >/dev/null 2>&1 & pid=$!; echo \"$pid\"; sleep 0.25; if kill -0 \"$pid\" 2>/dev/null; then exit 0; else wait \"$pid\"; exit $?; fi"
        ]
        process.environment = guiSafeEnvironment()
        if let workingDirectory {
            process.currentDirectoryURL = workingDirectory
        }

        let stdout = Pipe()
        let stderr = Pipe()
        process.standardOutput = stdout
        process.standardError = stderr

        do {
            try process.run()
        } catch {
            throw NeonDiffCLIError.launchFailed("Failed to launch NeonDiff CLI at \(executablePath): \(error.localizedDescription)")
        }
        process.waitUntilExit()

        let stdoutText = String(data: stdout.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        let stderrText = String(data: stderr.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? ""
        guard process.terminationStatus == 0 else {
            throw NeonDiffCLIError.launchFailed("Failed to launch NeonDiff CLI at \(executablePath): \(NeonDiffRedactor.redact(stderrText.trimmingCharacters(in: .whitespacesAndNewlines)))")
        }
        guard let processIdentifier = Int32(stdoutText.trimmingCharacters(in: .whitespacesAndNewlines)) else {
            throw NeonDiffCLIError.launchFailed("Failed to read detached NeonDiff CLI process id")
        }

        return CLILaunchResult(
            processIdentifier: processIdentifier,
            executablePath: resolvedExecutable.path,
            arguments: arguments
        )
    }
}

private enum NeonDiffOutputDrainResult {
    case open
    case endOfFile
    case deadlineExceeded
    case tooLarge
    case failed
    case cancelled
}

private func drainNonblockingOutput(
    descriptor: Int32,
    data: inout Data,
    maxBytes: Int,
    deadline: DispatchTime,
    monotonicNow: () -> DispatchTime,
    isCancelled: () -> Bool
) -> NeonDiffOutputDrainResult {
    var buffer = [UInt8](repeating: 0, count: 16 * 1024)
    while true {
        if isCancelled() { return .cancelled }
        if monotonicNow() >= deadline {
            return .deadlineExceeded
        }
        let count = buffer.withUnsafeMutableBytes { bytes in
            Darwin.read(descriptor, bytes.baseAddress, bytes.count)
        }
        if count > 0 {
            guard data.count <= maxBytes - count else { return .tooLarge }
            data.append(contentsOf: buffer.prefix(count))
            continue
        }
        if count == 0 { return .endOfFile }
        if errno == EINTR { continue }
        if errno == EAGAIN || errno == EWOULDBLOCK { return .open }
        return .failed
    }
}

@_spi(Testing) public enum NeonDiffProcessCleanup {
    public static func terminateAndReap(
        isRunning: () -> Bool,
        terminate: () -> Void,
        kill: () -> Void,
        waitForTermination: (DispatchTime) -> DispatchTimeoutResult
    ) throws {
        if isRunning() {
            terminate()
        }
        if waitForTermination(.now() + 0.1) == .success {
            return
        }
        if isRunning() {
            kill()
        }
        guard waitForTermination(.now() + 1) == .success else {
            throw NeonDiffCLIError.cleanupTimedOut
        }
    }
}

private func terminateAndReap(_ process: Process, terminationObserved: DispatchSemaphore) throws {
    try NeonDiffProcessCleanup.terminateAndReap(
        isRunning: { process.isRunning },
        terminate: { process.terminate() },
        kill: { _ = Darwin.kill(process.processIdentifier, SIGKILL) },
        waitForTermination: { deadline in terminationObserved.wait(timeout: deadline) }
    )
}

public enum NeonDiffCLIResolver {
    public static func defaultWorkingDirectory(
        environment: [String: String] = ProcessInfo.processInfo.environment,
        bundleURL: URL = Bundle.main.bundleURL,
        currentDirectory: URL = URL(fileURLWithPath: FileManager.default.currentDirectoryPath),
        fileManager: FileManager = .default
    ) -> URL? {
        if let override = environment["NEONDIFF_DESKTOP_CLI_WORKDIR"], !override.isEmpty {
            let url = URL(fileURLWithPath: override)
            if isDirectory(url.path, fileManager: fileManager) {
                return url
            }
        }

        for startingPoint in [currentDirectory, bundleURL] {
            if let packageRoot = findPackageRoot(startingAt: startingPoint, fileManager: fileManager) {
                return packageRoot
            }
        }
        return nil
    }

    public static func findPackageRoot(startingAt startURL: URL, fileManager: FileManager = .default) -> URL? {
        var current = startURL
        var isDirectoryValue: ObjCBool = false
        if fileManager.fileExists(atPath: current.path, isDirectory: &isDirectoryValue), !isDirectoryValue.boolValue {
            current.deleteLastPathComponent()
        }

        while true {
            if isNeonDiffPackageRoot(current, fileManager: fileManager) {
                return current
            }
            let parent = current.deletingLastPathComponent()
            if parent.path == current.path {
                return nil
            }
            current = parent
        }
    }

    public static func resolveExecutablePath(
        _ executablePath: String,
        workingDirectory: URL?,
        fileManager: FileManager = .default
    ) -> URL? {
        if executablePath.contains("/") {
            return isExecutableFilePath(executablePath, fileManager: fileManager) ? URL(fileURLWithPath: executablePath) : nil
        }

        var candidates: [String] = []
        if let localBin = workingDirectory?.appendingPathComponent("node_modules/.bin/\(executablePath)").path {
            candidates.append(localBin)
        }
        if executablePath == "neondiff", let localPackageBin = workingDirectory?.appendingPathComponent("dist/src/cli.js").path {
            candidates.append(localPackageBin)
        }
        candidates.append(contentsOf: guiSafeUserBinDirectories(fileManager: fileManager).map { "\($0)/\(executablePath)" })

        return candidates.first { isExecutableFilePath($0, fileManager: fileManager) }.map(URL.init(fileURLWithPath:))
    }
}

private func isNeonDiffPackageRoot(_ url: URL, fileManager: FileManager) -> Bool {
    let packageJSON = url.appendingPathComponent("package.json")
    guard fileManager.fileExists(atPath: packageJSON.path) else {
        return false
    }
    guard let data = try? Data(contentsOf: packageJSON),
          let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
          let packageName = root["name"] as? String,
          packageName == "neondiff"
    else {
        return false
    }
    let localBin = url.appendingPathComponent("node_modules/.bin/neondiff").path
    let builtCLI = url.appendingPathComponent("dist/src/cli.js").path
    return isExecutableFilePath(localBin, fileManager: fileManager) || isExecutableFilePath(builtCLI, fileManager: fileManager)
}

private func isExecutableFilePath(_ path: String, fileManager: FileManager) -> Bool {
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        return false
    }
    return fileManager.isExecutableFile(atPath: path)
}

private func isDirectory(_ path: String, fileManager: FileManager) -> Bool {
    var isDirectory: ObjCBool = false
    return fileManager.fileExists(atPath: path, isDirectory: &isDirectory) && isDirectory.boolValue
}

private func guiSafeUserBinDirectories(fileManager: FileManager = .default) -> [String] {
    let home = fileManager.homeDirectoryForCurrentUser.path
    return [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        "\(home)/.local/bin",
        "\(home)/.bun/bin",
        "\(home)/.npm-global/bin"
    ]
}

private func guiSafeSearchPath() -> String {
    (
        guiSafeUserBinDirectories()
            + ["/opt/homebrew/sbin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"]
    ).joined(separator: ":")
}

private func guiSafeEnvironment() -> [String: String] {
    let inherited = ProcessInfo.processInfo.environment
    var environment = ["PATH": guiSafeSearchPath()]
    for key in ["HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL", "LC_CTYPE"] {
        if let value = inherited[key], !value.isEmpty {
            environment[key] = value
        }
    }
    return environment
}
