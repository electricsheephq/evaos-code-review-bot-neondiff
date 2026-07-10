import Foundation
@_spi(Testing) import NeonDiffDesktopCore

public enum DesktopEvaluationFixtureError: LocalizedError, Equatable {
    case invalidJSON
    case oversized
    case unsupportedSchemaVersion(Int)
    case unknownField(path: String, field: String)
    case invalidValue(String)
    case unsafeContent(String)

    public var errorDescription: String? {
        switch self {
        case .invalidJSON:
            "Evaluation fixture must be a JSON object."
        case .oversized:
            "Evaluation fixture exceeds the 256 KiB limit."
        case .unsupportedSchemaVersion(let version):
            "Unsupported evaluation fixture schema version: \(version)."
        case .unknownField(let path, let field):
            "Unknown evaluation fixture field at \(path): \(field)."
        case .invalidValue(let detail):
            "Invalid evaluation fixture value: \(detail)."
        case .unsafeContent(let detail):
            "Unsafe evaluation fixture content: \(detail)."
        }
    }
}

public enum DesktopEvaluationAppearance: String, Codable, Sendable {
    case dark
    case light
    case system
}

public struct DesktopEvaluationContentSize: Codable, Equatable, Hashable, Sendable {
    public let width: Int
    public let height: Int

    public init(width: Int, height: Int) {
        self.width = width
        self.height = height
    }

    public static let canonical = [
        DesktopEvaluationContentSize(width: 1040, height: 680),
        DesktopEvaluationContentSize(width: 1280, height: 800),
        DesktopEvaluationContentSize(width: 1440, height: 900),
        DesktopEvaluationContentSize(width: 760, height: 560),
        DesktopEvaluationContentSize(width: 560, height: 700)
    ]
}

public struct DesktopEvaluationFixture: Codable, Equatable, Sendable {
    public struct Surface: Codable, Equatable, Sendable {
        public let section: DesktopSection
        public let onboardingStep: OnboardingStep?
    }

    public struct Environment: Codable, Equatable, Sendable {
        public let clock: String
        public let locale: String
        public let appearance: DesktopEvaluationAppearance
        public let disableAnimations: Bool
        public let contentSize: DesktopEvaluationContentSize?
    }

    public struct RepositoryState: Codable, Equatable, Sendable {
        public let name: String
        public let enabled: Bool
        public let profile: String
        public let lastReview: String
    }

    public struct ProviderState: Codable, Equatable, Sendable {
        public let id: String
        public let displayName: String
        public let adapter: String
        public let authMode: String
        public let baseURL: String
        public let model: String
        public let credentialPresent: Bool
        public let verification: String
    }

    public struct LicenseState: Codable, Equatable, Sendable {
        public let entitlement: String
        public let credentialPresent: Bool
        public let updateChannel: String
    }

    public struct GitHubState: Codable, Equatable, Sendable {
        public let connection: String
        public let login: String?
        public let repositoryCount: Int
    }

    public struct State: Codable, Equatable, Sendable {
        public let health: String
        public let runtimeReady: Bool?
        public let repositories: [RepositoryState]
        public let provider: ProviderState?
        public let license: LicenseState
        public let github: GitHubState
        public let logText: String
    }

    public struct ScriptedOutcome: Codable, Equatable, Sendable {
        public let action: String
        public let result: String
        public let delayMilliseconds: Int
    }

    public let schemaVersion: Int
    public let id: String
    public let surface: Surface
    public let environment: Environment
    public let state: State
    public let scriptedOutcomes: [ScriptedOutcome]
    public let expectedActions: [String]
    public let safeCopy: [String]

    public static func decode(data: Data) throws -> DesktopEvaluationFixture {
        guard data.count <= 256 * 1024 else {
            throw DesktopEvaluationFixtureError.oversized
        }
        let object: Any
        do {
            object = try JSONSerialization.jsonObject(with: data, options: [])
        } catch {
            throw DesktopEvaluationFixtureError.invalidJSON
        }
        guard let root = object as? [String: Any] else {
            throw DesktopEvaluationFixtureError.invalidJSON
        }
        try validateShape(root)
        try validateSafeContent(object)

        let fixture: DesktopEvaluationFixture
        do {
            fixture = try JSONDecoder().decode(DesktopEvaluationFixture.self, from: data)
        } catch {
            throw DesktopEvaluationFixtureError.invalidValue("fixture does not match schema")
        }
        try fixture.validate()
        return fixture
    }

