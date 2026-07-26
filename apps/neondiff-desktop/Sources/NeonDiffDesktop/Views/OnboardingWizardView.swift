import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct OnboardingWizardView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        VStack(spacing: 0) {
            header
                .padding(.horizontal, 18)
                .padding(.top, 16)
                .padding(.bottom, 12)

            Rectangle()
                .fill(NeonDiffTheme.stroke.opacity(0.35))
                .frame(height: 1)

            stepList
                .padding(.horizontal, 18)
                .padding(.vertical, 12)

            stepContent
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                .padding(.horizontal, 18)

            footer
                .padding(18)
        }
        .background(NeonDiffTheme.chrome)
        .overlay(alignment: .leading) {
            Rectangle()
                .fill(NeonDiffTheme.accent.opacity(0.64))
                .frame(width: 1)
        }
        .hostedOnboardingEvaluationRegion("neondiff-onboarding-wizard")
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(spacing: 10) {
                Text("• SETUP // \(String(format: "%02d", currentStepNumber))")
                    .font(.system(.caption, design: .monospaced).weight(.semibold))
                    .tracking(0.8)
                    .foregroundStyle(NeonDiffTheme.accent)

                Spacer()

                Button {
                    model.dismissOnboardingPanel()
                } label: {
                    Image(systemName: "xmark")
                        .font(.system(size: 14, weight: .medium))
                        .frame(width: 28, height: 28)
                }
                .buttonStyle(.plain)
                .foregroundStyle(NeonDiffTheme.textPrimary)
                .help("Close setup and continue in read-only mode.")
                .accessibilityIdentifier("neondiff-onboarding-dismiss")
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("STEP \(currentStepNumber) OF \(OnboardingStep.allCases.count)")
                    .font(.system(.caption2, design: .monospaced).weight(.semibold))
                    .foregroundStyle(NeonDiffTheme.accent)

                Text(model.onboardingFlow.currentStep.title.uppercased())
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                    .accessibilityIdentifier(
                        "neondiff-onboarding-current-step-\(model.onboardingFlow.currentStep.rawValue)"
                    )

                Text(stepSubtitle)
                    .font(.callout)
                    .foregroundStyle(NeonDiffTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .hostedOnboardingEvaluationRegion("neondiff-onboarding-header")
    }

    private var stepList: some View {
        HStack(spacing: 7) {
            ForEach(Array(OnboardingStep.allCases.enumerated()), id: \.element.id) { index, step in
                Capsule()
                    .fill(index < currentStepNumber ? NeonDiffTheme.accent : NeonDiffTheme.panelRaised)
                    .frame(maxWidth: .infinity)
                    .frame(height: 3)
                    .accessibilityLabel(step.title)
                    .accessibilityValue(index < currentStepNumber ? "reached" : "upcoming")
            }
        }
        .hostedOnboardingEvaluationRegion("neondiff-onboarding-step-list")
    }

    private var currentStepNumber: Int {
        (OnboardingStep.allCases.firstIndex(of: model.onboardingFlow.currentStep) ?? 0) + 1
    }

    private var stepSubtitle: String {
        switch model.onboardingFlow.currentStep {
        case .welcome:
            "Connect GitHub and choose the repository you want NeonDiff to review."
        case .provider:
            "Choose and verify the model provider that will analyze your pull requests."
        case .daemon:
            "Check the local review worker before starting a review."
        case .license:
            "Activate access for the selected repository without exposing your key."
        case .done:
            "Review your setup, then finish or continue in read-only mode."
        }
    }

    @ViewBuilder
    private var stepContent: some View {
        Group {
            switch model.onboardingFlow.currentStep {
            case .welcome:
                welcomeStep
            case .provider:
                providerStep
            case .daemon:
                daemonStep
            case .license:
                licenseStep
            case .done:
                doneStep
            }
        }
        .hostedOnboardingEvaluationRegion("neondiff-onboarding-step-content")
    }

    private var welcomeStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                if model.existingLocalBotReconciliationMode {
                    existingLocalBotSection
                    if model.managedGitHubAvailable {
                        managedGitHubSection
                    } else if model.byoGitHubCredentialOnboardingAvailable {
                        byoGitHubSection
                    }
                } else if model.managedGitHubAvailable {
                    managedGitHubSection
                } else if model.byoGitHubCredentialOnboardingAvailable {
                    byoGitHubSection
                } else {
                    OperatorSection("Mode") {
                        Picker("Review Mode", selection: $model.onboardingFlow.mode) {
                            ForEach(OnboardingMode.allCases) { mode in
                                Text(mode.title).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)

                        Text("All repository review work requires live API-backed activation. This desktop build cannot yet prove the native activation broker, so onboarding cannot complete.")
                            .operatorBodyText()
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                OperatorSection("Authority") {
                    Text(model.managedGitHubAvailable
                        ? "Repository visibility and installation scope come only from the production GitHub broker. Public repositories are free; private and internal repositories require API-backed activation. Unknown visibility fails closed."
                        : "Desktop configures local state and starts CLI-backed checks. GitHub reviews still go through the daemon and its current-head safety gates.")
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var existingLocalBotSection: some View {
        OperatorSection("Existing Bot Detected") {
            OperatorBadge(
                text: model.existingLocalBotSetupReady ? "SETUP CONFIGURED" : "RECOVERY NEEDED",
                color: model.existingLocalBotSetupReady ? NeonDiffTheme.accent : NeonDiffTheme.warning
            )

            Text("NeonDiff matched this Mac’s local config to a server-verified bot in the selected account. Existing credentials remain in their current approved stores; setup will not initialize or overwrite the config.")
                .operatorBodyText()
                .fixedSize(horizontal: false, vertical: true)

            if let bot = model.selectedBotInstallation {
                LabeledContent("Bot", value: bot.appSlug)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent(
                    "GitHub",
                    value: model.githubSetupReady ? "connected" : "recovery required"
                )
                .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent(
                    "Repositories",
                    value: model.repositorySetupReady
                        ? "\(model.repos.filter(\.enabled).count) applied"
                        : "recovery required"
                )
                .foregroundStyle(NeonDiffTheme.textPrimary)
            }

            Text(model.customerRuntimeBoundaryMessage)
                .font(.caption)
                .foregroundStyle(NeonDiffTheme.warning)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var byoGitHubSection: some View {
        OperatorSection("Customer-owned GitHub App") {
            HStack(spacing: 10) {
                OperatorBadge(
                    text: model.byoGitHubAppIdStored ? "APP ID STORED" : "APP ID NEEDED",
                    color: model.byoGitHubAppIdStored ? NeonDiffTheme.accent : NeonDiffTheme.warning
                )
                OperatorBadge(
                    text: model.byoGitHubPrivateKeyStored ? "KEYCHAIN KEY STORED" : "PRIVATE KEY NEEDED",
                    color: model.byoGitHubPrivateKeyStored ? NeonDiffTheme.accent : NeonDiffTheme.warning
                )
            }

            Text("This invite-only technical beta uses a GitHub App owned by you. Paste the App ID and its unencrypted private-key PEM. The private key is stored only in this Mac's Keychain and plaintext input is cleared after every attempt.")
                .operatorBodyText()
                .fixedSize(horizontal: false, vertical: true)

            OperatorTextField(
                title: "GitHub App ID",
                text: $model.pendingBYOGitHubAppId
            )
            .accessibilityIdentifier("neondiff-onboarding-byo-github-app-id")

            OperatorTextField(
                title: "GitHub App Private Key PEM",
                text: $model.pendingBYOGitHubAppPrivateKey,
                secure: true
            )
            .accessibilityIdentifier("neondiff-onboarding-byo-github-private-key")

            HStack(alignment: .top, spacing: 10) {
                Image(systemName: "lock.fill")
                    .foregroundStyle(NeonDiffTheme.accent)
                Text("Your private key is stored securely in macOS Keychain and never written to the NeonDiff config.")
                    .font(.caption)
                    .foregroundStyle(NeonDiffTheme.textSecondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(12)
            .background(NeonDiffTheme.panelRaised.opacity(0.55))
            .overlay(
                RoundedRectangle(cornerRadius: 7)
                    .stroke(NeonDiffTheme.stroke.opacity(0.45), lineWidth: 1)
            )

            HStack(spacing: 10) {
                Button("SAVE CONNECTION") {
                    model.storeBYOGitHubAppCredentials()
                }
                .disabled(
                    model.pendingBYOGitHubAppId.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || model.pendingBYOGitHubAppPrivateKey.isEmpty
                )
                .accessibilityIdentifier("neondiff-onboarding-byo-github-store")

                Button("Remove Credentials", role: .destructive) {
                    model.clearBYOGitHubAppCredentials()
                }
                .disabled(!model.byoGitHubAppIdStored && !model.byoGitHubPrivateKeyStored)
                .accessibilityIdentifier("neondiff-onboarding-byo-github-clear")
            }

            Text(model.byoGitHubCredentialStatus)
                .font(.caption)
                .foregroundStyle(model.byoGitHubCredentialsVerified ? NeonDiffTheme.accent : NeonDiffTheme.warning)
                .fixedSize(horizontal: false, vertical: true)

            Divider()
                .overlay(NeonDiffTheme.stroke.opacity(0.54))

            Text("Repository to review")
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(NeonDiffTheme.textPrimary)

            Text("B0 onboarding supports one repository at a time. On a clean install, initialize the local config first. This never overwrites an existing config. Then add owner/repo, apply that allowlist, and verify the customer-owned App installation.")
                .operatorBodyText()
                .fixedSize(horizontal: false, vertical: true)

            Button { model.initializeConfigForOnboarding() } label: {
                Label(
                    model.isConfigInitializationInProgress ? "Initializing…" : "Initialize Local Config",
                    systemImage: "doc.badge.plus"
                )
            }
            .disabled(
                !model.canEditProviderConfiguration
                    || model.isConfigInitializationInProgress
                    || model.isConfigPatchInProgress
                    || model.isConfigInspectInProgress
            )
            .accessibilityIdentifier("neondiff-onboarding-byo-config-initialize")

            Text(model.configInitializationStatus)
                .font(.caption)
                .foregroundStyle(NeonDiffTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)

            HStack(spacing: 10) {
                OperatorTextField(
                    title: "owner/repo",
                    text: $model.pendingRepoName
                )
                .accessibilityIdentifier("neondiff-onboarding-byo-repository")

                Button { model.addPendingRepoToAllowlist() } label: {
                    Label("Add Repository", systemImage: "plus.circle")
                }
                .disabled(
                    model.pendingRepoName.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                        || !model.canEditProviderConfiguration
                        || model.isConfigInitializationInProgress
                        || model.isConfigPatchInProgress
                        || model.isConfigInspectInProgress
                )
                .accessibilityIdentifier("neondiff-onboarding-byo-repository-add")
            }

            ForEach(model.repos.filter(\.enabled)) { repository in
                HStack(spacing: 10) {
                    Text(repository.name)
                        .font(NeonDiffTheme.commandFont)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                        .textSelection(.enabled)

                    Spacer()

                    Button(role: .destructive) {
                        model.removeRepoFromAllowlist(repository)
                    } label: {
                        Label("Remove", systemImage: "minus.circle")
                    }
                    .disabled(
                        !model.canEditProviderConfiguration
                            || model.isConfigInitializationInProgress
                            || model.isConfigPatchInProgress
                            || model.isConfigInspectInProgress
                    )
                    .accessibilityIdentifier("neondiff-onboarding-byo-repository-remove-\(repository.name)")
                }
            }

            HStack(spacing: 10) {
                Button { model.applyRepoAllowlistPatch() } label: {
                    Label("Apply Repository", systemImage: "checkmark.seal")
                }
                .disabled(
                    model.repos.filter(\.enabled).count != 1
                        || !model.canEditProviderConfiguration
                        || model.isConfigInitializationInProgress
                        || model.isConfigPatchInProgress
                        || model.isConfigInspectInProgress
                )
                .accessibilityIdentifier("neondiff-onboarding-byo-repository-apply")

                Button { model.verifyBYOGitHubAppCredentials() } label: {
                    Label(
                        model.isBYOGitHubVerificationInProgress ? "Verifying…" : "Verify App Access",
                        systemImage: "checkmark.shield"
                    )
                }
                .disabled(
                    !model.byoGitHubCredentialsStored
                        || model.repos.filter(\.enabled).count != 1
                        || !model.canEditProviderConfiguration
                        || model.isConfigInitializationInProgress
                        || model.isConfigPatchInProgress
                        || model.isConfigInspectInProgress
                        || model.isBYOGitHubVerificationInProgress
                )
                .accessibilityIdentifier("neondiff-onboarding-byo-github-verify")
            }

            Text("Continue becomes available only after GitHub verifies the exact configured repository through this App installation. A dry run and live review remain separate gates and are not claimed here.")
                .font(.caption)
                .foregroundStyle(NeonDiffTheme.textSecondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var managedGitHubSection: some View {
        OperatorSection("GitHub Authorization") {
            HStack(spacing: 10) {
                OperatorBadge(
                    text: model.managedGitHubStatusText,
                    color: model.managedGitHubConnectionState.isBound
                        ? NeonDiffTheme.accent
                        : NeonDiffTheme.warning
                )

                Spacer()

                if model.managedGitHubConnectionState == .verificationRequired {
                    Button { model.refreshManagedGitHubRepositories() } label: {
                        Label("Verify Binding", systemImage: "checkmark.shield")
                    }
                    .disabled(model.isManagedGitHubConnectionInProgress)
                    .accessibilityIdentifier("neondiff-onboarding-github-verify")
                } else if !model.managedGitHubConnectionState.isBound {
                    Button { model.startManagedGitHubConnection() } label: {
                        Label("Connect GitHub", systemImage: "person.crop.circle.badge.checkmark")
                    }
                    .disabled(model.isManagedGitHubConnectionInProgress)
                    .accessibilityIdentifier("neondiff-onboarding-github-connect")
                }
            }

            if let recovery = model.managedGitHubRecovery {
                VStack(alignment: .leading, spacing: 8) {
                    Text(recovery.message)
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                    Button("Retry Managed GitHub") {
                        model.performManagedGitHubRecoveryAction()
                    }
                    .disabled(model.isManagedGitHubConnectionInProgress)
                    .accessibilityIdentifier("neondiff-onboarding-github-recovery")
                }
            }

            if let code = model.githubAuthorizationCode,
               model.managedGitHubConnectionState == .awaitingAuthorization {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Authorize the existing App installation")
                        .font(.subheadline.weight(.semibold))
                    Text(code.userCode)
                        .font(NeonDiffTheme.commandFont)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("neondiff-onboarding-github-device-code")
                    HStack(spacing: 10) {
                        Button("Copy Code") { model.copyGitHubUserCode() }
                        Button("Open GitHub") { model.openGitHubDeviceVerification() }
                    }
                    Text("This user authorization proves installation access only. NeonDiff never stores it or uses it to post reviews; review credentials remain GitHub App installation tokens.")
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }

            if !model.managedGitHubInstallationCandidates.isEmpty {
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
                                Text("Installation \(candidate.installationId) · \(candidate.repositoryCount) accessible repositories")
                                    .font(.caption)
                            }
                            Spacer()
                            Image(systemName: "chevron.right")
                        }
                    }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier(
                        "neondiff-onboarding-github-installation-\(candidate.installationId)"
                    )
                }
            }

            if !model.managedGitHubRepositories.isEmpty {
                Text("Choose one server-bound repository")
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(NeonDiffTheme.textPrimary)

                ForEach(model.managedGitHubRepositories, id: \.fullName) { repository in
                    Button {
                        model.selectManagedGitHubRepository(fullName: repository.fullName)
                    } label: {
                        HStack(spacing: 10) {
                            Image(systemName: repository.visibility == .public ? "globe" : "lock.fill")
                            VStack(alignment: .leading, spacing: 2) {
                                Text(repository.fullName)
                                Text(repository.visibility == .unknown
                                    ? "Visibility unavailable · blocked"
                                    : repository.visibility.rawValue.capitalized)
                                    .font(.caption)
                            }
                            Spacer()
                            if model.selectedManagedGitHubRepository == repository.fullName {
                                Image(systemName: "checkmark.circle.fill")
                                    .foregroundStyle(NeonDiffTheme.accent)
                            }
                        }
                    }
                    .buttonStyle(.plain)
                    .disabled(repository.visibility == .unknown)
                    .accessibilityLabel(
                        "\(repository.fullName), \(repository.visibility.rawValue)"
                    )
                    .accessibilityIdentifier(
                        "neondiff-onboarding-repository-\(repository.fullName)"
                    )
                }

                Button { model.applyRepoAllowlistPatch() } label: {
                    Label("Apply Repository", systemImage: "checkmark.shield")
                }
                .disabled(
                    model.selectedManagedGitHubRepository == nil
                        || model.isConfigPatchInProgress
                        || model.isConfigInspectInProgress
                )
                .accessibilityIdentifier("neondiff-onboarding-repository-apply")
            }
        }
    }

    private var providerStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                OperatorSection("Provider") {
                    OperatorTextField(title: "Model", text: $model.providers.zcodeModel)
                    OperatorTextField(title: "CLI Path", text: $model.providers.zcodeCliPath)
                    OperatorTextField(title: "App Config Path", text: $model.providers.zcodeAppConfigPath)
                    OperatorTextField(title: "OpenAI-Compatible Endpoint", text: $model.providers.openAICompatibleEndpoint)
                    if model.selectedProviderRequiresAPIKey {
                        OperatorTextField(
                            title: "Provider API Key",
                            text: $model.pendingProviderKey,
                            secure: true
                        )

                        HStack(spacing: 10) {
                            Button { model.storeProviderKey() } label: {
                                Label("Store Key", systemImage: "key.fill")
                            }
                            OperatorBadge(
                                text: model.providers.providerKeyStored ? "Stored in Keychain" : "Key Required",
                                color: model.providers.providerKeyStored ? NeonDiffTheme.accent : NeonDiffTheme.warning
                            )
                        }
                    } else {
                        OperatorBadge(
                            text: model.providerSetupReady ? "APP CONFIG LOADED" : "CONFIG REQUIRED",
                            color: model.providerSetupReady ? NeonDiffTheme.accent : NeonDiffTheme.warning
                        )
                        Text("This provider uses its own app/config authentication path. No separate NeonDiff provider key is required.")
                            .operatorBodyText()
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if !model.existingLocalBotReconciliationMode {
                    OperatorSection("Config Patch") {
                        OperatorCommandText(text: model.providerPatchPreviewCommand.commandLine, lineLimit: 4)
                        HStack(spacing: 10) {
                            Button { model.previewProviderConfigPatch() } label: {
                                Label("Preview", systemImage: "eye")
                            }
                            Button { model.copyCommand(model.providerPatchPreviewCommand) } label: {
                                Label("Copy", systemImage: "doc.on.doc")
                            }
                        }
                    }
                }

                if let lastError = model.lastError, !lastError.isEmpty {
                    OperatorSection("Latest CLI Result") {
                        Text(lastError)
                            .font(NeonDiffTheme.commandFont)
                            .foregroundStyle(NeonDiffTheme.warning)
                            .textSelection(.enabled)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    private var daemonStep: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 16) {
                OperatorSection("Daemon") {
                    LabeledContent("Heartbeat", value: model.status.healthState)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                    LabeledContent("Config", value: model.configPath)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                    LabeledContent("Launchd Label", value: model.launchdLabel)
                        .foregroundStyle(NeonDiffTheme.textPrimary)

                    OperatorCommandText(text: model.statusCommand.commandLine, lineLimit: 4)

                    VStack(alignment: .leading, spacing: 10) {
                        HStack(spacing: 10) {
                            Button { model.refreshStatus() } label: {
                                Label("Check Status", systemImage: "arrow.clockwise")
                            }
                            Button { model.startDaemon() } label: {
                                Label("Start/Restart", systemImage: "play.circle")
                            }
                            .disabled(!model.productionUsefulWorkAvailable)
                            Button { model.stopDaemon() } label: {
                                Label("Stop", systemImage: "stop.circle")
                            }
                            .disabled(!model.productionDaemonStopAvailable)
                        }

                        HStack(spacing: 10) {
                            Button { model.previewStartDaemon() } label: {
                                Label("Preview Start", systemImage: "eye")
                            }
                            .disabled(!model.productionUsefulWorkAvailable)
                            Button { model.copyCommand(model.statusCommand) } label: {
                                Label("Copy Status", systemImage: "doc.on.doc")
                            }
                        }
                    }

                    OperatorBadge(
                        text: model.onboardingFlow.daemonBootstrapChecked ? "Checked" : "Check Required",
                        color: model.onboardingFlow.daemonBootstrapChecked ? NeonDiffTheme.accent : NeonDiffTheme.warning
                    )
                    Text(model.customerRuntimeBoundaryMessage)
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                }

                if !model.repos.isEmpty {
                    OperatorSection("Monitored Repos") {
                        Text(model.repos.map(\.name).prefix(6).joined(separator: "\n"))
                            .font(NeonDiffTheme.commandFont)
                            .foregroundStyle(NeonDiffTheme.textSecondary)
                            .textSelection(.enabled)
                    }
                }
            }
        }
        .scrollContentBackground(.hidden)
    }

    @ViewBuilder
    private var licenseStep: some View {
        if model.activationHandoffEnabled {
            VStack(alignment: .leading, spacing: 16) {
                ActivationStateView(model: model)
            }
            .onAppear { model.syncActivationEntryFromOnboardingMode() }
        } else {
            legacyLicenseStep
        }
    }

    private var legacyLicenseStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            OperatorSection("License") {
                OperatorTextField(title: "License Key", text: $model.pendingLicenseKey, secure: true)

                HStack(spacing: 10) {
                    Button { model.activateLicenseForOnboarding() } label: {
                        Label("Activation Unavailable", systemImage: "lock.shield")
                    }
                    .disabled(!model.productionUsefulWorkAvailable)
                    OperatorBadge(
                        text: model.onboardingFlow.licenseActivation == .activated ? "Activated" : "Activation Required",
                        color: model.onboardingFlow.licenseActivation == .activated ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary
                    )
                }

                Text(model.productionActivationBoundaryMessage)
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private var doneStep: some View {
        VStack(alignment: .leading, spacing: 16) {
            OperatorSection("Ready") {
                LabeledContent(
                    "Provider",
                    value: model.providerSetupReady ? "configured" : "setup required"
                )
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent("Daemon check", value: model.onboardingFlow.daemonBootstrapChecked ? "checked" : "not checked")
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent("Mode", value: model.onboardingFlow.mode.title)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                if let repository = model.selectedManagedGitHubRepository {
                    LabeledContent("Repository", value: repository)
                        .foregroundStyle(NeonDiffTheme.textPrimary)
                }
                LabeledContent(
                    "License",
                    value: model.licenseSetupReady ? "active" : "activation required"
                )
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                if model.existingLocalBotReconciliationMode {
                    Text("This existing setup remains read-only until current GitHub and repository entitlement checks pass for new work.")
                        .operatorBodyText()
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private var footer: some View {
        VStack(spacing: 12) {
            if let lastError = model.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(NeonDiffTheme.warning)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .help(lastError)
            }

            Button(model.incompleteOnboardingEscapeAvailable ? "Continue Later" : "Close Setup") {
                model.dismissOnboardingPanel()
            }
            .buttonStyle(.plain)
            .font(.system(.caption, design: .monospaced).weight(.semibold))
            .foregroundStyle(NeonDiffTheme.cyan)
            .keyboardShortcut(.cancelAction)
            .help(model.incompleteOnboardingEscapeAvailable
                ? "Close setup and inspect the app in read-only mode. Review actions remain blocked."
                : "Close setup and return to the app.")
            .accessibilityIdentifier("neondiff-onboarding-read-only-exit")

            Rectangle()
                .fill(NeonDiffTheme.stroke.opacity(0.35))
                .frame(height: 1)

            HStack(spacing: 10) {
                Button { model.goBackOnboarding() } label: {
                    Label("BACK", systemImage: "arrow.left")
                }
                .disabled(!model.onboardingFlow.canGoBack)

                Spacer()

                Button {
                    model.advanceOnboarding()
                } label: {
                    HStack(spacing: 8) {
                        Text(
                            model.existingLocalBotReconciliationMode
                                && model.onboardingFlow.currentStep == .done
                                && (!model.productionUsefulWorkAvailable
                                    || !model.providerSetupReady)
                                ? "CLOSE"
                                : model.onboardingFlow.nextActionTitle.uppercased()
                        )
                        Image(systemName: model.onboardingFlow.currentStep == .done ? "checkmark" : "arrow.right")
                    }
                }
                .buttonStyle(OperatorButtonStyle(solid: true))
                .disabled(!model.canAdvanceOnboarding)
            }
        }
        .hostedOnboardingEvaluationRegion("neondiff-onboarding-footer")
    }
}

private extension ManagedGitHubConnectionState {
    var isBound: Bool {
        if case .bound = self { return true }
        return false
    }
}

private extension View {
    @ViewBuilder
    func hostedOnboardingEvaluationRegion(_ identifier: String) -> some View {
#if DEBUG
        accessibilityElement(children: .contain)
            .accessibilityIdentifier(identifier)
#else
        self
#endif
    }
}
