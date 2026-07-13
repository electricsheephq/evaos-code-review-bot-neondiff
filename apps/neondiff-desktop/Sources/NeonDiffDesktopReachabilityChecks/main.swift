import Darwin
import Foundation
import NeonDiffDesktopEvaluationSupport

private enum CheckerError: LocalizedError {
    case usage
    case unsafeInput

    var errorDescription: String? {
        switch self {
        case .usage:
            return "usage: NeonDiffDesktopReachabilityChecks <absolute-reachability-json>"
        case .unsafeInput:
            return "reachability trace must be an absolute regular non-symlink file"
        }
    }
}

do {
    guard CommandLine.arguments.count == 2 else { throw CheckerError.usage }
    let input = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    guard input.isFileURL,
          input.path.hasPrefix("/"),
          input.lastPathComponent == "reachability.json" else {
        throw CheckerError.unsafeInput
    }
    let values = try input.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw CheckerError.unsafeInput
    }
    let trace = try DesktopReposReachabilityTrace.decode(data: Data(contentsOf: input, options: [.mappedIfSafe]))
    _ = try DesktopReposReachabilityValidator.validate(trace)
    FileHandle.standardOutput.write(Data("{\"ok\":true,\"status\":\"reachable\"}\n".utf8))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(65)
}
