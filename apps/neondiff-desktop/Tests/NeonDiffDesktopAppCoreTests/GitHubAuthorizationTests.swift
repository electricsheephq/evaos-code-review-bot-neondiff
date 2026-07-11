import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite(.timeLimit(.minutes(1))) struct GitHubAuthorizationTests {
    @Test func exactSixtySecondExpiryThresholdRefreshesToken() async throws {
        let now = fixtureDate(secondsSince1970: 1_000_000)
        let authenticator = ScriptedGitHubAuthenticator(
            refreshedToken: GitHubUserToken(
                accessToken: "refreshed-access",
                refreshToken: "refreshed-refresh",
                expiresAt: now.addingTimeInterval(3_600),
                refreshTokenExpiresAt: now.addingTimeInterval(7_200)
            )
        )
        let fixture = ModelDependencyFixture(now: now, githubAuthenticator: authenticator)
        fixture.model.github.clientId = "fixture-client-id"
        try fixture.secretStore.setSecret("old-access", account: "github/user-access-token")
        try fixture.secretStore.setSecret("old-refresh", account: "github/user-refresh-token")
        try fixture.secretStore.setSecret(
            fixtureISO8601String(now.addingTimeInterval(60)),
            account: "github/user-token-expires-at"
        )
        try fixture.secretStore.setSecret(
            fixtureISO8601String(now.addingTimeInterval(1_000)),
            account: "github/user-refresh-token-expires-at"
        )

        fixture.model.refreshGitHubRepositories()
        await fixture.waitForGitHubRefreshToFinish()

        #expect(authenticator.refreshTokens == ["old-refresh"])
        #expect(authenticator.fetchedAccessTokens == ["refreshed-access"])
        #expect(fixture.secretStore.values["github/user-access-token"] == "refreshed-access")
    }

    @Test func tokenBeyondSixtySecondThresholdSkipsRefresh() async throws {
        let now = fixtureDate(secondsSince1970: 1_000_000)
        let authenticator = ScriptedGitHubAuthenticator()
        let fixture = ModelDependencyFixture(now: now, githubAuthenticator: authenticator)
        fixture.model.github.clientId = "fixture-client-id"
        try fixture.secretStore.setSecret("current-access", account: "github/user-access-token")
        try fixture.secretStore.setSecret(
            fixtureISO8601String(now.addingTimeInterval(61)),
            account: "github/user-token-expires-at"
        )

        fixture.model.refreshGitHubRepositories()
        await fixture.waitForGitHubRefreshToFinish()

        #expect(authenticator.refreshTokens.isEmpty)
        #expect(authenticator.fetchedAccessTokens == ["current-access"])
    }

    @Test func refreshTokenExpiryAtInjectedNowFailsClosed() async throws {
        let now = fixtureDate(secondsSince1970: 1_000_000)
        let authenticator = ScriptedGitHubAuthenticator()
        let fixture = ModelDependencyFixture(now: now, githubAuthenticator: authenticator)
        fixture.model.github.clientId = "fixture-client-id"
        try fixture.secretStore.setSecret("expired-access", account: "github/user-access-token")
        try fixture.secretStore.setSecret("expired-refresh", account: "github/user-refresh-token")
        try fixture.secretStore.setSecret(
            fixtureISO8601String(now),
            account: "github/user-token-expires-at"
        )
        try fixture.secretStore.setSecret(
            fixtureISO8601String(now),
            account: "github/user-refresh-token-expires-at"
        )

        fixture.model.refreshGitHubRepositories()
        await fixture.waitForGitHubRefreshToFinish()

        #expect(authenticator.refreshTokens.isEmpty)
        #expect(fixture.model.githubRecovery?.action == .reconnect)
        #expect(fixture.secretStore.values["github/user-access-token"] == nil)
        #expect(fixture.secretStore.values["github/user-refresh-token"] == nil)
    }

    @Test func devicePollingAdoptsServerIntervalWithoutWallClockSleep() async throws {
        let now = fixtureDate(secondsSince1970: 1_000_000)
        let deviceCode = GitHubDeviceAuthorizationCode(
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationURI: fixtureURL("https://github.com/login/device"),
            expiresAt: now.addingTimeInterval(600),
            intervalSeconds: 2
        )
        let authenticator = ScriptedGitHubAuthenticator(
            deviceCode: deviceCode,
            pollResults: [
                .pending(intervalSeconds: 7),
                .authorized(GitHubUserToken(accessToken: "authorized-access"))
            ]
        )
        let fixture = ModelDependencyFixture(now: now, githubAuthenticator: authenticator)
        fixture.model.github.clientId = "fixture-client-id"

        fixture.model.startGitHubAuthorization()
        await fixture.waitForGitHubAuthorizationToFinish()

        #expect(fixture.clock.sleeps == [.seconds(2), .seconds(7)])
        #expect(authenticator.pollDeviceCodes == ["fixture-device-code", "fixture-device-code"])
        #expect(fixture.model.github.authorizedUserLogin == "fixture-user")
    }

    @Test func clipboardAndURLOpenFailuresStayInsideInjectedSeams() {
        let fixture = ModelDependencyFixture(clipboardResult: false, urlResult: false)
        let code = GitHubDeviceAuthorizationCode(
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationURI: fixtureURL("https://github.com/login/device"),
            expiresAt: fixtureDate(secondsSince1970: 2_000_000),
            intervalSeconds: 5
        )
        fixture.model.githubAuthorizationCode = code

        fixture.model.copyGitHubUserCode()
        #expect(fixture.model.githubAuthorizationStatus == "device code copy failed")
        #expect(fixture.model.lastError == "Could not copy the GitHub device code. Copy it manually and retry.")

        fixture.model.openGitHubDeviceVerification()
        #expect(fixture.model.githubAuthorizationStatus == "verification page open failed")
        #expect(fixture.model.lastError == "Could not open the GitHub verification page. Open the shown URL manually.")

        fixture.model.openGitHubAppInstallation()
        #expect(fixture.model.githubAuthorizationStatus == "App installation page open failed")
        #expect(fixture.model.lastError == "Could not open the GitHub App installation page. Open it manually in your browser.")

        #expect(!fixture.clipboard.result)
        #expect(fixture.clipboard.strings == ["ABCD-EFGH"])
        #expect(!fixture.urlOpener.result)
        #expect(fixture.urlOpener.urls == [code.verificationURI, fixture.model.githubAppInstallURL])
    }

    @Test func clipboardAndURLOpenSuccessPreservesExistingStatusSemantics() {
        let code = GitHubDeviceAuthorizationCode(
            deviceCode: "fixture-device-code",
            userCode: "ABCD-EFGH",
            verificationURI: fixtureURL("https://github.com/login/device"),
            expiresAt: fixtureDate(secondsSince1970: 2_000_000),
            intervalSeconds: 5
        )

        let copyFixture = ModelDependencyFixture()
        copyFixture.model.githubAuthorizationCode = code
        copyFixture.model.lastError = "stale failure"
        copyFixture.model.copyGitHubUserCode()
        #expect(copyFixture.model.githubAuthorizationStatus == "code copied")
        #expect(copyFixture.model.lastError == nil)

        let verificationFixture = ModelDependencyFixture()
        verificationFixture.model.githubAuthorizationCode = code
        verificationFixture.model.lastError = "stale failure"
        verificationFixture.model.openGitHubDeviceVerification()
        #expect(verificationFixture.model.githubAuthorizationStatus == "verification page opened")
        #expect(verificationFixture.model.lastError == nil)

        let installationFixture = ModelDependencyFixture()
        installationFixture.model.lastError = "stale failure"
        installationFixture.model.openGitHubAppInstallation()
        #expect(installationFixture.model.githubAuthorizationStatus == "App installation page opened")
        #expect(installationFixture.model.lastError == nil)
    }
}
