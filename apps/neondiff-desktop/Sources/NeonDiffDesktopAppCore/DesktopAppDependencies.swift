import Foundation
import NeonDiffDesktopCore

package struct DesktopProductionBoundary: Sendable {
    package let nativeActivationBrokerVerified: Bool

    package static let quarantined = DesktopProductionBoundary(nativeActivationBrokerVerified: false)
    package static let testVerified = DesktopProductionBoundary(nativeActivationBrokerVerified: true)
}

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
        self.productionBoundary = productionBoundary
        self.cliWorkingDirectory = cliWorkingDirectory
    }
}
