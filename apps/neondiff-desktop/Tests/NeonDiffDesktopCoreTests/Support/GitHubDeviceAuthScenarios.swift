import Foundation
@_spi(Testing) import NeonDiffDesktopCore
import Darwin

  @MainActor
  func runGithubDeviceFlowTransportContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    GitHubFixtureURLProtocol.reset()
    let fixtureSessionConfig = URLSessionConfiguration.ephemeral
    fixtureSessionConfig.protocolClasses = [GitHubFixtureURLProtocol.self]
    let fixtureGitHubClient = GitHubDeviceAuthClient(
        githubBaseURL: URL(string: "https://github.local")!,
        apiBaseURL: URL(string: "https://api.github.local")!,
        session: URLSession(configuration: fixtureSessionConfig),
        now: { Date(timeIntervalSince1970: 1000) },
        pageSize: 1
    )
    let fixtureDeviceCode = try await checkedAsync("GitHub client requests device code") {
        try await fixtureGitHubClient.requestDeviceCode(clientId: "Iv1.publicclientid123")
    }
    context.expect(fixtureDeviceCode.userCode == "WDJB-MJHT", "GitHub client parses device authorization user code")
    context.expect(fixtureDeviceCode.expiresAt == Date(timeIntervalSince1970: 1900), "GitHub client maps device authorization expiry")
    let fixtureToken = try await checkedAsync("GitHub client polls device token") {
        try await fixtureGitHubClient.pollDeviceAuthorization(clientId: "Iv1.publicclientid123", deviceCode: fixtureDeviceCode.deviceCode)
    }
    if case .authorized(let token) = fixtureToken {
        context.expect(token.accessToken == "fixture-access-token", "GitHub client parses device token response")
    } else {
        context.expect(false, "GitHub client did not parse authorized device token response")
    }
    let fixtureUser = try await checkedAsync("GitHub client fetches current user") {
        try await fixtureGitHubClient.fetchCurrentUser(accessToken: "fixture-access-token")
    }
    context.expect(fixtureUser.login == "octo-user", "GitHub client fetches current user")
    let fixtureRepos = try await checkedAsync("GitHub client lists accessible repositories") {
        try await fixtureGitHubClient.listAccessibleRepositories(accessToken: "fixture-access-token")
    }
    context.expect(fixtureRepos.count == 2, "GitHub client lists accessible repositories across installation pages")
    context.expect(fixtureRepos.first?.fullName == "octo-org/private-repo", "GitHub client maps repository full name")
    context.expect(fixtureRepos.first?.permissionsSummary == "admin:false,push:false,pull:true", "GitHub client maps documented repository permissions")
    context.expect(fixtureRepos.last?.fullName == "second-org/public-repo", "GitHub client follows later installation pages")
    let refreshedToken = try await checkedAsync("GitHub client refreshes expiring user tokens") {
        try await fixtureGitHubClient.refreshUserToken(clientId: "Iv1.publicclientid123", refreshToken: "fixture-refresh-token")
    }
    context.expect(refreshedToken.accessToken == "fixture-refreshed-access-token", "GitHub refresh token grant returns a new access token")
    let fixtureRequests = GitHubFixtureURLProtocol.requests
    let fixtureRequestBodies = GitHubFixtureURLProtocol.requestBodies
    let deviceCodeBody = zip(fixtureRequests, fixtureRequestBodies)
        .first { request, _ in request.url?.path == "/login/device/code" }?
        .1 ?? ""
    context.expect(deviceCodeBody.contains("client_id=Iv1.publicclientid123"), "GitHub device-code request includes the public client id")
    let tokenBody = zip(fixtureRequests, fixtureRequestBodies)
        .first { request, body in
            request.url?.path == "/login/oauth/access_token" && body.contains("device_code=device-fixture")
        }?
        .1 ?? ""
    context.expect(tokenBody.contains("device_code=device-fixture"), "GitHub token request includes the device code")
    context.expect(tokenBody.contains("grant_type=urn:ietf:params:oauth:grant-type:device_code"), "GitHub token request uses the device-code grant")
    let refreshBody = zip(fixtureRequests, fixtureRequestBodies)
        .first { request, body in
            request.url?.path == "/login/oauth/access_token" && body.contains("grant_type=refresh_token")
        }?
        .1 ?? ""
    context.expect(refreshBody.contains("refresh_token=fixture-refresh-token"), "GitHub refresh request includes the refresh token")
    let authorizedAPIRequests = fixtureRequests.filter { $0.url?.host == "api.github.local" }
    context.expect(
        authorizedAPIRequests.allSatisfy { $0.value(forHTTPHeaderField: "Authorization") == "Bearer fixture-access-token" },
        "GitHub API requests use the user access token authorization header"
    )


      return context.assertions
  }

  @MainActor
  func runDetachedCommandLaunchContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let fixture = try CoreCLIFixture()
    let tempRoot = fixture.root
    defer { try? FileManager.default.removeItem(at: tempRoot) }
    let shortLivedLaunchClient = NeonDiffCLIClient(executablePath: "/usr/bin/true", workingDirectory: tempRoot)
    let shortLivedLaunchResult = try shortLivedLaunchClient.launchDetached(arguments: [])
    context.expect(shortLivedLaunchResult.processIdentifier > 0, "detached launcher reports a pid for a successful short-lived command")

    let launchMarker = tempRoot.appendingPathComponent("dashboard-launch-marker.txt")
    let launchScript = tempRoot.appendingPathComponent("dashboard-launcher")
    try """
    #!/usr/bin/env bash
    printf '%s\\n' "$*" > \(launchMarker.path)
    """.write(to: launchScript, atomically: true, encoding: .utf8)
    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: launchScript.path)

    let launchClient = NeonDiffCLIClient(executablePath: launchScript.path, workingDirectory: tempRoot)
    let launchResult = try launchClient.launchDetached(arguments: ["dashboard", "--config", "config.local.json", "--open", "true"])
    context.expect(launchResult.processIdentifier > 0, "dashboard launcher returns a child process identifier")
    let markerDeadline = Date().addingTimeInterval(3)
    while !FileManager.default.fileExists(atPath: launchMarker.path), Date() < markerDeadline {
        try await Task.sleep(nanoseconds: 50_000_000)
    }
    context.expect(FileManager.default.fileExists(atPath: launchMarker.path), "dashboard launcher writes its marker file")
    let markerContents = try String(contentsOf: launchMarker, encoding: .utf8)
    context.expect(markerContents.contains("dashboard --config config.local.json --open true"), "dashboard launcher passes expected CLI arguments")


      return context.assertions
  }

  @MainActor
  func runGithubRecoveryRepositoryAndRateLimitContracts() async throws -> [LegacyCoreCheckAssertion] {
      let context = LegacyCoreCheckRecorder()
    let authCode = GitHubDeviceAuthorizationCode(
        deviceCode: "device-code",
        userCode: "WDJB-MJHT",
        verificationURI: URL(string: "https://github.com/login/device")!,
        expiresAt: Date(timeIntervalSince1970: 1000),
        intervalSeconds: 5
    )
    context.expect(authCode.userCode == "WDJB-MJHT", "device authorization exposes the user code for visible desktop setup")
    context.expect(authCode.intervalSeconds == 5, "device authorization preserves GitHub polling interval")

    let pendingPoll = GitHubDeviceAuthorizationPollResult.pending(intervalSeconds: 5)
    let slowedPoll = pendingPoll.applyingSlowDown()
    context.expect(slowedPoll.minimumNextPollIntervalSeconds == 10, "slow_down adds five seconds to the polling interval")

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
    context.expect(
        discoveredRepos.map(\.name) == ["owner/discovered", "owner/manual"],
        "discovered repositories merge with configured allowlist without dropping manual repos"
    )
    context.expect(
        discoveredRepos.first(where: { $0.name == "owner/discovered" })?.enabled == false,
        "discovered repositories are not enabled until the user selects them"
    )

    let fakeGitHubAccessToken = ["ghu", "fixture_token_12345678901234567890"].joined(separator: "_")
    let fakeGitHubRefreshToken = ["ghr", "fixture_token_12345678901234567890"].joined(separator: "_")
    let redactedGitHubTokens = NeonDiffRedactor.redact("access=\(fakeGitHubAccessToken) refresh=\(fakeGitHubRefreshToken)")
    context.expect(!redactedGitHubTokens.contains("ghu_fixture"), "GitHub user access tokens are redacted")
    context.expect(!redactedGitHubTokens.contains("ghr_fixture"), "GitHub refresh tokens are redacted")

    let unauthorizedRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 401,
        headers: [:],
        requestPath: "/user/installations"
    )
    context.expect(unauthorizedRecovery.action == .reconnect, "GitHub 401 tells the user to reconnect")
    context.expect(unauthorizedRecovery.status == "authorization expired", "GitHub 401 has a stable visible status")

    let rateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 403,
        headers: ["x-ratelimit-remaining": "0"],
        requestPath: "/user/installations"
    )
    context.expect(rateLimitRecovery.action == .retryLater, "GitHub rate limits tell the user to retry later")
    context.expect(rateLimitRecovery.message.contains("rate limit"), "GitHub rate limits are named in the visible recovery copy")

    let secondaryRateLimitRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 403,
        headers: ["Retry-After": "60"],
        requestPath: "/user/installations"
    )
    context.expect(secondaryRateLimitRecovery.action == .retryLater, "GitHub secondary rate limits are not mislabeled as organization policy")

    let organizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 403,
        headers: [:],
        requestPath: "/user/installations"
    )
    context.expect(organizationRecovery.action == .installOrManageApp, "Ambiguous GitHub 403 responses use permission recovery without assuming org policy")
    context.expect(organizationRecovery.status == "permission denied", "Ambiguous GitHub 403 responses have a stable permission status")

    let confirmedOrganizationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 403,
        headers: [:],
        requestPath: "/user/installations",
        responseBody: #"{"message":"Resource protected by organization SAML enforcement"}"#
    )
    context.expect(confirmedOrganizationRecovery.action == .contactOrganizationOwner, "Confirmed GitHub org policy blocks name the organization-owner recovery")
    context.expect(confirmedOrganizationRecovery.message.contains("organization policy"), "Confirmed org policy blocks are distinct from permission denials")

    let installationRecovery = GitHubConnectionRecoveryClassifier.httpFailure(
        statusCode: 404,
        headers: [:],
        requestPath: "/user/installations/42/repositories"
    )
    context.expect(installationRecovery.action == .installOrManageApp, "Missing installations point to GitHub App management")

    context.expect(
        GitHubAppInstallLink.url(botLogin: "evaos-code-review-bot[bot]")?.absoluteString
            == "https://github.com/apps/evaos-code-review-bot/installations/new",
        "GitHub App bot login maps to the selected-repository install URL"
    )
    context.expect(GitHubAppInstallLink.url(botLogin: "configured GitHub App bot") == nil, "Placeholder bot labels do not become install URLs")
    context.expect(
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
    context.expect(publicRepoCue == .publicFree, "Public repositories show the free-path cue")

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
    context.expect(privateRepoCue == .licenseRequired, "Private repositories do not treat a stored key as active entitlement")

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
    context.expect(unreadableRepoCue == .insufficientReadAccess, "Unreadable repositories name the permissions blocker before license state")

    let locallyExpiredDeviceCode = GitHubConnectionRecoveryClassifier.deviceCodeExpired
    context.expect(locallyExpiredDeviceCode.action == .reconnect, "Locally detected device-code expiry exposes reconnect recovery")
    context.expect(locallyExpiredDeviceCode.status == "device code expired", "Local and GitHub-returned device expiry share a stable status")

    var refreshGate = GitHubLatestRequestGate()
    let firstRefresh = refreshGate.begin()
    let secondRefresh = refreshGate.begin()
    context.expect(!refreshGate.isCurrent(firstRefresh), "An older repository refresh cannot overwrite a newer refresh")
    context.expect(refreshGate.isCurrent(secondRefresh), "The newest repository refresh may update UI state")

    let rateLimitSessionConfig = URLSessionConfiguration.ephemeral
    rateLimitSessionConfig.protocolClasses = [GitHubRateLimitURLProtocol.self]
    let rateLimitClient = GitHubDeviceAuthClient(
        apiBaseURL: URL(string: "https://rate-limit.github.local")!,
        session: URLSession(configuration: rateLimitSessionConfig)
    )
    do {
        _ = try await rateLimitClient.fetchCurrentUser(accessToken: "fixture-access-token")
        context.expect(false, "GitHub client must reject a rate-limited API response")
    } catch let error as GitHubDeviceAuthClientError {
        context.expect(error.recovery?.action == .retryLater, "GitHub client carries the classified rate-limit recovery to the UI model")
        context.expect(!error.localizedDescription.contains("must-not-surface"), "GitHub client does not surface raw API response bodies")
    } catch {
        context.expect(false, "GitHub client must expose a typed, actionable failure")
    }


      return context.assertions
  }
