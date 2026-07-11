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
            productionBoundary: .quarantined
        ))
    }
}
