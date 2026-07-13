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

public enum DesktopEvaluationHealth: String, Codable, Sendable {
    case unknown
    case healthy
    case degraded
    case offline
}

public enum DesktopEvaluationRepositoryProfile: String, Codable, Sendable {
    case standard = "default"
    case strict
}

public enum DesktopEvaluationProviderAdapter: String, Codable, Sendable {
    case openAICompatible = "openai-compatible"
    case zcode
}

public enum DesktopEvaluationProviderAuthMode: String, Codable, Sendable {
    case none
    case apiKeyEnvironment = "api-key-env"
    case zcodeAppConfig = "zcode-app-config"
}

public enum DesktopEvaluationProviderVerification: String, Codable, Sendable {
    case healthy
    case configuredUnverified = "configured_unverified"
    case blocked
    case dirty
    case inProgress = "in_progress"
}

public enum DesktopEvaluationLicenseEntitlement: String, Codable, Sendable {
    case notActivated = "not activated"
    case active
    case activationBlocked = "activation blocked"
}

public enum DesktopEvaluationUpdateChannel: String, Codable, Sendable {
    case dev
    case beta
    case stable
}

public enum DesktopEvaluationGitHubConnection: String, Codable, Sendable {
    case disconnected
    case deviceCode = "device_code"
    case connected
    case recovery
}

public enum DesktopEvaluationAction: String, Codable, Sendable {
    case refreshStatus = "refresh-status"
    case refreshRepositories = "refresh-repositories"
    case verifyProvider = "verify-provider"
    case inspectLicense = "inspect-license"
    case copyRedactedLog = "copy-redacted-log"
    case previewPolicy = "preview-policy"
    case inspectSettings = "inspect-settings"
    case beginSetup = "begin-setup"
    case chooseProvider = "choose-provider"
    case checkDaemon = "check-daemon"
    case activateLicense = "activate-license"
    case finishOnboarding = "finish-onboarding"
}

