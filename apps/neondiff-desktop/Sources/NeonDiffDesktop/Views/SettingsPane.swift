import AppKit
import SwiftUI
import NeonDiffDesktopAppCore

struct SettingsPane: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @ObservedObject var updateController: NeonUpdateController

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                OperatorSection("Local Paths") {
                    OperatorTextField(title: "NeonDiff CLI", text: $model.cliPath)
                    OperatorTextField(title: "Config", text: $model.configPath)
                    OperatorTextField(title: "Launchd Label", text: $model.launchdLabel)
                    Button { model.persistLocalSettings() } label: {
                        Label("Save Local Settings", systemImage: "externaldrive.badge.checkmark")
                    }
                }
                .disabled(!model.canEditProviderConfiguration)

                OperatorSection("Commands") {
                    OperatorCommandText(text: model.dashboardCommand.commandLine, lineLimit: 5)
                    OperatorCommandText(text: model.statusCommand.commandLine, lineLimit: 5)
                    HStack(spacing: 10) {
                        Button { model.openDashboard() } label: {
                            Label("Open Dashboard", systemImage: "safari")
                        }
                        Button { model.copyCommand(model.statusCommand) } label: {
                            Label("Copy Status Command", systemImage: "doc.on.doc")
                        }
                        Button { model.reopenOnboarding() } label: {
                            Label("Open Onboarding", systemImage: "sparkles")
                        }
                    }
                }

                OperatorSection("Updates") {
                    HStack(alignment: .top, spacing: 12) {
                        OperatorBadge(
                            text: updateController.badgeText,
                            color: updateController.isConfigured ? NeonDiffTheme.cyan : NeonDiffTheme.textSecondary
                        )

                        VStack(alignment: .leading, spacing: 6) {
                            Text(updateController.statusText)
                                .operatorBodyText()
                                .fixedSize(horizontal: false, vertical: true)
                            Text("Future release lane: #116. This dev build does not include a public feed or signing key.")
                                .font(.caption)
                                .foregroundStyle(NeonDiffTheme.textSecondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }

                    HStack(spacing: 10) {
                        Button {
                            updateController.checkForUpdates()
                        } label: {
                            Label("Check for Updates", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(!updateController.canCheckForUpdates)

                        Text(updateController.lastAction)
                            .font(.caption)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                            .lineLimit(1)
                            .minimumScaleFactor(0.8)
                    }
                }
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "settings")
            }
        }
        .accessibilityIdentifier("neondiff-settings-outer-scroll")
        .scrollContentBackground(.hidden)
    }
}

#if DEBUG
@MainActor
final class HostedSettingsEvaluationStatus: ObservableObject {
    @Published private(set) var accessibilityIdentifier =
        "neondiff.evaluation.settings.rendering"
    @Published private(set) var geometryPayload = "unavailable"

    func reset() {
        accessibilityIdentifier = "neondiff.evaluation.settings.rendering"
        geometryPayload = "unavailable"
    }

    fileprivate func markQuiescent(samples: [HostedSettingsWindowSample]) {
        let envelope = HostedSettingsWindowGeometryEnvelope(
            schemaVersion: 1,
            coordinateSpaces: HostedSettingsWindowCoordinateSpaces(
                windowFrame: "appkit-screen",
                contentLayoutRect: "appkit-window",
                contentLayoutScreenRect: "appkit-screen",
                visibleScreenFrame: "appkit-screen"
            ),
            samples: samples
        )
        guard let data = try? JSONEncoder().encode(envelope) else {
            geometryPayload = "encoding-failed"
            return
        }
        geometryPayload = data.base64EncodedString()
        accessibilityIdentifier = "neondiff.evaluation.settings.quiescent"
    }
}

extension View {
    @ViewBuilder
    func hostedSettingsEvaluationContent(
        enabled: Bool,
        status: HostedSettingsEvaluationStatus
    ) -> some View {
        if enabled {
            accessibilityElement(children: .contain)
                .accessibilityIdentifier("neondiff-settings-window-content")
                .overlay(alignment: .topLeading) {
                    HostedSettingsEvaluationMarker(status: status)
                }
                .background(
                    HostedSettingsWindowConfigurator(status: status)
                        .allowsHitTesting(false)
                )
        } else {
            self
        }
    }
}

private struct HostedSettingsEvaluationMarker: View {
    @ObservedObject var status: HostedSettingsEvaluationStatus
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize

    var body: some View {
        ZStack {
            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("NeonDiff Settings evaluation state")
                .accessibilityIdentifier(status.accessibilityIdentifier)

            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("NeonDiff Settings observed text size")
                .accessibilityIdentifier("neondiff.evaluation.settings.text-size")
                .accessibilityValue(dynamicTypeSize.evaluationIdentifier)

            Color.clear
                .frame(width: 1, height: 1)
                .accessibilityElement(children: .ignore)
                .accessibilityLabel("NeonDiff Settings AppKit geometry")
                .accessibilityIdentifier("neondiff.evaluation.settings.appkit-geometry")
                .accessibilityValue(status.geometryPayload)
        }
        .allowsHitTesting(false)
    }
}

struct HostedSettingsWindowConfigurator: NSViewRepresentable {
    @ObservedObject var status: HostedSettingsEvaluationStatus

    func makeCoordinator() -> Coordinator {
        Coordinator(status: status)
    }

