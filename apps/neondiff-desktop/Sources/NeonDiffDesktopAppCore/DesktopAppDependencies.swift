import Foundation
import NeonDiffDesktopCore

package struct DesktopProductionBoundary: Sendable {
    package let nativeActivationBrokerVerified: Bool
    package let managedGitHubBrokerOrigin: URL?
    package let managedGitHubAppClientID: String?

    package static let quarantined = DesktopProductionBoundary(
        nativeActivationBrokerVerified: false,
        managedGitHubBrokerOrigin: nil,
        managedGitHubAppClientID: nil
    )
    package static let testVerified = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        managedGitHubBrokerOrigin: nil,
        managedGitHubAppClientID: nil
    )
    package static let testManaged = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        managedGitHubBrokerOrigin: approvedManagedGitHubBrokerOrigin,
        managedGitHubAppClientID: "fixture-client-id"
    )

    package static func resolve(infoDictionary: [String: Any]) -> DesktopProductionBoundary {
        guard infoDictionary["NeonDiffPaidBetaContract"] as? String == "paid-mac-beta-v1",
              infoDictionary["NeonDiffManagedGitHubBrokerEnabled"] as? Bool == true,
              let originText = infoDictionary["NeonDiffGitHubBrokerOrigin"] as? String,
              let origin = URL(string: originText),
              origin == approvedManagedGitHubBrokerOrigin
        else {
            return .quarantined
        }
        return DesktopProductionBoundary(
            nativeActivationBrokerVerified: true,
            managedGitHubBrokerOrigin: origin,
            managedGitHubAppClientID: approvedManagedGitHubAppClientID
        )
    }
}

private let approvedManagedGitHubBrokerOrigin = URL(
    string: "https://neondiff-license.fly.dev"
)!
private let approvedManagedGitHubAppClientID = "Iv23liNr6jOVuCFC7DkN"

package struct DesktopAppDependencies {
    package let clipboard: any DesktopClipboard
    package let urlOpener: any DesktopURLOpener
    package let cli: any DesktopCLIExecuting
    package let dashboard: any DesktopDashboardLaunching
    package let preferences: any DesktopPreferences
    package let clock: any DesktopClock
    package let fileWriter: any DesktopFileWriting
    package let providerVerifier: any DesktopProviderVerifying
    package let secretStore: any DesktopSecretStoring
    package let githubAuthenticator: any GitHubDesktopAuthenticating
    package let githubBroker: (any GitHubBrokerConnecting)?
    package let productionBoundary: DesktopProductionBoundary
    package let cliWorkingDirectory: URL?

    package init(
        clipboard: any DesktopClipboard,
        urlOpener: any DesktopURLOpener,
        cli: any DesktopCLIExecuting,
        dashboard: any DesktopDashboardLaunching,
        preferences: any DesktopPreferences,
        clock: any DesktopClock,
        fileWriter: any DesktopFileWriting,
        providerVerifier: any DesktopProviderVerifying,
        secretStore: any DesktopSecretStoring,
        githubAuthenticator: any GitHubDesktopAuthenticating,
        githubBroker: (any GitHubBrokerConnecting)? = nil,
        productionBoundary: DesktopProductionBoundary,
        cliWorkingDirectory: URL? = nil
    ) {
        self.clipboard = clipboard
        self.urlOpener = urlOpener
        self.cli = cli
        self.dashboard = dashboard
        self.preferences = preferences
        self.clock = clock
        self.fileWriter = fileWriter
        self.providerVerifier = providerVerifier
        self.secretStore = secretStore
        self.githubAuthenticator = githubAuthenticator
        self.githubBroker = githubBroker
        self.productionBoundary = productionBoundary
        self.cliWorkingDirectory = cliWorkingDirectory
    }
}
