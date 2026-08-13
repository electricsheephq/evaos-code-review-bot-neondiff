import Foundation
import NeonDiffDesktopCore

package struct DesktopProductionBoundary: Sendable {
    package let nativeActivationBrokerVerified: Bool
    package let byoGitHubEnabled: Bool
    package let managedGitHubBrokerOrigin: URL?
    package let managedGitHubAppClientID: String?
    package let accountLinkBrokerOrigin: URL?
    package let accountConnectURL: URL?

    package static let quarantined = DesktopProductionBoundary(
        nativeActivationBrokerVerified: false,
        byoGitHubEnabled: false,
        managedGitHubBrokerOrigin: nil,
        managedGitHubAppClientID: nil,
        accountLinkBrokerOrigin: nil,
        accountConnectURL: nil
    )
    package static let testVerified = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        byoGitHubEnabled: false,
        managedGitHubBrokerOrigin: nil,
        managedGitHubAppClientID: nil,
        accountLinkBrokerOrigin: nil,
        accountConnectURL: nil
    )
    package static let testManaged = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        byoGitHubEnabled: false,
        managedGitHubBrokerOrigin: approvedManagedGitHubBrokerOrigin,
        managedGitHubAppClientID: "fixture-client-id",
        accountLinkBrokerOrigin: nil,
        accountConnectURL: nil
    )
    package static let testAccountLink = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        byoGitHubEnabled: true,
        managedGitHubBrokerOrigin: nil,
        managedGitHubAppClientID: nil,
        accountLinkBrokerOrigin: approvedAccountLinkBrokerOrigin,
        accountConnectURL: approvedAccountConnectURL
    )
    package static let testManagedAccountLink = DesktopProductionBoundary(
        nativeActivationBrokerVerified: true,
        byoGitHubEnabled: false,
        managedGitHubBrokerOrigin: approvedManagedGitHubBrokerOrigin,
        managedGitHubAppClientID: "fixture-client-id",
        accountLinkBrokerOrigin: approvedAccountLinkBrokerOrigin,
        accountConnectURL: approvedAccountConnectURL
    )

    package static func resolve(infoDictionary: [String: Any]) -> DesktopProductionBoundary {
        let contract = infoDictionary["NeonDiffPaidBetaContract"] as? String
        if contract == "paid-mac-beta-byo-v1" {
            guard infoDictionary["NeonDiffBYOGitHubEnabled"] as? Bool == true,
                  infoDictionary["NeonDiffManagedGitHubBrokerEnabled"] == nil,
                  infoDictionary["NeonDiffGitHubBrokerOrigin"] == nil
            else {
                return .quarantined
            }
            return DesktopProductionBoundary(
                nativeActivationBrokerVerified: true,
                byoGitHubEnabled: true,
                managedGitHubBrokerOrigin: nil,
                managedGitHubAppClientID: nil,
                accountLinkBrokerOrigin: approvedAccountLinkBrokerOrigin,
                accountConnectURL: approvedAccountConnectURL
            )
        }

        guard contract == "paid-mac-beta-v1",
              infoDictionary["NeonDiffBYOGitHubEnabled"] == nil,
              infoDictionary["NeonDiffManagedGitHubBrokerEnabled"] as? Bool == true,
              let originText = infoDictionary["NeonDiffGitHubBrokerOrigin"] as? String,
              let origin = URL(string: originText),
              origin == approvedManagedGitHubBrokerOrigin else {
            return .quarantined
        }
        return DesktopProductionBoundary(
            nativeActivationBrokerVerified: true,
            byoGitHubEnabled: false,
            managedGitHubBrokerOrigin: origin,
            managedGitHubAppClientID: approvedManagedGitHubAppClientID,
            accountLinkBrokerOrigin: approvedAccountLinkBrokerOrigin,
            accountConnectURL: approvedAccountConnectURL
        )
    }
}

private let approvedManagedGitHubBrokerOrigin = URL(
    string: "https://neondiff-license.fly.dev"
)!
private let approvedManagedGitHubAppClientID = "Iv23liNr6jOVuCFC7DkN"
private let approvedAccountLinkBrokerOrigin = URL(
    string: "https://neondiff-license.fly.dev"
)!
private let approvedAccountConnectURL = URL(
    string: "https://www.neondiff.com/desktop/connect"
)!

package enum DesktopReleaseRouting {
    private static let releasesURL = URL(
        string: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/releases"
    )!
    package static let activationCheckoutURL = URL(
        string: "https://www.neondiff.com/#pricing"
    )!

    package static func localWorkerUpdateGuideURL(shortVersion: String?) -> URL {
        guard let shortVersion else { return releasesURL }
        let version = shortVersion.trimmingCharacters(in: .whitespacesAndNewlines)
        let semverPattern = #"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$"#
        guard version.range(of: semverPattern, options: .regularExpression) != nil else {
            return releasesURL
        }
        return releasesURL
            .appendingPathComponent("tag", isDirectory: false)
            .appendingPathComponent("v\(version)", isDirectory: false)
    }
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
    package let githubBroker: (any GitHubBrokerConnecting)?
    package let accountLink: (any NeonDiffAccountLinkConnecting)?
    package let productionBoundary: DesktopProductionBoundary
    package let localWorkerUpdateGuideURL: URL
    package let cliWorkingDirectory: URL?
    package let localBotConfigurations: [DesktopLocalBotConfiguration]
    package let localBotExecutionContexts: [DesktopLocalBotExecutionContext]
    package let localBotExecutionConfigPaths: [String]

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
        accountLink: (any NeonDiffAccountLinkConnecting)? = nil,
        productionBoundary: DesktopProductionBoundary,
        localWorkerUpdateGuideURL: URL = DesktopReleaseRouting.localWorkerUpdateGuideURL(
            shortVersion: nil
        ),
        cliWorkingDirectory: URL? = nil,
        localBotConfigurations: [DesktopLocalBotConfiguration] = [],
        localBotExecutionContexts: [DesktopLocalBotExecutionContext] = [],
        localBotExecutionConfigPaths: [String] = []
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
        self.accountLink = accountLink
        self.productionBoundary = productionBoundary
        self.localWorkerUpdateGuideURL = localWorkerUpdateGuideURL
        self.cliWorkingDirectory = cliWorkingDirectory
        self.localBotConfigurations = localBotConfigurations
        self.localBotExecutionContexts = localBotExecutionContexts
        self.localBotExecutionConfigPaths = localBotExecutionConfigPaths
    }
}
