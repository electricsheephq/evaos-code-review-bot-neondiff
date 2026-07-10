import Foundation

public enum DesktopSection: String, CaseIterable, Identifiable {
    case overview
    case repos
    case providers
    case license
    case logs
    case policy
    case settings

    public var id: String { rawValue }

    public var title: String {
        switch self {
        case .overview: "Overview"
        case .repos: "Repos"
        case .providers: "Providers"
        case .license: "License"
        case .logs: "Logs"
        case .policy: "Policy"
        case .settings: "Settings"
        }
    }

    public var systemImage: String {
        switch self {
        case .overview: "gauge.with.dots.needle.bottom.50percent"
        case .repos: "folder.badge.gearshape"
        case .providers: "cpu"
        case .license: "key"
        case .logs: "doc.text.magnifyingglass"
        case .policy: "slider.horizontal.3"
        case .settings: "gearshape"
        }
    }
}

public struct DaemonStatus: Equatable {
    public var ok: Bool
    public var runtimeOk: Bool?
    public var healthState: String
    public var checkedAt: String?
    public var monitoredRepos: [String]
    public var launchdLabel: String?
    public var lastCommand: String

    public init(
        ok: Bool,
        runtimeOk: Bool?,
        healthState: String,
        checkedAt: String?,
        monitoredRepos: [String],
        launchdLabel: String?,
        lastCommand: String
    ) {
        self.ok = ok
        self.runtimeOk = runtimeOk
        self.healthState = healthState
        self.checkedAt = checkedAt
        self.monitoredRepos = monitoredRepos
        self.launchdLabel = launchdLabel
        self.lastCommand = lastCommand
    }

    public static let unknown = DaemonStatus(
        ok: false,
        runtimeOk: nil,
        healthState: "unknown",
        checkedAt: nil,
        monitoredRepos: [],
        launchdLabel: nil,
        lastCommand: "neondiff status --config <config>"
    )
}

public struct RepoMonitor: Identifiable, Hashable {
    public var id: String { name }
    public var name: String
    public var enabled: Bool
    public var profile: String
    public var lastReview: String

    public init(name: String, enabled: Bool, profile: String = "default", lastReview: String = "not loaded") {
        self.name = name
        self.enabled = enabled
        self.profile = profile
        self.lastReview = lastReview
    }
}

public struct ProviderRegistryTarget: Identifiable, Equatable, Sendable {
    public var id: String
    public var displayName: String
    public var enabled: Bool
    public var adapter: String
    public var authMode: String
    public var baseUrl: String
    public var model: String

    public init(
        id: String,
        displayName: String,
        enabled: Bool,
        adapter: String,
        authMode: String,
        baseUrl: String = "",
        model: String = ""
    ) {
        self.id = id
        self.displayName = displayName
        self.enabled = enabled
        self.adapter = adapter
        self.authMode = authMode
        self.baseUrl = baseUrl
        self.model = model
    }

