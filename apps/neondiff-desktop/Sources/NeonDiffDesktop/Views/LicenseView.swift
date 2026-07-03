import SwiftUI

struct LicenseView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                OperatorSection("License") {
                    OperatorTextField(title: "License Key", text: $model.pendingLicenseKey, secure: true)
                    HStack(spacing: 10) {
                        Button { model.storeLicenseKey() } label: {
                            Label("Store License", systemImage: "key.fill")
                        }
                        OperatorBadge(
                            text: model.license.keyStored ? "Stored Locally" : "No Key Stored",
                            color: model.license.keyStored ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary
                        )
                    }
                    Divider()
                        .overlay(NeonDiffTheme.stroke.opacity(0.6))
                    LabeledContent("Entitlement", value: model.license.entitlement)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                    LabeledContent("Update Channel", value: model.license.updateChannel)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                }

                OperatorSection("Boundary") {
                    Text("This MVP stores a fake/local license key only. Activation, signed updater behavior, and downloadable app readiness remain separate release work.")
                        .operatorBodyText()
                }
            }
            .padding(24)
        }
        .scrollContentBackground(.hidden)
    }
}
