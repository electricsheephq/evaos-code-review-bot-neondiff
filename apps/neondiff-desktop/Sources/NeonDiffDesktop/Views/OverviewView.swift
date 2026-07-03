import SwiftUI
import NeonDiffDesktopCore

struct OverviewView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                HStack(alignment: .top, spacing: 12) {
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

                HStack {
                    Button("Refresh") { model.refreshStatus() }
                    Button("Load Config") { model.inspectConfig() }
                    Button("Preview Start") { model.previewStartDaemon() }
                    Button("Preview Stop") { model.previewStopDaemon() }
                }

                if let lastError = model.lastError, !lastError.isEmpty {
                    Text(lastError)
                        .foregroundStyle(.red)
                        .font(.callout)
                }

                VStack(alignment: .leading, spacing: 8) {
                    Text("Last Command")
                        .font(.headline)
                    Text(model.lastCommandLine)
                        .font(.system(.callout, design: .monospaced))
                        .textSelection(.enabled)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(24)
        }
    }
}

private struct StatusTile: View {
    var title: String
    var value: String
    var systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.title3.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
    }
}
