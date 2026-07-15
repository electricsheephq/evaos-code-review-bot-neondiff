import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

// Issue #612 — AppCore integration for the native activation handoff. Proves the
// executable acceptance criteria: resume-exact restore (AC6), NO Keychain read on
// the launch path (v1.0.3 startup-stability rule), Keychain-only key storage,
// the honest checkout_paused production state, and that no raw key material ever
// reaches published state or logs.
@MainActor
@Suite struct ActivationHandoffModelTests {
    /// In-memory Keychain that records reads so the "no decrypt on init" rule can
    /// be proven, and supports the store→read roundtrip the flow needs.
    private final class RecordingKeychain: DesktopSecretStoring, @unchecked Sendable {
        private let lock = NSLock()
        private var storage: [String: String] = [:]
        private(set) var readAccounts: [String] = []

        func setSecret(_ secret: String, account: String) throws {
            lock.withLock { storage[account] = secret }
        }
        func readSecret(account: String) throws -> String? {
            try readSecret(account: account, allowUserInteraction: true)
        }
        func readSecret(account: String, allowUserInteraction: Bool) throws -> String? {
            lock.withLock { readAccounts.append(account); return storage[account] }
        }
        func containsSecret(account: String) -> Bool {
            lock.withLock { storage[account] != nil }
        }
        func deleteSecret(account: String) throws {
            _ = lock.withLock { storage.removeValue(forKey: account) }
        }
    }

    private final class FakeActivationClient: ActivationLicenseClienting, @unchecked Sendable {
        private let lock = NSLock()
        private var outcome: ActivationClientOutcome

        init(_ outcome: ActivationClientOutcome) { self.outcome = outcome }
        func set(_ outcome: ActivationClientOutcome) { lock.withLock { self.outcome = outcome } }
        func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome { lock.withLock { outcome } }
        func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome { lock.withLock { outcome } }
    }

    private func makeModel(
        preferences: MemoryPreferences = MemoryPreferences(),
        secretStore: RecordingKeychain = RecordingKeychain(),
        client: (any ActivationLicenseClienting)? = nil
    ) -> NeonDiffDesktopModel {
        let root = URL(fileURLWithPath: NSTemporaryDirectory(), isDirectory: true)
        let dependencies = DesktopAppDependencies(
            clipboard: RecordingClipboard(),
            urlOpener: RecordingURLOpener(),
            cli: RecordingCLIExecutor(),
            dashboard: RecordingDashboardLauncher(),
            preferences: preferences,
            clock: TestClock(),
            fileWriter: TemporaryFileWriter(root: root),
            providerVerifier: RecordingProviderVerifier(),
            secretStore: secretStore,
            githubAuthenticator: StubGitHubAuthenticator(),
            productionBoundary: .testVerified
        )
        return NeonDiffDesktopModel(dependencies: dependencies, activationLicenseClient: client)
    }

    private let activationKeyAccount = "activation-key/default"
    private let activationStateKey = "neondiff.activationState.v1"

    @Test func initNeverDecryptsKeychainOnLaunchPath() {
        let keychain = RecordingKeychain()
        _ = makeModel(secretStore: keychain)
        // The v1.0.3 regression class: no SecItemCopyMatching decrypt (readSecret)
        // may run during init. Existence checks (containsSecret) are the existing
        // established pattern and are not decrypt calls.
        #expect(keychain.readAccounts.isEmpty, "init must not read (decrypt) any Keychain secret")
    }

    @Test func defaultsToPurchaseRequiredWithoutPersistedState() {
        let model = makeModel()
        #expect(model.activationState == .purchaseRequired)
    }

    @Test func resumeExactRestoresPersistedState() {
        let prefs = MemoryPreferences()
        prefs.set(ActivationState.keyReady.rawValue, forKey: activationStateKey)
        let model = makeModel(preferences: prefs)
        #expect(model.activationState == .keyReady)
    }

