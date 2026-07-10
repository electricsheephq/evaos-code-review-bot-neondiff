import Foundation
import NeonDiffDesktopCore

@discardableResult
func check(_ condition: @autoclosure () -> Bool, _ message: String) -> Bool {
    if condition() {
        return true
    }
    fputs("check failed: \(message)\n", stderr)
    exit(1)
}

func checkedAsync<T>(_ message: String, _ operation: () async throws -> T) async -> T {
    do {
        return try await operation()
    } catch {
        fputs("check failed: \(message): \(NeonDiffRedactor.redact(error.localizedDescription))\n", stderr)
        exit(1)
    }
}

var providerFlow = OnboardingFlow()
check(providerFlow.currentStep == .welcome, "flow starts at welcome")
providerFlow.advance()
check(providerFlow.currentStep == .provider, "welcome advances to provider")
check(!providerFlow.canAdvance, "provider step requires a stored provider key")
providerFlow.providerKeyStored = true
check(providerFlow.canAdvance, "provider step advances after key storage")

var publicFlow = OnboardingFlow(providerKeyStored: true)
publicFlow.currentStep = .license
publicFlow.mode = .publicReposOnly
publicFlow.licenseActivation = .servicePending
check(publicFlow.canAdvance, "public repo path can finish while license service is pending")
publicFlow.advance()
check(publicFlow.currentStep == .done, "public repo path finishes from license step")

var privateFlow = OnboardingFlow(providerKeyStored: true)
privateFlow.currentStep = .license
privateFlow.mode = .privateRepos
privateFlow.licenseActivation = .servicePending
check(!privateFlow.canAdvance, "private repo path cannot fake activation while service is pending")
check(privateFlow.licenseActivation != .activated, "pending service is not activated")

var daemonFlow = OnboardingFlow(providerKeyStored: true)
daemonFlow.currentStep = .daemon
check(!daemonFlow.canAdvance, "daemon step requires bootstrap/status check")
daemonFlow.daemonBootstrapChecked = true
check(daemonFlow.canAdvance, "daemon step advances after bootstrap/status check")

let tempRoot = FileManager.default.temporaryDirectory
    .appendingPathComponent("neondiff-desktop-core-checks-\(UUID().uuidString)", isDirectory: true)
let packageBin = tempRoot.appendingPathComponent("node_modules/.bin", isDirectory: true)
try FileManager.default.createDirectory(at: packageBin, withIntermediateDirectories: true)
try """
{"name":"neondiff","bin":{"neondiff":"dist/src/cli.js"}}
""".write(to: tempRoot.appendingPathComponent("package.json"), atomically: true, encoding: .utf8)
let localCLI = packageBin.appendingPathComponent("neondiff")
try """
#!/usr/bin/env bash
printf '{"command":"%s","args":%d}\\n' "$1" "$#"
""".write(to: localCLI, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: localCLI.path)
defer { try? FileManager.default.removeItem(at: tempRoot) }

let nestedBundleURL = tempRoot
    .appendingPathComponent("apps/neondiff-desktop/dist/NeonDiffDesktop.app", isDirectory: true)
check(
    NeonDiffCLIResolver.findPackageRoot(startingAt: nestedBundleURL)?.standardizedFileURL == tempRoot.standardizedFileURL,
    "CLI resolver discovers the repo package root from a local app bundle path"
)

check(
    NeonDiffCLIResolver.resolveExecutablePath("neondiff", workingDirectory: tempRoot)?.standardizedFileURL == localCLI.standardizedFileURL,
    "local package CLI is preferred over GUI PATH fallback"
)

final class GitHubFixtureURLProtocol: URLProtocol {
    static var requests: [URLRequest] = []
    static var requestBodies: [String] = []
    private static let lock = NSLock()

    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host?.hasSuffix("github.local") == true
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let capturedBody = Self.captureBody(from: request)
        Self.lock.lock()
        Self.requests.append(request)
        Self.requestBodies.append(capturedBody)
        Self.lock.unlock()

