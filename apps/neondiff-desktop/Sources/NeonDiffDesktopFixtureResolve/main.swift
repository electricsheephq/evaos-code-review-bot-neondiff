import Foundation
import NeonDiffDesktopEvaluationSupport

do {
    let context = try DesktopEvaluationLaunchContext.load(arguments: CommandLine.arguments)
    guard let context else { throw DesktopEvaluationLaunchOptionsError.incomplete }
    let encoder = JSONEncoder()
    encoder.outputFormatting = [.sortedKeys]
    FileHandle.standardOutput.write(try encoder.encode(context.fixture))
    FileHandle.standardOutput.write(Data("\n".utf8))
} catch {
    FileHandle.standardError.write(Data("\(error.localizedDescription)\n".utf8))
    exit(1)
}
