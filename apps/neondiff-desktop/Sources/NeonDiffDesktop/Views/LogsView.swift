import SwiftUI
import NeonDiffDesktopAppCore
#if DEBUG
import AppKit
#endif

struct LogsView: View {
    @ObservedObject var model: NeonDiffDesktopModel
#if DEBUG
    @State private var hostedTerminalVisibilityPayload: String?
#endif

    var body: some View {
        ScrollView(.vertical) {
            pageContent
        }
        .accessibilityIdentifier("neondiff-logs-outer-scroll")
        .scrollContentBackground(.hidden)
        .scrollIndicators(.visible, axes: .vertical)
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Button { model.refreshStatus() } label: {
                    Label("Refresh Status Logs", systemImage: "arrow.clockwise")
                }
                Button { model.copyCommand(model.statusCommand) } label: {
                    Label("Copy Last Command", systemImage: "doc.on.doc")
                }
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Redacted Output")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.accentSoft)

                TextEditor(text: $model.logText)
                    .accessibilityIdentifier("neondiff-logs-text-editor")
                    .font(.system(.body, design: .monospaced))
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                    .scrollContentBackground(.hidden)
                    .textSelection(.enabled)
                    .frame(height: 360)
#if DEBUG
                    .background {
                        if HostedLogsVisibleRangeEvaluation.isActive {
                            LogsTextEditorVisibleRangeProbe(
                                terminalToken: HostedLogsVisibleRangeEvaluation.terminalToken,
                                terminalVisibilityPayload: $hostedTerminalVisibilityPayload
                            )
                        }
                    }
                    .overlay(alignment: .bottomTrailing) {
                        if HostedLogsVisibleRangeEvaluation.isActive,
                           let hostedTerminalVisibilityPayload {
                            Color.clear
                                .frame(width: 1, height: 1)
                                .accessibilityElement(children: .ignore)
                                .accessibilityLabel(hostedTerminalVisibilityPayload)
                                .accessibilityIdentifier("neondiff-logs-visible-tail")
                                .accessibilityRespondsToUserInteraction(false)
                                .allowsHitTesting(false)
                        }
                    }
#endif
                    .padding(8)
                    .background(Color.black.opacity(0.42))
                    .overlay {
                        AngularRectangle(corner: 10)
                            .stroke(NeonDiffTheme.stroke.opacity(0.7), lineWidth: 0.8)
                    }
                    .clipShape(AngularRectangle(corner: 10))
            }
            .operatorPanel()

            OperatorSection("Display Safety") {
                Text("Output is redacted before display. Raw provider keys, license keys, tokens, private keys, and credential URLs must not appear here.")
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .overlay(alignment: .bottom) {
            PageBottomSentinel(section: "logs")
        }
    }
}

#if DEBUG
private enum HostedLogsVisibleRangeEvaluation {
    static let terminalToken = "HOSTED_INNER_SCROLL_SAFE_TAIL_070"

    static var isActive: Bool {
        let arguments = ProcessInfo.processInfo.arguments
        guard !NSWorkspace.shared.isVoiceOverEnabled,
              !NSWorkspace.shared.isSwitchControlEnabled,
              arguments.contains("--ui-testing"),
              let fixtureFlagIndex = arguments.firstIndex(of: "--ui-fixture"),
              arguments.indices.contains(fixtureFlagIndex + 1) else {
            return false
        }
        return URL(fileURLWithPath: arguments[fixtureFlagIndex + 1]).lastPathComponent
            == "hosted-inner-scroll-overflow.json"
    }
}

private struct LogsTextEditorVisibleRangeProbe: NSViewRepresentable {
    let terminalToken: String
    @Binding var terminalVisibilityPayload: String?

    func makeCoordinator() -> Coordinator {
        Coordinator(terminalVisibilityPayload: $terminalVisibilityPayload)
    }

    func makeNSView(context: Context) -> LogsTextEditorVisibleRangeProbeView {
        let view = LogsTextEditorVisibleRangeProbeView()
        view.terminalToken = terminalToken
        view.onVisibilityChange = { [weak coordinator = context.coordinator] payload in
            coordinator?.report(payload)
        }
        return view
    }

    func updateNSView(
        _ nsView: LogsTextEditorVisibleRangeProbeView,
        context: Context
    ) {
        nsView.terminalToken = terminalToken
        nsView.resolveAndObserveTextView()
    }

    static func dismantleNSView(
        _ nsView: LogsTextEditorVisibleRangeProbeView,
        coordinator: Coordinator
    ) {
        nsView.stopAllObserving()
        coordinator.report(nil)
    }

    final class Coordinator {
        private var terminalVisibilityPayload: Binding<String?>

        init(terminalVisibilityPayload: Binding<String?>) {
            self.terminalVisibilityPayload = terminalVisibilityPayload
        }

