import AppKit
import NeonDiffDesktopAppCore

struct AppKitClipboard: DesktopClipboard {
    @MainActor func write(_ string: String) -> Bool {
        NSPasteboard.general.clearContents()
        return NSPasteboard.general.setString(string, forType: .string)
    }
}
