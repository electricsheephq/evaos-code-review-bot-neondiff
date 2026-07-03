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
        if executablePath.contains("/") {
            process.executableURL = URL(fileURLWithPath: executablePath)
            process.arguments = arguments
        } else {
            process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
            process.arguments = [executablePath] + arguments
        }
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
