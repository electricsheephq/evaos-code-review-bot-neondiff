import SwiftUI
import NeonDiffDesktopAppCore

struct LogsView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView(.vertical) {
            pageContent
        }
        .accessibilityIdentifier("neondiff-logs-outer-scroll")
        .scrollContentBackground(.hidden)
        .scrollIndicators(.visible, axes: .vertical)
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Button { model.refreshStatus() } label: {
                    Label("Refresh Activity", systemImage: "arrow.clockwise")
                }
            }

            OperatorSection("Current Activity") {
                activityRow(
                    title: "Account and bot",
                    detail: model.existingLocalBotIdentityReady
                        ? "Existing verified bot selected on this Mac"
                        : "Setup or account selection required",
                    ready: model.existingLocalBotIdentityReady
                )
                activityRow(
                    title: "Repository configuration",
                    detail: model.repositorySetupReady
                        ? "\(model.repos.filter(\.enabled).count) configured repositories loaded"
                        : "No applied repository configuration",
                    ready: model.repositorySetupReady
                )
                activityRow(
                    title: "Local worker",
                    detail: model.status.healthState,
                    ready: model.status.runtimeOk == true
                )
            }

            DisclosureGroup {
                VStack(alignment: .leading, spacing: 10) {
                    TextEditor(text: $model.logText)
                        .font(.system(.body, design: .monospaced))
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                        .scrollContentBackground(.hidden)
                        .textSelection(.enabled)
                        .frame(height: 360)
                        .padding(8)
                        .background(Color.black.opacity(0.42))
                        .overlay {
                            AngularRectangle(corner: 10)
                                .stroke(NeonDiffTheme.stroke.opacity(0.7), lineWidth: 0.8)
                        }
                        .clipShape(AngularRectangle(corner: 10))

                    HStack {
                        Button { model.copyCommand(model.statusCommand) } label: {
                            Label("Copy Status Command", systemImage: "doc.on.doc")
                        }
                        Spacer()
                        Text("Redacted output only")
                            .font(.caption)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                    }
                }
                .padding(.top, 10)
            } label: {
                Text("// ADVANCED DIAGNOSTICS")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.accentSoft)
            }
            .operatorPanel()

            OperatorSection("Display Safety") {
                Text("Customer activity is shown separately from raw diagnostics. Diagnostic output is redacted before display; keys, tokens, private keys, and credential URLs must never appear here.")
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(24)
        .overlay(alignment: .bottom) {
            PageBottomSentinel(section: "logs")
        }
    }

    private func activityRow(
        title: String,
        detail: String,
        ready: Bool
    ) -> some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: ready ? "checkmark.circle.fill" : "exclamationmark.circle")
                .foregroundStyle(ready ? NeonDiffTheme.accent : NeonDiffTheme.warning)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.headline)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(NeonDiffTheme.textSecondary)
            }
            Spacer()
        }
    }
}
