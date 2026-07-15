import SwiftUI
import NeonDiffDesktopAppCore

struct LicenseView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 18) {
                if model.activationHandoffEnabled {
                    ActivationStateView(model: model)
                }
                OperatorSection("License") {
                    OperatorTextField(title: "License Key", text: $model.pendingLicenseKey, secure: true)
                    HStack(spacing: 10) {
                        Button { model.storeLicenseKey() } label: {
                            Label("Activation Unavailable", systemImage: "lock.shield")
                        }
                        .disabled(!model.productionUsefulWorkAvailable)
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
                    Text(model.productionActivationBoundaryMessage)
                        .operatorBodyText()
                }
            }
            .padding(24)
            .overlay(alignment: .bottom) {
                PageBottomSentinel(section: "license")
            }
        }
        .accessibilityIdentifier("neondiff-license-outer-scroll")
        .scrollContentBackground(.hidden)
    }
}
