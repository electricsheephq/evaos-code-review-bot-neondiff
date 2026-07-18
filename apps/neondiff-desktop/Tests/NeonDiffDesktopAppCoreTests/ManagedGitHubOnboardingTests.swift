import Foundation
import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

private final class ManagedGitHubLocked<Value>: @unchecked Sendable {
    private let lock = NSLock()
    private var value: Value

    init(_ value: Value) {
        self.value = value
    }

    func read<Result>(_ body: (Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(value) }
    }

    func update<Result>(_ body: (inout Value) throws -> Result) rethrows -> Result {
        try lock.withLock { try body(&value) }
    }
}

final class ScriptedGitHubBroker: GitHubBrokerConnecting, @unchecked Sendable {
    private struct State {
        var completionResults: [GitHubBrokerConnectionCompletion]
        var repositoryPages: [GitHubBrokerRepositoryPage]
        var error: GitHubBrokerClientError?
        var registeredDeviceIds: [String] = []
        var startedDeviceIds: [String] = []
        var completedStates: [String] = []
        var listedInstallationIds: [Int] = []
    }

    private let state: ManagedGitHubLocked<State>
    let connection: GitHubBrokerConnection

    init(
        completionResults: [GitHubBrokerConnectionCompletion] = [.bound(installationId: 42)],
        repositories: [GitHubBrokerRepository] = [
            GitHubBrokerRepository(fullName: "electric/public", visibility: .public)
        ],
        error: GitHubBrokerClientError? = nil
    ) {
        connection = GitHubBrokerConnection(
            installURL: URL(string: "https://github.com/apps/neondiff/installations/new?state=fixture-state")!,
            state: "fixture-state",
            expiresAt: Date(timeIntervalSince1970: 1_000_600)
        )
        state = ManagedGitHubLocked(State(
            completionResults: completionResults,
            repositoryPages: [
                GitHubBrokerRepositoryPage(
                    installationId: 42,
                    page: 1,
                    repositories: repositories,
                    nextPage: nil
                )
            ],
            error: error
        ))
    }

    var registeredDeviceIds: [String] { state.read(\.registeredDeviceIds) }
    var startedDeviceIds: [String] { state.read(\.startedDeviceIds) }
    var completedStates: [String] { state.read(\.completedStates) }
    var listedInstallationIds: [Int] { state.read(\.listedInstallationIds) }

    func register(identity: GitHubBrokerDeviceIdentity) async throws {
        try throwIfNeeded()
        state.update { $0.registeredDeviceIds.append(identity.deviceId) }
    }

    func startConnection(identity: GitHubBrokerDeviceIdentity) async throws -> GitHubBrokerConnection {
        try throwIfNeeded()
        state.update { $0.startedDeviceIds.append(identity.deviceId) }
        return connection
    }

    func completeConnection(
        identity: GitHubBrokerDeviceIdentity,
        state opaqueState: String
    ) async throws -> GitHubBrokerConnectionCompletion {
        try throwIfNeeded()
        return state.update {
            $0.completedStates.append(opaqueState)
            return $0.completionResults.isEmpty ? .pending : $0.completionResults.removeFirst()
        }
    }

    func listRepositories(
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int,
        page: Int
    ) async throws -> GitHubBrokerRepositoryPage {
        try throwIfNeeded()
        return state.update {
            $0.listedInstallationIds.append(installationId)
            return $0.repositoryPages.removeFirst()
        }
    }

    private func throwIfNeeded() throws {
        if let error = state.read(\.error) {
            throw error
        }
    }
}

private struct ActiveManagedActivationClient: ActivationLicenseClienting {
    func activate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        .active(.init(
            status: .active,
            repoVisibilityScope: "private",
            privateRepoAllowed: true,
            updateEntitlement: true,
            expiresAt: nil,
            plan: "beta",
            seats: 1
        ))
    }

    func revalidate(key: ActivationKeyMaterial) async throws -> ActivationClientOutcome {
        try await activate(key: key)
    }
}

