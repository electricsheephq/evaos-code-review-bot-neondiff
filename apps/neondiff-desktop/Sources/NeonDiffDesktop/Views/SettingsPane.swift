import SwiftUI

struct SettingsPane: View {
    @ObservedObject var model: NeonDiffDesktopModel

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

                OperatorSection("Commands") {
                    OperatorCommandText(text: model.statusCommand.commandLine, lineLimit: 5)
                    Button { model.copyCommand(model.statusCommand) } label: {
                        Label("Copy Status Command", systemImage: "doc.on.doc")
                    }
                }
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}
