import Darwin
import Foundation
import NeonDiffDesktopEvaluationSupport

private enum CheckerError: Error {
    case usage
    case unsafeInput
}

private func emit(_ result: DesktopSettledGeometryCheckResult) {
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    guard let data = try? encoder.encode(result) else {
        FileHandle.standardOutput.write(Data(
            "{\"category\":\"contract\",\"ok\":false,\"reasonCode\":\"checker-encoding-failed\",\"schemaVersion\":1,\"status\":\"failed\"}\n".utf8
        ))
        exit(70)
    }
    FileHandle.standardOutput.write(data)
    FileHandle.standardOutput.write(Data("\n".utf8))
}

do {
    guard CommandLine.arguments.count == 2 else { throw CheckerError.usage }
    let input = URL(fileURLWithPath: CommandLine.arguments[1]).standardizedFileURL
    guard input.isFileURL,
          input.path.hasPrefix("/"),
          input.lastPathComponent == "settled-geometry.json" else {
        throw CheckerError.unsafeInput
    }
    let values = try input.resourceValues(forKeys: [.isRegularFileKey, .isSymbolicLinkKey])
    guard values.isRegularFile == true, values.isSymbolicLink != true else {
        throw CheckerError.unsafeInput
    }
    let trace = try DesktopSettledGeometryTrace.decode(
        data: Data(contentsOf: input, options: [.mappedIfSafe])
    )
    _ = try DesktopSettledGeometryValidator.validate(trace)
    emit(.stable)
} catch CheckerError.usage {
    emit(.inputFailure("usage"))
    exit(64)
} catch CheckerError.unsafeInput {
    emit(.inputFailure("unsafe-input"))
    exit(65)
} catch let error as DesktopSettledGeometryValidationError {
    emit(.failure(error))
    exit(65)
} catch {
    emit(.inputFailure("input-read-failed"))
    exit(65)
}
