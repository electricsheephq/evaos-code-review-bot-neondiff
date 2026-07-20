import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite(.timeLimit(.minutes(1)))
struct BYOGitHubAppCredentialOnboardingTests {
    @Test func exactB0BuildStoresPrivateKeyOnlyInFixedKeychainAccount() throws {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        #expect(!fixture.model.canAdvanceOnboarding)
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey

        fixture.model.storeBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == "123456")
        #expect(
            try fixture.secretStore.readSecret(account: BYOGitHubAppKeychainAccount.privateKey)
                == fixturePrivateKey
        )
        #expect(fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.byoGitHubCredentialsStored)
        #expect(fixture.model.canAdvanceOnboarding)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        #expect(fixture.model.pendingBYOGitHubAppId == "123456")
        #expect(fixture.cli.calls.isEmpty)
        #expect(fixture.model.lastError == nil)
    }

    @Test func invalidInputFailsClosedWithoutPersistingOrEchoingSecret() {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        let invalidSecret = "not-a-private-key-sensitive-fixture"
        fixture.model.pendingBYOGitHubAppId = "not-an-app-id"
        fixture.model.pendingBYOGitHubAppPrivateKey = invalidSecret

        fixture.model.storeBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId")?.isEmpty != false)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
        #expect(!fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        #expect(fixture.model.lastError?.contains(invalidSecret) == false)
    }

    @Test func nonASCIIAppIdAndPrivateKeyBodyAreRejected() {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        fixture.model.pendingBYOGitHubAppId = "１２３４５６"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)

        fixture.model.pendingBYOGitHubAppId = "00123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)

        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey.replacingOccurrences(
            of: "Z",
            with: "é"
        )
        fixture.model.storeBYOGitHubAppCredentials()
        #expect(!fixture.model.byoGitHubCredentialsStored)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
    }

    @Test func managedOrQuarantinedBuildCannotEnterBYOCredentials() {
        for boundary in [DesktopProductionBoundary.testManaged, .quarantined] {
            let fixture = ModelDependencyFixture(productionBoundary: boundary)
            fixture.model.pendingBYOGitHubAppId = "123456"
            fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey

            fixture.model.storeBYOGitHubAppCredentials()

            #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == nil)
            #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
            #expect(!fixture.model.byoGitHubPrivateKeyStored)
            #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
        }
    }

    @Test func removalDeletesOnlyTheFixedBYOKeyAndRetainsNoSecretInModel() throws {
        let fixture = ModelDependencyFixture(productionBoundary: exactB0Boundary)
        fixture.model.pendingBYOGitHubAppId = "123456"
        fixture.model.pendingBYOGitHubAppPrivateKey = fixturePrivateKey
        fixture.model.storeBYOGitHubAppCredentials()

        fixture.model.clearBYOGitHubAppCredentials()

        #expect(fixture.preferences.string(forKey: "neondiff.byoGitHubAppId") == nil)
        #expect(!fixture.secretStore.containsSecret(account: BYOGitHubAppKeychainAccount.privateKey))
        #expect(!fixture.model.byoGitHubPrivateKeyStored)
        #expect(fixture.model.pendingBYOGitHubAppId.isEmpty)
        #expect(fixture.model.pendingBYOGitHubAppPrivateKey.isEmpty)
    }
}

private let exactB0Boundary = DesktopProductionBoundary.resolve(infoDictionary: [
    "NeonDiffPaidBetaContract": "paid-mac-beta-byo-v1",
    "NeonDiffBYOGitHubEnabled": true
])

private let fixturePrivateKey = """
-----BEGIN PRIVATE KEY-----
ZmFrZS1maXh0dXJlLXByaXZhdGUta2V5
-----END PRIVATE KEY-----
"""
