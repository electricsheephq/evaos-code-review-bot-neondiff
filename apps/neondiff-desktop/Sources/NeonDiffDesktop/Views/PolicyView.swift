import SwiftUI
import NeonDiffDesktopCore

struct PolicyView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                Text("Review Policy Defaults")
                    .font(.title2.weight(.semibold))

                VStack(alignment: .leading, spacing: 8) {
                    Label("No direct review posting from desktop UI", systemImage: "checkmark.shield")
                    Label("Daemon duplicate, stale-head, secret, and inline-coordinate gates stay authoritative", systemImage: "checkmark.shield")
                    Label("Config writes use `config patch` with dry-run preview first", systemImage: "checkmark.shield")
                }
                .foregroundStyle(.secondary)

                CommandPanel(commands: [
                    model.configInspectCommand,
                    model.providerPatchPreviewCommand
                ], copy: model.copyCommand)
            }
            .padding(24)
        }
    }
}

struct CommandPanel: View {
    var commands: [DesktopCommand]
    var copy: (DesktopCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CLI Equivalents")
                .font(.headline)
            ForEach(commands) { command in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(command.title)
                            .font(.subheadline.weight(.semibold))
                        Text(command.commandLine)
                            .font(.system(.caption, design: .monospaced))
                            .textSelection(.enabled)
                            .foregroundStyle(.secondary)
                            .lineLimit(3)
                    }
                    Spacer()
                    Button {
                        copy(command)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .help("Copy command")
                }
                .padding(10)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8))
            }
        }
    }
}
