import Foundation
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
enum NeonDiffDesktopCompositionRoot {
    static func makeModel() -> NeonDiffDesktopModel {
        let keychain = KeychainSecretStore()
        let model = NeonDiffDesktopModel(dependencies: DesktopAppDependencies(
            clipboard: AppKitClipboard(),
            urlOpener: AppKitURLOpener(),
            cli: FoundationDesktopCLIExecutor(),
            dashboard: FoundationDesktopDashboardLauncher(),
            preferences: UserDefaultsDesktopPreferences(.standard),
            clock: ContinuousDesktopClock(),
            fileWriter: ApplicationSupportFileWriter(),
            providerVerifier: FoundationProviderVerifier(secretStore: keychain),
            secretStore: keychain,
            githubAuthenticator: GitHubDeviceAuthClient()
        ))
        #if DEBUG
        if ProcessInfo.processInfo.environment[
            "NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE"
        ] == "provider-verification" {
            model.applyProviderVerificationVisualProofFixture()
        }
        #endif
        return model
    }
}
