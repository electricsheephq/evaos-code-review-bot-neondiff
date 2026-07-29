import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

// Issue #612 — the native activation surface. Renders the current activation
// state (cause + the ONE recovery action) using the #611 design tokens
// (NDPalette / NDBracketButtonStyle / NDSecondaryButtonStyle / ndSectionLabel),
// never ad-hoc colors. Slots into the CURRENT onboarding wizard frame and the
// License pane; the structural redesign is #519/#523's later work. The entitlement
// credential is always the "NeonDiff Activation Key" — never the "Provider Key".
struct ActivationStateView: View {
    @ObservedObject var model: NeonDiffDesktopModel
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        let palette = NDPalette(scheme: colorScheme)
        Group {
            if model.existingAccountEntitlementSummaryReady,
               let entitlement = model.selectedAccountEntitlementLabel {
                existingAccountEntitlement(entitlement, palette: palette)
            } else if model.existingAccountEntitlementNeedsCurrentAccessVerification,
                      let entitlement = model.selectedAccountEntitlementLabel {
                existingAccountEntitlementRecovery(
                    entitlement,
                    palette: palette
                )
            } else {
                activationFlow(palette: palette)
            }
        }
    }

    private func activationFlow(palette: NDPalette) -> some View {
        let presentation = model.activationPresentation
        return VStack(alignment: .leading, spacing: 14) {
            Text("Activation")
                .ndSectionLabel(palette)

            Text(presentation.title)
                .font(.system(.headline, design: .monospaced).weight(.bold))
                .foregroundStyle(presentation.isSuccess ? palette.accentPrimary : palette.textPrimary)

            Text(
                model.activationTargetSelectionRequired
                    ? "Choose one Review Target in Repositories before activating. The existing worker allowlist will remain unchanged."
                    : presentation.cause
            )
                .font(NDFont.mono)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if presentation.requiresKeyEntry {
                keyField(palette: palette)
            }

            HStack(spacing: 12) {
                if model.activationTargetSelectionRequired {
                    Button("Choose review target") {
                        model.reviewActivationTargetSelection()
                    }
                    .buttonStyle(NDBracketButtonStyle())
                    .accessibilityIdentifier("neondiff.activation.choose-review-target")
                } else if let recovery = presentation.recovery {
                    Button(recovery.label) {
                        Task { await model.performActivationRecovery() }
                    }
                    .buttonStyle(NDBracketButtonStyle())
                    .accessibilityLabel(recovery.accessibilityLabel)
                    .accessibilityIdentifier("neondiff.activation.primary")
                }

                if presentation.showsNotifyOption {
                    Button("Notify me when checkout reopens") {
                        model.requestActivationNotifyWhenCheckoutReopens()
                    }
                    .buttonStyle(NDSecondaryButtonStyle())
                    .accessibilityIdentifier("neondiff.activation.notify")
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(palette.surface))
        .overlay(Rectangle().stroke(palette.borderPrimary, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("neondiff.activation.state.\(presentation.state.rawValue)")
    }

    private func existingAccountEntitlement(
        _ entitlement: String,
        palette: NDPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Activation")
                .ndSectionLabel(palette)

            Text("Active")
                .font(.system(.headline, design: .monospaced).weight(.bold))
                .foregroundStyle(palette.accentPrimary)

            LabeledContent("Account entitlement", value: entitlement)
                .font(NDFont.mono)
                .foregroundStyle(palette.textPrimary)

            Text("This is the authoritative entitlement for the selected existing account and bot. NeonDiff still reverifies the exact repository and current access before starting new work.")
                .font(NDFont.mono)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(palette.surface))
        .overlay(Rectangle().stroke(palette.borderPrimary, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("neondiff.activation.existing-account")
    }

    private func existingAccountEntitlementNeedsVerification(
        _ entitlement: String,
        palette: NDPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Activation")
                .ndSectionLabel(palette)

            Text("Account entitlement active")
                .font(.system(.headline, design: .monospaced).weight(.bold))
                .foregroundStyle(palette.accentPrimary)

            LabeledContent("Account entitlement", value: entitlement)
                .font(NDFont.mono)
                .foregroundStyle(palette.textPrimary)

            Text("Current review access needs reverification")
                .font(NDFont.label)
                .foregroundStyle(palette.warning)

            Text("NeonDiff still blocks new work until the exact GitHub App, repository, and API-backed entitlement are reverified for this launch.")
                .font(NDFont.mono)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button(
                model.existingLocalAgentAccessAvailable
                    ? "Verify existing access"
                    : "Review repository access"
            ) {
                if model.existingLocalAgentAccessAvailable {
                    model.verifyExistingLocalBotGitHubAccess()
                } else {
                    model.reviewExistingBotRepositoryAccess()
                }
            }
            .buttonStyle(NDBracketButtonStyle())
            .disabled(model.isBYOGitHubVerificationInProgress)
            .accessibilityIdentifier("neondiff.activation.existing-account-reverify")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(palette.surface))
        .overlay(Rectangle().stroke(palette.borderPrimary, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            "neondiff.activation.existing-account-verification-required"
        )
    }

    private func existingAccountEntitlementRecovery(
        _ entitlement: String,
        palette: NDPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            existingAccountEntitlementNeedsVerification(
                entitlement,
                palette: palette
            )
            switch model.activationState {
            case .purchaseRequired:
                if !model.existingLocalAgentAccessAvailable {
                    existingAccountActivationRecovery(palette: palette)
                }
            case .active:
                EmptyView()
            default:
                if !model.existingLocalAgentAccessAvailable {
                    activationFlow(palette: palette)
                }
            }
        }
    }

    private func existingAccountActivationRecovery(
        palette: NDPalette
    ) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Native app authorization required")
                .font(.system(.headline, design: .monospaced).weight(.bold))
                .foregroundStyle(palette.textPrimary)

            Text("The selected account is active and the existing local worker stays in place. Use its existing NeonDiff Activation Key to authorize the native app for the selected repository; no new purchase is required.")
                .font(NDFont.mono)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            Button("Use existing activation key") {
                model.applyActivationEvent(.checkoutUnavailable)
            }
            .buttonStyle(NDBracketButtonStyle())
            .accessibilityIdentifier(
                "neondiff.activation.existing-account-use-key"
            )
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(16)
        .background(Rectangle().fill(palette.surface))
        .overlay(Rectangle().stroke(palette.borderPrimary, lineWidth: 1))
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier(
            "neondiff.activation.existing-account-device-recovery"
        )
    }

    private func keyField(palette: NDPalette) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(ActivationTerminology.activationKey)
                .font(NDFont.label)
                .foregroundStyle(palette.textSecondary)
            SecureField(ActivationTerminology.activationKey, text: $model.pendingActivationKey)
                .textFieldStyle(.plain)
                .font(NDFont.mono)
                .foregroundStyle(palette.textPrimary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background(Rectangle().fill(palette.surface))
                .overlay(Rectangle().stroke(palette.borderInput, lineWidth: 1))
                .accessibilityLabel("\(ActivationTerminology.activationKey) entry")
                .accessibilityIdentifier("neondiff.activation.key-field")
            if let prefix = model.activationKeyRedactedPrefix {
                Text("Stored: \(prefix)")
                    .font(NDFont.label)
                    .foregroundStyle(palette.textSecondary)
                    .accessibilityIdentifier("neondiff.activation.key-stored")
            }
        }
    }
}
