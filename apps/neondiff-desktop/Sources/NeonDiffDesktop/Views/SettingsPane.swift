import SwiftUI

struct SettingsPane: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        Form {
            Section("Local Paths") {
                TextField("NeonDiff CLI", text: $model.cliPath)
                TextField("Config", text: $model.configPath)
                TextField("Launchd Label", text: $model.launchdLabel)
                Button("Save Local Settings") { model.persistLocalSettings() }
            }

            Section("Commands") {
                Text(model.statusCommand.commandLine)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                Button("Copy Status Command") { model.copyCommand(model.statusCommand) }
            }
        }
        .formStyle(.grouped)
        .padding(20)
    }
}
