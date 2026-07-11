import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite struct GitHubAuthorizationTests {
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
        fixture.model.openGitHubDeviceVerification()

        #expect(!fixture.clipboard.result)
        #expect(fixture.clipboard.strings == ["ABCD-EFGH"])
        #expect(!fixture.urlOpener.result)
        #expect(fixture.urlOpener.urls == [code.verificationURI])
    }
}
