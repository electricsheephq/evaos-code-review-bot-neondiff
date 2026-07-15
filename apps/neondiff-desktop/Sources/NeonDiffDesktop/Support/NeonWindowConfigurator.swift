import AppKit
import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct NeonWindowConfigurator: NSViewRepresentable {
    let requestedContentSize: NSSize?
    let disablesAnimations: Bool
#if DEBUG
    let readinessRequest: DesktopEvaluationReadinessRequest?
    let evaluationSection: DesktopSection?
    let surfaceStatus: DesktopEvaluationSurfaceStatus?
#endif

#if DEBUG
    init(
        requestedContentSize: NSSize? = nil,
        disablesAnimations: Bool = false,
        readinessRequest: DesktopEvaluationReadinessRequest? = nil,
        evaluationSection: DesktopSection? = nil,
        surfaceStatus: DesktopEvaluationSurfaceStatus? = nil
    ) {
        self.requestedContentSize = requestedContentSize
        self.disablesAnimations = disablesAnimations
        self.readinessRequest = readinessRequest
        self.evaluationSection = evaluationSection
        self.surfaceStatus = surfaceStatus
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
        window.styleMask.insert(.fullSizeContentView)
        window.standardWindowButton(.closeButton)?.isHidden = false
        window.standardWindowButton(.miniaturizeButton)?.isHidden = false
        window.standardWindowButton(.zoomButton)?.isHidden = false
        if let requestedContentSize {
            let currentContentSize = DesktopWindowContentSize(
                width: window.contentLayoutRect.width,
                height: window.contentLayoutRect.height
            )
            let requestedSize = DesktopWindowContentSize(
                width: requestedContentSize.width,
                height: requestedContentSize.height
            )
            let targetFrameSize = DesktopWindowGeometryPolicy.targetFrameSize(
                requestedContent: requestedSize,
                currentFrame: DesktopWindowContentSize(
                    width: window.frame.width,
                    height: window.frame.height
                ),
                currentContent: currentContentSize
            )
            window.minSize = NSSize(width: targetFrameSize.width, height: targetFrameSize.height)
            if DesktopWindowGeometryPolicy.shouldApply(current: currentContentSize, requested: requestedSize) {
                if disablesAnimations {
                    window.animationBehavior = .none
                }
                window.setFrame(
                    NSRect(
                        origin: window.frame.origin,
                        size: NSSize(width: targetFrameSize.width, height: targetFrameSize.height)
                    ),
                    display: true
                )
            }
        } else {
            window.minSize = NSSize(width: 1040, height: 680)
        }
        if requestedContentSize != nil,
           coordinator.positionedWindowNumber != window.windowNumber {
            if let visibleFrame = window.screen?.visibleFrame ?? NSScreen.main?.visibleFrame {
                window.setFrameOrigin(NSPoint(
                    x: visibleFrame.minX + 80,
                    y: visibleFrame.maxY - window.frame.height - 80
                ))
            }
            coordinator.positionedWindowNumber = window.windowNumber
        }
#if DEBUG
        if let readinessRequest {
            window.isRestorable = false
            window.setAccessibilityIdentifier("neondiff.fixture.\(readinessRequest.fixtureId)")
        }
#endif
        paintNativeTitlebar(in: window)
#if DEBUG
        scheduleReadinessSample(window: window, coordinator: coordinator)
        scheduleSurfaceStateSample(window: window, coordinator: coordinator)
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
        var positionedWindowNumber: Int?
#if DEBUG
        var readinessSampling = false
        var readinessEmitted = false
        var lastSample: DesktopEvaluationGeometrySample?
        var stableSampleCount = 0
        var readinessAttemptCount = 0
        var surfaceSection: DesktopSection?
        var surfaceSamplingToken = 0
        var surfaceLastSample: DesktopHostedGeometrySample?
        var surfaceSamples: [DesktopHostedGeometrySample] = []
        var surfaceSamplingStartedAt: TimeInterval?
        var surfaceAttemptCount = 0
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

    private func scheduleSurfaceStateSample(window: NSWindow, coordinator: Coordinator) {
        guard let surfaceStatus,
              let evaluationSection,
              coordinator.surfaceSection != evaluationSection else {
            return
        }
        coordinator.surfaceSection = evaluationSection
        let generation = surfaceStatus.begin(section: evaluationSection)
        coordinator.surfaceSamplingToken += 1
        coordinator.surfaceLastSample = nil
        coordinator.surfaceSamples = []
        coordinator.surfaceSamplingStartedAt = nil
        coordinator.surfaceAttemptCount = 0
        let token = coordinator.surfaceSamplingToken
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
            sampleSurfaceState(
                window: window,
                section: evaluationSection,
                generation: generation,
                token: token,
                coordinator: coordinator
            )
        }
    }

    private func sampleSurfaceState(
        window: NSWindow,
        section: DesktopSection,
        generation: Int,
        token: Int,
        coordinator: Coordinator
    ) {
        guard let surfaceStatus,
              token == coordinator.surfaceSamplingToken,
              section == coordinator.surfaceSection,
              surfaceStatus.snapshot?.generation == generation else {
            return
        }
        coordinator.surfaceAttemptCount += 1
        guard coordinator.surfaceAttemptCount < 50 else {
            fatalError("NeonDiff Desktop evaluation surface state did not settle within five seconds.")
        }
        guard surfaceStatus.isRendered(section: section, generation: generation) else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                sampleSurfaceState(
                    window: window,
                    section: section,
                    generation: generation,
                    token: token,
                    coordinator: coordinator
                )
            }
            return
        }
        let windowSample = DesktopEvaluationSurfaceStateWriter.sample(window: window)
        let sampledAt = ProcessInfo.processInfo.systemUptime
        guard let rawSample = surfaceStatus.hostedGeometrySample(
            windowSample: windowSample,
            elapsedMilliseconds: 0
        ) else {
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
                sampleSurfaceState(
                    window: window,
                    section: section,
                    generation: generation,
                    token: token,
                    coordinator: coordinator
                )
            }
            return
        }
        if let previous = coordinator.surfaceLastSample,
           let startedAt = coordinator.surfaceSamplingStartedAt,
           rawSample.approximatelyEquals(previous) {
            let elapsed = Int(((sampledAt - startedAt) * 1_000).rounded())
            let priorElapsed = coordinator.surfaceSamples.last?.elapsedMilliseconds ?? 0
            let interval = elapsed - priorElapsed
            if interval >= 90, interval <= 150 {
                coordinator.surfaceSamples.append(
                    rawSample.withElapsedMilliseconds(elapsed)
                )
            } else {
                coordinator.surfaceSamplingStartedAt = sampledAt
                coordinator.surfaceSamples = [rawSample.withElapsedMilliseconds(0)]
            }
        } else {
            coordinator.surfaceSamplingStartedAt = sampledAt
            coordinator.surfaceSamples = [rawSample.withElapsedMilliseconds(0)]
        }
        coordinator.surfaceLastSample = rawSample
        if coordinator.surfaceSamples.count >= 3 {
            guard surfaceStatus.markQuiescent(
                section: section,
                generation: generation,
                samples: Array(coordinator.surfaceSamples.suffix(3))
            ) else {
                return
            }
            guard let readinessRequest else { return }
            do {
                try DesktopEvaluationSurfaceStateWriter.write(
                    request: readinessRequest,
                    window: window,
                    sample: windowSample,
                    section: section,
                    surfaceGeneration: generation
                )
            } catch {
                fatalError("NeonDiff Desktop evaluation surface state failed: \(error.localizedDescription)")
            }
            return
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.10) {
            sampleSurfaceState(
                window: window,
                section: section,
                generation: generation,
                token: token,
                coordinator: coordinator
            )
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
