import Foundation

public enum DesktopEvaluationLaunchOptionsError: LocalizedError, Equatable {
    case incomplete
    case duplicate(String)
    case relativeFixturePath
    case unsupportedContentSize
    case fixtureFlagWithoutUITesting

    public var errorDescription: String? {
        switch self {
        case .incomplete: "UI-testing launch arguments are incomplete."
        case .duplicate(let flag): "Duplicate UI-testing launch argument: \(flag)."
        case .relativeFixturePath: "UI fixture path must be absolute."
        case .unsupportedContentSize: "UI-testing content size is not canonical."
        case .fixtureFlagWithoutUITesting: "UI fixture flags require --ui-testing."
        }
    }
}

public struct DesktopEvaluationLaunchOptions: Equatable, Sendable {
    public let fixtureURL: URL
    public let contentSize: DesktopEvaluationContentSize
    public let disableAnimations: Bool

    public static func parse(arguments: [String]) throws -> DesktopEvaluationLaunchOptions? {
        let evaluationFlags: Set<String> = ["--ui-testing", "--ui-fixture", "--content-size", "--disable-animations"]
        let suppliedEvaluationFlags = arguments.filter(evaluationFlags.contains)
        guard !suppliedEvaluationFlags.isEmpty else { return nil }
        guard arguments.contains("--ui-testing") else {
            throw DesktopEvaluationLaunchOptionsError.fixtureFlagWithoutUITesting
        }
        for flag in evaluationFlags where arguments.filter({ $0 == flag }).count > 1 {
            throw DesktopEvaluationLaunchOptionsError.duplicate(flag)
        }
        guard arguments.contains("--disable-animations"),
              let fixturePath = value(after: "--ui-fixture", in: arguments),
              let contentSizeValue = value(after: "--content-size", in: arguments) else {
            throw DesktopEvaluationLaunchOptionsError.incomplete
        }
        guard fixturePath.hasPrefix("/") else {
            throw DesktopEvaluationLaunchOptionsError.relativeFixturePath
        }
        let pieces = contentSizeValue.split(separator: "x", omittingEmptySubsequences: false)
        guard pieces.count == 2,
              let width = Int(pieces[0]),
              let height = Int(pieces[1]) else {
            throw DesktopEvaluationLaunchOptionsError.unsupportedContentSize
        }
        let contentSize = DesktopEvaluationContentSize(width: width, height: height)
        guard DesktopEvaluationContentSize.canonical.contains(contentSize) else {
            throw DesktopEvaluationLaunchOptionsError.unsupportedContentSize
        }
        return DesktopEvaluationLaunchOptions(
            fixtureURL: URL(fileURLWithPath: fixturePath),
            contentSize: contentSize,
            disableAnimations: true
        )
    }

    private static func value(after flag: String, in arguments: [String]) -> String? {
        guard let index = arguments.firstIndex(of: flag), arguments.indices.contains(index + 1) else {
            return nil
        }
        let value = arguments[index + 1]
        return value.hasPrefix("--") ? nil : value
    }
}
