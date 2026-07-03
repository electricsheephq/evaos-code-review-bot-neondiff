import SwiftUI
import NeonDiffDesktopCore

struct ProviderSettingsView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        Form {
            Section("ZCode / GLM") {
                TextField("Model", text: $model.providers.zcodeModel)
                TextField("CLI Path", text: $model.providers.zcodeCliPath)
                TextField("App Config Path", text: $model.providers.zcodeAppConfigPath)
            }

            Section("OpenAI-Compatible Endpoint") {
                TextField("Endpoint", text: $model.providers.openAICompatibleEndpoint)
                SecureField("Provider API Key", text: $model.pendingProviderKey)
                HStack {
                    Button("Store Key") { model.storeProviderKey() }
                    Label(model.providers.providerKeyStored ? "Stored in Keychain" : "Not stored", systemImage: model.providers.providerKeyStored ? "checkmark.seal" : "key")
                        .foregroundStyle(model.providers.providerKeyStored ? .green : .secondary)
                }
            }

            Section("CLI Equivalent") {
                Text(model.providerPatchPreviewCommand.commandLine)
                    .font(.system(.callout, design: .monospaced))
                    .textSelection(.enabled)
                HStack {
                    Button("Preview Patch") { model.previewProviderConfigPatch() }
                    Button("Apply Patch") { model.applyProviderConfigPatch() }
                    Button("Copy Patch Command") { model.copyCommand(model.providerPatchPreviewCommand) }
                }
            }
        }
        .formStyle(.grouped)
        .padding(20)
    }
}
