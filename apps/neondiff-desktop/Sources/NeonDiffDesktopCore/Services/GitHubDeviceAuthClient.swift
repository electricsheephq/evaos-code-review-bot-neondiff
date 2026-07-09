import Foundation

public protocol GitHubDesktopAuthenticating {
    func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode
    func pollDeviceAuthorization(clientId: String, deviceCode: String) async throws -> GitHubDeviceAuthorizationPollResult
    func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken
    func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser
    func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository]
}

public enum GitHubDeviceAuthClientError: Error, LocalizedError {
    case invalidURL(String)
    case invalidResponse(String)
    case apiError(String)

    public var errorDescription: String? {
        switch self {
        case .invalidURL(let value):
            "Invalid GitHub URL: \(value)"
        case .invalidResponse(let value):
            "Invalid GitHub response: \(NeonDiffRedactor.redact(value))"
        case .apiError(let value):
            "GitHub API error: \(NeonDiffRedactor.redact(value))"
        }
    }
}

public final class GitHubDeviceAuthClient: GitHubDesktopAuthenticating {
    private let githubBaseURL: URL
    private let apiBaseURL: URL
    private let session: URLSession
    private let now: () -> Date
    private let pageSize: Int

    public init(
        githubBaseURL: URL = URL(string: "https://github.com")!,
        apiBaseURL: URL = URL(string: "https://api.github.com")!,
        session: URLSession = .shared,
        now: @escaping () -> Date = Date.init,
        pageSize: Int = 100
    ) {
        self.githubBaseURL = githubBaseURL
        self.apiBaseURL = apiBaseURL
        self.session = session
        self.now = now
        self.pageSize = max(1, min(pageSize, 100))
    }

    public func requestDeviceCode(clientId: String) async throws -> GitHubDeviceAuthorizationCode {
        let response: DeviceCodeResponse = try await postForm(
            baseURL: githubBaseURL,
            path: "/login/device/code",
            fields: ["client_id": clientId]
        )
        guard let verificationURL = URL(string: response.verificationUri) else {
            throw GitHubDeviceAuthClientError.invalidResponse("verification_uri was not a valid URL")
        }
        return GitHubDeviceAuthorizationCode(
            deviceCode: response.deviceCode,
            userCode: response.userCode,
            verificationURI: verificationURL,
            expiresAt: now().addingTimeInterval(TimeInterval(response.expiresIn)),
            intervalSeconds: response.interval ?? 5
        )
    }

    public func pollDeviceAuthorization(clientId: String, deviceCode: String) async throws -> GitHubDeviceAuthorizationPollResult {
        let response: TokenResponse = try await postForm(
            baseURL: githubBaseURL,
            path: "/login/oauth/access_token",
            fields: [
                "client_id": clientId,
                "device_code": deviceCode,
                "grant_type": "urn:ietf:params:oauth:grant-type:device_code"
            ]
        )
        if let accessToken = response.accessToken {
            return .authorized(GitHubUserToken(
                accessToken: accessToken,
                refreshToken: response.refreshToken,
                expiresAt: response.expiresIn.map { now().addingTimeInterval(TimeInterval($0)) },
                refreshTokenExpiresAt: response.refreshTokenExpiresIn.map { now().addingTimeInterval(TimeInterval($0)) },
                tokenType: response.tokenType ?? "bearer"
            ))
        }
        let error = GitHubDeviceAuthorizationError(rawValue: response.error ?? "") ?? .unknown
        if error == .authorizationPending {
            return .pending(intervalSeconds: response.interval ?? 5)
        }
        if error == .slowDown {
            return .pending(intervalSeconds: (response.interval ?? 5) + 5)
        }
        return .failed(error: error, description: response.errorDescription)
    }

    public func refreshUserToken(clientId: String, refreshToken: String) async throws -> GitHubUserToken {
        let response: TokenResponse = try await postForm(
            baseURL: githubBaseURL,
            path: "/login/oauth/access_token",
            fields: [
                "client_id": clientId,
                "grant_type": "refresh_token",
                "refresh_token": refreshToken
            ]
        )
        if let accessToken = response.accessToken {
            return GitHubUserToken(
                accessToken: accessToken,
                refreshToken: response.refreshToken,
                expiresAt: response.expiresIn.map { now().addingTimeInterval(TimeInterval($0)) },
                refreshTokenExpiresAt: response.refreshTokenExpiresIn.map { now().addingTimeInterval(TimeInterval($0)) },
                tokenType: response.tokenType ?? "bearer"
            )
        }
        let error = response.error ?? "missing_access_token"
        throw GitHubDeviceAuthClientError.apiError(response.errorDescription ?? error)
    }

    public func fetchCurrentUser(accessToken: String) async throws -> GitHubAuthenticatedUser {
        let user: CurrentUserResponse = try await getJSON(path: "/user", accessToken: accessToken)
        return GitHubAuthenticatedUser(login: user.login)
    }

