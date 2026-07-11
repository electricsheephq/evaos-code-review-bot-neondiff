import Foundation
import Sparkle

@MainActor
final class NeonUpdateController: ObservableObject {
    @Published private(set) var lastAction = "Update channel not configured"

    private let controller: SPUStandardUpdaterController?

    init(bundle: Bundle = .main, startsUpdater: Bool = true) {
        guard startsUpdater, Self.hasSparkleConfiguration(in: bundle) else {
            self.controller = nil
            return
        }
        self.controller = SPUStandardUpdaterController(
            startingUpdater: true,
            updaterDelegate: nil,
            userDriverDelegate: nil
        )
        self.lastAction = "Update channel configured"
    }

    var isConfigured: Bool {
        controller != nil
    }

    var canCheckForUpdates: Bool {
        controller?.updater.canCheckForUpdates ?? false
    }

    var badgeText: String {
        isConfigured ? "UPDATES READY" : "UPDATES OFF"
    }

    var statusText: String {
        if isConfigured {
            return canCheckForUpdates ? "Manual update checks are available." : "Sparkle is configured but cannot check right now."
        }
        return "No Sparkle feed/public key is bundled for this dev build."
    }

    func checkForUpdates() {
        guard let controller, canCheckForUpdates else {
            lastAction = "Update channel not configured"
            return
        }
        controller.checkForUpdates(nil)
        lastAction = "Opened Sparkle update check"
    }

    private static func hasSparkleConfiguration(in bundle: Bundle) -> Bool {
        guard
            let feedURL = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
            let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String
        else {
            return false
        }
        return !feedURL.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            && !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}
