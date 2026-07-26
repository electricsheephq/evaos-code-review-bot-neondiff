import Foundation

package enum DesktopAccountKind: String, Codable, Equatable, Sendable {
    case personal
    case organization
}

package enum DesktopAccountRole: String, Codable, Equatable, Sendable {
    case owner
    case admin
    case member
}

package enum DesktopAccountEntitlement: String, Codable, Equatable, Sendable {
    case publicFree = "public_free"
    case paid
    case internalAdmin = "internal_admin"
    case trial
    case none
}

package enum DesktopBotMode: String, Codable, Equatable, Sendable {
    case byo
    case managed
}

package enum DesktopBotStatus: String, Codable, Equatable, Sendable {
    case pending
    case verified
    case suspended
    case revoked
}

package struct DesktopBotInstallation: Identifiable, Codable, Equatable, Sendable {
    package let id: String
    package let appID: Int64
    package let appSlug: String
    package let mode: DesktopBotMode
    package let githubInstallationID: Int64?
    package let githubAccountLogin: String?
    package let status: DesktopBotStatus
    package var localConfigPath: String?

    package init(
        id: String,
        appID: Int64,
        appSlug: String,
        mode: DesktopBotMode,
        githubInstallationID: Int64?,
        githubAccountLogin: String?,
        status: DesktopBotStatus,
        localConfigPath: String?
    ) {
        self.id = id
        self.appID = appID
        self.appSlug = appSlug
        self.mode = mode
        self.githubInstallationID = githubInstallationID
        self.githubAccountLogin = githubAccountLogin
        self.status = status
        self.localConfigPath = localConfigPath
    }

    package var isAvailableOnThisMac: Bool {
        localConfigPath != nil
    }
}

package struct DesktopLocalBotCandidate: Equatable, Sendable {
    package let appID: Int64
    package let appSlug: String
    package let githubAccountLogin: String
    package let configPath: String

    package init(
        appID: Int64,
        appSlug: String,
        githubAccountLogin: String,
        configPath: String
    ) {
        self.appID = appID
        self.appSlug = appSlug
        self.githubAccountLogin = githubAccountLogin
        self.configPath = configPath
    }
}

package struct DesktopAccountWorkspace: Identifiable, Codable, Equatable, Sendable {
    package let id: String
    package let kind: DesktopAccountKind
    package let name: String
    package let role: DesktopAccountRole?
    package let entitlement: DesktopAccountEntitlement
    package var bots: [DesktopBotInstallation]

    package init(
        id: String,
        kind: DesktopAccountKind,
        name: String,
        role: DesktopAccountRole?,
        entitlement: DesktopAccountEntitlement,
        bots: [DesktopBotInstallation]
    ) {
        self.id = id
        self.kind = kind
        self.name = name
        self.role = role
        self.entitlement = entitlement
        self.bots = bots
    }

    /// A local candidate is displayable only when it intersects an already
    /// verified server installation by App identity and GitHub account. Local
    /// config is a convenience cache; it can never create membership or proof.
    package func merging(
        localCandidates: [DesktopLocalBotCandidate]
    ) -> DesktopAccountWorkspace {
        var result = self
        result.bots = bots.map { bot in
            guard bot.status == .verified,
                  let account = bot.githubAccountLogin,
                  let local = localCandidates.first(where: {
                      $0.appID == bot.appID
                          && $0.appSlug.caseInsensitiveCompare(bot.appSlug) == .orderedSame
                          && $0.githubAccountLogin.caseInsensitiveCompare(account) == .orderedSame
                  })
            else {
                return bot
            }
            var merged = bot
            merged.localConfigPath = local.configPath
            return merged
        }
        return result
    }
}

package enum DesktopAccountWorkspaceCatalog: Equatable, Sendable {
    case idle
    case loading
    case loaded([DesktopAccountWorkspace])
    case failed(String)

    package var accounts: [DesktopAccountWorkspace] {
        guard case .loaded(let accounts) = self else { return [] }
        return accounts.filter { $0.role != nil }
    }
}

package struct DesktopAccountWorkspaceSelection: Equatable, Sendable {
    package private(set) var accountID: String?
    package private(set) var botID: String?
    package private(set) var repository: String?
    package private(set) var providerID: String?

    package init(
        accountID: String? = nil,
        botID: String? = nil,
        repository: String? = nil,
        providerID: String? = nil
    ) {
        self.accountID = accountID
        self.botID = botID
        self.repository = repository
        self.providerID = providerID
    }

    package mutating func selectAccount(_ id: String) {
        guard id != accountID else { return }
        accountID = id
        botID = nil
        repository = nil
        providerID = nil
    }

    package mutating func selectBot(_ id: String?) {
        guard id != botID else { return }
        botID = id
        repository = nil
        providerID = nil
    }
}

package enum DesktopNewBotPlanError: Error, Equatable {
    case invalidSlug
    case accountMembershipRequired
}

package struct DesktopNewBotPlan: Equatable, Sendable {
    package let accountID: String
    package let bot: DesktopBotInstallation

    package static func make(
        account: DesktopAccountWorkspace,
        appSlug: String,
        applicationSupportDirectory: URL,
        occupiedConfigPaths: Set<String>
    ) throws -> DesktopNewBotPlan {
        guard account.role != nil else {
            throw DesktopNewBotPlanError.accountMembershipRequired
        }
        guard appSlug.range(
            of: "^[a-z0-9][a-z0-9-]{0,99}$",
            options: .regularExpression
        ) != nil else {
            throw DesktopNewBotPlanError.invalidSlug
        }

        let baseDirectory = applicationSupportDirectory
            .appendingPathComponent("Accounts", isDirectory: true)
            .appendingPathComponent(account.id, isDirectory: true)
            .appendingPathComponent("Bots", isDirectory: true)
        var candidate = baseDirectory
            .appendingPathComponent(appSlug, isDirectory: true)
            .appendingPathComponent("config.local.json")
            .standardizedFileURL.path
        var suffix = 2
        while occupiedConfigPaths.contains(candidate) {
            candidate = baseDirectory
                .appendingPathComponent("\(appSlug)-\(suffix)", isDirectory: true)
                .appendingPathComponent("config.local.json")
                .standardizedFileURL.path
            suffix += 1
        }

        return DesktopNewBotPlan(
            accountID: account.id,
            bot: DesktopBotInstallation(
                id: "pending-\(UUID().uuidString.lowercased())",
                appID: 0,
                appSlug: appSlug,
                mode: .byo,
                githubInstallationID: nil,
                githubAccountLogin: nil,
                status: .pending,
                localConfigPath: candidate
            )
        )
    }
}