    public func listAccessibleRepositories(accessToken: String) async throws -> [GitHubDiscoveredRepository] {
        var installationPage = 1
        var installations: [InstallationResponse] = []
        while true {
            let response: InstallationsResponse = try await getJSON(
                path: "/user/installations?per_page=\(pageSize)&page=\(installationPage)",
                accessToken: accessToken
            )
            installations.append(contentsOf: response.installations)
            if response.installations.count < pageSize { break }
            installationPage += 1
        }
        var repositories: [GitHubDiscoveredRepository] = []
        for installation in installations {
            var page = 1
            while true {
                let path = "/user/installations/\(installation.id)/repositories?per_page=\(pageSize)&page=\(page)"
                let response: InstallationRepositoriesResponse = try await getJSON(path: path, accessToken: accessToken)
                repositories.append(contentsOf: response.repositories.map { repository in
                    GitHubDiscoveredRepository(
                        fullName: repository.fullName,
                        visibility: repository.visibility ?? (repository.private == true ? "private" : "public"),
                        installationId: installation.id,
                        installationAccount: installation.account.login,
                        permissionsSummary: repository.permissions.summary
                    )
                })
                if response.repositories.count < 100 { break }
                page += 1
            }
        }
        return repositories.sorted { $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending }
    }

    private func postForm<T: Decodable>(baseURL: URL, path: String, fields: [String: String]) async throws -> T {
        let body = fields
            .map { key, value in "\(urlEncode(key))=\(urlEncode(value))" }
            .joined(separator: "&")
        var request = try makeRequest(baseURL: baseURL, path: path)
        request.httpMethod = "POST"
        request.setValue("application/json", forHTTPHeaderField: "Accept")
        request.setValue("application/x-www-form-urlencoded", forHTTPHeaderField: "Content-Type")
        request.httpBody = Data(body.utf8)
        return try await decode(request)
    }

    private func getJSON<T: Decodable>(path: String, accessToken: String) async throws -> T {
        var request = try makeRequest(baseURL: apiBaseURL, path: path)
        request.setValue("application/vnd.github+json", forHTTPHeaderField: "Accept")
        request.setValue("Bearer \(accessToken)", forHTTPHeaderField: "Authorization")
        request.setValue("2022-11-28", forHTTPHeaderField: "X-GitHub-Api-Version")
        return try await decode(request)
    }

    private func makeRequest(baseURL: URL, path: String) throws -> URLRequest {
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else {
            throw GitHubDeviceAuthClientError.invalidURL(path)
        }
        return URLRequest(url: url)
    }

    private func decode<T: Decodable>(_ request: URLRequest) async throws -> T {
        let (data, response) = try await session.data(for: request)
        guard let http = response as? HTTPURLResponse else {
            throw GitHubDeviceAuthClientError.invalidResponse("missing HTTP response")
        }
        guard (200..<300).contains(http.statusCode) else {
            let body = String(data: data, encoding: .utf8) ?? "<binary response>"
            throw GitHubDeviceAuthClientError.apiError("HTTP \(http.statusCode): \(body)")
        }
        do {
            return try JSONDecoder.github.decode(T.self, from: data)
        } catch {
            throw GitHubDeviceAuthClientError.invalidResponse(error.localizedDescription)
        }
    }
}

private struct DeviceCodeResponse: Decodable {
    var deviceCode: String
    var userCode: String
    var verificationUri: String
    var expiresIn: Int
    var interval: Int?
}

private struct TokenResponse: Decodable {
    var accessToken: String?
    var refreshToken: String?
    var expiresIn: Int?
    var refreshTokenExpiresIn: Int?
    var tokenType: String?
    var error: String?
    var errorDescription: String?
    var interval: Int?
}

private struct CurrentUserResponse: Decodable {
    var login: String
}

private struct InstallationsResponse: Decodable {
    var installations: [InstallationResponse]
}

private struct InstallationResponse: Decodable {
    var id: Int
    var account: InstallationAccountResponse
}

private struct InstallationAccountResponse: Decodable {
    var login: String
}

private struct InstallationRepositoriesResponse: Decodable {
    var repositories: [InstallationRepositoryResponse]
}

private struct InstallationRepositoryResponse: Decodable {
    var fullName: String
    var visibility: String?
    var `private`: Bool?
    var permissions: RepositoryPermissionsResponse
}

private struct RepositoryPermissionsResponse: Decodable {
    var admin: Bool?
    var push: Bool?
    var pull: Bool?
    var metadata: String?
    var pullRequests: String?
    var contents: String?
    var issues: String?

    var summary: String {
        [
            admin.map { "admin:\($0)" },
            push.map { "push:\($0)" },
            pull.map { "pull:\($0)" },
            metadata.map { "metadata:\($0)" },
            pullRequests.map { "pull_requests:\($0)" },
            contents.map { "contents:\($0)" },
            issues.map { "issues:\($0)" }
        ]
            .compactMap { $0 }
            .joined(separator: ",")
            .ifEmpty("permissions:unknown")
    }
}

private extension JSONDecoder {
    static var github: JSONDecoder {
        let decoder = JSONDecoder()
        decoder.keyDecodingStrategy = .convertFromSnakeCase
        return decoder
    }
}

private func urlEncode(_ value: String) -> String {
    value.addingPercentEncoding(withAllowedCharacters: .urlFormAllowed) ?? value
}

private extension CharacterSet {
    static var urlFormAllowed: CharacterSet {
        var allowed = CharacterSet.urlQueryAllowed
        allowed.remove(charactersIn: "&=+")
        return allowed
    }
}

private extension String {
    func ifEmpty(_ fallback: String) -> String {
        isEmpty ? fallback : self
    }
}