@MainActor
@Suite(.timeLimit(.minutes(1))) struct ManagedGitHubOnboardingTests {
    @Test func productionBoundaryRequiresExactSignedBuildContract() {
        let valid = DesktopProductionBoundary.resolve(infoDictionary: [
            "NeonDiffPaidBetaContract": "paid-mac-beta-v1",
            "NeonDiffManagedGitHubBrokerEnabled": true,
            "NeonDiffGitHubBrokerOrigin": "https://neondiff-license.fly.dev"
        ])
        #expect(valid.nativeActivationBrokerVerified)
        #expect(valid.managedGitHubBrokerOrigin?.absoluteString == "https://neondiff-license.fly.dev")

        for invalid in [
            [
                "NeonDiffPaidBetaContract": "paid-mac-beta-v1",
                "NeonDiffManagedGitHubBrokerEnabled": true,
                "NeonDiffGitHubBrokerOrigin": "http://neondiff-license.fly.dev"
            ],
            [
                "NeonDiffPaidBetaContract": "paid-mac-beta-v1",
                "NeonDiffManagedGitHubBrokerEnabled": true,
                "NeonDiffGitHubBrokerOrigin": "https://example.com"
            ],
            [
                "NeonDiffPaidBetaContract": "paid-mac-beta-v1",
                "NeonDiffManagedGitHubBrokerEnabled": false,
                "NeonDiffGitHubBrokerOrigin": "https://neondiff-license.fly.dev"
            ]
        ] {
            #expect(!DesktopProductionBoundary.resolve(infoDictionary: invalid).nativeActivationBrokerVerified)
        }
    }

    @Test func managedConnectUsesBrokerAndKeychainIdentityWithoutLegacyUserTokenFallback() async throws {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electric/private", visibility: .private),
            GitHubBrokerRepository(fullName: "electric/public", visibility: .public)
        ])
        let authenticator = ScriptedGitHubAuthenticator()
        let fixture = ModelDependencyFixture(
            githubAuthenticator: authenticator,
            githubBroker: broker,
            productionBoundary: .testManaged
        )

        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()

        #expect(broker.registeredDeviceIds.count == 1)
        #expect(broker.startedDeviceIds == broker.registeredDeviceIds)
        #expect(broker.completedStates == ["fixture-state"])
        #expect(broker.listedInstallationIds == [42])
        #expect(authenticator.requestedClientIds.isEmpty)
        #expect(authenticator.fetchedAccessTokens.isEmpty)
        #expect(fixture.urlOpener.urls == [broker.connection.installURL])
        #expect(fixture.model.managedGitHubConnectionState == .bound(installationId: 42))
        #expect(fixture.model.managedGitHubRepositories.map(\.fullName) == [
            "electric/private",
            "electric/public"
        ])
        #expect(fixture.secretStore.containsSecret(account: GitHubBrokerDeviceIdentityStore.defaultAccount))
    }

    @Test func authoritativeVisibilityControlsPublicFreeAndPrivateActivationEntry() async {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electric/private", visibility: .private),
            GitHubBrokerRepository(fullName: "electric/public", visibility: .public),
            GitHubBrokerRepository(fullName: "electric/unknown", visibility: .unknown)
        ])
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            productionBoundary: .testManaged
        )
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()

        fixture.model.selectManagedGitHubRepository(fullName: "electric/public")
        #expect(fixture.model.selectedManagedGitHubRepository == "electric/public")
        #expect(fixture.model.onboardingFlow.mode == .publicReposOnly)
        #expect(fixture.model.activationState == .publicFreeSkip)
        #expect(fixture.model.onboardingFlow.licenseActivation == .activated)
        #expect(fixture.model.canAdvanceOnboarding)
        #expect(fixture.model.productionUsefulWorkAvailable)

        fixture.model.selectManagedGitHubRepository(fullName: "electric/private")
        #expect(fixture.model.selectedManagedGitHubRepository == "electric/private")
        #expect(fixture.model.onboardingFlow.mode == .privateRepos)
        #expect(fixture.model.activationState == .purchaseRequired)
        #expect(fixture.model.onboardingFlow.licenseActivation == .servicePending)
        #expect(!fixture.model.productionUsefulWorkAvailable)

        fixture.model.selectManagedGitHubRepository(fullName: "electric/unknown")
        #expect(fixture.model.selectedManagedGitHubRepository == "electric/private")
        #expect(fixture.model.lastError?.contains("visibility") == true)
    }

    @Test func missingOrUnavailableBrokerFailsClosedWithoutCreatingIdentity() async {
        let missingFixture = ModelDependencyFixture(productionBoundary: .testManaged)
        missingFixture.model.startManagedGitHubConnection()
        #expect(missingFixture.model.managedGitHubConnectionState == .quarantined)
        #expect(!missingFixture.secretStore.containsSecret(account: GitHubBrokerDeviceIdentityStore.defaultAccount))

        let unavailable = ScriptedGitHubBroker(error: .server(reason: .brokerUnavailable))
        let unavailableFixture = ModelDependencyFixture(
            githubBroker: unavailable,
            productionBoundary: .testManaged
        )
        unavailableFixture.model.startManagedGitHubConnection()
        await unavailableFixture.waitForManagedGitHubConnectionToFinish()

        #expect(unavailableFixture.model.managedGitHubConnectionState == .failed)
        #expect(unavailableFixture.model.managedGitHubRecovery?.action == .retryLater)
        #expect(unavailableFixture.model.managedGitHubRepositories.isEmpty)
    }

    @Test func recordedInstallationIsOnlyRoutingHintUntilServerReadbackPasses() async {
        let broker = ScriptedGitHubBroker()
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            preferenceStrings: ["neondiff.managedGitHubInstallationId": "42"],
            productionBoundary: .testManaged
        )

        #expect(fixture.model.managedGitHubConnectionState == .verificationRequired)
        #expect(!fixture.model.canAdvanceOnboarding)

        fixture.model.refreshManagedGitHubRepositories()
        await fixture.waitForManagedGitHubConnectionToFinish()

        #expect(broker.listedInstallationIds == [42])
        #expect(fixture.model.managedGitHubConnectionState == .bound(installationId: 42))
    }

    @Test func lostBindingRevokesOnboardingAdvanceAndCompletion() async {
        let broker = ScriptedGitHubBroker()
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            productionBoundary: .testManaged
        )
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: "electric/public")
        fixture.model.onboardingFlow.currentStep = .done
        fixture.model.managedGitHubConnectionState = .failed

        #expect(!fixture.model.canAdvanceOnboarding)
        fixture.model.completeOnboarding()
        #expect(fixture.model.isOnboardingPresented)
        #expect(!fixture.preferences.bool(forKey: "neondiff.hasCompletedActivationOnboarding.v2"))
    }

    @Test func managedModeRejectsManualOrUnboundAllowlistMutation() async {
        let broker = ScriptedGitHubBroker()
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            productionBoundary: .testManaged
        )
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()

        fixture.model.pendingRepoName = "attacker/spoofed-public"
        fixture.model.addPendingRepoToAllowlist()
        #expect(!fixture.model.repos.contains { $0.name == "attacker/spoofed-public" })

        fixture.model.selectManagedGitHubRepository(fullName: "electric/public")
        let selected = fixture.model.repos.first { $0.name == "electric/public" }!
        fixture.model.toggleRepoAllowlist(selected)
        #expect(fixture.model.repos.first { $0.name == "electric/public" }?.enabled == true)
    }

    @Test func activePrivateReadinessCannotCrossRepositoryBoundary() async {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electric/private-a", visibility: .private),
            GitHubBrokerRepository(fullName: "electric/private-b", visibility: .private)
        ])
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            productionBoundary: .testManaged
        )
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: "electric/private-a")
        fixture.model.activationState = .active
        fixture.preferences.set(
            "electric/private-a",
            forKey: "neondiff.activationRepository.v1"
        )

        fixture.model.selectManagedGitHubRepository(fullName: "electric/private-b")

        #expect(fixture.model.activationState == .purchaseRequired)
        #expect(fixture.model.onboardingFlow.licenseActivation == .servicePending)
    }

    @Test func successfulPrivateActivationPinsExactBrokerRepository() async {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electric/private-a", visibility: .private)
        ])
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            activationLicenseClient: ActiveManagedActivationClient(),
            productionBoundary: .testManaged
        )
        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: "electric/private-a")
        fixture.model.pendingActivationKey = "NDL-FIXTURE-0123456789"
        fixture.model.provideExistingActivationKey()
        await fixture.model.submitActivation()

        #expect(fixture.model.activationState == .active)
        #expect(
            fixture.preferences.string(forKey: "neondiff.activationRepository.v1")
                == "electric/private-a"
        )
        #expect(fixture.model.productionUsefulWorkAvailable)
    }

    @Test func persistedPrivateActivationCannotUnlockUsefulWorkWithoutCurrentAPIVerification() async {
        let broker = ScriptedGitHubBroker(repositories: [
            GitHubBrokerRepository(fullName: "electric/private-a", visibility: .private)
        ])
        let fixture = ModelDependencyFixture(
            githubBroker: broker,
            preferenceBools: [
                "neondiff.hasCompletedActivationOnboarding.v2": true
            ],
            preferenceStrings: [
                "neondiff.activationState.v1": ActivationState.active.rawValue,
                "neondiff.activationRepository.v1": "electric/private-a"
            ],
            productionBoundary: .testManaged
        )

        fixture.model.startManagedGitHubConnection()
        await fixture.waitForManagedGitHubConnectionToFinish()
        fixture.model.selectManagedGitHubRepository(fullName: "electric/private-a")

        #expect(!fixture.model.productionUsefulWorkAvailable)
        fixture.model.startDaemon()
        for _ in 0..<10 {
            await Task.yield()
        }
        #expect(fixture.cli.calls.isEmpty)
    }
}
