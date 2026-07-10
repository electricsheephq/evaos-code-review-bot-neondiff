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
                .disabled(!model.canEditProviderConfiguration)

                OperatorSection("Saved Provider Registry") {
                    Picker("Provider", selection: $model.providers.selectedProviderId) {
                        ForEach(model.providers.registryTargets) { target in
                            Text("\(target.displayName) (\(target.id))").tag(target.id)
                        }
                    }
                    .pickerStyle(.menu)
                    OperatorTextField(title: "Endpoint", text: $model.providers.selectedProviderBaseUrl)
                    OperatorTextField(title: "Model", text: $model.providers.selectedProviderModel)
                    if let target = model.providers.selectedRegistryTarget {
                        Text("\(target.adapter) · \(target.authMode) · \(target.enabled ? "enabled" : "disabled")")
                            .font(.caption)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                    }
                    OperatorTextField(title: "Provider API Key", text: $model.pendingProviderKey, secure: true)
                    HStack(spacing: 10) {
                        Button { model.storeProviderKey() } label: {
                            Label("Store Key", systemImage: "key.fill")
                        }
                        .disabled(!model.canEditProviderConfiguration)
                        Button { model.verifyProviderKey() } label: {
                            Label(
                                model.providerVerificationButtonTitle,
                                systemImage: "checkmark.shield"
                            )
                        }
                        .disabled(!model.canVerifyProviderKey)
                        OperatorBadge(
                            text: model.providers.providerKeyStored ? "Stored in Keychain" : "Not Stored",
                            color: model.providers.providerKeyStored ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary
                        )
                    }
                    Text(model.providerVerificationStatus)
                        .font(.caption)
                        .foregroundStyle(NeonDiffTheme.textSecondary)

                    if let verification = model.providerVerification {
                        ProviderVerificationResultCard(snapshot: verification)
                    }
                }
                .disabled(!model.canEditProviderConfiguration)

                OperatorSection("CLI Equivalent") {
                    OperatorCommandText(text: model.providerPatchPreviewCommand.commandLine, lineLimit: 5)
                    HStack(spacing: 10) {
                        Button { model.previewProviderConfigPatch() } label: {
                            Label("Preview Patch", systemImage: "eye")
                        }
                        .disabled(!model.canPreviewProviderConfig)
                        Button { model.applyProviderConfigPatch() } label: {
                            Label("Apply Patch", systemImage: "checkmark.square")
                        }
                        .disabled(!model.canApplyProviderConfig)
                        Button { model.copyCommand(model.providerPatchPreviewCommand) } label: {
                            Label("Copy Patch Command", systemImage: "doc.on.doc")
                        }
                    }
                }
                .disabled(!model.canEditProviderConfiguration)
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}

private struct ProviderVerificationResultCard: View {
    let snapshot: ProviderVerificationSnapshot

    private var badgeText: String {
        switch snapshot.state {
        case .healthy: "verified"
        case .configuredUnverified: "configured / unverified"
        case .blocked: "blocked"
        }
    }

    private var badgeColor: Color {
        snapshot.isVerified ? NeonDiffTheme.accent : NeonDiffTheme.warning
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                OperatorBadge(text: badgeText, color: badgeColor)
                Text(snapshot.providerId)
                    .font(NeonDiffTheme.commandFont)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                    .textSelection(.enabled)
                Spacer()
            }

            verificationRow("Checked", snapshot.checkedAt)
            verificationRow("Mode", snapshot.mode)
            Text(snapshot.detail)
                .font(.caption)
                .foregroundStyle(NeonDiffTheme.textPrimary)
                .textSelection(.enabled)

            if !snapshot.troubleshooting.isEmpty {
                VStack(alignment: .leading, spacing: 5) {
                    Text("Troubleshooting")
                        .font(NeonDiffTheme.badgeFont)
                        .foregroundStyle(NeonDiffTheme.accentSoft)
                    ForEach(Array(snapshot.troubleshooting.enumerated()), id: \.offset) { _, item in
                        Text("• \(item)")
                            .font(.caption)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .padding(12)
        .background(
            AngularRectangle(corner: 8)
                .fill(NeonDiffTheme.panelRaised)
        )
        .overlay {
            AngularRectangle(corner: 8)
                .stroke(badgeColor.opacity(0.6), lineWidth: 0.8)
        }
    }

    private func verificationRow(_ label: String, _ value: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(label)
                .font(NeonDiffTheme.badgeFont)
                .foregroundStyle(NeonDiffTheme.textSecondary)
                .frame(width: 64, alignment: .leading)
            Text(value)
                .font(NeonDiffTheme.commandFont)
                .foregroundStyle(NeonDiffTheme.textPrimary)
                .textSelection(.enabled)
        }
    }
}
