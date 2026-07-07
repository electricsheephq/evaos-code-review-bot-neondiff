import Foundation
import NeonDiffDesktopCore

struct AppcastDryRunArguments {
    var fixture: URL?
    var output: URL?

    init(_ arguments: [String]) throws {
        var index = 0
        while index < arguments.count {
            let argument = arguments[index]
            switch argument {
            case "--fixture":
                index += 1
                guard index < arguments.count else { throw ArgumentError.missingValue("--fixture") }
                fixture = URL(fileURLWithPath: arguments[index])
            case "--output":
                index += 1
                guard index < arguments.count else { throw ArgumentError.missingValue("--output") }
                output = URL(fileURLWithPath: arguments[index])
            case "--dry-run":
                break
            default:
                throw ArgumentError.unknown(argument)
            }
            index += 1
        }
    }
}

enum ArgumentError: Error, LocalizedError {
    case missingValue(String)
    case missingFixture
    case unknown(String)

    var errorDescription: String? {
        switch self {
        case .missingValue(let flag): "\(flag) requires a value"
        case .missingFixture: "--fixture is required"
        case .unknown(let argument): "unknown argument: \(argument)"
        }
    }
}

do {
    let parsed = try AppcastDryRunArguments(Array(CommandLine.arguments.dropFirst()))
    guard let fixture = parsed.fixture else { throw ArgumentError.missingFixture }
    let xml = try AppcastDryRun(fixture: fixture, output: parsed.output).run()
    if parsed.output == nil {
        print(xml)
    }
} catch {
    fputs("NeonDiffDesktopAppcastDryRun: \(error.localizedDescription)\n", stderr)
    fputs("usage: NeonDiffDesktopAppcastDryRun --fixture <manifest.json> [--output <appcast.xml>] [--dry-run]\n", stderr)
    exit(2)
}
