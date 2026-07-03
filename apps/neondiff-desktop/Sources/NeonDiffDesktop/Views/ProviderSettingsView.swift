import SwiftUI
import NeonDiffDesktopCore

struct ProviderSettingsView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                OperatorSection("ZCode / GLM") {
                    OperatorTextField(title: "Model", text: $model.providers.zcodeModel)
                    OperatorTextField(title: "CLI Path", text: $model.providers.zcodeCliPath)
                    OperatorTextField(title: "App Config Path", text: $model.providers.zcodeAppConfigPath)
                }

                OperatorSection("OpenAI-Compatible Endpoint") {
                    OperatorTextField(title: "Endpoint", text: $model.providers.openAICompatibleEndpoint)
                    OperatorTextField(title: "Provider API Key", text: $model.pendingProviderKey, secure: true)
                    HStack(spacing: 10) {
                        Button { model.storeProviderKey() } label: {
                            Label("Store Key", systemImage: "key.fill")
                        }
                        OperatorBadge(
                            text: model.providers.providerKeyStored ? "Stored in Keychain" : "Not Stored",
                            color: model.providers.providerKeyStored ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary
                        )
                    }
                }

                OperatorSection("CLI Equivalent") {
                    OperatorCommandText(text: model.providerPatchPreviewCommand.commandLine, lineLimit: 5)
                    HStack(spacing: 10) {
                        Button { model.previewProviderConfigPatch() } label: {
                            Label("Preview Patch", systemImage: "eye")
                        }
                        Button { model.applyProviderConfigPatch() } label: {
                            Label("Apply Patch", systemImage: "checkmark.square")
                        }
                        Button { model.copyCommand(model.providerPatchPreviewCommand) } label: {
                            Label("Copy Patch Command", systemImage: "doc.on.doc")
                        }
                    }
                }
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}
