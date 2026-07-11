import AppKit
import SwiftUI

struct NeonWindowConfigurator: NSViewRepresentable {
    let requestedContentSize: NSSize?
    let disablesAnimations: Bool
#if DEBUG
    let readinessRequest: DesktopEvaluationReadinessRequest?
#endif

#if DEBUG
    init(
        requestedContentSize: NSSize? = nil,
        disablesAnimations: Bool = false,
        readinessRequest: DesktopEvaluationReadinessRequest? = nil
    ) {
        self.requestedContentSize = requestedContentSize
        self.disablesAnimations = disablesAnimations
        self.readinessRequest = readinessRequest
    }
#else
    init(requestedContentSize: NSSize? = nil, disablesAnimations: Bool = false) {
        self.requestedContentSize = requestedContentSize
        self.disablesAnimations = disablesAnimations
    }
#endif

    func makeCoordinator() -> Coordinator { Coordinator() }

    func makeNSView(context: Context) -> NSView {
        let view = NSView(frame: .zero)
        view.isHidden = true
        DispatchQueue.main.async {
            configure(window: view.window, coordinator: context.coordinator)
        }
        return view
    }

    func updateNSView(_ nsView: NSView, context: Context) {
        DispatchQueue.main.async {
            configure(window: nsView.window, coordinator: context.coordinator)
        }
    }

    private func configure(window: NSWindow?, coordinator: Coordinator) {
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
        if let requestedContentSize,
           coordinator.configuredWindowNumber != window.windowNumber {
            if disablesAnimations {
                window.animationBehavior = .none
            }
            window.setContentSize(requestedContentSize)
            if let visibleFrame = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
                window.setFrameOrigin(NSPoint(
                    x: visibleFrame.minX + 80,
                    y: visibleFrame.maxY - window.frame.height - 80
                ))
            }
            coordinator.configuredWindowNumber = window.windowNumber
        }
#if DEBUG
        if readinessRequest != nil {
            window.isRestorable = false
        }
#endif
        paintNativeTitlebar(in: window)
#if DEBUG
        scheduleReadinessSample(window: window, coordinator: coordinator)
#endif
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

    final class Coordinator {
        var configuredWindowNumber: Int?
#if DEBUG
        var readinessSampling = false
        var readinessEmitted = false
        var lastSample: DesktopEvaluationGeometrySample?
        var stableSampleCount = 0
        var readinessAttemptCount = 0
#endif
    }

#if DEBUG
    private func scheduleReadinessSample(window: NSWindow, coordinator: Coordinator) {
        guard readinessRequest != nil,
              !coordinator.readinessSampling,
              !coordinator.readinessEmitted else { return }
        coordinator.readinessSampling = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
            sampleReadiness(window: window, coordinator: coordinator)
        }
    }

    private func sampleReadiness(window: NSWindow, coordinator: Coordinator) {
        guard let readinessRequest, !coordinator.readinessEmitted else {
            coordinator.readinessSampling = false
            return
        }
        coordinator.readinessAttemptCount += 1
        guard coordinator.readinessAttemptCount < 50 else {
            fatalError("NeonDiff Desktop evaluation surface did not settle within five seconds.")
        }
        guard readinessRequest.renderLatch.isReady else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                sampleReadiness(window: window, coordinator: coordinator)
            }
            return
        }
        let sample = DesktopEvaluationReadinessWriter.sample(window: window)
        if let previous = coordinator.lastSample, sample.approximatelyEquals(previous) {
            coordinator.stableSampleCount += 1
        } else {
            coordinator.stableSampleCount = 1
        }
        coordinator.lastSample = sample
        if coordinator.stableSampleCount >= 3 {
            do {
                try DesktopEvaluationReadinessWriter.write(
                    request: readinessRequest,
                    window: window,
                    sample: sample
                )
                coordinator.readinessEmitted = true
                coordinator.readinessSampling = false
            } catch {
                fatalError("NeonDiff Desktop evaluation readiness failed: \(error.localizedDescription)")
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
            sampleReadiness(window: window, coordinator: coordinator)
        }
    }
#endif
}

private let nativeTitlebarBackgroundIdentifier = NSUserInterfaceItemIdentifier("NeonDiffNativeTitlebarBackground")
private let neonGreen = NSColor(
    calibratedRed: 0.224,
    green: 1.0,
    blue: 0.533,
    alpha: 1.0
)