    @Test func publicPathSkipsWithoutLicenseUI() {
        let model = makeModel()
        model.enterActivation(for: .publicReposOnly)
        #expect(model.activationState == .publicFreeSkip)
        #expect(model.activationPresentation.requiresKeyEntry == false)
        #expect(model.activationPresentation.recovery == nil)
    }

    @Test func privatePathBeginsCheckoutPausedWhenCheckoutDisabled() {
        let model = makeModel()
        model.enterActivation(for: .privateRepos)
        #expect(model.activationState == .purchaseRequired)
        // Production checkout stays disabled → honest checkout_paused, not a dead link.
        model.beginActivationCheckout()
        #expect(model.activationState == .checkoutPaused)
        #expect(model.activationPresentation.showsNotifyOption)
    }

    @Test func provideExistingKeyStoresInKeychainOnlyAndAdvances() {
        let keychain = RecordingKeychain()
        let model = makeModel(secretStore: keychain)
        model.activationState = .checkoutPaused
        model.pendingActivationKey = "NDL-EXISTING-0123456789"
        model.provideExistingActivationKey()

        #expect(model.activationState == .keyReady)
        #expect(keychain.containsSecret(account: activationKeyAccount), "key must be stored in the Keychain")
        #expect(model.pendingActivationKey.isEmpty, "the pasted key must be cleared from memory")
        #expect(model.activationKeyRedactedPrefix?.contains("•") == true)
        #expect(model.activationKeyRedactedPrefix?.contains("EXISTING") == false)
    }

    @Test func submitActivationSuccessUnlocksAndPersists() async {
        let prefs = MemoryPreferences()
        let keychain = RecordingKeychain()
        let client = FakeActivationClient(.active(.init(
            status: .active, repoVisibilityScope: "private", privateRepoAllowed: true,
            updateEntitlement: true, expiresAt: nil, plan: "team", seats: 3
        )))
        let model = makeModel(preferences: prefs, secretStore: keychain, client: client)
        model.activationState = .checkoutPaused
        model.pendingActivationKey = "NDL-GOOD-0123456789"
        model.provideExistingActivationKey()
        await model.submitActivation()

        #expect(model.activationState == .active)
        #expect(model.license.entitlement.contains("active"))
        #expect(prefs.string(forKey: activationStateKey) == ActivationState.active.rawValue,
                "active state must be persisted for resume-exact")
    }

    @Test func offlineThenRetrySucceeds() async {
        let keychain = RecordingKeychain()
        let client = FakeActivationClient(.offline)
        let model = makeModel(secretStore: keychain, client: client)
        model.activationState = .checkoutPaused
        model.pendingActivationKey = "NDL-GOOD-0123456789"
        model.provideExistingActivationKey()
        await model.submitActivation()
        #expect(model.activationState == .offline)

        client.set(.active(.init(
            status: .active, repoVisibilityScope: "private", privateRepoAllowed: true,
            updateEntitlement: true, expiresAt: nil, plan: nil, seats: nil
        )))
        await model.retryActivation()
        #expect(model.activationState == .active)
    }

    @Test func rawKeyNeverLeaksIntoPublishedStateOrLogs() async {
        let secret = "NDL-TOPSECRET-0123456789ABCDEF"
        let keychain = RecordingKeychain()
        let client = FakeActivationClient(.serviceError)
        let model = makeModel(secretStore: keychain, client: client)
        model.activationState = .checkoutPaused
        model.pendingActivationKey = secret
        model.provideExistingActivationKey()
        await model.submitActivation()

        let surfaces = [
            model.activationKeyRedactedPrefix ?? "",
            model.license.entitlement,
            model.logText,
            model.lastError ?? "",
            model.activationPresentation.cause,
            model.activationPresentation.accessibilityLabel
        ]
        for surface in surfaces {
            #expect(!surface.contains("TOPSECRET"), "raw key leaked into a published/log surface: \(surface)")
        }
    }

    @Test func expiredRecoveryReturnsToPurchase() {
        let model = makeModel()
        model.activationState = .expired
        model.renewActivation()
        #expect(model.activationState == .purchaseRequired)
    }
}
