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

    func reset() {
        accessibilityIdentifier = "neondiff.evaluation.settings.rendering"
    }

    func markQuiescent() {
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

    var body: some View {
        Color.clear
            .frame(width: 1, height: 1)
            .accessibilityElement(children: .ignore)
            .accessibilityLabel("NeonDiff Settings evaluation state")
            .accessibilityIdentifier(status.accessibilityIdentifier)
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
                    guard let window = view?.window else {
                        try? await Task.sleep(for: .milliseconds(20))
                        continue
                    }
                    window.contentView?.layoutSubtreeIfNeeded()
                    let sample = HostedSettingsWindowSample(
                        windowFrame: window.frame,
                        contentLayoutRect: window.contentLayoutRect
                    )
                    if let previous = stableSamples.last,
                       previous.differs(from: sample, byMoreThan: 1) {
                        stableSamples = [sample]
                    } else {
                        stableSamples.append(sample)
                    }
                    if stableSamples.count == 3 {
                        completed = true
                        status.markQuiescent()
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

private struct HostedSettingsWindowSample {
    let windowFrame: CGRect
    let contentLayoutRect: CGRect

    func differs(from other: Self, byMoreThan tolerance: CGFloat) -> Bool {
        windowFrame.differs(from: other.windowFrame, byMoreThan: tolerance)
            || contentLayoutRect.differs(
                from: other.contentLayoutRect,
                byMoreThan: tolerance
            )
    }
}

private extension CGRect {
    func differs(from other: CGRect, byMoreThan tolerance: CGFloat) -> Bool {
        abs(origin.x - other.origin.x) > tolerance
            || abs(origin.y - other.origin.y) > tolerance
            || abs(width - other.width) > tolerance
            || abs(height - other.height) > tolerance
    }
}
#endif