        let path = request.url?.path ?? ""
        let query = request.url?.query ?? ""
        let statusCode = 200
        let payload: String
        switch path {
        case "/login/device/code":
            payload = """
            {
              "device_code": "device-fixture",
              "user_code": "WDJB-MJHT",
              "verification_uri": "https://github.com/login/device",
              "expires_in": 900,
              "interval": 5
            }
            """
        case "/login/oauth/access_token":
            if capturedBody.contains("grant_type=refresh_token") {
                payload = """
                {
                  "access_token": "fixture-refreshed-access-token",
                  "refresh_token": "fixture-refreshed-refresh-token",
                  "expires_in": 28800,
                  "refresh_token_expires_in": 15811200,
                  "token_type": "bearer"
                }
                """
            } else {
                payload = """
                {
                  "access_token": "fixture-access-token",
                  "refresh_token": "fixture-refresh-token",
                  "expires_in": 28800,
                  "refresh_token_expires_in": 15811200,
                  "token_type": "bearer"
                }
                """
            }
        case "/user":
            payload = #"{"login":"octo-user"}"#
        case "/user/installations":
            if query.contains("page=2") {
                payload = #"{"installations":[{"id":43,"account":{"login":"second-org"}}]}"#
            } else if query.contains("page=3") {
                payload = #"{"installations":[]}"#
            } else {
                payload = #"{"installations":[{"id":42,"account":{"login":"octo-org"}}]}"#
            }
        case "/user/installations/42/repositories":
            if query.contains("page=2") {
                payload = #"{"repositories":[]}"#
            } else {
                payload = """
                {
                  "repositories": [
                    {
                      "full_name": "octo-org/private-repo",
                      "visibility": "private",
                      "private": true,
                      "permissions": {
                        "admin": false,
                        "push": false,
                        "pull": true
                      }
                    }
                  ]
                }
                """
            }
        case "/user/installations/43/repositories":
            if query.contains("page=2") {
                payload = #"{"repositories":[]}"#
            } else {
                payload = """
                {
                  "repositories": [
                    {
                      "full_name": "second-org/public-repo",
                      "visibility": "public",
                      "private": false,
                      "permissions": {
                        "admin": false,
                        "push": true,
                        "pull": true
                      }
                    }
                  ]
                }
                """
            }
        default:
            payload = #"{"message":"unexpected fixture path"}"#
        }

        let data = Data(payload.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: statusCode,
            httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}

    private static func captureBody(from request: URLRequest) -> String {
        if let body = request.httpBody {
            return String(data: body, encoding: .utf8) ?? ""
        }
        guard let stream = request.httpBodyStream else { return "" }
        stream.open()
        defer { stream.close() }
        var data = Data()
        let bufferSize = 1024
        let buffer = UnsafeMutablePointer<UInt8>.allocate(capacity: bufferSize)
        defer { buffer.deallocate() }
        while stream.hasBytesAvailable {
            let count = stream.read(buffer, maxLength: bufferSize)
            if count <= 0 { break }
            data.append(buffer, count: count)
        }
        return String(data: data, encoding: .utf8) ?? ""
    }
}

final class GitHubRateLimitURLProtocol: URLProtocol {
    override class func canInit(with request: URLRequest) -> Bool {
        request.url?.host == "rate-limit.github.local"
    }

    override class func canonicalRequest(for request: URLRequest) -> URLRequest {
        request
    }

