import Foundation

public struct DesktopEvaluationLaunchContext: Equatable, Sendable {
    public let options: DesktopEvaluationLaunchOptions
    public let fixture: DesktopEvaluationFixture

    public static func load(arguments: [String]) throws -> DesktopEvaluationLaunchContext? {
        guard let options = try DesktopEvaluationLaunchOptions.parse(arguments: arguments) else {
            return nil
        }
        let values = try options.fixtureURL.resourceValues(forKeys: [
            .isRegularFileKey,
            .isSymbolicLinkKey
        ])
        guard values.isRegularFile == true, values.isSymbolicLink != true else {
            throw DesktopEvaluationFixtureError.invalidValue("launch fixture file")
        }

        let data = try Data(contentsOf: options.fixtureURL, options: [.mappedIfSafe])
        let fixture = try DesktopEvaluationFixture.decode(data: data)
        if let fixtureContentSize = fixture.environment.contentSize,
           fixtureContentSize != options.contentSize {
            throw DesktopEvaluationFixtureError.invalidValue("launch content size mismatch")
        }

        return DesktopEvaluationLaunchContext(options: options, fixture: fixture)
    }
}
