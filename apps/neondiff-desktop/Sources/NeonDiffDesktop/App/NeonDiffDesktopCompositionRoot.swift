import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
enum NeonDiffDesktopCompositionRoot {
    static func makeModel() -> NeonDiffDesktopModel {
        #if DEBUG
        if ProcessInfo.processInfo.environment[
            "NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE"
        ] == "provider-verification" {
            let model = NeonDiffDesktopModel(
                dependencies: VisualProofDesktopDependencies.make()
            )
            model.applyProviderVerificationVisualProofFixture()
            return model
        }
        #endif

        let keychain = KeychainSecretStore()
        var productionBoundary = DesktopProductionBoundary.resolve(
            infoDictionary: Bundle.main.infoDictionary ?? [:]
        )
        let githubBroker = productionBoundary.managedGitHubBrokerOrigin.flatMap {
            try? GitHubBrokerClient(baseURL: $0)
        }
        let accountLink = productionBoundary.accountLinkBrokerOrigin.flatMap { origin in
            productionBoundary.accountConnectURL.flatMap { connectURL in
                try? GitHubBrokerClient(
                    baseURL: origin,
                    accountConnectURL: connectURL
                )
            }
        }
        if productionBoundary.managedGitHubBrokerOrigin != nil, githubBroker == nil {
            productionBoundary = .quarantined
        }
        let cliWorkingDirectory = NeonDiffCLIResolver.defaultWorkingDirectory()
        let localBotSnapshot =
            LaunchAgentLocalBotConfigurationDiscovery.discoverSnapshot()
        let localBotConfigurations = localBotSnapshot.configurations
        let localBotExecutionContexts = localBotSnapshot.executionContexts
        let localBotExecutionContextProvider:
            @Sendable () -> [DesktopLocalBotExecutionContext] = {
                LaunchAgentLocalBotConfigurationDiscovery
                    .discoverExecutionContexts()
            }
        let localBotDiscoveryProvider:
            @Sendable (String) -> DesktopLocalBotDiscoverySnapshot = {
                label in
                let snapshot =
                    LaunchAgentLocalBotConfigurationDiscovery
                        .discoverSnapshot(label: label)
                return DesktopLocalBotDiscoverySnapshot(
                    configurations: snapshot.configurations,
                    executionContexts: snapshot.executionContexts
                )
            }
        let keychainWorkerLaunchAgentManager:
            any DesktopKeychainWorkerLaunchAgentManaging
        if let appExecutableURL = Bundle.main.executableURL {
            keychainWorkerLaunchAgentManager =
                FoundationKeychainWorkerLaunchAgentManager(
                    appExecutableURL: appExecutableURL,
                    executionContextProvider: { label in
                        LaunchAgentLocalBotConfigurationDiscovery
                            .discoverExecutionContexts(label: label)
                    }
                )
        } else {
            keychainWorkerLaunchAgentManager =
                UnavailableDesktopKeychainWorkerLaunchAgentManager()
        }
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: AppKitClipboard(),
            urlOpener: AppKitURLOpener(),
            cli: FoundationDesktopCLIExecutor(
                localBotConfigurations: localBotConfigurations,
                localBotExecutionContexts: localBotExecutionContexts,
                localBotExecutionContextProvider:
                    localBotExecutionContextProvider,
                defaultWorkingDirectory: cliWorkingDirectory
            ),
            dashboard: FoundationDesktopDashboardLauncher(),
            preferences: UserDefaultsDesktopPreferences(.standard),
            clock: ContinuousDesktopClock(),
            fileWriter: ApplicationSupportFileWriter(),
            providerVerifier: FoundationProviderVerifier(secretStore: keychain),
            secretStore: keychain,
            githubAuthenticator: GitHubDeviceAuthClient(),
            githubBroker: githubBroker,
            accountLink: accountLink,
            productionBoundary: productionBoundary,
            localWorkerUpdateGuideURL: DesktopReleaseRouting.localWorkerUpdateGuideURL(
                shortVersion: Bundle.main.object(
                    forInfoDictionaryKey: "CFBundleShortVersionString"
                ) as? String
            ),
            cliWorkingDirectory: cliWorkingDirectory,
            localBotConfigurations: localBotConfigurations,
            localBotExecutionContexts: localBotExecutionContexts,
            localBotExecutionConfigPaths: localBotExecutionContexts.map(
                \.configPath
            ),
            localBotDiscoveryProvider: localBotDiscoveryProvider,
            keychainWorkerLaunchAgentManager:
                keychainWorkerLaunchAgentManager
        ))
        model.localWorkerExecutionContextProvider =
            localBotExecutionContextProvider
        return model
    }
}
