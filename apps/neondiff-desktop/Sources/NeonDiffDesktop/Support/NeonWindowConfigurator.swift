import AppKit
import SwiftUI

struct NeonWindowConfigurator: NSViewRepresentable {
    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        view.isHidden = true
        DispatchQueue.main.async {
            configure(window: view.window)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            configure(window: nsView.window)
        }
    }

    private func configure(window: NSWindow?) {
        guard let window else { return }

        window.title = "NeonDiff Desktop"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.isMovableByWindowBackground = true
        window.backgroundColor = NSColor(
            calibratedRed: 0.224,
            green: 1.0,
            blue: 0.533,
            alpha: 1.0
        )
        window.minSize = NSSize(width: 1040, height: 680)
        window.styleMask.insert(.fullSizeContentView)
        window.standardWindowButton(.closeButton)?.isHidden = false
        window.standardWindowButton(.miniaturizeButton)?.isHidden = false
        window.standardWindowButton(.zoomButton)?.isHidden = false
        paintNativeTitlebar(in: window)
    }

    private func paintNativeTitlebar(in window: NSWindow) {
        guard let titlebarView = window.standardWindowButton(.closeButton)?.superview else {
            return
        }

        titlebarView.wantsLayer = true
        titlebarView.layer?.backgroundColor = neonGreen.cgColor

        if !titlebarView.subviews.contains(where: { $0.identifier == nativeTitlebarBackgroundIdentifier }) {
            let background = NSView(frame: titlebarView.bounds)
            background.identifier = nativeTitlebarBackgroundIdentifier
            background.wantsLayer = true
            background.layer?.backgroundColor = neonGreen.cgColor
            background.autoresizingMask = [.width, .height]
            titlebarView.addSubview(background, positioned: .below, relativeTo: nil)
        }
    }
}

private let nativeTitlebarBackgroundIdentifier = NSUserInterfaceItemIdentifier("NeonDiffNativeTitlebarBackground")
private let neonGreen = NSColor(
    calibratedRed: 0.224,
    green: 1.0,
    blue: 0.533,
    alpha: 1.0
)
