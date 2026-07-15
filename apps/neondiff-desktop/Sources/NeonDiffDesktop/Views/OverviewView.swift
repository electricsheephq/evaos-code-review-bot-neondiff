import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct OverviewView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    private let statusColumns = [GridItem(.adaptive(minimum: 160), spacing: 12)]

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                LazyVGrid(columns: statusColumns, alignment: .leading, spacing: 12) {
                    StatusTile(title: "Runtime", value: model.status.healthState, systemImage: "bolt.horizontal.circle")
                    StatusTile(title: "Repos", value: "\(model.status.monitoredRepos.count)", systemImage: "folder")
                    StatusTile(title: "Keys", value: model.providers.providerKeyStored ? "stored" : "missing", systemImage: "key")
                    StatusTile(title: "Dashboard", value: model.dashboardProcessIdentifier == nil ? model.dashboardLaunchStatus : "launched", systemImage: "macwindow")
                }

                OperatorSection("Local Dashboard Launcher") {
                    VStack(alignment: .leading, spacing: 10) {
                        Text("The Mac app stays in control on launch. Start the local dashboard service here, then open the browser dashboard only when you choose to inspect the full HTML setup surface.")
                            .operatorBodyText()
                            .fixedSize(horizontal: false, vertical: true)

                        HStack(spacing: 10) {
                            Button { model.startDashboardServer() } label: {
                                Label("Start Local Dashboard", systemImage: "play.circle")
                            }
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
                    Text(lastError)
                        .foregroundStyle(NeonDiffTheme.warning)
                        .font(.callout)
                        .operatorPanel()
                }

                OperatorSection("Last Command") {
                    OperatorCommandText(text: model.lastCommandLine, lineLimit: 4)
                }
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "overview")
            }
        }
        .accessibilityIdentifier("neondiff-overview-outer-scroll")
        .scrollContentBackground(.hidden)
    }
}

private struct StatusTile: View {
    var title: String
    var value: String
    var systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(NeonDiffTheme.badgeFont)
                .foregroundStyle(NeonDiffTheme.textSecondary)
            Text(value)
                .font(.system(.title3, design: .monospaced).weight(.black))
                .foregroundStyle(NeonDiffTheme.statusColor(value))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .operatorPanel(active: true)
    }
}
