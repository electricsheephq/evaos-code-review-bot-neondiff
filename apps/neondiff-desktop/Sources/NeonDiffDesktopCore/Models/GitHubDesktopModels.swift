import Foundation

public struct GitHubDeviceAuthorizationCode: Equatable {
    public var deviceCode: String
    public var userCode: String
    public var verificationURI: URL
    public var expiresAt: Date
    public var intervalSeconds: Int

    public init(deviceCode: String, userCode: String, verificationURI: URL, expiresAt: Date, intervalSeconds: Int) {
        self.deviceCode = deviceCode
        self.userCode = userCode
        self.verificationURI = verificationURI
        self.expiresAt = expiresAt
        self.intervalSeconds = intervalSeconds
    }
}

public struct GitHubUserToken: Equatable {
    public var accessToken: String
    public var refreshToken: String?
    public var expiresAt: Date?
    public var refreshTokenExpiresAt: Date?
    public var tokenType: String

    public init(
        accessToken: String,
        refreshToken: String? = nil,
        expiresAt: Date? = nil,
        refreshTokenExpiresAt: Date? = nil,
        tokenType: String = "bearer"
    ) {
        self.accessToken = accessToken
        self.refreshToken = refreshToken
        self.expiresAt = expiresAt
        self.refreshTokenExpiresAt = refreshTokenExpiresAt
        self.tokenType = tokenType
    }
}

public enum GitHubDeviceAuthorizationError: String, Equatable {
    case authorizationPending = "authorization_pending"
    case slowDown = "slow_down"
    case expiredToken = "expired_token"
    case tokenExpired = "token_expired"
    case unsupportedGrantType = "unsupported_grant_type"
    case incorrectClientCredentials = "incorrect_client_credentials"
    case incorrectDeviceCode = "incorrect_device_code"
    case accessDenied = "access_denied"
    case deviceFlowDisabled = "device_flow_disabled"
    case unknown
}

public enum GitHubDeviceAuthorizationPollResult: Equatable {
    case pending(intervalSeconds: Int)
    case authorized(GitHubUserToken)
    case failed(error: GitHubDeviceAuthorizationError, description: String?)

    public var minimumNextPollIntervalSeconds: Int {
        switch self {
        case .pending(let intervalSeconds):
            return intervalSeconds
        case .authorized, .failed:
            return 0
        }
    }

    public func applyingSlowDown() -> GitHubDeviceAuthorizationPollResult {
        switch self {
        case .pending(let intervalSeconds):
            return .pending(intervalSeconds: intervalSeconds + 5)
        case .authorized, .failed:
            return self
        }
    }
}

public struct GitHubAuthenticatedUser: Equatable {
    public var login: String

    public init(login: String) {
        self.login = login
    }
}

public struct GitHubDiscoveredRepository: Identifiable, Hashable {
    public var id: String { fullName }
    public var fullName: String
    public var visibility: String
    public var installationId: Int
    public var installationAccount: String
    public var permissionsSummary: String

    public init(
        fullName: String,
        visibility: String,
        installationId: Int,
        installationAccount: String,
        permissionsSummary: String = "metadata:read"
    ) {
        self.fullName = fullName
        self.visibility = visibility
        self.installationId = installationId
        self.installationAccount = installationAccount
        self.permissionsSummary = permissionsSummary
    }
}

public enum GitHubRepositoryDiscovery {
    public static func mergeConfiguredAndDiscoveredRepos(
        configured: [RepoMonitor],
        discovered: [GitHubDiscoveredRepository]
    ) -> [RepoMonitor] {
        var byName: [String: RepoMonitor] = [:]
        for repo in configured {
            byName[repo.name.lowercased()] = repo
        }
        for repo in discovered where byName[repo.fullName.lowercased()] == nil {
            byName[repo.fullName.lowercased()] = RepoMonitor(
                name: repo.fullName,
                enabled: false,
                profile: repo.visibility,
                lastReview: "discovered via GitHub App installation \(repo.installationId)"
            )
        }
        return byName.values.sorted { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
    }
}
