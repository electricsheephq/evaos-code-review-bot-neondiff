import Combine
import Foundation
import NeonDiffDesktopAppCore
import Sparkle

@MainActor
final class NeonUpdateController: NSObject, ObservableObject, SPUUpdaterDelegate {
    @Published private(set) var lastAction: String

    private let bundle: Bundle
    private let model: NeonDiffDesktopModel
    private var updaterController: SPUStandardUpdaterController?
    private var modelObservation: AnyCancellable?
    private var runtimeStatus: RuntimeStatus

    init(bundle: Bundle = .main, model: NeonDiffDesktopModel) {
        self.bundle = bundle
        self.model = model
        if Self.hasSignedFeedConfiguration(bundle: bundle) {
            runtimeStatus = .blocked(model.desktopUpdateAccess.customerMessage)
            lastAction = "Ready to verify update access"
        } else {
            runtimeStatus = .notConfigured
            lastAction = "Signed update feed is not configured in this build"
        }
        super.init()

        modelObservation = model.objectWillChange.sink { [weak self] _ in
            DispatchQueue.main.async {
                self?.modelDidChange()
            }
        }
        modelDidChange()
    }

    var isConfigured: Bool {
        Self.hasSignedFeedConfiguration(bundle: bundle)
    }

    var canCheckForUpdates: Bool {
        guard isConfigured,
              model.desktopUpdateAccess.allowedChannel != nil
        else {
            return false
        }
        return updaterController?.updater.canCheckForUpdates ?? false
    }

    var badgeText: String {
        switch runtimeStatus {
        case .notConfigured: "NOT CONFIGURED"
        case .blocked: "ENTITLEMENT REQUIRED"
        case .ready: "READY"
        case .checking: "CHECKING"
        case .updateAvailable: "UPDATE AVAILABLE"
        case .upToDate: "UP TO DATE"
        case .networkError: "NETWORK ERROR"
        case .signatureError: "SIGNATURE ERROR"
        case .failed: "UPDATE ERROR"
        }
    }

    var statusText: String {
        switch runtimeStatus {
        case .notConfigured:
            "This build has no signed NeonDiff update feed."
        case .blocked(let reason):
            reason
        case .ready:
            "Signed beta updates are enabled for this verified account."
        case .checking:
            "Checking the signed NeonDiff beta feed."
        case .updateAvailable:
            "A signed NeonDiff update is available."
        case .upToDate:
            "This Mac has the newest eligible NeonDiff beta."
        case .networkError:
            "NeonDiff could not reach the update feed. Check your connection and try again."
        case .signatureError:
            "The downloaded update failed signature verification and was not installed."
        case .failed(let message):
            message
        }
    }

    func checkForUpdates() {
        startUpdaterIfEligible()
        guard isConfigured else {
            runtimeStatus = .notConfigured
            lastAction = "Signed update feed is not configured in this build"
            objectWillChange.send()
            return
        }
        guard case .allowed = model.desktopUpdateAccess else {
            runtimeStatus = .blocked(model.desktopUpdateAccess.customerMessage)
            lastAction = "Update check blocked until entitlement is verified"
            objectWillChange.send()
            return
        }
        guard let updaterController, updaterController.updater.canCheckForUpdates else {
            lastAction = "The updater is busy; try again in a moment"
            objectWillChange.send()
            return
        }

        runtimeStatus = .checking
        lastAction = "Checking for signed updates"
        objectWillChange.send()
        updaterController.checkForUpdates(nil)
    }