public enum DesktopEvaluationOutcomeResult: String, Codable, Sendable {
    case success
    case failure
    case cancelled
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
        public let profile: DesktopEvaluationRepositoryProfile
        public let lastReview: String
    }

    public struct ProviderState: Codable, Equatable, Sendable {
        public let id: String
        public let displayName: String
        public let adapter: DesktopEvaluationProviderAdapter
        public let authMode: DesktopEvaluationProviderAuthMode
        public let baseURL: String
        public let model: String
        public let credentialPresent: Bool
        public let verification: DesktopEvaluationProviderVerification
    }

    public struct LicenseState: Codable, Equatable, Sendable {
        public let entitlement: DesktopEvaluationLicenseEntitlement
        public let credentialPresent: Bool
        public let updateChannel: DesktopEvaluationUpdateChannel
    }

    public struct GitHubState: Codable, Equatable, Sendable {
        public let connection: DesktopEvaluationGitHubConnection
        public let login: String?
        public let repositoryCount: Int
    }

    public struct State: Codable, Equatable, Sendable {
        public let health: DesktopEvaluationHealth
        public let runtimeReady: Bool?
        public let repositories: [RepositoryState]
        public let provider: ProviderState?
        public let license: LicenseState
        public let github: GitHubState
        public let logText: String
    }

    public struct ScriptedOutcome: Codable, Equatable, Sendable {
        public let action: DesktopEvaluationAction
        public let result: DesktopEvaluationOutcomeResult
        public let delayMilliseconds: Int
    }

    public let schemaVersion: Int
    public let id: String
    public let surface: Surface
    public let environment: Environment
    public let state: State
    public let scriptedOutcomes: [ScriptedOutcome]
    public let expectedActions: [DesktopEvaluationAction]
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
        try validatePublicSafeContent(object)

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
        guard Self.isCanonicalTimestamp(environment.clock) else {
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
        guard state.repositories.count <= 100,
              scriptedOutcomes.count <= 50,
              expectedActions.count <= 50,
              safeCopy.count <= 100 else {
            throw DesktopEvaluationFixtureError.invalidValue("collection limit")
        }
        for repository in state.repositories {
            guard repository.name.range(of: #"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$"#, options: .regularExpression) != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("repository.name")
            }
            guard Self.isCanonicalTimestamp(repository.lastReview) else {
                throw DesktopEvaluationFixtureError.invalidValue("repository.lastReview")
            }
        }
        if let provider = state.provider {
            guard provider.id.range(of: #"^[a-z0-9][a-z0-9-]{0,63}$"#, options: .regularExpression) != nil,
                  !provider.displayName.isEmpty,
                  provider.displayName.utf8.count <= 128,
                  !provider.model.isEmpty,
                  provider.model.utf8.count <= 256,
                  let url = URL(string: provider.baseURL),
                  ["http", "https"].contains(url.scheme?.lowercased() ?? ""),
                  let host = url.host,
                  !host.isEmpty,
                  url.user == nil,
                  url.password == nil else {
                throw DesktopEvaluationFixtureError.invalidValue("provider")
            }
        }
        if let login = state.github.login {
            guard login.range(of: #"^[A-Za-z0-9-]{1,39}$"#, options: .regularExpression) != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("github.login")
            }
        }
        switch surface.onboardingStep {
        case .daemon, .license, .done:
            guard state.provider?.credentialPresent == true else {
                throw DesktopEvaluationFixtureError.invalidValue("onboarding state has not completed provider setup")
            }
        case .welcome, .provider, nil:
            break
        }
        switch surface.onboardingStep {
        case .license, .done:
            guard state.runtimeReady != nil else {
                throw DesktopEvaluationFixtureError.invalidValue("onboarding state has not completed daemon readiness")
            }
        case .welcome, .provider, .daemon, nil:
            break
        }
        switch surface.onboardingStep {
        case .license:
            guard state.license.entitlement == .notActivated,
                  !state.license.credentialPresent,
                  expectedActions == [.activateLicense] else {
                throw DesktopEvaluationFixtureError.invalidValue("license onboarding must be blocked on API-backed activation")
            }
        case .done:
            guard state.license.entitlement == .active,
                  state.license.credentialPresent else {
                throw DesktopEvaluationFixtureError.invalidValue("done onboarding requires API-backed activation")
            }
        case nil:
            guard state.license.entitlement == .active,
                  state.license.credentialPresent else {
                throw DesktopEvaluationFixtureError.invalidValue("post-onboarding state requires API-backed activation")
            }
        case .welcome, .provider, .daemon:
            break
        }
        for outcome in scriptedOutcomes {
            guard (0...30_000).contains(outcome.delayMilliseconds) else {
                throw DesktopEvaluationFixtureError.invalidValue("scriptedOutcomes.delayMilliseconds")
            }
        }
    }

    private static func isCanonicalTimestamp(_ value: String) -> Bool {
        guard value.range(
            of: #"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$"#,
            options: .regularExpression
        ) != nil else { return false }
        let formatter = ISO8601DateFormatter()
        guard let date = formatter.date(from: value) else { return false }
        return formatter.string(from: date) == value
    }

    private static func validateShape(_ root: [String: Any]) throws {
        try requireOnly(root, allowed: ["schemaVersion", "id", "surface", "environment", "state", "scriptedOutcomes", "expectedActions", "safeCopy"], path: "root")
        try requireObject(root["surface"], allowed: ["section", "onboardingStep"], path: "surface")
        let environment = try object(root["environment"], path: "environment")
        try requireOnly(environment, allowed: ["clock", "locale", "appearance", "disableAnimations", "contentSize"], path: "environment")
        if let contentSize = environment["contentSize"], !(contentSize is NSNull) {
            try requireObject(contentSize, allowed: ["width", "height"], path: "environment.contentSize")
        }
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

    static func validatePublicSafeContent(_ value: Any, path: String = "root") throws {
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
                try validatePublicSafeContent(item, path: "\(path)[\(index)]")
            }
            return
        }
        if let object = value as? [String: Any] {
            for (key, item) in object {
                try validatePublicSafeContent(item, path: "\(path).\(key)")
            }
        }
    }
}