        func report(_ payload: String?) {
            let binding = terminalVisibilityPayload
            DispatchQueue.main.async {
                guard binding.wrappedValue != payload else { return }
                binding.wrappedValue = payload
            }
        }
    }
}

private final class LogsTextEditorVisibleRangeProbeView: NSView {
    var terminalToken = "" {
        didSet { updateVisibility() }
    }
    var onVisibilityChange: ((String?) -> Void)?

    private weak var observedTextView: NSTextView?
    private weak var observedClipView: NSClipView?
    private var originalPostsBoundsChangedNotifications: Bool?
    private var observationTokens: [NSObjectProtocol] = []
    private var assistiveTechnologyObservations: [NSKeyValueObservation] = []
    private var resolutionScheduled = false
    private var resolutionAttemptCount = 0

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        observeAssistiveTechnologyIfNeeded()
        scheduleResolution()
    }

    override func viewDidMoveToSuperview() {
        super.viewDidMoveToSuperview()
        scheduleResolution()
    }

    override func layout() {
        super.layout()
        scheduleResolution()
    }

    func resolveAndObserveTextView() {
        resolutionScheduled = false
        guard !NSWorkspace.shared.isVoiceOverEnabled,
              !NSWorkspace.shared.isSwitchControlEnabled else {
            deactivateForAssistiveTechnology()
            return
        }
        guard window != nil,
              bounds.width > 0,
              bounds.height > 0,
              let textView = uniquelyOverlappingTextView() else {
            stopObserving()
            onVisibilityChange?(nil)
            if window != nil, resolutionAttemptCount < 20 {
                resolutionAttemptCount += 1
                scheduleResolution(after: 0.05)
            }
            return
        }
        resolutionAttemptCount = 0
        if observedTextView !== textView {
            startObserving(textView)
        }
        updateVisibility()
    }

    func stopObserving() {
        for token in observationTokens {
            NotificationCenter.default.removeObserver(token)
        }
        observationTokens.removeAll()
        if let observedClipView,
           let originalPostsBoundsChangedNotifications {
            observedClipView.postsBoundsChangedNotifications =
                originalPostsBoundsChangedNotifications
        }
        observedClipView = nil
        originalPostsBoundsChangedNotifications = nil
        observedTextView = nil
    }

    func stopAllObserving() {
        stopObserving()
        assistiveTechnologyObservations.removeAll()
    }

    private func observeAssistiveTechnologyIfNeeded() {
        guard assistiveTechnologyObservations.isEmpty else { return }
        let workspace = NSWorkspace.shared
        assistiveTechnologyObservations = [
            workspace.observe(\.isVoiceOverEnabled, options: [.initial, .new]) {
                [weak self] workspace, _ in
                guard workspace.isVoiceOverEnabled else { return }
                DispatchQueue.main.async {
                    self?.deactivateForAssistiveTechnology()
                }
            },
            workspace.observe(\.isSwitchControlEnabled, options: [.initial, .new]) {
                [weak self] workspace, _ in
                guard workspace.isSwitchControlEnabled else { return }
                DispatchQueue.main.async {
                    self?.deactivateForAssistiveTechnology()
                }
            }
        ]
    }

    private func deactivateForAssistiveTechnology() {
        stopObserving()
        onVisibilityChange?(nil)
    }

    private func scheduleResolution(after delay: TimeInterval = 0) {
        guard !resolutionScheduled else { return }
        resolutionScheduled = true
        if delay == 0 {
            DispatchQueue.main.async { [weak self] in
                self?.resolveAndObserveTextView()
            }
        } else {
            DispatchQueue.main.asyncAfter(deadline: .now() + delay) { [weak self] in
                self?.resolveAndObserveTextView()
            }
        }
    }

    private func uniquelyOverlappingTextView() -> NSTextView? {
        let probeFrame = convert(bounds, to: nil)
        guard probeFrame.width > 0, probeFrame.height > 0 else { return nil }

        var ancestor = superview
        while let container = ancestor {
            let candidates = textViews(in: container).filter { candidate in
                guard candidate.window === window else { return false }
                let candidateFrame = candidate.convert(candidate.bounds, to: nil)
                let intersection = probeFrame.intersection(candidateFrame)
                guard !intersection.isNull else { return false }
                let minimumArea = min(
                    probeFrame.width * probeFrame.height,
                    candidateFrame.width * candidateFrame.height
                )
                return minimumArea > 0
                    && (intersection.width * intersection.height) / minimumArea >= 0.5
            }
            if candidates.count == 1 {
                return candidates[0]
            }
            if candidates.count > 1 {
                return nil
            }
            ancestor = container.superview
        }
        return nil
    }

    private func textViews(in root: NSView) -> [NSTextView] {
        var matches: [NSTextView] = []
        if let textView = root as? NSTextView {
            matches.append(textView)
        }
        for subview in root.subviews {
            matches.append(contentsOf: textViews(in: subview))
        }
        return matches
    }

    private func startObserving(_ textView: NSTextView) {
        stopObserving()
        observedTextView = textView
        if let clipView = textView.enclosingScrollView?.contentView {
            observedClipView = clipView
            originalPostsBoundsChangedNotifications =
                clipView.postsBoundsChangedNotifications
            clipView.postsBoundsChangedNotifications = true
            observationTokens.append(
                NotificationCenter.default.addObserver(
                    forName: NSView.boundsDidChangeNotification,
                    object: clipView,
                    queue: .main
                ) { [weak self] _ in
                    self?.updateVisibility()
                }
            )
        }
        observationTokens.append(
            NotificationCenter.default.addObserver(
                forName: NSText.didChangeNotification,
                object: textView,
                queue: .main
            ) { [weak self] _ in
                self?.updateVisibility()
            }
        )
    }

    private func updateVisibility() {
        guard !NSWorkspace.shared.isVoiceOverEnabled,
              !NSWorkspace.shared.isSwitchControlEnabled else {
            deactivateForAssistiveTechnology()
            return
        }
        guard let textView = observedTextView,
              let layoutManager = textView.layoutManager,
              let textContainer = textView.textContainer,
              !terminalToken.isEmpty else {
            onVisibilityChange?(nil)
            return
        }
        layoutManager.ensureLayout(for: textContainer)
        let textContainerOrigin = textView.textContainerOrigin
        let visibleTextContainerRect = textView.visibleRect.offsetBy(
            dx: -textContainerOrigin.x,
            dy: -textContainerOrigin.y
        )
        let visibleGlyphRange = layoutManager.glyphRange(
            forBoundingRect: visibleTextContainerRect,
            in: textContainer
        )
        let visibleCharacterRange = layoutManager.characterRange(
            forGlyphRange: visibleGlyphRange,
            actualGlyphRange: nil
        )
        let utf16Text = textView.string as NSString
        let terminalTokenRange = utf16Text.range(of: terminalToken)
        guard DesktopTextVisibility.visibleRange(
            visibleCharacterRange,
            fullyContainsTokenIn: textView.string,
            terminalToken: terminalToken
        ), terminalTokenRange.location != NSNotFound else {
            onVisibilityChange?(nil)
            return
        }
        let terminalGlyphRange = layoutManager.glyphRange(
            forCharacterRange: terminalTokenRange,
            actualCharacterRange: nil
        )
        let terminalGlyphBounds = layoutManager.boundingRect(
            forGlyphRange: terminalGlyphRange,
            in: textContainer
        ).offsetBy(
            dx: textContainerOrigin.x,
            dy: textContainerOrigin.y
        )
        let visibleRect = textView.visibleRect
        let terminalGlyphBoundsAreFullyVisible = terminalGlyphBounds.width > 0
            && terminalGlyphBounds.height > 0
            && terminalGlyphBounds.minX >= visibleRect.minX
            && terminalGlyphBounds.minY >= visibleRect.minY
            && terminalGlyphBounds.maxX <= visibleRect.maxX
            && terminalGlyphBounds.maxY <= visibleRect.maxY
        guard terminalGlyphBoundsAreFullyVisible else {
            onVisibilityChange?(nil)
            return
        }
        let payload = HostedLogsTerminalVisibilityPayload(
            schemaVersion: 1,
            coordinateSpace: "appkit-text-view-local",
            terminalToken: terminalToken,
            textUTF16Length: utf16Text.length,
            terminalTokenRange: HostedLogsTextRange(terminalTokenRange),
            visibleCharacterRange: HostedLogsTextRange(visibleCharacterRange),
            visibleRect: HostedLogsRect(visibleRect),
            terminalGlyphBounds: HostedLogsRect(terminalGlyphBounds),
            terminalTokenFullyVisible: true
        )
        guard let encoded = try? JSONEncoder.hostedVisibilityEncoder.encode(payload) else {
            onVisibilityChange?(nil)
            return
        }
        onVisibilityChange?("ndlv1:" + encoded.base64EncodedString())
    }

    deinit {
        stopAllObserving()
    }
}

private struct HostedLogsTerminalVisibilityPayload: Codable {
    let schemaVersion: Int
    let coordinateSpace: String
    let terminalToken: String
    let textUTF16Length: Int
    let terminalTokenRange: HostedLogsTextRange
    let visibleCharacterRange: HostedLogsTextRange
    let visibleRect: HostedLogsRect
    let terminalGlyphBounds: HostedLogsRect
    let terminalTokenFullyVisible: Bool
}

private struct HostedLogsTextRange: Codable {
    let location: Int
    let length: Int

    init(_ range: NSRange) {
        location = range.location
        length = range.length
    }
}

private struct HostedLogsRect: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = Double(rect.origin.x)
        y = Double(rect.origin.y)
        width = Double(rect.size.width)
        height = Double(rect.size.height)
    }
}

private extension JSONEncoder {
    static var hostedVisibilityEncoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }
}
#endif
