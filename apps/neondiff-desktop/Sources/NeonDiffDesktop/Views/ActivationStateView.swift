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
        let presentation = model.activationPresentation

        VStack(alignment: .leading, spacing: 14) {
            Text("Activation")
                .ndSectionLabel(palette)

            Text(presentation.title)
                .font(.system(.headline, design: .monospaced).weight(.bold))
                .foregroundStyle(presentation.isSuccess ? palette.accentPrimary : palette.textPrimary)

            Text(presentation.cause)
                .font(NDFont.mono)
                .foregroundStyle(palette.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            if presentation.requiresKeyEntry {
                keyField(palette: palette)
            }

            HStack(spacing: 12) {
                if let recovery = presentation.recovery {
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
