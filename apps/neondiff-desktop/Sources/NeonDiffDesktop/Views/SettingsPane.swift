import SwiftUI

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

                OperatorSection("Commands") {
                    OperatorCommandText(text: model.statusCommand.commandLine, lineLimit: 5)
                    Button { model.copyCommand(model.statusCommand) } label: {
                        Label("Copy Status Command", systemImage: "doc.on.doc")
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
        }
        .scrollContentBackground(.hidden)
    }
}