    override func startLoading() {
        let payload = Data(#"{"message":"API rate limit exceeded","token":"must-not-surface"}"#.utf8)
        let response = HTTPURLResponse(
            url: request.url!,
            statusCode: 403,
            httpVersion: "HTTP/1.1",
            headerFields: [
                "Content-Type": "application/json",
                "X-RateLimit-Remaining": "0"
            ]
        )!
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: payload)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}

let fixtureSessionConfig = URLSessionConfiguration.ephemeral
fixtureSessionConfig.protocolClasses = [GitHubFixtureURLProtocol.self]
let fixtureGitHubClient = GitHubDeviceAuthClient(
    githubBaseURL: URL(string: "https://github.local")!,
    apiBaseURL: URL(string: "https://api.github.local")!,
    session: URLSession(configuration: fixtureSessionConfig),
    now: { Date(timeIntervalSince1970: 1000) },
    pageSize: 1
)
let fixtureDeviceCode = await checkedAsync("GitHub client requests device code") {
    try await fixtureGitHubClient.requestDeviceCode(clientId: "Iv1.publicclientid123")
}
check(fixtureDeviceCode.userCode == "WDJB-MJHT", "GitHub client parses device authorization user code")
check(fixtureDeviceCode.expiresAt == Date(timeIntervalSince1970: 1900), "GitHub client maps device authorization expiry")
let fixtureToken = await checkedAsync("GitHub client polls device token") {
    try await fixtureGitHubClient.pollDeviceAuthorization(clientId: "Iv1.publicclientid123", deviceCode: fixtureDeviceCode.deviceCode)
}
if case .authorized(let token) = fixtureToken {
    check(token.accessToken == "fixture-access-token", "GitHub client parses device token response")
} else {
    check(false, "GitHub client did not parse authorized device token response")
}
let fixtureUser = await checkedAsync("GitHub client fetches current user") {
    try await fixtureGitHubClient.fetchCurrentUser(accessToken: "fixture-access-token")
}
check(fixtureUser.login == "octo-user", "GitHub client fetches current user")
let fixtureRepos = await checkedAsync("GitHub client lists accessible repositories") {
    try await fixtureGitHubClient.listAccessibleRepositories(accessToken: "fixture-access-token")
}
check(fixtureRepos.count == 2, "GitHub client lists accessible repositories across installation pages")
check(fixtureRepos.first?.fullName == "octo-org/private-repo", "GitHub client maps repository full name")
check(fixtureRepos.first?.permissionsSummary == "admin:false,push:false,pull:true", "GitHub client maps documented repository permissions")
check(fixtureRepos.last?.fullName == "second-org/public-repo", "GitHub client follows later installation pages")
let refreshedToken = await checkedAsync("GitHub client refreshes expiring user tokens") {
    try await fixtureGitHubClient.refreshUserToken(clientId: "Iv1.publicclientid123", refreshToken: "fixture-refresh-token")
}
check(refreshedToken.accessToken == "fixture-refreshed-access-token", "GitHub refresh token grant returns a new access token")
let fixtureRequests = GitHubFixtureURLProtocol.requests
let fixtureRequestBodies = GitHubFixtureURLProtocol.requestBodies
let deviceCodeBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, _ in request.url?.path == "/login/device/code" }?
    .1 ?? ""
check(deviceCodeBody.contains("client_id=Iv1.publicclientid123"), "GitHub device-code request includes the public client id")
let tokenBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, body in
        request.url?.path == "/login/oauth/access_token" && body.contains("device_code=device-fixture")
    }?
    .1 ?? ""
check(tokenBody.contains("device_code=device-fixture"), "GitHub token request includes the device code")
check(tokenBody.contains("grant_type=urn:ietf:params:oauth:grant-type:device_code"), "GitHub token request uses the device-code grant")
let refreshBody = zip(fixtureRequests, fixtureRequestBodies)
    .first { request, body in
        request.url?.path == "/login/oauth/access_token" && body.contains("grant_type=refresh_token")
    }?
    .1 ?? ""
check(refreshBody.contains("refresh_token=fixture-refresh-token"), "GitHub refresh request includes the refresh token")
let authorizedAPIRequests = fixtureRequests.filter { $0.url?.host == "api.github.local" }
check(
    authorizedAPIRequests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access-token" },
    "GitHub API requests use the user access token authorization header"
)

let launchMarker = tempRoot.appendingPathComponent("dashboard-launch-marker.txt")
let launchScript = tempRoot.appendingPathComponent("dashboard-launcher")
try """
#!/usr/bin/env bash
printf '%s\\n' "$*" > \(launchMarker.path)
""".write(to: launchScript, atomically: true, encoding: .utf8)
try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchScript.path)

