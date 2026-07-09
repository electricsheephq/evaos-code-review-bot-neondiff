import Foundation

public struct CLIRunResult: Equatable {
    public var exitCode: Int32
    public var stdout: String
    public var stderr: String

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
    func launchDetached(arguments: [String]) throws -> CLILaunchResult
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

    public func launchDetached(arguments: [String]) throws -> CLILaunchResult {
        let process = Process()
        guard let resolvedExecutable = NeonDiffCLIResolver.resolveExecutablePath(executablePath, workingDirectory: workingDirectory) else {
            throw NeonDiffCLIError.launchFailed("Could not find executable NeonDiff CLI at \(executablePath). Set an absolute CLI path or install the `neondiff` command in a GUI-visible bin directory.")
        }
        let commandLine = ([resolvedExecutable.path] + arguments).map(shellQuote).joined(separator: " ")
        process.executableURL = URL(fileURLWithPath: "/bin/sh")
        process.arguments = [
            "-lc",
            "\(commandLine) >/dev/null 2>&1 & pid=$!; sleep 0.25; if kill -0 \"$pid\" 2>/dev/null; then echo \"$pid\"; else wait \"$pid\"; exit $?; fi"
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