    private func validate() throws {
        guard schemaVersion == 1 else {
            throw DesktopEvaluationFixtureError.unsupportedSchemaVersion(schemaVersion)
        }
        guard id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil else {
            throw DesktopEvaluationFixtureError.invalidValue("id")
        }
        guard ISO8601DateFormatter().date(from: environment.clock) != nil else {
            throw DesktopEvaluationFixtureError.invalidValue("clock")
        }
        guard environment.locale.range(of: #"^[A-Za-z0-9_@.-]{2,48}$"#, options: .regularExpression) != nil else {
            throw DesktopEvaluationFixtureError.invalidValue("locale")
        }
        guard environment.disableAnimations else {
            throw DesktopEvaluationFixtureError.invalidValue("disableAnimations must be true")
        }
        if let contentSize = environment.contentSize,
           !DesktopEvaluationContentSize.canonical.contains(contentSize) {
            throw DesktopEvaluationFixtureError.invalidValue("contentSize")
        }
        guard state.github.repositoryCount >= 0 else {
            throw DesktopEvaluationFixtureError.invalidValue("github.repositoryCount")
        }
        for repository in state.repositories {
            guard repository.name.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("repository.name")
            }
        }
        for outcome in scriptedOutcomes {
            guard (0...30_000).contains(outcome.delayMilliseconds) else {
                throw DesktopEvaluationFixtureError.invalidValue("scriptedOutcomes.delayMilliseconds")
            }
        }
    }

    private static func validateShape(_ root: [String: Any]) throws {
        try requireOnly(root, allowed: ["schemaVersion", "id", "surface", "environment", "state", "scriptedOutcomes", "expectedActions", "safeCopy"], path: "root")
        try requireObject(root["surface"], allowed: ["section", "onboardingStep"], path: "surface")
        try requireObject(root["environment"], allowed: ["clock", "locale", "appearance", "disableAnimations", "contentSize"], path: "environment")
        let state = try object(root["state"], path: "state")
        try requireOnly(state, allowed: ["health", "runtimeReady", "repositories", "provider", "license", "github", "logText"], path: "state")
        if let repositories = state["repositories"] as? [Any] {
            for (index, value) in repositories.enumerated() {
                try requireObject(value, allowed: ["name", "enabled", "profile", "lastReview"], path: "state.repositories[\(index)]")
            }
        }
        if let provider = state["provider"], !(provider is NSNull) {
            try requireObject(provider, allowed: ["id", "displayName", "adapter", "authMode", "baseURL", "model", "credentialPresent", "verification"], path: "state.provider")
        }
        try requireObject(state["license"], allowed: ["entitlement", "credentialPresent", "updateChannel"], path: "state.license")
        try requireObject(state["github"], allowed: ["connection", "login", "repositoryCount"], path: "state.github")
        if let outcomes = root["scriptedOutcomes"] as? [Any] {
            for (index, value) in outcomes.enumerated() {
                try requireObject(value, allowed: ["action", "result", "delayMilliseconds"], path: "scriptedOutcomes[\(index)]")
            }
        }
    }

    private static func object(_ value: Any?, path: String) throws -> [String: Any] {
        guard let object = value as? [String: Any] else {
            throw DesktopEvaluationFixtureError.invalidValue(path)
        }
        return object
    }

    private static func requireObject(_ value: Any?, allowed: Set<String>, path: String) throws {
        try requireOnly(try object(value, path: path), allowed: allowed, path: path)
    }

    private static func requireOnly(_ object: [String: Any], allowed: Set<String>, path: String) throws {
        if let field = object.keys.sorted().first(where: { !allowed.contains($0) }) {
            throw DesktopEvaluationFixtureError.unknownField(path: path, field: field)
        }
    }

    private static func validateSafeContent(_ value: Any, path: String = "root") throws {
        if let string = value as? String {
            guard string.utf8.count <= 4096 else {
                throw DesktopEvaluationFixtureError.unsafeContent("oversized string at \(path)")
            }
            let lowered = string.lowercased()
            let forbiddenPaths = ["/users/", "/volumes/", "file://", ".ssh/"]
            if forbiddenPaths.contains(where: lowered.contains)
                || CanonicalSecretScanner.containsSecretLikeText(string) {
                throw DesktopEvaluationFixtureError.unsafeContent("secret or author-machine path at \(path)")
            }
            return
        }
        if let array = value as? [Any] {
            for (index, item) in array.enumerated() {
                try validateSafeContent(item, path: "\(path)[\(index)]")
            }
            return
        }
        if let object = value as? [String: Any] {
            for (key, item) in object {
                try validateSafeContent(item, path: "\(path).\(key)")
            }
        }
    }
}
