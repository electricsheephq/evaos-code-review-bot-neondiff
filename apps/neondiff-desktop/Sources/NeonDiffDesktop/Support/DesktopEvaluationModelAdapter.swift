#if DEBUG
import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
enum DesktopEvaluationModelAdapter {
    static func makeModel(context: DesktopResolvedEvaluationLaunchContext) -> NeonDiffDesktopModel {
        let model = NeonDiffDesktopModel(
            dependencies: DesktopEvaluationDependencies.make(fixture: context.fixture)
        )
        model.applyInitialState(state(from: context.fixture))
        return model
    }

    static func state(from fixture: DesktopResolvedEvaluationFixture) -> DesktopModelInitialState {
        let providerSettings = providers(from: fixture)
        let verification = providerVerification(from: fixture, revision: String(repeating: "a", count: 64))
        return DesktopModelInitialState(
            selectedSection: fixture.surface.section,
            configPath: "fixture/config.local.json",
            cliPath: "neondiff",
            status: daemonStatus(from: fixture),
            repos: fixture.state.repositories.map {
                RepoMonitor(name: $0.name, enabled: $0.enabled, profile: $0.profile, lastReview: $0.lastReview)
            },
            providers: providerSettings,
            license: LicenseStatus(
                keyStored: fixture.state.license.credentialPresent,
                entitlement: fixture.state.license.entitlement,
                updateChannel: fixture.state.license.updateChannel
            ),
            github: githubStatus(from: fixture),
            githubAuthorizationStatus: githubAuthorizationStatus(from: fixture),
            logText: fixture.state.logText,
            onboardingFlow: onboardingFlow(from: fixture),
            isOnboardingPresented: fixture.surface.onboardingStep != nil,
            providerVerification: verification,
            providerVerificationStatus: verification.map {
                $0.isVerified ? "Verified from deterministic fixture metadata." : $0.detail
            } ?? "Verify the stored API key when ready.",
            providerConfigurationIsDirty: fixture.state.provider?.verification == "dirty",
            providerVerificationInProgress: fixture.state.provider?.verification == "in_progress"
        )
    }

    nonisolated static func providerVerification(
        from fixture: DesktopResolvedEvaluationFixture,
        revision: String
    ) -> ProviderVerificationSnapshot? {
        guard let provider = fixture.state.provider else { return nil }
        let state: ProviderVerificationState
        let ok: Bool
        switch provider.verification {
        case "healthy":
            state = .healthy
            ok = true
        case "blocked":
            state = .blocked
            ok = false
        default:
            state = .configuredUnverified
            ok = false
        }
        return ProviderVerificationSnapshot(
            ok: ok,
            command: "providers verify",
            providerId: provider.id,
            checkedAt: fixture.environment.clock,
            state: state,
            mode: "metadata_only",
            detail: ok ? "Provider metadata is healthy in this deterministic fixture." : "Provider verification is represented by deterministic fixture metadata.",
            troubleshooting: state == .blocked ? ["Inspect the redacted provider configuration."] : [],
            configRevision: revision
        )
    }

    private static func daemonStatus(from fixture: DesktopResolvedEvaluationFixture) -> DaemonStatus {
        DaemonStatus(
            ok: fixture.state.health == "healthy",
            runtimeOk: fixture.state.runtimeReady,
            healthState: fixture.state.health,
            checkedAt: fixture.environment.clock,
            monitoredRepos: fixture.state.repositories.map(\.name),
            launchdLabel: "fixture.neondiff",
            lastCommand: "neondiff daemon status --config fixture/config.local.json"
        )
    }

    private static func providers(from fixture: DesktopResolvedEvaluationFixture) -> ProviderSettings {
        guard let provider = fixture.state.provider else {
            return ProviderSettings(
                zcodeModel: "fixture-model",
                zcodeCliPath: "fixture-zcode",
                zcodeAppConfigPath: "fixture/zcode/config.json",
                openAICompatibleEndpoint: "https://provider.invalid/v1"
            )
        }
        return ProviderSettings(
            zcodeModel: provider.model,
            zcodeCliPath: "fixture-zcode",
            zcodeAppConfigPath: "fixture/zcode/config.json",
            openAICompatibleEndpoint: provider.baseURL,
            providerKeyStored: provider.credentialPresent,
            selectedProviderId: provider.id,
            registryTargets: [
                ProviderRegistryTarget(
                    id: provider.id,
                    displayName: provider.displayName,
                    enabled: true,
                    adapter: provider.adapter,
                    authMode: provider.authMode,
                    baseUrl: provider.baseURL,
                    model: provider.model
                )
            ]
        )
    }

    private static func githubStatus(from fixture: DesktopResolvedEvaluationFixture) -> GitHubConnectionStatus {
        let connected = fixture.state.github.connection == "connected"
        return GitHubConnectionStatus(
            appIdConfigured: connected,
            clientIdConfigured: fixture.state.github.connection != "disconnected",
            clientId: fixture.state.github.connection == "disconnected" ? nil : "fixture-client-id",
            botLogin: "neondiff-fixture[bot]",
            userTokenStored: connected,
            installationState: fixture.state.github.connection,
            authorizedUserLogin: fixture.state.github.login,
            installationCount: connected ? 1 : 0,
            discoveredRepositoryCount: fixture.state.github.repositoryCount
        )
    }

    private static func onboardingFlow(from fixture: DesktopResolvedEvaluationFixture) -> OnboardingFlow {
        OnboardingFlow(
            currentStep: fixture.surface.onboardingStep ?? .welcome,
            mode: .publicReposOnly,
            providerKeyStored: fixture.state.provider?.credentialPresent == true,
            daemonBootstrapChecked: fixture.state.runtimeReady != nil,
            licenseActivation: fixture.state.license.entitlement == "active private" ? .activated : .servicePending
        )
    }

    private static func githubAuthorizationStatus(from fixture: DesktopResolvedEvaluationFixture) -> String {
        switch fixture.state.github.connection {
        case "connected":
            fixture.state.github.login.map { "connected as \($0)" } ?? "connected"
        case "device_code":
            "device code ready"
        case "recovery":
            "recovery required"
        default:
            "not connected"
        }
    }
}
#endif
