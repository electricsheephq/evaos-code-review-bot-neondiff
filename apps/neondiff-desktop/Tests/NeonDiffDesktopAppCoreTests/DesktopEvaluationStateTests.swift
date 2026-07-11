import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite("Desktop evaluation state")
struct DesktopEvaluationStateTests {
    @Test func reappliesRequestedContentSizeAfterSwiftUIWindowDrift() {
        let requested = DesktopWindowContentSize(width: 1280, height: 800)
        #expect(DesktopWindowGeometryPolicy.shouldApply(
            current: DesktopWindowContentSize(width: 1280, height: 768),
            requested: requested
        ))
        #expect(!DesktopWindowGeometryPolicy.shouldApply(current: requested, requested: requested))
        #expect(DesktopWindowGeometryPolicy.targetFrameSize(
            requestedContent: requested,
            currentFrame: DesktopWindowContentSize(width: 1280, height: 800),
            currentContent: DesktopWindowContentSize(width: 1280, height: 768)
        ) == DesktopWindowContentSize(width: 1280, height: 832))
        #expect(DesktopWindowGeometryPolicy.targetFrameSize(
            requestedContent: DesktopWindowContentSize(width: 760, height: 560),
            currentFrame: DesktopWindowContentSize(width: 1040, height: 680),
            currentContent: DesktopWindowContentSize(width: 1040, height: 648)
        ) == DesktopWindowContentSize(width: 760, height: 592))
        #expect(DesktopWindowGeometryPolicy.minimumContentSize(requested: nil)
            == DesktopWindowContentSize(width: 1040, height: 680))
        #expect(DesktopWindowGeometryPolicy.minimumContentSize(
            requested: DesktopWindowContentSize(width: 760, height: 560)
        ) == DesktopWindowContentSize(width: 760, height: 560))
    }

    @Test func appliesASettledProviderFixtureWithoutLiveDependencies() {
        let dependencies = RecordingDesktopDependencies(
            root: fixtureURL("/fixture/evaluation", directory: true)
        )
        let model = NeonDiffDesktopModel(dependencies: dependencies.dependencies)
        let providers = ProviderSettings(
            providerKeyStored: true,
            selectedProviderId: "fixture-provider",
            registryTargets: [
                ProviderRegistryTarget(
                    id: "fixture-provider",
                    displayName: "Fixture Provider",
                    enabled: true,
                    adapter: "openai-compatible",
                    authMode: "api-key-env",
                    baseUrl: "https://provider.invalid/v1",
                    model: "fixture-model"
                )
            ]
        )
        let state = DesktopModelInitialState(
            selectedSection: .providers,
            configPath: "fixture/config.local.json",
            cliPath: "neondiff",
            status: DaemonStatus(
                ok: true,
                runtimeOk: true,
                healthState: "healthy",
                checkedAt: "2026-07-10T12:00:00Z",
                monitoredRepos: ["fixture/repository"],
                launchdLabel: "fixture.neondiff",
                lastCommand: "fixture status"
            ),
            repos: [RepoMonitor(name: "fixture/repository", enabled: true)],
            providers: providers,
            license: LicenseStatus(entitlement: "public repositories"),
            github: GitHubConnectionStatus(installationState: "connected", authorizedUserLogin: "fixture-user", discoveredRepositoryCount: 1),
            githubAuthorizationStatus: "connected as fixture-user",
            logText: "Fixture log: settled.",
            onboardingFlow: OnboardingFlow(currentStep: .done, providerKeyStored: true, daemonBootstrapChecked: true),
            isOnboardingPresented: false,
            providerVerification: ProviderVerificationSnapshot(
                ok: true,
                command: "providers verify",
                providerId: "fixture-provider",
                checkedAt: "2026-07-10T12:00:00Z",
                state: .healthy,
                mode: "metadata_only",
                detail: "Fixture metadata verified.",
                troubleshooting: [],
                configRevision: String(repeating: "a", count: 64)
            ),
            providerVerificationStatus: "Verified from deterministic fixture metadata."
        )

        model.applyInitialState(state)

        #expect(model.selectedSection == .providers)
        #expect(model.status.healthState == "healthy")
        #expect(model.repos.map(\.name) == ["fixture/repository"])
        #expect(model.providerVerification?.providerId == "fixture-provider")
        #expect(model.githubAuthorizationStatus == "connected as fixture-user")
        #expect(model.canVerifyProviderKey)
        #expect(!model.isOnboardingPresented)
        #expect(dependencies.cli.calls.isEmpty)
        #expect(dependencies.providerVerifier.calls.isEmpty)
        #expect(dependencies.secretStore.mutations.isEmpty)
    }
}
