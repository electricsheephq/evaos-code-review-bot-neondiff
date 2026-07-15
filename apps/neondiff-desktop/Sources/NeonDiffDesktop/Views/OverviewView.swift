import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

// Reference screen for issue #611: applies the live-site design contract
// (docs/design/live-site-design-source.md) as native translation — tokenized
// colors for both appearances, mono uppercase section labels, status rows with
// glyph + text (never color alone), one bracket primary action, and a
// corner-ticked readiness console. Behavior, bindings, accessibility
// identifiers, and the #517 geometry sentinel (neondiff-overview-start-dashboard)
// are preserved; structural Home redesign remains owned by #521.
struct OverviewView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                NDConsolePanel {
                    VStack(alignment: .leading, spacing: 12) {
                        Text("Readiness // Overview").ndSectionLabel()
                        StatusRow(title: "Runtime", value: model.status.healthState)
                        StatusRow(title: "Repos", value: "\(model.status.monitoredRepos.count)")
                        StatusRow(title: "Keys", value: model.providers.providerKeyStored ? "stored" : "missing")
                        StatusRow(
                            title: "Dashboard",
                            value: model.dashboardProcessIdentifier == nil ? model.dashboardLaunchStatus : "launched"
                        )
                    }
                }

                OverviewSection(title: "Local Dashboard Launcher // Operator") {
                    Text("The Mac app stays in control on launch. Start the local dashboard service here, then open the browser dashboard only when you choose to inspect the full HTML setup surface.")
                        .font(.body)
                        .foregroundStyle(NDColor.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    HStack(spacing: 10) {
                        // The one bracket primary action for this screen.
                        Button { model.startDashboardServer() } label: {
                            Text("Start Local Dashboard")
                        }
                        .buttonStyle(NDBracketButtonStyle())
                        .accessibilityIdentifier("neondiff-start-dashboard-server")

                        Button { model.openDashboard() } label: {
                            Label("Open Browser Dashboard", systemImage: "safari")
                        }
                        .accessibilityIdentifier("neondiff-open-browser-dashboard")

                        Button { model.copyCommand(model.dashboardCommand) } label: {
                            Label("Copy Dashboard Command", systemImage: "doc.on.doc")
                        }
                        .accessibilityIdentifier("neondiff-copy-dashboard-command")
                    }

                    OperatorCommandText(text: model.dashboardCommand.commandLine, lineLimit: 3)
                }

                CommandPanel(commands: [
                    model.dashboardServerCommand,
                    model.dashboardCommand,
                    model.statusCommand,
                    model.startDaemonDryRunCommand,
                    model.stopDaemonDryRunCommand,
                    model.configInspectCommand
                ], copy: model.copyCommand)

                HStack(spacing: 10) {
                    Button { model.startDashboardServer() } label: {
                        Label("Start Dashboard", systemImage: "play.circle")
                    }
                    .accessibilityIdentifier("neondiff-overview-start-dashboard")

                    Button { model.openDashboard() } label: {
                        Label("Open Dashboard", systemImage: "macwindow")
                    }
                    .accessibilityIdentifier("neondiff-overview-open-dashboard")

                    Button { model.refreshStatus() } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    .accessibilityIdentifier("neondiff-refresh-status")

                    Button { model.inspectConfig() } label: {
                        Label("Load Config", systemImage: "doc.text.magnifyingglass")
                    }
                    .accessibilityIdentifier("neondiff-load-config")

                    Button { model.previewStartDaemon() } label: {
                        Label("Preview Start", systemImage: "play.circle")
                    }
                    .disabled(!model.productionUsefulWorkAvailable)
                    .accessibilityIdentifier("neondiff-preview-start-daemon")

                    Button { model.previewStopDaemon() } label: {
                        Label("Preview Stop", systemImage: "stop.circle")
                    }
                    .disabled(!model.productionUsefulWorkAvailable)
                    .accessibilityIdentifier("neondiff-preview-stop-daemon")
                }

                if let lastError = model.lastError, !lastError.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Text("◆")
                            .foregroundStyle(NDColor.danger)
                            .accessibilityHidden(true)
                        Text(lastError)
                            .foregroundStyle(NDColor.danger)
                            .font(.callout)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Rectangle().fill(NDColor.surface))
                    .overlay(Rectangle().stroke(NDColor.danger.opacity(0.5), lineWidth: 1))
                }

                OverviewSection(title: "Last Command // Log") {
                    OperatorCommandText(text: model.lastCommandLine, lineLimit: 4)
                }
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "overview")
            }
        }
        .background(NDColor.background)
        .accessibilityIdentifier("neondiff-overview-outer-scroll")
        .scrollContentBackground(.hidden)
    }
}

/// A working-screen section: mono uppercase label header over a tokenized
/// surface. Local to the reference screen; the shared component system is #520.
private struct OverviewSection<Content: View>: View {
    let title: String
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).ndSectionLabel()
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(NDColor.surface))
        .overlay(Rectangle().stroke(NDColor.borderInput, lineWidth: 1))
    }
}

/// Key-value status row: mono uppercase label left, glyph + mono value right.
/// Status is carried by glyph + text, not color alone.
private struct StatusRow: View {
    var title: String
    var value: String

    var body: some View {
        LabeledContent {
            HStack(spacing: 6) {
                Text(glyph)
                    .font(NDFont.mono)
                    .foregroundStyle(color)
                    .accessibilityHidden(true)
                Text(value)
                    .font(NDFont.mono)
                    .foregroundStyle(color)
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        } label: {
            Text(title).ndSectionLabel()
        }
    }

    private var normalized: String { value.lowercased() }

    private var isHealthy: Bool {
        ["ok", "stored", "ready", "active", "launched"].contains { normalized.contains($0) }
    }

    private var isAttention: Bool {
        ["missing", "blocked", "error", "unknown", "stopped"].contains { normalized.contains($0) }
    }

    private var glyph: String {
        if isHealthy { return "●" }
        if isAttention { return "◆" }
        return "◇"
    }

    private var color: Color {
        if isHealthy { return NDColor.accentPrimary }
        if isAttention { return NDColor.warning }
        return NDColor.textSecondary
    }
}