    func makeNSView(context: Context) -> NSView {
        NSView(frame: .zero)
    }

    func updateNSView(_ view: NSView, context: Context) {
        context.coordinator.monitor(view: view)
    }

    static func dismantleNSView(_ view: NSView, coordinator: Coordinator) {
        coordinator.cancel()
    }

    @MainActor
    final class Coordinator {
        private let status: HostedSettingsEvaluationStatus
        private weak var monitoredView: NSView?
        private var monitorTask: Task<Void, Never>?
        private var completed = false

        init(status: HostedSettingsEvaluationStatus) {
            self.status = status
        }

        func monitor(view: NSView) {
            if monitoredView !== view {
                monitoredView = view
                monitorTask?.cancel()
                monitorTask = nil
                completed = false
                status.reset()
            }
            guard !completed, monitorTask == nil else { return }
            monitorTask = Task { @MainActor [weak self, weak view] in
                guard let self else { return }
                let deadline = ProcessInfo.processInfo.systemUptime + 5
                var stableSamples: [HostedSettingsWindowSample] = []
                while !Task.isCancelled,
                      ProcessInfo.processInfo.systemUptime <= deadline {
                    guard let window = view?.window,
                          let visibleScreenFrame = window.screen?.visibleFrame else {
                        try? await Task.sleep(for: .milliseconds(20))
                        continue
                    }
                    window.contentView?.layoutSubtreeIfNeeded()
                    let sample = HostedSettingsWindowSample(
                        windowFrame: window.frame,
                        contentLayoutRect: window.contentLayoutRect,
                        contentLayoutScreenRect: window.convertToScreen(
                            window.contentLayoutRect
                        ),
                        visibleScreenFrame: visibleScreenFrame
                    )
                    if let previous = stableSamples.last,
                       previous.differs(from: sample, byMoreThan: 1) {
                        stableSamples = [sample]
                    } else {
                        stableSamples.append(sample)
                    }
                    if stableSamples.count == 3 {
                        completed = true
                        status.markQuiescent(samples: stableSamples)
                        monitorTask = nil
                        return
                    }
                    try? await Task.sleep(for: .milliseconds(100))
                }
                monitorTask = nil
            }
        }

        func cancel() {
            monitorTask?.cancel()
            monitorTask = nil
        }
    }
}

fileprivate struct HostedSettingsWindowGeometryEnvelope: Codable {
    let schemaVersion: Int
    let coordinateSpaces: HostedSettingsWindowCoordinateSpaces
    let samples: [HostedSettingsWindowSample]
}

fileprivate struct HostedSettingsWindowCoordinateSpaces: Codable {
    let windowFrame: String
    let contentLayoutRect: String
    let contentLayoutScreenRect: String
    let visibleScreenFrame: String
}

fileprivate struct HostedSettingsWindowSample: Codable {
    let windowFrame: HostedSettingsAppKitFrame
    let contentLayoutRect: HostedSettingsAppKitFrame
    let contentLayoutScreenRect: HostedSettingsAppKitFrame
    let visibleScreenFrame: HostedSettingsAppKitFrame

    init(
        windowFrame: CGRect,
        contentLayoutRect: CGRect,
        contentLayoutScreenRect: CGRect,
        visibleScreenFrame: CGRect
    ) {
        self.windowFrame = HostedSettingsAppKitFrame(windowFrame)
        self.contentLayoutRect = HostedSettingsAppKitFrame(contentLayoutRect)
        self.contentLayoutScreenRect = HostedSettingsAppKitFrame(
            contentLayoutScreenRect
        )
        self.visibleScreenFrame = HostedSettingsAppKitFrame(visibleScreenFrame)
    }

    func differs(from other: Self, byMoreThan tolerance: CGFloat) -> Bool {
        windowFrame.differs(from: other.windowFrame, byMoreThan: tolerance)
            || contentLayoutRect.differs(
                from: other.contentLayoutRect,
                byMoreThan: tolerance
            )
            || contentLayoutScreenRect.differs(
                from: other.contentLayoutScreenRect,
                byMoreThan: tolerance
            )
            || visibleScreenFrame.differs(
                from: other.visibleScreenFrame,
                byMoreThan: tolerance
            )
    }
}

fileprivate struct HostedSettingsAppKitFrame: Codable {
    let x: Double
    let y: Double
    let width: Double
    let height: Double

    init(_ rect: CGRect) {
        x = rect.origin.x
        y = rect.origin.y
        width = rect.width
        height = rect.height
    }

    func differs(from other: Self, byMoreThan tolerance: CGFloat) -> Bool {
        abs(x - other.x) > tolerance
            || abs(y - other.y) > tolerance
            || abs(width - other.width) > tolerance
            || abs(height - other.height) > tolerance
    }
}

private extension DynamicTypeSize {
    var evaluationIdentifier: String {
        switch self {
        case .xSmall: "x-small"
        case .small: "small"
        case .medium: "medium"
        case .large: "large"
        case .xLarge: "x-large"
        case .xxLarge: "xx-large"
        case .xxxLarge: "xxx-large"
        case .accessibility1: "accessibility1"
        case .accessibility2: "accessibility2"
        case .accessibility3: "accessibility3"
        case .accessibility4: "accessibility4"
        case .accessibility5: "accessibility5"
        @unknown default: "unknown"
        }
    }
}
#endif
