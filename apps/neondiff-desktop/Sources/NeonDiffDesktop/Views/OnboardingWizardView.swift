import SwiftUI
import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

struct OnboardingWizardView: View {
    @ObservedObject var model: NeonDiffDesktopModel

    var body: some View {
        ZStack {
            OperatorBackdrop()

            VStack(spacing: 0) {
                header
                    .padding([.horizontal, .top], 22)
                    .padding(.bottom, 12)

                HStack(spacing: 0) {
                    stepList
                        .frame(width: 190)
                        .padding(.leading, 22)
                        .padding(.bottom, 22)

                    Divider()
                        .overlay(NeonDiffTheme.stroke.opacity(0.54))
                        .padding(.vertical, 4)

                    stepContent
                        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                        .padding(22)
                }

                footer
                    .padding(.horizontal, 22)
                    .padding(.bottom, 22)
            }
        }
    }

    private var header: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: model.onboardingFlow.currentStep.systemImage)
                .font(.system(size: 22, weight: .bold))
                .foregroundStyle(NeonDiffTheme.accent)

            VStack(alignment: .leading, spacing: 3) {
                Text("NeonDiff Onboarding")
                    .font(NeonDiffTheme.headlineFont)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                Text(model.onboardingFlow.currentStep.title)
                    .font(NeonDiffTheme.badgeFont)
                    .foregroundStyle(NeonDiffTheme.textSecondary)
            }

            Spacer()

            OperatorBadge(
                text: model.onboardingFlow.mode == .publicReposOnly ? "Public" : "Private",
                color: model.onboardingFlow.mode == .publicReposOnly ? NeonDiffTheme.accent : NeonDiffTheme.cyan
            )
        }
        .operatorPanel(active: true)
    }

    private var stepList: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(OnboardingStep.allCases) { step in
                HStack(spacing: 9) {
                    Image(systemName: step.systemImage)
                        .frame(width: 18)
                    Text(step.title)
                        .lineLimit(1)
                        .minimumScaleFactor(0.76)
                }
                .font(NeonDiffTheme.badgeFont)
                .foregroundStyle(step == model.onboardingFlow.currentStep ? NeonDiffTheme.accent : NeonDiffTheme.textSecondary)
                .padding(.horizontal, 10)
                .padding(.vertical, 8)
                .background {
                    AngularRectangle(corner: 8)
                        .fill(step == model.onboardingFlow.currentStep ? NeonDiffTheme.panelActive : Color.black.opacity(0.20))
                }
            }

            Spacer()
        }
    }

    @ViewBuilder
    private var stepContent: some View {
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

    private var welcomeStep: some View {
        VStack(alignment: .leading, spacing: 16) {
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

            OperatorSection("Authority") {
                Text("Desktop configures local state and starts CLI-backed checks. GitHub reviews still go through the daemon and its current-head safety gates.")
                    .operatorBodyText()
                    .fixedSize(horizontal: false, vertical: true)
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
                    OperatorTextField(title: "Provider API Key", text: $model.pendingProviderKey, secure: true)

                    HStack(spacing: 10) {
                        Button { model.storeProviderKey() } label: {
                            Label("Store Key", systemImage: "key.fill")
                        }
                        OperatorBadge(
                            text: model.providers.providerKeyStored ? "Stored in Keychain" : "Key Required",
                            color: model.providers.providerKeyStored ? NeonDiffTheme.accent : NeonDiffTheme.warning
                        )
                    }
                }

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
                        .disabled(!model.productionUsefulWorkAvailable)
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
                Text(model.productionActivationBoundaryMessage)
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

    @ViewBuilder
    private var licenseStep: some View {
        if model.activationHandoffEnabled {
            VStack(alignment: .leading, spacing: 16) {
                ActivationStateView(model: model)
            }
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
                LabeledContent("Provider key", value: model.providers.providerKeyStored ? "stored" : "missing")
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent("Daemon check", value: model.onboardingFlow.daemonBootstrapChecked ? "checked" : "not checked")
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent("Mode", value: model.onboardingFlow.mode.title)
                    .foregroundStyle(NeonDiffTheme.textPrimary)
                LabeledContent("License", value: model.onboardingFlow.licenseActivation == .activated ? "activated" : "service pending")
                    .foregroundStyle(NeonDiffTheme.textPrimary)
            }
        }
    }

    private var footer: some View {
        HStack(spacing: 10) {
            Button { model.goBackOnboarding() } label: {
                Label("Back", systemImage: "chevron.left")
            }
            .disabled(!model.onboardingFlow.canGoBack)

            Spacer()

            if !model.productionUsefulWorkAvailable {
                Button("Open Read-Only App") {
                    model.openReadOnlyAppFromQuarantinedOnboarding()
                }
                .help("Inspect setup and settings without completing activation onboarding. Useful work remains blocked.")
            }

            if let lastError = model.lastError, !lastError.isEmpty {
                Text(lastError)
                    .font(.caption)
                    .foregroundStyle(NeonDiffTheme.warning)
                    .lineLimit(2)
                    .minimumScaleFactor(0.8)
            }

            Button {
                if model.onboardingFlow.currentStep == .done {
                    model.completeOnboarding()
                } else {
                    model.advanceOnboarding()
                }
            } label: {
                Label(model.onboardingFlow.nextActionTitle, systemImage: model.onboardingFlow.currentStep == .done ? "checkmark" : "chevron.right")
            }
            .buttonStyle(OperatorButtonStyle(solid: true))
            .disabled(!model.onboardingFlow.canAdvance)
        }
    }
}
