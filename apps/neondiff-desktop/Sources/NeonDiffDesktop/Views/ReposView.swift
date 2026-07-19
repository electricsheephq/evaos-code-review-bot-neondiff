import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct ReposView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ScrollView(.vertical) {
            pageContent
        }
        .accessibilityIdentifier("neondiff-repos-outer-scroll")
        .scrollContentBackground(.hidden)
        .scrollIndicators(.visible, axes: .vertical)
    }

    private var pageContent: some View {
        VStack(alignment: .leading, spacing: 14) {
            if model.managedGitHubAvailable {
                managedGitHubConnection
            } else {
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

                    Text("Use GitHub App device authorization to discover accessible repositories. Tokens stay in Keychain and selected repositories persist through config patch only.")
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)

                    HStack {
                        Label("Bot: \(model.github.botLogin)", systemImage: "app.connected.to.app.below.fill")
                            .foregroundStyle(NeonDiffTheme.textPrimary)
                        Spacer()
                        Text(model.github.installationState)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                    }

                    HStack(spacing: 10) {
                        Button { model.startGitHubAuthorization() } label: {
                            Label(
                                model.github.userTokenStored ? "Reconnect GitHub" : "Connect GitHub",
                                systemImage: "person.crop.circle.badge.checkmark"
                            )
                        }
                        .disabled(
                            !model.github.clientIdConfigured
                                || model.isGitHubAuthorizationInProgress
                                || model.isGitHubRepositoryRefreshInProgress
                        )
                        .accessibilityIdentifier("neondiff-github-connect")

                        Button { model.refreshGitHubRepositories() } label: {
                            Label("Refresh Repositories", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(
                            !model.github.userTokenStored
                                || model.isGitHubRepositoryRefreshInProgress
                                || model.isGitHubAuthorizationInProgress
                        )
                        .accessibilityIdentifier("neondiff-github-refresh-repos")

                        Button { model.openGitHubAppInstallation() } label: {
                            Label("Install / Manage App", systemImage: "shippingbox.and.arrow.backward")
                        }
                        .accessibilityIdentifier("neondiff-github-manage-app")

                        if model.isGitHubAuthorizationInProgress {
                            Button { model.cancelGitHubAuthorization() } label: {
                                Label("Cancel", systemImage: "xmark.circle")
                            }
                            .accessibilityIdentifier("neondiff-github-cancel")
                        }
                    }

                    Text("Use Only select repositories. Core review permissions are Metadata read, Contents read, Pull requests read/write, Checks read, and Actions read. Issues access is only for the separate issue-enrichment feature; organization admin is not a runtime permission.")
                        .font(.caption)
                        .foregroundStyle(NeonDiffTheme.textSecondary)
                        .fixedSize(horizontal: false, vertical: true)

                    if let recovery = model.githubRecovery {
                        HStack(alignment: .top, spacing: 10) {
                            Image(systemName: "exclamationmark.triangle.fill")
                                .foregroundStyle(NeonDiffTheme.warning)
                            Text(recovery.message)
                                .operatorBodyText()
                                .fixedSize(horizontal: false, vertical: true)
                            Spacer()
                            if model.githubRecoveryShowsAction {
                                Button(model.githubRecoveryActionTitle) {
                                    model.performGitHubRecoveryAction()
                                }
                                .disabled(model.isGitHubRepositoryRefreshInProgress)
                                .accessibilityIdentifier("neondiff-github-recovery-action")
                            }
                        }
                        .padding(10)
                        .background(NeonDiffTheme.warning.opacity(0.08), in: RoundedRectangle(cornerRadius: 8))
                    }

                    if let code = model.githubAuthorizationCode {
                        VStack(alignment: .leading, spacing: 8) {
                            HStack(spacing: 10) {
                                Text(code.userCode)
                                    .font(.system(.title3, design: .monospaced).weight(.semibold))
                                    .foregroundStyle(NeonDiffTheme.accentSoft)
                                    .textSelection(.enabled)
                                    .accessibilityIdentifier("neondiff-github-user-code")

                                Button { model.copyGitHubUserCode() } label: {
                                    Label("Copy Code", systemImage: "doc.on.doc")
                                }
                                .accessibilityIdentifier("neondiff-github-copy-code")

                                Button { model.openGitHubDeviceVerification() } label: {
                                    Label("Open GitHub", systemImage: "safari")
                                }
                                .accessibilityIdentifier("neondiff-github-open-device")
                            }

                            Text("Expires \(code.expiresAt.formatted(date: .omitted, time: .shortened)); status: \(model.githubAuthorizationStatus)")
                                .operatorBodyText()
                        }
                    } else {
                        Text("GitHub status: \(model.githubAuthorizationStatus)")
                            .operatorBodyText()
                    }

                    HStack(spacing: 10) {
                        if let login = model.github.authorizedUserLogin {
                            Label("@\(login)", systemImage: "person.crop.circle")
                                .foregroundStyle(NeonDiffTheme.textPrimary)
                        }
                        Label("\(model.github.installationCount) installations", systemImage: "square.stack.3d.up")
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                        Label("\(model.github.discoveredRepositoryCount) repos discovered", systemImage: "folder.badge.plus")
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                    }
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
                        .disabled(model.managedGitHubAvailable)
                        .accessibilityIdentifier("neondiff-repo-toggle-\(repo.name)")
                    }
                    TableColumn("Profile", value: \.profile)
                    TableColumn("Access") { repo in
                        if let cue = model.githubAccessCue(for: repo) {
                            Text(cue.label)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(
                                    cue == .licenseRequired || cue == .insufficientReadAccess
                                        ? NeonDiffTheme.warning
                                        : NeonDiffTheme.accent
                                )
                        } else {
                            Text("MANUAL · VERIFY INSTALL")
                                .font(.caption)
                                .foregroundStyle(NeonDiffTheme.textSecondary)
                        }
                    }
                    TableColumn("Last Review", value: \.lastReview)
                    TableColumn("Remove") { repo in
                        Button { model.removeRepoFromAllowlist(repo) } label: {
                            Image(systemName: "minus.circle")
                                .foregroundStyle(NeonDiffTheme.warning)
                        }
                        .buttonStyle(.plain)
                        .disabled(model.managedGitHubAvailable)
                        .accessibilityIdentifier("neondiff-repo-remove-\(repo.name)")
                    }
                }
                .scrollContentBackground(.hidden)
                .frame(height: 360)

                if !model.managedGitHubAvailable {
                    HStack(spacing: 10) {
                        TextField("owner/repo", text: $model.pendingRepoName)
                            .textFieldStyle(.roundedBorder)
                            .accessibilityIdentifier("neondiff-repo-name-input")
                        Button { model.addPendingRepoToAllowlist() } label: {
                            Label("Add Repo", systemImage: "plus.circle")
                        }
                        .accessibilityIdentifier("neondiff-repo-add")
                    }
                }

                if !model.discoveredGitHubRepos.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Discovered From GitHub")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NeonDiffTheme.textPrimary)

                        ForEach(model.discoveredGitHubRepos.prefix(8)) { repo in
                            HStack(spacing: 8) {
                                Image(systemName: repo.visibility == "private" ? "lock.fill" : "globe")
                                    .foregroundStyle(repo.visibility == "private" ? NeonDiffTheme.warning : NeonDiffTheme.accent)
                                Text(repo.fullName)
                                    .textSelection(.enabled)
                                Spacer()
                                VStack(alignment: .trailing, spacing: 2) {
                                    let cue = GitHubRepositoryAccessPolicy.cue(
                                        for: repo,
                                        licenseEntitlement: model.license.entitlement
                                    )
                                    Text(cue.label)
                                        .font(.caption.weight(.semibold))
                                        .foregroundStyle(
                                            cue == .licenseRequired || cue == .insufficientReadAccess
                                                ? NeonDiffTheme.warning
                                                : NeonDiffTheme.accent
                                        )
                                    Text(repo.permissionsSummary)
                                        .foregroundStyle(NeonDiffTheme.textSecondary)
                                }
                            }
                            .font(.body)
                        }
                    }
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
                    .accessibilityIdentifier("neondiff-repos-boundary")
            }
        }
        .padding(24)
        .overlay(alignment: .bottom) {
            PageBottomSentinel(section: "repos")
        }
        .disabled(!model.canEditProviderConfiguration)
    }

    private var managedGitHubConnection: some View {
        OperatorSection("Managed GitHub Connection") {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    OperatorBadge(
                        text: model.managedGitHubStatusText,
                        color: model.isManagedGitHubBound
                            ? NeonDiffTheme.accent
                            : NeonDiffTheme.warning
                    )
                    Spacer()
                    if model.managedGitHubConnectionState == .verificationRequired {
                        Button { model.refreshManagedGitHubRepositories() } label: {
                            Label("Verify Binding", systemImage: "checkmark.shield")
                        }
                        .disabled(model.isManagedGitHubConnectionInProgress)
                        .accessibilityIdentifier("neondiff-managed-github-verify")
                    } else if !model.isManagedGitHubBound {
                        Button { model.startManagedGitHubConnection() } label: {
                            Label("Connect GitHub", systemImage: "person.crop.circle.badge.checkmark")
                        }
                        .disabled(model.isManagedGitHubConnectionInProgress)
                        .accessibilityIdentifier("neondiff-managed-github-connect")
                    } else {
                        Button { model.refreshManagedGitHubRepositories() } label: {
                            Label("Refresh Bound Repositories", systemImage: "arrow.triangle.2.circlepath")
                        }
                        .disabled(model.isManagedGitHubConnectionInProgress)
                        .accessibilityIdentifier("neondiff-managed-github-refresh")
                    }
                }

                Text("The paid-beta path uses the server broker and Keychain-backed device identity. Existing installations may use a transient GitHub user authorization only to prove the selected installation; it is never stored or used to post reviews. Repository scope, visibility, and review credentials come only from the verified GitHub App binding.")
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)

                if let recovery = model.managedGitHubRecovery {
                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .foregroundStyle(NeonDiffTheme.warning)
                        Text(recovery.message)
                            .operatorBodyText()
                            .fixedSize(horizontal: false, vertical: true)
                        Spacer()
                        Button("Retry") {
                            model.performManagedGitHubRecoveryAction()
                        }
                        .disabled(model.isManagedGitHubConnectionInProgress)
                        .accessibilityIdentifier("neondiff-managed-github-recovery")
                    }
                }

                if let code = model.githubAuthorizationCode,
                   model.managedGitHubConnectionState == .awaitingAuthorization {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Authorize existing installation")
                            .font(.subheadline.weight(.semibold))
                        Text(code.userCode)
                            .font(NeonDiffTheme.commandFont)
                            .textSelection(.enabled)
                            .accessibilityIdentifier("neondiff-managed-github-device-code")
                        HStack(spacing: 10) {
                            Button("Copy Code") { model.copyGitHubUserCode() }
                            Button("Open GitHub") { model.openGitHubDeviceVerification() }
                        }
                    }
                }

                if !model.managedGitHubInstallationCandidates.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Choose the App installation to bind")
                            .font(.subheadline.weight(.semibold))
                        ForEach(model.managedGitHubInstallationCandidates) { candidate in
                            Button {
                                model.selectManagedGitHubInstallation(
                                    installationId: candidate.installationId
                                )
                            } label: {
                                HStack {
                                    VStack(alignment: .leading, spacing: 2) {
                                        Text(candidate.account)
                                        Text("Installation \(candidate.installationId) · \(candidate.repositoryCount) repositories")
                                            .font(.caption)
                                    }
                                    Spacer()
                                    Image(systemName: "chevron.right")
                                }
                            }
                            .buttonStyle(.plain)
                            .accessibilityIdentifier(
                                "neondiff-managed-github-installation-\(candidate.installationId)"
                            )
                        }
                    }
                }

                if let selected = model.selectedManagedGitHubRepository {
                    Label("Selected: \(selected)", systemImage: "checkmark.circle.fill")
                        .foregroundStyle(NeonDiffTheme.accent)
                }

                if !model.managedGitHubRepositories.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("Server-bound repositories")
                            .font(.subheadline.weight(.semibold))
                            .foregroundStyle(NeonDiffTheme.textPrimary)
                        ForEach(model.managedGitHubRepositories, id: \.fullName) { repository in
                            Button {
                                model.selectManagedGitHubRepository(fullName: repository.fullName)
                            } label: {
                                HStack {
                                    Image(systemName: repository.visibility == .public ? "globe" : "lock.fill")
                                    Text(repository.fullName)
                                    Spacer()
                                    Text(repository.visibility == .unknown
                                        ? "VISIBILITY BLOCKED"
                                        : repository.visibility.rawValue.uppercased())
                                        .font(.caption.weight(.semibold))
                                    if model.selectedManagedGitHubRepository == repository.fullName {
                                        Image(systemName: "checkmark.circle.fill")
                                            .foregroundStyle(NeonDiffTheme.accent)
                                    }
                                }
                            }
                            .buttonStyle(.plain)
                            .disabled(repository.visibility == .unknown)
                            .accessibilityIdentifier("neondiff-managed-repository-\(repository.fullName)")
                        }
                    }
                }
            }
        }
    }
}
