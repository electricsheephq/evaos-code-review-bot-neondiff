import SwiftUI
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
                }

                CommandPanel(commands: [
                    model.statusCommand,
                    model.startDaemonDryRunCommand,
                    model.stopDaemonDryRunCommand,
                    model.configInspectCommand
                ], copy: model.copyCommand)

                HStack(spacing: 10) {
                    Button { model.refreshStatus() } label: {
                        Label("Refresh", systemImage: "arrow.clockwise")
                    }
                    Button { model.inspectConfig() } label: {
                        Label("Load Config", systemImage: "doc.text.magnifyingglass")
                    }
                    Button { model.previewStartDaemon() } label: {
                        Label("Preview Start", systemImage: "play.circle")
                    }
                    Button { model.previewStopDaemon() } label: {
                        Label("Preview Stop", systemImage: "stop.circle")
                    }
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
        }
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
