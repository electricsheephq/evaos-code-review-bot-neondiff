import Foundation

public struct CLIRunResult: Equatable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

    public var redactedStdout: String { NeonDiffRedactor.redact(stdout) }
    public var redactedStderr: String { NeonDiffRedactor.redact(stderr) }
}

public enum NeonDiffCLIError: Error, LocalizedError {
    case timedOut
    case launchFailed(String)

    public var errorDescription: String? {
        switch self {
        case .timedOut: "NeonDiff CLI command timed out"
        case .launchFailed(let message): message
        }
    }
}

public protocol NeonDiffCLIClienting {
    func run(arguments: [String], timeout: TimeInterval) throws -> CLIRunResult
}

public final class NeonDiffCLIClient: NeonDiffCLIClienting {
    private let executablePath: String
    private let workingDirectory: URL?

    public init(executablePath: String, workingDirectory: URL? = nil) {
        self.executablePath = executablePath
        self.workingDirectory = workingDirectory
    }

    public func run(arguments: [String], timeout: TimeInterval = 15) throws -> CLIRunResult {
        let process = Process()
        if let resolvedExecutable = resolveExecutablePath(executablePath, workingDirectory: workingDirectory) {
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
        process.standardOutput = stdout
        process.standardError = stderr

        let outputLock = NSLock()
        var stdoutData = Data()
        var stderrData = Data()
        stdout.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            outputLock.lock()
            stdoutData.append(data)
            outputLock.unlock()
        }
        stderr.fileHandleForReading.readabilityHandler = { handle in
            let data = handle.availableData
            guard !data.isEmpty else { return }
            outputLock.lock()
            stderrData.append(data)
            outputLock.unlock()
        }

        let finished = DispatchSemaphore(value: 0)
        process.terminationHandler = { _ in finished.signal() }

        do {
            try process.run()
        } catch {
            throw NeonDiffCLIError.launchFailed("Failed to launch NeonDiff CLI at \(executablePath): \(error.localizedDescription)")
        }

        if finished.wait(timeout: .now() + timeout) == .timedOut {
            process.terminate()
            stdout.fileHandleForReading.readabilityHandler = nil
            stderr.fileHandleForReading.readabilityHandler = nil
            throw NeonDiffCLIError.timedOut
        }

        stdout.fileHandleForReading.readabilityHandler = nil
        stderr.fileHandleForReading.readabilityHandler = nil
        let trailingStdout = stdout.fileHandleForReading.readDataToEndOfFile()
        let trailingStderr = stderr.fileHandleForReading.readDataToEndOfFile()
        outputLock.lock()
        stdoutData.append(trailingStdout)
        stderrData.append(trailingStderr)
        let stdoutSnapshot = stdoutData
        let stderrSnapshot = stderrData
        outputLock.unlock()
        let stdoutText = String(data: stdoutSnapshot, encoding: .utf8) ?? ""
        let stderrText = String(data: stderrSnapshot, encoding: .utf8) ?? ""
        return CLIRunResult(exitCode: process.terminationStatus, stdout: stdoutText, stderr: stderrText)
    }
}

private func resolveExecutablePath(_ executablePath: String, workingDirectory: URL?) -> URL? {
    let fileManager = FileManager.default
    if executablePath.contains("/") {
        return isExecutableFilePath(executablePath, fileManager: fileManager) ? URL(fileURLWithPath: executablePath) : nil
    }

    var candidates = guiSafeUserBinDirectories(fileManager: fileManager).map { "\($0)/\(executablePath)" }
    if let localBin = workingDirectory?.appendingPathComponent("node_modules/.bin/\(executablePath)").path {
        candidates.append(localBin)
    }

    return candidates.first { isExecutableFilePath($0, fileManager: fileManager) }.map(URL.init(fileURLWithPath:))
}

private func isExecutableFilePath(_ path: String, fileManager: FileManager) -> Bool {
    var isDirectory: ObjCBool = false
    guard fileManager.fileExists(atPath: path, isDirectory: &isDirectory), !isDirectory.boolValue else {
        return false
    }
    return fileManager.isExecutableFile(atPath: path)
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
