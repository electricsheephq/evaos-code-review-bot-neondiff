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

public enum GitHubConnectionRecoveryAction: String, Equatable {
    case reconnect
    case retryLater
    case installOrManageApp
    case contactOrganizationOwner
    case retry
}

public struct GitHubConnectionRecovery: Equatable {
    public var status: String
    public var message: String
    public var action: GitHubConnectionRecoveryAction

    public init(status: String, message: String, action: GitHubConnectionRecoveryAction) {
        self.status = status
        self.message = message
        self.action = action
    }
}

public enum GitHubConnectionRecoveryClassifier {
    public static func httpFailure(
        statusCode: Int,
        headers: [String: String],
        requestPath: String,
        responseBody: String? = nil
    ) -> GitHubConnectionRecovery {
        let normalizedHeaders = Dictionary(uniqueKeysWithValues: headers.map { ($0.key.lowercased(), $0.value) })
        let normalizedBody = responseBody?.lowercased() ?? ""
        let rateLimited = statusCode == 429
            || (statusCode == 403 && (
                normalizedHeaders["x-ratelimit-remaining"] == "0"
                    || normalizedHeaders["retry-after"] != nil
            ))

        if statusCode == 401 {
            return GitHubConnectionRecovery(
                status: "authorization expired",
                message: "GitHub authorization is expired or revoked. Reconnect GitHub, then refresh repositories.",
                action: .reconnect
            )
        }
        if rateLimited {
            return GitHubConnectionRecovery(
                status: "rate limited",
                message: "GitHub API rate limit reached. Wait for the API window to recover, then retry repository discovery.",
                action: .retryLater
            )
        }
        if statusCode == 403 {
            let confirmedOrganizationPolicy = normalizedBody.contains("organization")
                && (
                    normalizedBody.contains("saml")
                        || normalizedBody.contains("oauth app access restriction")
                        || normalizedBody.contains("third-party application restriction")
                )
            if confirmedOrganizationPolicy {
                return GitHubConnectionRecovery(
                    status: "organization access blocked",
                    message: "GitHub organization policy blocked repository discovery. Ask an organization owner to approve the App or authorize access.",
                    action: .contactOrganizationOwner
                )
            }
            return GitHubConnectionRecovery(
                status: "permission denied",
                message: "GitHub denied repository discovery. The App may lack selected-repository access or required permissions. Manage App access, then retry.",
                action: .installOrManageApp
            )
        }
        if statusCode == 404 && requestPath.contains("/user/installations") {
            return GitHubConnectionRecovery(
                status: "installation unavailable",
                message: "The GitHub App installation is missing or no longer grants access to this repository. Install or manage the App for selected repositories, then retry.",
                action: .installOrManageApp
            )
        }
        return GitHubConnectionRecovery(
            status: "GitHub API error",
            message: "GitHub API request failed with HTTP \(statusCode). Retry; if the failure persists, inspect App installation and permission state.",
            action: .retry
        )
    }

    public static let noInstallations = GitHubConnectionRecovery(
        status: "no accessible App repositories",
        message: "GitHub authorization succeeded, but no App repositories are accessible. Install or manage NeonDiff for selected repositories, then refresh.",
        action: .installOrManageApp
    )

    public static let deviceCodeExpired = GitHubConnectionRecovery(
        status: "device code expired",
        message: "The GitHub device code expired or is no longer valid. Start a new connection.",
        action: .reconnect
    )

    public static func deviceAuthorizationFailure(
        _ error: GitHubDeviceAuthorizationError,
        description: String?
    ) -> GitHubConnectionRecovery {
        switch error {
        case .deviceFlowDisabled:
            return GitHubConnectionRecovery(
                status: "device flow disabled",
                message: "GitHub App device flow is disabled. An App owner must enable device flow before users can connect.",
                action: .installOrManageApp
            )
        case .accessDenied:
            return GitHubConnectionRecovery(
                status: "authorization denied",
                message: "GitHub authorization was denied. Reconnect when you are ready to approve access.",
                action: .reconnect
            )
        case .expiredToken, .tokenExpired, .incorrectDeviceCode:
            return deviceCodeExpired
        default:
            let detail = description?.trimmingCharacters(in: .whitespacesAndNewlines)
            return GitHubConnectionRecovery(
                status: error.rawValue,
                message: NeonDiffRedactor.redact(
                    detail?.isEmpty == false
                        ? detail!
                        : "GitHub authorization failed. Retry or inspect the App client configuration."
                ),
                action: .retry
            )
        }
    }
}

public struct GitHubLatestRequestGate {
    private var generation: UInt64 = 0

    public init() {}

    public mutating func begin() -> UInt64 {
        generation &+= 1
        return generation
    }

    public func isCurrent(_ candidate: UInt64) -> Bool {
        candidate == generation
    }
}

public enum GitHubAppInstallLink {
    public static let publicAppURL = URL(string: "https://github.com/apps/evaos-code-review-bot/installations/new")!

    public static func url(botLogin: String) -> URL? {
        let slug = botLogin
            .replacingOccurrences(of: "[bot]", with: "")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard slug.range(of: #"^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$"#, options: .regularExpression) != nil else {
            return nil
        }
        return URL(string: "https://github.com/apps/\(slug)/installations/new")
    }
}

public enum GitHubRepositoryAccessCue: String, Equatable {
    case publicFree
    case licenseActive
    case licenseRequired
    case insufficientReadAccess

    public var label: String {
        switch self {
        case .publicFree: "PUBLIC · FREE"
        case .licenseActive: "PRIVATE · LICENSE ACTIVE"
        case .licenseRequired: "PRIVATE · LICENSE REQUIRED"
        case .insufficientReadAccess: "INSUFFICIENT READ ACCESS"
        }
    }
}

public enum GitHubRepositoryAccessPolicy {
    public static func cue(
        for repository: GitHubDiscoveredRepository,
        licenseEntitlement: String
    ) -> GitHubRepositoryAccessCue {
        if repository.permissionsSummary.lowercased().contains("pull:false") {
            return .insufficientReadAccess
        }
        if repository.visibility.lowercased() == "public" {
            return .publicFree
        }
        let normalizedEntitlement = licenseEntitlement
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        if ["active", "activated", "valid"].contains(normalizedEntitlement) {
            return .licenseActive
        }
        return .licenseRequired
    }
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
