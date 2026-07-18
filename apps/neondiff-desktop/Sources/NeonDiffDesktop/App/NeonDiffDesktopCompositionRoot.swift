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
        if productionBoundary.managedGitHubBrokerOrigin != nil, githubBroker == nil {
            productionBoundary = .quarantined
        }
        return NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: AppKitClipboard(),
            urlOpener: AppKitURLOpener(),
            cli: FoundationDesktopCLIExecutor(),
            dashboard: FoundationDesktopDashboardLauncher(),
            preferences: UserDefaultsDesktopPreferences(.standard),
            clock: ContinuousDesktopClock(),
            fileWriter: ApplicationSupportFileWriter(),
            providerVerifier: FoundationProviderVerifier(secretStore: keychain),
            secretStore: keychain,
            githubAuthenticator: GitHubDeviceAuthClient(),
            githubBroker: githubBroker,
            productionBoundary: productionBoundary,
            cliWorkingDirectory: NeonDiffCLIResolver.defaultWorkingDirectory()
        ))
    }
}