    public var isAPIKeyVerificationEligible: Bool {
        enabled && adapter == "openai-compatible" && authMode == "api-key-env"
            && !baseUrl.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !model.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

public struct ProviderSettings: Equatable {
    public var zcodeModel: String
    public var zcodeCliPath: String
    public var zcodeAppConfigPath: String
    public var openAICompatibleEndpoint: String
    public var providerKeyStored: Bool
    public var selectedProviderId: String
    public var registryTargets: [ProviderRegistryTarget]

    public init(
        zcodeModel: String = "GLM-5.2",
        zcodeCliPath: String = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        zcodeAppConfigPath: String = "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
        openAICompatibleEndpoint: String = "http://localhost:8000/v1",
        providerKeyStored: Bool = false,
        selectedProviderId: String = "zcode-glm",
        registryTargets: [ProviderRegistryTarget] = []
    ) {
        self.zcodeModel = zcodeModel
        self.zcodeCliPath = zcodeCliPath
        self.zcodeAppConfigPath = zcodeAppConfigPath
        self.openAICompatibleEndpoint = openAICompatibleEndpoint
        self.providerKeyStored = providerKeyStored
        self.selectedProviderId = selectedProviderId
        self.registryTargets = registryTargets
    }

    public var selectedRegistryTarget: ProviderRegistryTarget? {
        get { registryTargets.first { $0.id == selectedProviderId } }
        set {
            guard let newValue else { return }
            selectedProviderId = newValue.id
            if let index = registryTargets.firstIndex(where: { $0.id == newValue.id }) {
                registryTargets[index] = newValue
            } else {
                registryTargets.append(newValue)
            }
        }
    }

    public var selectedProviderBaseUrl: String {
        get { selectedRegistryTarget?.baseUrl ?? "" }
        set {
            guard let index = registryTargets.firstIndex(where: { $0.id == selectedProviderId }) else { return }
            registryTargets[index].baseUrl = newValue
        }
    }

    public var selectedProviderModel: String {
        get { selectedRegistryTarget?.model ?? "" }
        set {
            guard let index = registryTargets.firstIndex(where: { $0.id == selectedProviderId }) else { return }
            registryTargets[index].model = newValue
        }
    }
}

public struct LicenseStatus: Equatable {
    public var keyStored: Bool
    public var entitlement: String
    public var updateChannel: String

    public init(keyStored: Bool = false, entitlement: String = "not activated", updateChannel: String = "dev") {
        self.keyStored = keyStored
        self.entitlement = entitlement
        self.updateChannel = updateChannel
    }
}

public struct GitHubConnectionStatus: Equatable {
    public var appIdConfigured: Bool
    public var clientIdConfigured: Bool
    public var clientId: String?
    public var botLogin: String
    public var userTokenStored: Bool
    public var installationState: String
    public var authorizedUserLogin: String?
    public var installationCount: Int
    public var discoveredRepositoryCount: Int

    public init(
        appIdConfigured: Bool = false,
        clientIdConfigured: Bool = false,
        clientId: String? = nil,
        botLogin: String = "not configured",
        userTokenStored: Bool = false,
        installationState: String = "not connected",
        authorizedUserLogin: String? = nil,
        installationCount: Int = 0,
        discoveredRepositoryCount: Int = 0
    ) {
        self.appIdConfigured = appIdConfigured
        self.clientIdConfigured = clientIdConfigured
        self.clientId = clientId
        self.botLogin = botLogin
        self.userTokenStored = userTokenStored
        self.installationState = installationState
        self.authorizedUserLogin = authorizedUserLogin
        self.installationCount = installationCount
        self.discoveredRepositoryCount = discoveredRepositoryCount
    }
}

public struct DesktopControlCenterSettings: Equatable, Sendable {
    public var pollIntervalMs: Int
    public var skipDrafts: Bool
    public var reviewMaxActiveRuns: Int
    public var reviewLeaseTtlMs: Int
    public var maxInlineComments: Int
    public var issueEnrichmentEnabled: Bool
    public var issuePostComment: Bool
    public var issueAllowlist: [String]
    public var issueMaxIssuesPerCycle: Int
    public var issueMaxCommentsPerCycle: Int
    public var issueGlobalMaxIssuesPerCycle: Int
    public var issueGlobalMaxCommentsPerCycle: Int
    public var issueMaxActiveRuns: Int
    public var issueLeaseTtlMs: Int
    public var issueCooldownMs: Int
    public var issueBurstWindowMs: Int
    public var issueMaxIssuesPerBurst: Int
    public var issueLookbackMs: Int
    public var issueProcessExistingOnActivation: Bool

    public init(
        pollIntervalMs: Int = 90_000,
        skipDrafts: Bool = true,
        reviewMaxActiveRuns: Int = 1,
        reviewLeaseTtlMs: Int = 900_000,
        maxInlineComments: Int = 25,
        issueEnrichmentEnabled: Bool = false,
        issuePostComment: Bool = false,
        issueAllowlist: [String] = [],
        issueMaxIssuesPerCycle: Int = 5,
        issueMaxCommentsPerCycle: Int = 1,
        issueGlobalMaxIssuesPerCycle: Int = 5,
        issueGlobalMaxCommentsPerCycle: Int = 1,
        issueMaxActiveRuns: Int = 1,
        issueLeaseTtlMs: Int = 1_200_000,
        issueCooldownMs: Int = 3_600_000,
        issueBurstWindowMs: Int = 3_600_000,
        issueMaxIssuesPerBurst: Int = 10,
        issueLookbackMs: Int = 600_000,
        issueProcessExistingOnActivation: Bool = false
    ) {
        self.pollIntervalMs = pollIntervalMs
        self.skipDrafts = skipDrafts
        self.reviewMaxActiveRuns = reviewMaxActiveRuns
        self.reviewLeaseTtlMs = reviewLeaseTtlMs
        self.maxInlineComments = maxInlineComments
        self.issueEnrichmentEnabled = issueEnrichmentEnabled
        self.issuePostComment = issuePostComment
        self.issueAllowlist = issueAllowlist
        self.issueMaxIssuesPerCycle = issueMaxIssuesPerCycle
        self.issueMaxCommentsPerCycle = issueMaxCommentsPerCycle
        self.issueGlobalMaxIssuesPerCycle = issueGlobalMaxIssuesPerCycle
        self.issueGlobalMaxCommentsPerCycle = issueGlobalMaxCommentsPerCycle
        self.issueMaxActiveRuns = issueMaxActiveRuns
        self.issueLeaseTtlMs = issueLeaseTtlMs
        self.issueCooldownMs = issueCooldownMs
        self.issueBurstWindowMs = issueBurstWindowMs
        self.issueMaxIssuesPerBurst = issueMaxIssuesPerBurst
        self.issueLookbackMs = issueLookbackMs
        self.issueProcessExistingOnActivation = issueProcessExistingOnActivation
    }
}

public struct DesktopControlCenterSnapshot: Equatable, Sendable {
    public let settings: DesktopControlCenterSettings
    public let configPath: String

    public init(settings: DesktopControlCenterSettings, configPath: String) {
        self.settings = settings
        self.configPath = configPath
    }
}

public enum DesktopControlCenterPatchBuilder {
    public static func validationError(for settings: DesktopControlCenterSettings) -> String? {
        let positiveValues: [(String, Int)] = [
            ("poll interval", settings.pollIntervalMs),
            ("review max active runs", settings.reviewMaxActiveRuns),
            ("review lease TTL", settings.reviewLeaseTtlMs),
            ("max inline comments", settings.maxInlineComments),
            ("issue max issues per cycle", settings.issueMaxIssuesPerCycle),
            ("issue global max issues per cycle", settings.issueGlobalMaxIssuesPerCycle),
            ("issue max active runs", settings.issueMaxActiveRuns),
            ("issue lease TTL", settings.issueLeaseTtlMs),
            ("issue cooldown", settings.issueCooldownMs),
            ("issue burst window", settings.issueBurstWindowMs),
            ("issue max issues per burst", settings.issueMaxIssuesPerBurst),
            ("issue lookback", settings.issueLookbackMs)
        ]
        if let invalid = positiveValues.first(where: { $0.1 <= 0 }) {
            return "\(invalid.0) must be a positive integer"
        }
        if settings.issueMaxCommentsPerCycle < 0 || settings.issueGlobalMaxCommentsPerCycle < 0 {
            return "issue comments per cycle must be zero or greater"
        }
        if settings.issueMaxCommentsPerCycle > settings.issueMaxIssuesPerCycle {
            return "issue comments per cycle must be less than or equal to issues per cycle"
        }
        if settings.issueGlobalMaxCommentsPerCycle > settings.issueGlobalMaxIssuesPerCycle {
            return "global issue comments per cycle must be less than or equal to global issues per cycle"
        }
        for repo in settings.issueAllowlist where !isValidRepoName(repo) {
            return "issue-enrichment allowlist entries must use owner/repo"
        }
        return nil
    }

    public static func data(for settings: DesktopControlCenterSettings) throws -> Data {
        if let error = validationError(for: settings) {
            throw DesktopControlCenterPatchError.invalidSettings(error)
        }
        let patch: [String: Any] = [
            "pollIntervalMs": settings.pollIntervalMs,
            "skipDrafts": settings.skipDrafts,
            "reviewConcurrency": [
                "maxActiveRuns": settings.reviewMaxActiveRuns,
                "leaseTtlMs": settings.reviewLeaseTtlMs
            ],
            "reviewGate": [
                "maxInlineComments": settings.maxInlineComments
            ],
            "issueEnrichment": [
                "enabled": settings.issueEnrichmentEnabled,
                "postIssueComment": settings.issuePostComment,
                "allowlist": settings.issueAllowlist,
                "maxIssuesPerCycle": settings.issueMaxIssuesPerCycle,
                "maxCommentsPerCycle": settings.issueMaxCommentsPerCycle,
                "globalMaxIssuesPerCycle": settings.issueGlobalMaxIssuesPerCycle,
                "globalMaxCommentsPerCycle": settings.issueGlobalMaxCommentsPerCycle,
                "maxActiveRuns": settings.issueMaxActiveRuns,
                "leaseTtlMs": settings.issueLeaseTtlMs,
                "cooldownMs": settings.issueCooldownMs,
                "burstWindowMs": settings.issueBurstWindowMs,
                "maxIssuesPerBurst": settings.issueMaxIssuesPerBurst,
                "lookbackMs": settings.issueLookbackMs,
                "processExistingOpenIssuesOnActivation": settings.issueProcessExistingOnActivation
            ]
        ]
        return try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
    }

    private static func isValidRepoName(_ value: String) -> Bool {
        let parts = value.split(separator: "/", omittingEmptySubsequences: false)
        guard parts.count == 2 else { return false }
        let allowed = CharacterSet.alphanumerics.union(CharacterSet(charactersIn: "_.-"))
        return parts.allSatisfy { part in
            !part.isEmpty && part.unicodeScalars.allSatisfy { allowed.contains($0) }
        }
    }
}

public enum DesktopControlCenterPatchError: Error, LocalizedError {
    case invalidSettings(String)

    public var errorDescription: String? {
        switch self {
        case .invalidSettings(let message): message
        }
    }
}

public struct DesktopCommand: Identifiable, Equatable {
    public var id: String { commandLine }
    public var title: String
    public var commandLine: String
    public var requiresConfirmation: Bool

    public init(title: String, commandLine: String, requiresConfirmation: Bool = false) {
        self.title = title
        self.commandLine = commandLine
        self.requiresConfirmation = requiresConfirmation
    }
}