    func updater(
        _ updater: SPUUpdater,
        mayPerform updateCheck: SPUUpdateCheck
    ) throws {
        guard case .allowed = model.desktopUpdateAccess else {
            let message = model.desktopUpdateAccess.customerMessage
            runtimeStatus = .blocked(message)
            lastAction = "Update check blocked until entitlement is verified"
            objectWillChange.send()
            throw NSError(
                domain: "com.electricsheephq.NeonDiffDesktop.UpdateAccess",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
    }

    func allowedChannels(for updater: SPUUpdater) -> Set<String> {
        guard let channel = model.desktopUpdateAccess.allowedChannel else {
            return []
        }
        return [channel.rawValue]
    }

    func updater(
        _ updater: SPUUpdater,
        shouldProceedWithUpdate updateItem: SUAppcastItem,
        updateCheck: SPUUpdateCheck
    ) throws {
        guard case .allowed = model.desktopUpdateAccess else {
            let message = model.desktopUpdateAccess.customerMessage
            runtimeStatus = .blocked(message)
            lastAction = "Update download blocked until entitlement is verified"
            objectWillChange.send()
            throw NSError(
                domain: "com.electricsheephq.NeonDiffDesktop.UpdateAccess",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: message]
            )
        }
    }

    func updater(_ updater: SPUUpdater, didFindValidUpdate item: SUAppcastItem) {
        runtimeStatus = .updateAvailable
        lastAction = "Signed update available"
        objectWillChange.send()
    }

    func updaterDidNotFindUpdate(_ updater: SPUUpdater, error: Error) {
        runtimeStatus = .upToDate
        lastAction = "NeonDiff is up to date"
        objectWillChange.send()
    }

    func updater(
        _ updater: SPUUpdater,
        didFinishUpdateCycleFor updateCheck: SPUUpdateCheck,
        error: Error?
    ) {
        guard let error = error as NSError? else { return }
        switch DesktopUpdateCycleResult.classify(sparkleErrorCode: error.code) {
        case .noUpdate:
            runtimeStatus = .upToDate
            lastAction = "NeonDiff is up to date"
        case .signatureError:
            runtimeStatus = .signatureError
            lastAction = "Update rejected: signature verification failed"
        case .networkError:
            runtimeStatus = .networkError
            lastAction = "Update check failed: feed unavailable"
        case .cancelled:
            runtimeStatus = .ready
            lastAction = "Update cancelled"
        case .failed:
            runtimeStatus = .failed("The update could not be completed. Try again or contact support.")
            lastAction = "Update failed safely"
        }
        objectWillChange.send()
    }

    private func modelDidChange() {
        guard isConfigured else {
            runtimeStatus = .notConfigured
            objectWillChange.send()
            return
        }

        switch model.desktopUpdateAccess {
        case .allowed:
            startUpdaterIfEligible()
            if case .blocked = runtimeStatus {
                runtimeStatus = .ready
                lastAction = "Ready to check for signed updates"
            } else if case .notConfigured = runtimeStatus {
                runtimeStatus = .ready
                lastAction = "Ready to check for signed updates"
            }
        case .blocked(let reason):
            runtimeStatus = .blocked(reason.customerMessage)
            lastAction = "Update access needs verification"
        }
        objectWillChange.send()
    }

    private func startUpdaterIfEligible() {
        guard updaterController == nil,
              isConfigured,
              case .allowed = model.desktopUpdateAccess
        else {
            return
        }

        let controller = SPUStandardUpdaterController(
            startingUpdater: false,
            updaterDelegate: self,
            userDriverDelegate: nil
        )
        controller.startUpdater()
        updaterController = controller
        runtimeStatus = .ready
        lastAction = "Ready to check for signed updates"
    }

    private static func hasSignedFeedConfiguration(bundle: Bundle) -> Bool {
        guard let feed = bundle.object(forInfoDictionaryKey: "SUFeedURL") as? String,
              let feedURL = URL(string: feed),
              feedURL.scheme?.lowercased() == "https",
              feedURL.host?.isEmpty == false,
              let publicKey = bundle.object(forInfoDictionaryKey: "SUPublicEDKey") as? String,
              !publicKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else {
            return false
        }
        return true
    }
}

private enum RuntimeStatus {
    case notConfigured
    case blocked(String)
    case ready
    case checking
    case updateAvailable
    case upToDate
    case networkError
    case signatureError
    case failed(String)
}