let launchClient = NeonDiffCLIClient(executablePath: launchScript.path, workingDirectory: tempRoot)
let launchResult = try launchClient.launchDetached(arguments: ["dashboard", "--config", "config.local.json", "--open", "true"])
check(launchResult.processIdentifier > 0, "dashboard launcher returns a child process identifier")
let markerDeadline = Date().addingTimeInterval(3)
while !FileManager.default.fileExists(atPath: launchMarker.path), Date() < markerDeadline {
    try await Task.sleep(nanoseconds: 50_000_000)
}
check(FileManager.default.fileExists(atPath: launchMarker.path), "dashboard launcher writes its marker file")
let markerContents = try String(contentsOf: launchMarker, encoding: .utf8)
check(markerContents.contains("dashboard --config config.local.json --open true"), "dashboard launcher passes expected CLI arguments")

let authCode = GitHubDeviceAuthorizationCode(
    deviceCode: "device-code",
    userCode: "WDJB-MJHT",
    verificationURI: URL(string: "https://github.com/login/device")!,
    expiresAt: Date(timeIntervalSince1970: 1000),
    intervalSeconds: 5
)
check(authCode.userCode == "WDJB-MJHT", "device authorization exposes the user code for visible desktop setup")
check(authCode.intervalSeconds == 5, "device authorization preserves GitHub polling interval")

let pendingPoll = GitHubDeviceAuthorizationPollResult.pending(intervalSeconds: 5)
let slowedPoll = pendingPoll.applyingSlowDown()
check(slowedPoll.minimumNextPollIntervalSeconds == 10, "slow_down adds five seconds to the polling interval")

let discoveredRepos = GitHubRepositoryDiscovery.mergeConfiguredAndDiscoveredRepos(
    configured: [RepoMonitor(name: "owner/manual", enabled: true, profile: "selected")],
    discovered: [
        GitHubDiscoveredRepository(
            fullName: "owner/discovered",
            visibility: "private",
            installationId: 123,
            installationAccount: "owner",
            permissionsSummary: "metadata:read,pull_requests:write"
        )
    ]
)
check(
    discoveredRepos.map(\.name) == ["owner/discovered", "owner/manual"],
    "discovered repositories merge with configured allowlist without dropping manual repos"
)
check(
    discoveredRepos.first(where: { $0.name == "owner/discovered" })?.enabled == false,
    "discovered repositories are not enabled until the user selects them"
)

let fakeGitHubAccessToken = ["ghu", "fixture_token_12345678901234567890"].joined(separator: "_")
let fakeGitHubRefreshToken = ["ghr", "fixture_token_12345678901234567890"].joined(separator: "_")
let redactedGitHubTokens = NeonDiffRedactor.redact("access=\(fakeGitHubAccessToken) refresh=\(fakeGitHubRefreshToken)")
check(!redactedGitHubTokens.contains("ghu_fixture"), "GitHub user access tokens are redacted")
check(!redactedGitHubTokens.contains("ghr_fixture"), "GitHub refresh tokens are redacted")

let unauthorizedRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 401,
    headers: [:],
    requestPath: "/user/installations"
)
check(unauthorizedRecovery.action == .reconnect, "GitHub 401 tells the user to reconnect")
check(unauthorizedRecovery.status == "authorization expired", "GitHub 401 has a stable visible status")

let rateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: ["x-ratelimit-remaining": "0"],
    requestPath: "/user/installations"
)
check(rateLimitRecovery.action == .retryLater, "GitHub rate limits tell the user to retry later")
check(rateLimitRecovery.message.contains("rate limit"), "GitHub rate limits are named in the visible recovery copy")

let secondaryRateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: ["Retry-After": "60"],
    requestPath: "/user/installations"
)
check(secondaryRateLimitRecovery.action == .retryLater, "GitHub secondary rate limits are not mislabeled as organization policy")

let organizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: [:],
    requestPath: "/user/installations"
)
check(organizationRecovery.action == .installOrManageApp, "Ambiguous GitHub 403 responses use permission recovery without assuming org policy")
check(organizationRecovery.status == "permission denied", "Ambiguous GitHub 403 responses have a stable permission status")

let confirmedOrganizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 403,
    headers: [:],
    requestPath: "/user/installations",
    responseBody: #"{"message":"Resource protected by organization SAML enforcement"}"#
)
check(confirmedOrganizationRecovery.action == .contactOrganizationOwner, "Confirmed GitHub org policy blocks name the organization-owner recovery")
check(confirmedOrganizationRecovery.message.contains("organization policy"), "Confirmed org policy blocks are distinct from permission denials")

let installationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
    statusCode: 404,
    headers: [:],
    requestPath: "/user/installations/42/repositories"
)
check(installationRecovery.action == .installOrManageApp, "Missing installations point to GitHub App management")

check(
    GitHubAppInstallLink.url(botLogin: "evaos-code-review-bot[bot]")?.absoluteString
        == "https://github.com/apps/evaos-code-review-bot/installations/new",
    "GitHub App bot login maps to the selected-repository install URL"
)
check(GitHubAppInstallLink.url(botLogin: "configured GitHub App bot") == nil, "Placeholder bot labels do not become install URLs")
check(
    GitHubAppInstallLink.publicAppURL.absoluteString
        == "https://github.com/apps/evaos-code-review-bot/installations/new",
    "The public product has a stable selected-repository install URL when botLogin is omitted"
)

let publicRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/public-repo",
        visibility: "public",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:true"
    ),
    licenseEntitlement: "not activated"
)
check(publicRepoCue == .publicFree, "Public repositories show the free-path cue")

let privateRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/private-repo",
        visibility: "private",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:true"
    ),
    licenseEntitlement: "stored locally"
)
check(privateRepoCue == .licenseRequired, "Private repositories do not treat a stored key as active entitlement")

let unreadableRepoCue = GitHubRepositoryAccessPolicy.cue(
    for: GitHubDiscoveredRepository(
        fullName: "octo-org/unreadable-repo",
        visibility: "private",
        installationId: 42,
        installationAccount: "octo-org",
        permissionsSummary: "admin:false,push:false,pull:false"
    ),
    licenseEntitlement: "active"
)
check(unreadableRepoCue == .insufficientReadAccess, "Unreadable repositories name the permissions blocker before license state")

let locallyExpiredDeviceCode = GitHubConnectionRecoveryClassifier.deviceCodeExpired
check(locallyExpiredDeviceCode.action == .reconnect, "Locally detected device-code expiry exposes reconnect recovery")
check(locallyExpiredDeviceCode.status == "device code expired", "Local and GitHub-returned device expiry share a stable status")

var refreshGate = GitHubLatestRequestGate()
let firstRefresh = refreshGate.begin()
let secondRefresh = refreshGate.begin()
check(!refreshGate.isCurrent(firstRefresh), "An older repository refresh cannot overwrite a newer refresh")
check(refreshGate.isCurrent(secondRefresh), "The newest repository refresh may update UI state")

let rateLimitSessionConfig = URLSessionConfiguration.ephemeral
rateLimitSessionConfig.protocolClasses = [GitHubRateLimitURLProtocol.self]
let rateLimitClient = GitHubDeviceAuthClient(
    apiBaseURL: URL(string: "https://rate-limit.github.local")!,
    session: URLSession(configuration: rateLimitSessionConfig)
)
do {
    _ = try await rateLimitClient.fetchCurrentUser(accessToken: "fixture-access-token")
    check(false, "GitHub client must reject a rate-limited API response")
} catch let error as GitHubDeviceAuthClientError {
    check(error.recovery?.action == .retryLater, "GitHub client carries the classified rate-limit recovery to the UI model")
    check(!error.localizedDescription.contains("must-not-surface"), "GitHub client does not surface raw API response bodies")
} catch {
    check(false, "GitHub client must expose a typed, actionable failure")
}

print("NeonDiffDesktopCoreChecks passed")
