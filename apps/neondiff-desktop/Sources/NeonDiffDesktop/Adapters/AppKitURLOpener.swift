import AppKit
import NeonDiffDesktopAppCore

struct AppKitURLOpener: DesktopURLOpener {
    @MainActor func open(_ url: URL) -> Bool {
        NSWorkspace.shared.open(url)
    }
}
