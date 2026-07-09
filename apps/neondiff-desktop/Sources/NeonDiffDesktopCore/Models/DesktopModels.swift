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

public struct ProviderSettings: Equatable {
    public var zcodeModel: String
    public var zcodeCliPath: String
    public var zcodeAppConfigPath: String
    public var openAICompatibleEndpoint: String
    public var providerKeyStored: Bool

    public init(
        zcodeModel: String = "GLM-5.2",
        zcodeCliPath: String = "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
        zcodeAppConfigPath: String = "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
        openAICompatibleEndpoint: String = "http://localhost:8000/v1",
        providerKeyStored: Bool = false
    ) {
        self.zcodeModel = zcodeModel
        self.zcodeCliPath = zcodeCliPath
        self.zcodeAppConfigPath = zcodeAppConfigPath
        self.openAICompatibleEndpoint = openAICompatibleEndpoint
        self.providerKeyStored = providerKeyStored
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
    public var botLogin: String
    public var userTokenStored: Bool
    public var installationState: String

    public init(
        appIdConfigured: Bool = false,
        clientIdConfigured: Bool = false,
        botLogin: String = "not configured",
        userTokenStored: Bool = false,
        installationState: String = "not connected"
    ) {
        self.appIdConfigured = appIdConfigured
        self.clientIdConfigured = clientIdConfigured
        self.botLogin = botLogin
        self.userTokenStored = userTokenStored
        self.installationState = installationState
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
