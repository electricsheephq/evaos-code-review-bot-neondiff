import Foundation

@MainActor
final class NeonUpdateController: ObservableObject {
    @Published private(set) var lastAction = "Updates blocked pending native activation proof"

    init(bundle: Bundle = .main) {
        _ = bundle
    }

    var isConfigured: Bool {
        false
    }

    var canCheckForUpdates: Bool {
        false
    }

    var badgeText: String {
        "UPDATES BLOCKED"
    }

    var statusText: String {
        "Sparkle startup and manual checks are disabled until the native app proves API-backed activation and update entitlement."
    }

    func checkForUpdates() {
        lastAction = "Updates blocked pending native activation proof"
    }
}
