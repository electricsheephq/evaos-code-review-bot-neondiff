import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

// Reference screen for issue #611: applies the live-site design contract
// (docs/design/live-site-design-source.md) as native translation — tokenized
// colors for both appearances, mono uppercase section labels, status rows with
// glyph + text (never color alone), and one bracket primary action as the
// screen's single decorative brand treatment (one-treatment neon budget: the
// readiness panel is a plain tokenized surface, not corner-ticked). Colors resolve from the SwiftUI
// `\.colorScheme` (NDPalette) so light mode actually renders light. Behavior,
// bindings, accessibility identifiers, and the #517 geometry sentinel
// (neondiff-overview-start-dashboard) are preserved; structural Home redesign
// remains owned by #521.
struct OverviewView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let nd = NDPalette(scheme: colorScheme)
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                // Readiness console: tokenized bordered surface with mono labels
                // and glyph+text status rows. The corner-tick flourish
                // (NDConsolePanel) is intentionally omitted here so the bracket
                // CTA below is the screen's single decorative brand treatment,
                // honoring the one-treatment neon budget (#611).
                VStack(alignment: .leading, spacing: 12) {
                    Text("Readiness // Overview").ndSectionLabel(nd)
                    StatusRow(title: "Runtime", value: model.status.healthState, palette: nd)
                    StatusRow(title: "Repos", value: "\(model.status.monitoredRepos.count)", palette: nd)
                    StatusRow(title: "Keys", value: model.providers.providerKeyStored ? "stored" : "missing", palette: nd)
                    StatusRow(
                        title: "Dashboard",
                        value: model.dashboardProcessIdentifier == nil ? model.dashboardLaunchStatus : "launched",
                        palette: nd
                    )
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(Rectangle().fill(nd.surface))
                .overlay(Rectangle().stroke(nd.borderPrimary, lineWidth: 1))

                OverviewSection(title: "Local Dashboard Launcher // Operator", palette: nd) {
                    Text("The Mac app stays in control on launch. Start the local dashboard service here, then open the browser dashboard only when you choose to inspect the full HTML setup surface.")
                        .font(.body)
                        .foregroundStyle(nd.textSecondary)
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
                        .buttonStyle(NDSecondaryButtonStyle())
                        .accessibilityIdentifier("neondiff-open-browser-dashboard")

                        Button { model.copyCommand(model.dashboardCommand) } label: {
                            Label("Copy Dashboard Command", systemImage: "doc.on.doc")
                        }
                        .buttonStyle(NDSecondaryButtonStyle())
                        .accessibilityIdentifier("neondiff-copy-dashboard-command")
                    }

                    OperatorCommandText(text: model.dashboardCommand.commandLine, lineLimit: 3, palette: nd)
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
                    .disabled(!model.productionDaemonStopAvailable)
                    .accessibilityIdentifier("neondiff-preview-stop-daemon")
                }

                if let lastError = model.lastError, !lastError.isEmpty {
                    HStack(alignment: .top, spacing: 8) {
                        Text("◆")
                            .foregroundStyle(nd.danger)
                            .accessibilityHidden(true)
                        Text(lastError)
                            .foregroundStyle(nd.danger)
                            .font(.callout)
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(12)
                    .background(Rectangle().fill(nd.surface))
                    .overlay(Rectangle().stroke(nd.danger.opacity(0.5), lineWidth: 1))
                }

                OverviewSection(title: "Last Command // Log", palette: nd) {
                    OperatorCommandText(text: model.lastCommandLine, lineLimit: 4, palette: nd)
                }
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "overview")
            }
        }
        .background(nd.background)
        .accessibilityIdentifier("neondiff-overview-outer-scroll")
        .scrollContentBackground(.hidden)
    }
}

/// A working-screen section: mono uppercase label header over a tokenized
/// surface. Local to the reference screen; the shared component system is #520.
private struct OverviewSection<Content: View>: View {
    let title: String
    let palette: NDPalette
    @ViewBuilder var content: Content

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(title).ndSectionLabel(palette)
            content
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(palette.surface))
        .overlay(Rectangle().stroke(palette.borderInput, lineWidth: 1))
    }
}

/// Key-value status row: mono uppercase label left, glyph + mono value right.
/// Status is carried by glyph + text, not color alone.
private struct StatusRow: View {
    var title: String
    var value: String
    var palette: NDPalette

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
            Text(title).ndSectionLabel(palette)
        }
    }

    private var normalized: String { value.lowercased() }

    private var isHealthy: Bool {
        ["ok", "healthy", "stored", "ready", "active", "launched", "connected"].contains { normalized.contains($0) }
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
        if isHealthy { return palette.accentPrimary }
        if isAttention { return palette.warning }
        return palette.textSecondary
    }
}
