import SwiftUI
import NeonDiffDesktopCore

struct PolicyView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                OperatorSection("Review Policy Defaults") {
                    Label("No direct review posting from desktop UI", systemImage: "checkmark.shield")
                    Label("Daemon duplicate, stale-head, secret, and inline-coordinate gates stay authoritative", systemImage: "checkmark.shield")
                    Label("Config writes use `config patch` with dry-run preview first", systemImage: "checkmark.shield")
                }
                .foregroundStyle(NeonDiffTheme.textSecondary)

                OperatorSection("Proof Boundary") {
                    Text("This desktop shell previews and copies operator-safe commands. Runtime gates, live review posting, signing, updater, and release claims remain outside this MVP.")
                        .operatorBodyText()
                }

                CommandPanel(commands: [
                    model.configInspectCommand,
                    model.providerPatchPreviewCommand
                ], copy: model.copyCommand)
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}

struct CommandPanel: View {
    var commands: [DesktopCommand]
    var copy: (DesktopCommand) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("CLI Equivalents")
                .font(NeonDiffTheme.headlineFont)
                .foregroundStyle(NeonDiffTheme.accentSoft)
            ForEach(commands) { command in
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text(command.title)
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NeonDiffTheme.textPrimary)
                        OperatorCommandText(text: command.commandLine)
                    }
                    Spacer()
                    Button {
                        copy(command)
                    } label: {
                        Image(systemName: "doc.on.doc")
                    }
                    .help("Copy command")
                }
                .operatorPanel(padding: 10)
            }
        }
    }
}
