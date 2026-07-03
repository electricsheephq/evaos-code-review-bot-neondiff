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
        return fileManager.isExecutableFile(atPath: executablePath) ? URL(fileURLWithPath: executablePath) : nil
    }

    let home = fileManager.homeDirectoryForCurrentUser.path
    let candidates = [
        "/opt/homebrew/bin/\(executablePath)",
        "/usr/local/bin/\(executablePath)",
        "\(home)/.local/bin/\(executablePath)",
        "\(home)/.bun/bin/\(executablePath)",
        "\(home)/.npm-global/bin/\(executablePath)",
        workingDirectory?.appendingPathComponent("node_modules/.bin/\(executablePath)").path
    ].compactMap { $0 }

    return candidates.first(where: fileManager.isExecutableFile).map(URL.init(fileURLWithPath:))
}

private func guiSafeSearchPath() -> String {
    let home = FileManager.default.homeDirectoryForCurrentUser.path
    return [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
        "\(home)/.local/bin",
        "\(home)/.bun/bin",
        "\(home)/.npm-global/bin"
    ].joined(separator: ":")
}

private func guiSafeEnvironment() -> [String: String] {
    var environment = ProcessInfo.processInfo.environment
    let safePath = guiSafeSearchPath()
    if let existingPath = environment["PATH"], !existingPath.isEmpty {
        environment["PATH"] = "\(safePath):\(existingPath)"
    } else {
        environment["PATH"] = safePath
    }
    return environment
}
