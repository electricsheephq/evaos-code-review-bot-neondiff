import SwiftUI
import NeonDiffDesktopCore

struct ReposView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            OperatorSection("GitHub Connection") {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 10) {
                        OperatorBadge(
                            text: model.github.userTokenStored ? "USER AUTHORIZED" : "USER NOT CONNECTED",
                            color: model.github.userTokenStored ? NeonDiffTheme.accent : NeonDiffTheme.warning
                        )
                        OperatorBadge(
                            text: model.github.clientIdConfigured ? "CLIENT ID READY" : "CLIENT ID MISSING",
                            color: model.github.clientIdConfigured ? NeonDiffTheme.accent : NeonDiffTheme.warning
                        )
                        OperatorBadge(
                            text: model.github.appIdConfigured ? "APP ID READY" : "APP ID MISSING",
                            color: model.github.appIdConfigured ? NeonDiffTheme.accent : NeonDiffTheme.warning
                        )
                    }

                    Text("Use GitHub App device authorization to discover repositories later. This release keeps tokens in Keychain and persists selected repositories through config patch only.")
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)

                    HStack {
                        Label("Bot: \(model.github.botLogin)", systemImage: "app.connected.to.app.below.fill")
                            .foregroundStyle(NeonDiffTheme.textPrimary)
                        Spacer()
                        Text(model.github.installationState)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                    }
                }
            }

            HStack(spacing: 10) {
                Button { model.inspectConfig() } label: {
                    Label("Load From Config", systemImage: "doc.text.magnifyingglass")
                }
                .accessibilityIdentifier("neondiff-repos-load-config")

                Button { model.refreshStatus() } label: {
                    Label("Refresh Runtime", systemImage: "arrow.clockwise")
                }
                .accessibilityIdentifier("neondiff-repos-refresh-runtime")
            }

            VStack(alignment: .leading, spacing: 10) {
                Text("Monitored Repositories")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.accentSoft)

                Table(model.repos) {
                    TableColumn("Repository") { repo in
                        Text(repo.name)
                            .textSelection(.enabled)
                    }
                    TableColumn("Enabled") { repo in
                        Button { model.toggleRepoAllowlist(repo) } label: {
                            Image(systemName: repo.enabled ? "checkmark.circle.fill" : "pause.circle")
                                .foregroundStyle(repo.enabled ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("neondiff-repo-toggle-\(repo.name)")
                    }
                    TableColumn("Profile", value: \.profile)
                    TableColumn("Last Review", value: \.lastReview)
                    TableColumn("Remove") { repo in
                        Button { model.removeRepoFromAllowlist(repo) } label: {
                            Image(systemName: "minus.circle")
                                .foregroundStyle(NeonDiffTheme.warning)
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("neondiff-repo-remove-\(repo.name)")
                    }
                }
                .scrollContentBackground(.hidden)
                .frame(minHeight: 360)

                HStack(spacing: 10) {
                    TextField("owner/repo", text: $model.pendingRepoName)
                        .textFieldStyle(.roundedBorder)
                        .accessibilityIdentifier("neondiff-repo-name-input")
                    Button { model.addPendingRepoToAllowlist() } label: {
                        Label("Add Repo", systemImage: "plus.circle")
                    }
                    .accessibilityIdentifier("neondiff-repo-add")
                }

                HStack(spacing: 10) {
                    Button { model.previewRepoAllowlistPatch() } label: {
                        Label("Preview Allowlist Patch", systemImage: "eye")
                    }
                    .accessibilityIdentifier("neondiff-repo-preview-patch")

                    Button { model.applyRepoAllowlistPatch() } label: {
                        Label("Apply Allowlist", systemImage: "checkmark.seal")
                    }
                    .accessibilityIdentifier("neondiff-repo-apply-patch")
                }
            }
            .operatorPanel()

            OperatorSection("Boundary") {
                Text("Repo changes are written through `config patch` only; the desktop does not post reviews or bypass daemon gates.")
                    .operatorBodyText()
            }
        }
        .padding(24)
    }
}
