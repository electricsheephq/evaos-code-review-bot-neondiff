import Combine
import Foundation
import NeonDiffDesktopCore

#if DEBUG
package struct DesktopModelInitialState {
    package let selectedSection: DesktopSection
    package let configPath: String
    package let cliPath: String
    package let status: DaemonStatus
    package let repos: [RepoMonitor]
    package let providers: ProviderSettings
    package let license: LicenseStatus
    package let github: GitHubConnectionStatus
    package let githubAuthorizationStatus: String
    package let logText: String
    package let onboardingFlow: OnboardingFlow
    package let isOnboardingPresented: Bool
    package let providerVerification: ProviderVerificationSnapshot?
    package let providerVerificationStatus: String
    package let providerConfigurationIsDirty: Bool
    package let providerVerificationInProgress: Bool

    package init(
        selectedSection: DesktopSection,
        configPath: String,
        cliPath: String,
        status: DaemonStatus,
        repos: [RepoMonitor],
        providers: ProviderSettings,
        license: LicenseStatus,
        github: GitHubConnectionStatus,
        githubAuthorizationStatus: String,
        logText: String,
        onboardingFlow: OnboardingFlow,
        isOnboardingPresented: Bool,
        providerVerification: ProviderVerificationSnapshot?,
        providerVerificationStatus: String,
        providerConfigurationIsDirty: Bool = false,
        providerVerificationInProgress: Bool = false
    ) {
        self.selectedSection = selectedSection
        self.configPath = configPath
        self.cliPath = cliPath
        self.status = status
        self.repos = repos
        self.providers = providers
        self.license = license
        self.github = github
        self.githubAuthorizationStatus = githubAuthorizationStatus
        self.logText = logText
        self.onboardingFlow = onboardingFlow
        self.isOnboardingPresented = isOnboardingPresented
        self.providerVerification = providerVerification
        self.providerVerificationStatus = providerVerificationStatus
        self.providerConfigurationIsDirty = providerConfigurationIsDirty
        self.providerVerificationInProgress = providerVerificationInProgress
    }
}
#endif

package enum ManagedGitHubConnectionState: Equatable, Sendable {
    case quarantined
    case disconnected
    case verificationRequired
    case connecting
    case awaitingAuthorization
    case bound(installationId: Int)
    case failed
}

@MainActor
package final class NeonDiffDesktopModel: ObservableObject {
    @Published package var selectedSection: DesktopSection = .overview
    @Published package var configPath: String {
        didSet {
            guard configPath != oldValue else { return }
            invalidateProviderConfigAuthorization()
            invalidateProviderVerificationContext()
        }
    }
    @Published package var cliPath: String {
        didSet {
            guard cliPath != oldValue else { return }
            invalidateProviderVerificationContext()
        }
    }
    @Published package var launchdLabel: String
    @Published package var status: DaemonStatus = .unknown
    @Published package var repos: [RepoMonitor] = []
    @Published package var providers = ProviderSettings() {
        didSet {
            guard providers != oldValue else { return }
            if providers.selectedProviderId != oldValue.selectedProviderId {
                refreshSelectedProviderKeyState()
            }
            invalidateProviderVerificationContext()
        }
    }
    @Published package var license = LicenseStatus()
    @Published package var controlCenter = DesktopControlCenterSettings()
    @Published package var controlCenterStatus = "Load current config before editing."
    @Published package var isControlCenterOperationInProgress = false
    @Published package var isConfigPatchInProgress = false
    @Published package var isConfigInspectInProgress = false
    @Published package var pendingIssueRepoName = ""
    @Published package var github = GitHubConnectionStatus()
    @Published package var githubAuthorizationCode: GitHubDeviceAuthorizationCode?
    @Published package var githubAuthorizationStatus = "not connected"
    @Published package var githubRecovery: GitHubConnectionRecovery?
    @Published package var discoveredGitHubRepos: [GitHubDiscoveredRepository] = []
    @Published package var isGitHubAuthorizationInProgress = false
    @Published package var isGitHubRepositoryRefreshInProgress = false
    @Published package var managedGitHubConnectionState: ManagedGitHubConnectionState = .quarantined
    @Published package var managedGitHubRepositories: [GitHubBrokerRepository] = []
    @Published package var selectedManagedGitHubRepository: String?
    @Published package var managedGitHubRecovery: GitHubConnectionRecovery?
    @Published package var isManagedGitHubConnectionInProgress = false
    @Published package var logText = "No logs loaded."
    @Published package var lastError: String?
    @Published package var lastCommandLine = ""
    @Published package var dashboardLaunchStatus = "not opened"
    @Published package var dashboardProcessIdentifier: Int32?
    @Published package var pendingRepoName = ""
    @Published package var pendingProviderKey = ""
    @Published package var providerVerification: ProviderVerificationSnapshot?
    @Published package var providerVerificationStatus = "Verify the stored API key when ready."
    @Published package var isProviderVerificationInProgress = false
    @Published package var isProviderVerificationCancelling = false
    @Published package private(set) var providerVerificationSafetyLatchMessage: String?
    @Published package var pendingLicenseKey = ""
    @Published package var onboardingFlow = OnboardingFlow()
    @Published package var isOnboardingPresented = false

    // Issue #612 — native purchase-to-activation state. Restored from preferences
    // (its raw value) so onboarding resumes exactly across relaunch / cancel /
    // network loss (AC6). No Keychain read happens on the launch path; the
    // activation key is read lazily only when the user activates.
    @Published package var activationState: ActivationState = ActivationStateMachine.initialState
    @Published package private(set) var activationKeyRedactedPrefix: String?
    @Published package var pendingActivationKey = ""
    @Published package private(set) var activationVerifiedThisLaunch = false

    package var productionActivationBoundaryMessage: String {
        "Native activation broker proof is not available in this build. Provider verification, daemon control, updates, and onboarding completion remain blocked."
    }

    package var productionUsefulWorkAvailable: Bool {
        guard dependencies.productionBoundary.nativeActivationBrokerVerified else {
            return false
        }
        guard dependencies.productionBoundary.managedGitHubBrokerOrigin != nil else {
            return true
        }
        guard hasVerifiedManagedGitHubSelection,
              let selectedManagedGitHubRepository,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == selectedManagedGitHubRepository
              })
        else {
            return false
        }
        switch repository.visibility {
        case .public:
            return true
        case .private, .internal:
            return activationVerifiedThisLaunch
                && activationState == .active
                && activatedRepository == selectedManagedGitHubRepository
        case .unknown:
            return false
        }
    }

    package var managedGitHubAvailable: Bool {
        dependencies.productionBoundary.managedGitHubBrokerOrigin != nil
            && dependencies.githubBroker != nil
    }

    package var managedGitHubStatusText: String {
        switch managedGitHubConnectionState {
        case .quarantined:
            "Unavailable in this signed build"
        case .disconnected:
            "Not connected"
        case .verificationRequired:
            "Saved binding requires server verification"
        case .connecting:
            "Creating Keychain-backed device binding"
        case .awaitingAuthorization:
            "Waiting for GitHub authorization"
        case .bound(let installationId):
            "Server binding verified · installation \(installationId)"
        case .failed:
            managedGitHubRecovery?.status ?? "Verification failed"
        }
    }

    package var isManagedGitHubBound: Bool {
        if case .bound = managedGitHubConnectionState { return true }
        return false
    }

    package var canAdvanceOnboarding: Bool {
        if dependencies.productionBoundary.managedGitHubBrokerOrigin != nil {
            guard hasVerifiedManagedGitHubSelection else { return false }
        }
        return onboardingFlow.canAdvance
    }

    private var hasVerifiedManagedGitHubSelection: Bool {
        guard case .bound = managedGitHubConnectionState,
              let selectedManagedGitHubRepository,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == selectedManagedGitHubRepository
              }),
              repository.visibility != .unknown
        else {
            return false
        }
        return repos.filter(\.enabled).map(\.name) == [selectedManagedGitHubRepository]
    }

    private let dependencies: DesktopAppDependencies
    private let activationLicenseClientOverride: (any ActivationLicenseClienting)?
    private var providerVerificationTask: Task<Void, Never>?
    private var providerVerificationRequestGeneration: UInt64 = 0
    private var providerVerificationContextGeneration: UInt64 = 0
    private var activeProviderVerificationRequestGeneration: UInt64?
    private var providerKeyRevision: UInt64 = 0
    private var githubAuthorizationTask: Task<Void, Never>?
    private var githubRepositoryRefreshTask: Task<Void, Never>?
    private var managedGitHubConnectionTask: Task<Void, Never>?
    private var githubRepositoryRefreshGate = GitHubLatestRequestGate()
    private var controlCenterLoadedSnapshot: DesktopControlCenterSnapshot?
    private var controlCenterRollbackSnapshot: DesktopControlCenterSnapshot?
    private var previewedControlCenterSnapshot: DesktopControlCenterSnapshot?
    private var previewedControlCenterBaseline: DesktopControlCenterSnapshot?
    private var controlCenterLoadedRevision: String?
    private var controlCenterRollbackExpectedRevision: String?
    private var previewedControlCenterExpectedRevision: String?
    private var providerLoadedSnapshot: ProviderConfigurationSnapshot?
    private var providerLoadedRevision: String?
    private var previewedProviderSnapshot: ProviderConfigurationSnapshot?
    private var previewedProviderExpectedRevision: String?
    private var pendingProviderPatchProof: PendingProviderPatchProof?

    package init(dependencies: DesktopAppDependencies, activationLicenseClient: (any ActivationLicenseClienting)? = nil) {
        self.dependencies = dependencies
        self.activationLicenseClientOverride = activationLicenseClient
        self.configPath = dependencies.preferences.string(forKey: "neondiff.configPath") ?? "config.local.json"
        self.cliPath = dependencies.preferences.string(forKey: "neondiff.cliPath") ?? "neondiff"
        self.launchdLabel = dependencies.preferences.string(forKey: "neondiff.launchdLabel") ?? "com.electricsheephq.evaos-code-review-bot"
        let providerKeyStored = ProviderKeychainAccount.account(providerId: providers.selectedProviderId)
            .map(dependencies.secretStore.containsSecret(account:)) == true
        let githubUserTokenStored = dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
        let githubRefreshTokenStored = dependencies.secretStore.containsSecret(account: githubRefreshTokenAccount)
        self.providers.providerKeyStored = providerKeyStored
        self.license.keyStored = dependencies.secretStore.containsSecret(account: licenseKeyAccount)
        self.github.userTokenStored = githubUserTokenStored
        if githubUserTokenStored {
            self.github.installationState = "authorization stored; verify"
            self.githubAuthorizationStatus = "authorization stored; refresh repos to verify"
        } else if githubRefreshTokenStored {
            self.github.installationState = "authorization refresh available"
            self.githubAuthorizationStatus = "authorization refresh available"
        } else {
            self.github.installationState = "not connected"
        }
        self.github.authorizedUserLogin = nil
        if dependencies.productionBoundary.managedGitHubBrokerOrigin != nil {
            if dependencies.githubBroker == nil {
                self.managedGitHubConnectionState = .quarantined
            } else if Self.savedManagedGitHubInstallationId(
                preferences: dependencies.preferences
            ) != nil {
                self.managedGitHubConnectionState = .verificationRequired
            } else {
                self.managedGitHubConnectionState = .disconnected
            }
        } else {
            self.managedGitHubConnectionState = .quarantined
        }
        self.onboardingFlow = OnboardingFlow(providerKeyStored: providerKeyStored)
        self.isOnboardingPresented = !dependencies.preferences.bool(forKey: onboardingCompletedKey)
        // Resume-exact: restore the persisted activation state (rawValue) without
        // touching the Keychain on the launch path (v1.0.3 startup-stability rule).
        if let rawActivationState = dependencies.preferences.string(forKey: activationStateKey),
           let restored = ActivationState(rawValue: rawActivationState) {
            self.activationState = restored
        } else {
            self.activationState = ActivationStateMachine.initialState
        }
        self.lastCommandLine = statusCommand.commandLine
    }

    #if DEBUG
    package func applyInitialState(_ state: DesktopModelInitialState) {
        selectedSection = state.selectedSection
        configPath = state.configPath
        cliPath = state.cliPath
        status = state.status
        repos = state.repos
        providers = state.providers
        providers.providerKeyStored = state.providers.providerKeyStored
        license = state.license
        github = state.github
        githubAuthorizationStatus = state.githubAuthorizationStatus
        logText = state.logText
        onboardingFlow = state.onboardingFlow
        isOnboardingPresented = state.isOnboardingPresented
        providerVerification = state.providerVerification
        providerVerificationStatus = state.providerVerificationStatus
        isProviderVerificationInProgress = state.providerVerificationInProgress
        isProviderVerificationCancelling = false
        providerVerificationSafetyLatchMessage = nil
        previewedProviderSnapshot = nil
        previewedProviderExpectedRevision = nil
        if state.providers.registryTargets.isEmpty {
            providerLoadedSnapshot = nil
            providerLoadedRevision = nil
        } else {
            var loadedProviders = state.providers
            if state.providerConfigurationIsDirty {
                loadedProviders.selectedProviderModel += "-saved"
            }
            providerLoadedSnapshot = ProviderConfigurationSnapshot(
                providers: loadedProviders,
                configPath: configPath
            )
            providerLoadedRevision = state.providerVerification?.configRevision
                ?? String(repeating: "a", count: 64)
        }
        lastError = nil
        lastCommandLine = state.status.lastCommand
    }

    package func applyProviderVerificationVisualProofFixture() {
        selectedSection = .providers
        configPath = "/tmp/neondiff-visual-proof/config.local.json"
        cliPath = "neondiff"
        providers.zcodeModel = "glm-5"
        providers.zcodeCliPath = "/usr/local/bin/zcode"
        providers.zcodeAppConfigPath = "~/.config/zcode/config.json"
        providers.openAICompatibleEndpoint = "https://legacy-endpoint.invalid/v1"
        providers.selectedProviderId = "zcode-glm"
        providers.registryTargets = [
            ProviderRegistryTarget(
                id: "zcode-glm",
                displayName: "Z.AI GLM",
                enabled: true,
                adapter: "openai-compatible",
                authMode: "api-key-env",
                baseUrl: "https://api.z.ai/api/coding/paas/v4",
                model: "glm-5"
            )
        ]
        providers.providerKeyStored = true
        providerLoadedSnapshot = ProviderConfigurationSnapshot(
            providers: providers,
            configPath: configPath
        )
        providerLoadedRevision = String(repeating: "a", count: 64)
        providerVerification = ProviderVerificationSnapshot(
            ok: true,
            command: "providers verify",
            providerId: "zcode-glm",
            checkedAt: "2026-07-10T12:00:00Z",
            state: .healthy,
            mode: "openai_compatible_models",
            detail: "Provider responded with compatible model metadata. No secret value is retained.",
            troubleshooting: []
        )
        providerVerificationStatus = "Verified from redacted fixture metadata. No hosted request was made."
        isOnboardingPresented = false
    }
    #endif

    package var statusCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonStatus(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var dashboardCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var dashboardServerCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, openBrowser: false)
    }

    package var startDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var stopDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    package var startDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    package var stopDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    package var configInspectCommand: DesktopCommand {
        NeonDiffCommandBuilder.configInspect(cliPath: cliPath, configPath: configPath)
    }

    package var providerPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: providerPatchPath.path,
            expectedRevision: providerLoadedRevision
        )
    }

    package var providerPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: providerPatchPath.path,
            dryRun: false,
            expectedRevision: previewedProviderExpectedRevision
        )
    }

    package var repoSelectionPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path)
    }

    package var repoSelectionPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path, dryRun: false)
    }

    package var controlCenterPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            expectedRevision: controlCenterLoadedRevision
        )
    }

    package var controlCenterPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            dryRun: false,
            expectedRevision: previewedControlCenterExpectedRevision
        )
    }

    package var controlCenterRollbackCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterRollbackPath.path,
            dryRun: false,
            expectedRevision: controlCenterRollbackExpectedRevision
        )
    }

    package var controlCenterValidationError: String? {
        DesktopControlCenterPatchBuilder.validationError(for: controlCenter)
    }

    package var canPreviewControlCenter: Bool {
        controlCenterLoadedSnapshot?.configPath == configPath
            && controlCenterLoadedRevision != nil
            && controlCenterValidationError == nil
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canApplyControlCenter: Bool {
        canPreviewControlCenter
            && previewedControlCenterSnapshot == currentControlCenterSnapshot
            && previewedControlCenterBaseline?.configPath == configPath
            && previewedControlCenterExpectedRevision != nil
    }

    package var canRollbackControlCenter: Bool {
        controlCenterRollbackSnapshot?.configPath == configPath
            && controlCenterRollbackExpectedRevision != nil
            && controlCenterLoadedRevision == controlCenterRollbackExpectedRevision
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canVerifyProviderKey: Bool {
        providers.providerKeyStored
            && providers.selectedRegistryTarget?.isAPIKeyVerificationEligible == true
            && providerLoadedRevision != nil
            && providerLoadedSnapshot == currentProviderConfigurationSnapshot
            && previewedProviderSnapshot == nil
            && !isProviderVerificationInProgress
            && !isProviderVerificationCancelling
            && providerVerificationSafetyLatchMessage == nil
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canEditProviderConfiguration: Bool {
        !isProviderVerificationInProgress
            && !isProviderVerificationCancelling
            && providerVerificationSafetyLatchMessage == nil
    }

    package var canPreviewProviderConfig: Bool {
        canEditProviderConfiguration
            && providerLoadedSnapshot?.configPath == configPath
            && providerLoadedRevision != nil
            && providerLoadedSnapshot != nil
            && providerLoadedSnapshot != currentProviderConfigurationSnapshot
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var canApplyProviderConfig: Bool {
        canEditProviderConfiguration
            && previewedProviderSnapshot == currentProviderConfigurationSnapshot
            && previewedProviderExpectedRevision == providerLoadedRevision
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    package var providerVerificationButtonTitle: String {
        isProviderVerificationCancelling ? "Cancelling…" : (isProviderVerificationInProgress ? "Verifying…" : "Verify API Key")
    }

    private var currentProviderConfigurationSnapshot: ProviderConfigurationSnapshot {
        ProviderConfigurationSnapshot(providers: providers, configPath: configPath)
    }

    private var currentControlCenterSnapshot: DesktopControlCenterSnapshot {
        DesktopControlCenterSnapshot(settings: controlCenter, configPath: configPath)
    }

    package var githubAppInstallURL: URL {
        GitHubAppInstallLink.url(botLogin: github.botLogin) ?? GitHubAppInstallLink.publicAppURL
    }

    package var githubRecoveryActionTitle: String {
        switch githubRecovery?.action {
        case .reconnect: "Reconnect GitHub"
        case .retryLater, .retry: "Retry Repository Discovery"
        case .installOrManageApp: "Install / Manage App"
        case .contactOrganizationOwner: "Manage App Access"
        case nil: "Retry"
        }
    }

    package var githubRecoveryShowsAction: Bool {
        githubRecovery?.action != .contactOrganizationOwner
    }

    package func persistLocalSettings() {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        dependencies.preferences.set(configPath, forKey: "neondiff.configPath")
        dependencies.preferences.set(cliPath, forKey: "neondiff.cliPath")
        dependencies.preferences.set(launchdLabel, forKey: "neondiff.launchdLabel")
        if controlCenterLoadedSnapshot?.configPath != configPath {
            previewedControlCenterSnapshot = nil
            previewedControlCenterBaseline = nil
            previewedControlCenterExpectedRevision = nil
            controlCenterStatus = "Config path changed. Load current config before editing."
        }
    }

    package func refreshStatus() {
        persistLocalSettings()
        runCLI(arguments: ["daemon", "status", "--config", configPath, "--launchd-label", launchdLabel], displayCommand: statusCommand)
    }

    package func openDashboard() {
        launchDashboard(openBrowser: true)
    }

    package func startDashboardServer() {
        launchDashboard(openBrowser: false)
    }

    private func launchDashboard(openBrowser: Bool) {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            dashboardLaunchStatus = "restart required"
            return
        }
        persistLocalSettings()
        let command = openBrowser ? dashboardCommand : dashboardServerCommand
        lastCommandLine = command.commandLine
        dashboardLaunchStatus = openBrowser ? "opening browser" : "starting server"
        let executablePath = cliPath
        let arguments = NeonDiffCommandBuilder.dashboardArguments(
            configPath: configPath,
            launchdLabel: launchdLabel,
            openBrowser: openBrowser
        )
        let dashboard = dependencies.dashboard
        let workingDirectory = dependencies.cliWorkingDirectory

        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await dashboard.launch(
                    executablePath: executablePath,
                    arguments: arguments,
                    workingDirectory: workingDirectory
                )
                self.dashboardProcessIdentifier = result.processIdentifier
                self.dashboardLaunchStatus = openBrowser
                    ? "launched pid \(result.processIdentifier); browser opens the local HTML dashboard"
                    : "launched pid \(result.processIdentifier); local dashboard server started"
                self.lastError = nil
                self.logText = openBrowser
                    ? "Started NeonDiff local dashboard from the desktop launcher and opened the browser dashboard."
                    : "Started NeonDiff local dashboard server from the desktop launcher without opening a browser tab."
            } catch {
                self.dashboardProcessIdentifier = nil
                self.dashboardLaunchStatus = "failed"
                self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                self.logText = self.lastError ?? "Unknown dashboard launch error"
            }
        }
    }

    package func previewStartDaemon() {
        guard requireProductionUsefulWorkAuthorization() else { return }
        runCLI(arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: startDaemonDryRunCommand)
    }

    package func previewStopDaemon() {
        guard requireProductionUsefulWorkAuthorization() else { return }
        runCLI(arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: stopDaemonDryRunCommand)
    }

    package func startDaemon() {
        guard requireProductionUsefulWorkAuthorization() else { return }
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: startDaemonCommand
        )
    }

    package func stopDaemon() {
        guard requireProductionUsefulWorkAuthorization() else { return }
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: stopDaemonCommand
        )
    }

    package func inspectConfig() {
        guard canEditProviderConfiguration, !isConfigPatchInProgress, !isConfigInspectInProgress else { return }
        runCLI(arguments: ["config", "inspect", "--config", configPath], displayCommand: configInspectCommand)
    }

    package func addPendingIssueRepo() {
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        let repo = pendingIssueRepoName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isValidRepoName(repo) else {
            lastError = "Enter an issue-enrichment repository as owner/repo."
            return
        }
        if !controlCenter.issueAllowlist.contains(where: { $0.caseInsensitiveCompare(repo) == .orderedSame }) {
            controlCenter.issueAllowlist.append(repo)
            controlCenter.issueAllowlist.sort { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        }
        pendingIssueRepoName = ""
        lastError = nil
        controlCenterStatus = "Issue-enrichment allowlist changed locally; Preview is required before Apply."
    }

    package func removeIssueRepo(_ repo: String) {
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        controlCenter.issueAllowlist.removeAll { $0.caseInsensitiveCompare(repo) == .orderedSame }
        controlCenterStatus = "Issue-enrichment allowlist changed locally; Preview is required before Apply."
    }

    package func previewControlCenterPatch() {
        guard
            let baseline = controlCenterLoadedSnapshot,
            baseline.configPath == configPath,
            let expectedRevision = controlCenterLoadedRevision
        else {
            lastError = "Load current config before previewing control-center changes."
            return
        }
        let snapshot = currentControlCenterSnapshot
        let operation = ControlCenterOperation.preview(
            snapshot: snapshot,
            baseline: baseline,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(snapshot.settings, to: controlCenterPatchPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center patch generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterPatchPath.path,
                "--dry-run", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterPatchPreviewCommand
        )
    }

    package func applyControlCenterPatch() {
        guard
            let snapshot = previewedControlCenterSnapshot,
            let baseline = previewedControlCenterBaseline,
            let expectedRevision = previewedControlCenterExpectedRevision,
            snapshot == currentControlCenterSnapshot,
            baseline.configPath == configPath
        else {
            lastError = "Preview the current control-center settings before Apply."
            return
        }
        let operation = ControlCenterOperation.apply(
            snapshot: snapshot,
            baseline: baseline,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(snapshot.settings, to: controlCenterPatchPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center patch generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterPatchPath.path,
                "--dry-run", "false", "--confirm", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterPatchApplyCommand
        )
    }

    package func rollbackControlCenterPatch() {
        guard
            let rollback = controlCenterRollbackSnapshot,
            rollback.configPath == configPath,
            let expectedRevision = controlCenterRollbackExpectedRevision
        else {
            lastError = "No applied control-center change is available to roll back."
            return
        }
        let operation = ControlCenterOperation.rollback(
            snapshot: rollback,
            expectedRevision: expectedRevision
        )
        guard beginControlCenterOperation(operation) else { return }
        do {
            try writeControlCenterPatch(rollback.settings, to: controlCenterRollbackPath)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            controlCenterStatus = lastError ?? "Control-center rollback generation failed."
            isControlCenterOperationInProgress = false
            return
        }
        runControlCenterPatch(
            operation: operation,
            arguments: [
                "config", "patch", "--config", configPath, "--input", controlCenterRollbackPath.path,
                "--dry-run", "false", "--confirm", "true", "--expected-revision", expectedRevision
            ],
            command: controlCenterRollbackCommand
        )
    }

    package func previewProviderConfigPatch() {
        guard canPreviewProviderConfig else {
            lastError = "Load current config, make a provider change, then preview it."
            return
        }
        runProviderConfigPatch(dryRun: true)
    }

    package func applyProviderConfigPatch() {
        guard canApplyProviderConfig else {
            lastError = "Preview this exact provider configuration before applying it."
            return
        }
        runProviderConfigPatch(dryRun: false)
    }

    package func addPendingRepoToAllowlist() {
        guard !managedGitHubAvailable else {
            lastError = "Choose a repository from the verified GitHub App binding. Manual repository names are disabled in managed mode."
            return
        }
        guard canEditProviderConfiguration else {
            lastError = providerVerificationSafetyLatchMessage ?? "Wait for provider verification cleanup before changing config."
            return
        }
        let repoName = pendingRepoName.trimmingCharacters(in: .whitespacesAndNewlines)
        guard isValidRepoName(repoName) else {
            lastError = "Enter a GitHub repository as owner/repo."
            return
        }
        if let index = repos.firstIndex(where: { $0.name.caseInsensitiveCompare(repoName) == .orderedSame }) {
            repos[index].enabled = true
        } else {
            repos.append(RepoMonitor(name: repoName, enabled: true, profile: "selected"))
            repos.sort { $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending }
        }
        pendingRepoName = ""
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    package func toggleRepoAllowlist(_ repo: RepoMonitor) {
        guard !managedGitHubAvailable else {
            lastError = "Managed mode keeps exactly one server-bound repository selected. Choose it from the verified repository list."
            return
        }
        guard let index = repos.firstIndex(where: { $0.id == repo.id }) else { return }
        repos[index].enabled.toggle()
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    package func githubAccessCue(for repo: RepoMonitor) -> GitHubRepositoryAccessCue? {
        if managedGitHubAvailable,
           let authoritative = managedGitHubRepositories.first(where: {
               $0.fullName == repo.name
           }) {
            switch authoritative.visibility {
            case .public:
                return .publicFree
            case .private, .internal:
                return activationState == .active ? .licenseActive : .licenseRequired
            case .unknown:
                return .insufficientReadAccess
            }
        }
        guard let discovered = discoveredGitHubRepos.first(where: {
            $0.fullName.caseInsensitiveCompare(repo.name) == .orderedSame
        }) else {
            return nil
        }
        return GitHubRepositoryAccessPolicy.cue(for: discovered, licenseEntitlement: license.entitlement)
    }

    package func removeRepoFromAllowlist(_ repo: RepoMonitor) {
        guard !managedGitHubAvailable else {
            lastError = "Managed mode repository scope comes from the verified GitHub App binding."
            return
        }
        repos.removeAll { $0.id == repo.id }
        lastError = nil
        logText = "Repo removed locally. Preview or apply the config patch to persist it."
    }

    package func startGitHubAuthorization() {
        guard !isGitHubRepositoryRefreshInProgress else { return }
        guard let clientId = github.clientId?.trimmingCharacters(in: .whitespacesAndNewlines), !clientId.isEmpty else {
            lastError = "Set the public GitHub App client ID before connecting GitHub."
            githubAuthorizationStatus = "client id missing"
            return
        }
        githubAuthorizationTask?.cancel()
        githubAuthorizationCode = nil
        isGitHubAuthorizationInProgress = true
        githubAuthorizationStatus = "requesting device code"
        githubRecovery = nil
        lastError = nil
        githubAuthorizationTask = Task { [weak self] in
            guard let self else { return }
            do {
                let code = try await dependencies.githubAuthenticator.requestDeviceCode(clientId: clientId)
                if Task.isCancelled { return }
                githubAuthorizationCode = code
                githubAuthorizationStatus = "enter code \(code.userCode)"
                github.installationState = "waiting for GitHub authorization"
                logText = "Open \(code.verificationURI.absoluteString) and enter code \(code.userCode)."
                await pollGitHubAuthorization(clientId: clientId, code: code)
            } catch {
                if Task.isCancelled { return }
                isGitHubAuthorizationInProgress = false
                applyGitHubFailure(error, fallbackStatus: "authorization failed")
            }
        }
    }

    package func cancelGitHubAuthorization() {
        githubAuthorizationTask?.cancel()
        githubAuthorizationTask = nil
        isGitHubAuthorizationInProgress = false
        githubAuthorizationCode = nil
        githubAuthorizationStatus = "cancelled"
        github.installationState = github.userTokenStored ? "user authorized" : "not connected"
    }

    package func copyGitHubUserCode() {
        guard let userCode = githubAuthorizationCode?.userCode else { return }
        guard dependencies.clipboard.write(userCode) else {
            githubAuthorizationStatus = "device code copy failed"
            lastError = "Could not copy the GitHub device code. Copy it manually and retry."
            return
        }
        githubAuthorizationStatus = "code copied"
        lastError = nil
    }

    package func openGitHubDeviceVerification() {
        guard let verificationURI = githubAuthorizationCode?.verificationURI else { return }
        guard dependencies.urlOpener.open(verificationURI) else {
            githubAuthorizationStatus = "verification page open failed"
            lastError = "Could not open the GitHub verification page. Open the shown URL manually."
            return
        }
        githubAuthorizationStatus = "verification page opened"
        lastError = nil
    }

    package func openGitHubAppInstallation() {
        guard dependencies.urlOpener.open(githubAppInstallURL) else {
            githubAuthorizationStatus = "App installation page open failed"
            lastError = "Could not open the GitHub App installation page. Open it manually in your browser."
            return
        }
        githubAuthorizationStatus = "App installation page opened"
        lastError = nil
    }

    package func performGitHubRecoveryAction() {
        switch githubRecovery?.action {
        case .reconnect:
            startGitHubAuthorization()
        case .retryLater, .retry:
            refreshGitHubRepositories()
        case .installOrManageApp:
            openGitHubAppInstallation()
        case .contactOrganizationOwner:
            logText = githubRecovery?.message ?? "Ask an organization owner to approve GitHub App access."
        case nil:
            refreshGitHubRepositories()
        }
    }

    package func refreshGitHubRepositories() {
        guard !isGitHubRepositoryRefreshInProgress, !isGitHubAuthorizationInProgress else { return }
        githubRepositoryRefreshTask?.cancel()
        let requestGeneration = githubRepositoryRefreshGate.begin()
        isGitHubRepositoryRefreshInProgress = true
        githubRepositoryRefreshTask = Task { [weak self] in
            guard let self else { return }
            defer {
                if githubRepositoryRefreshGate.isCurrent(requestGeneration) {
                    isGitHubRepositoryRefreshInProgress = false
                    githubRepositoryRefreshTask = nil
                }
            }
            do {
                githubAuthorizationStatus = "refreshing repositories"
                githubRecovery = nil
                let accessToken = try await gitHubAccessTokenForAPI()
                let user = try await dependencies.githubAuthenticator.fetchCurrentUser(accessToken: accessToken)
                let discovered = try await dependencies.githubAuthenticator.listAccessibleRepositories(accessToken: accessToken)
                guard !Task.isCancelled, githubRepositoryRefreshGate.isCurrent(requestGeneration) else { return }
                applyGitHubDiscovery(user: user, discovered: discovered)
            } catch {
                guard !Task.isCancelled, githubRepositoryRefreshGate.isCurrent(requestGeneration) else { return }
                if error is GitHubDesktopAuthorizationStateError {
                    lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    logText = lastError ?? "Reconnect GitHub."
                    githubRecovery = GitHubConnectionRecovery(
                        status: "reconnect required",
                        message: lastError ?? "Reconnect GitHub before refreshing repositories.",
                        action: .reconnect
                    )
                    return
                }
                applyGitHubFailure(error, fallbackStatus: "repository refresh failed")
            }
        }
    }

    package func startManagedGitHubConnection() {
        guard let broker = dependencies.githubBroker,
              dependencies.productionBoundary.managedGitHubBrokerOrigin != nil
        else {
            managedGitHubConnectionState = .quarantined
            managedGitHubRecovery = GitHubConnectionRecovery(
                status: "managed GitHub unavailable",
                message: "Managed GitHub authorization is not enabled in this signed build.",
                action: .retryLater
            )
            lastError = managedGitHubRecovery?.message
            return
        }
        guard !isManagedGitHubConnectionInProgress else { return }

        managedGitHubConnectionTask?.cancel()
        isManagedGitHubConnectionInProgress = true
        managedGitHubConnectionState = .connecting
        managedGitHubRecovery = nil
        managedGitHubRepositories = []
        selectedManagedGitHubRepository = nil
        lastError = nil

        managedGitHubConnectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                isManagedGitHubConnectionInProgress = false
                managedGitHubConnectionTask = nil
            }
            do {
                let identity = try GitHubBrokerDeviceIdentityStore(
                    secretStore: dependencies.secretStore
                ).loadOrCreate()
                try await broker.register(identity: identity)
                let connection = try await broker.startConnection(identity: identity)
                guard dependencies.urlOpener.open(connection.installURL) else {
                    throw ManagedGitHubModelError.installPageOpenFailed
                }
                managedGitHubConnectionState = .awaitingAuthorization
                logText = "GitHub App installation opened. Complete authorization in GitHub; NeonDiff is waiting for the server binding."

                let installationId = try await awaitManagedGitHubBinding(
                    broker: broker,
                    identity: identity,
                    connection: connection
                )
                dependencies.preferences.set(
                    String(installationId),
                    forKey: managedGitHubInstallationIdKey
                )
                try await loadManagedGitHubRepositories(
                    broker: broker,
                    identity: identity,
                    installationId: installationId
                )
            } catch {
                guard !Task.isCancelled else { return }
                applyManagedGitHubFailure(error)
            }
        }
    }

    package func refreshManagedGitHubRepositories() {
        guard let broker = dependencies.githubBroker,
              dependencies.productionBoundary.managedGitHubBrokerOrigin != nil,
              let installationId = Self.savedManagedGitHubInstallationId(
                preferences: dependencies.preferences
              )
        else {
            managedGitHubConnectionState = .quarantined
            managedGitHubRecovery = GitHubConnectionRecovery(
                status: "connection required",
                message: "Connect GitHub before refreshing server-bound repositories.",
                action: .reconnect
            )
            lastError = managedGitHubRecovery?.message
            return
        }
        guard !isManagedGitHubConnectionInProgress else { return }

        managedGitHubConnectionTask?.cancel()
        isManagedGitHubConnectionInProgress = true
        managedGitHubConnectionState = .verificationRequired
        managedGitHubRecovery = nil
        managedGitHubRepositories = []
        selectedManagedGitHubRepository = nil
        lastError = nil

        managedGitHubConnectionTask = Task { [weak self] in
            guard let self else { return }
            defer {
                isManagedGitHubConnectionInProgress = false
                managedGitHubConnectionTask = nil
            }
            do {
                let identity = try GitHubBrokerDeviceIdentityStore(
                    secretStore: dependencies.secretStore
                ).loadOrCreate()
                try await loadManagedGitHubRepositories(
                    broker: broker,
                    identity: identity,
                    installationId: installationId
                )
            } catch {
                guard !Task.isCancelled else { return }
                applyManagedGitHubFailure(error)
            }
        }
    }

    package func selectManagedGitHubRepository(fullName: String) {
        guard case .bound = managedGitHubConnectionState,
              let repository = managedGitHubRepositories.first(where: {
                  $0.fullName == fullName
              })
        else {
            lastError = "Refresh the server-bound GitHub repositories before selecting one."
            return
        }
        guard repository.visibility != .unknown else {
            lastError = "GitHub repository visibility is unavailable. NeonDiff fails closed until the broker returns authoritative visibility."
            return
        }

        selectedManagedGitHubRepository = repository.fullName
        for index in repos.indices {
            repos[index].enabled = false
        }
        if let index = repos.firstIndex(where: { $0.name == repository.fullName }) {
            repos[index].enabled = true
            repos[index].profile = repository.visibility.rawValue
        } else {
            repos.append(RepoMonitor(
                name: repository.fullName,
                enabled: true,
                profile: repository.visibility.rawValue,
                lastReview: "selected through managed GitHub broker"
            ))
            repos.sort {
                $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
            }
        }

        switch repository.visibility {
        case .public:
            onboardingFlow.mode = .publicReposOnly
            enterActivation(for: .publicReposOnly)
            onboardingFlow.licenseActivation = .activated
        case .private, .internal:
            onboardingFlow.mode = .privateRepos
            if activationState == .active,
               !activationVerifiedThisLaunch || activatedRepository != repository.fullName {
                activationVerifiedThisLaunch = false
                dependencies.preferences.set("", forKey: activationRepositoryKey)
                activationState = license.keyStored ? .keyReady : .purchaseRequired
                dependencies.preferences.set(activationState.rawValue, forKey: activationStateKey)
            }
            enterActivation(for: .privateRepos)
            onboardingFlow.licenseActivation = activationVerifiedThisLaunch
                    && activationState == .active
                    && activatedRepository == repository.fullName
                ? .activated
                : .servicePending
        case .unknown:
            break
        }
        managedGitHubRecovery = nil
        lastError = nil
        logText = "\(repository.fullName) selected from the authoritative GitHub App binding. Preview and apply the allowlist before review."
    }

    package func performManagedGitHubRecoveryAction() {
        switch managedGitHubRecovery?.action {
        case .installOrManageApp, .reconnect:
            startManagedGitHubConnection()
        case .retryLater, .retry:
            if Self.savedManagedGitHubInstallationId(preferences: dependencies.preferences) != nil {
                refreshManagedGitHubRepositories()
            } else {
                startManagedGitHubConnection()
            }
        case .contactOrganizationOwner:
            logText = managedGitHubRecovery?.message
                ?? "Ask an organization owner to approve the GitHub App installation."
        case nil:
            refreshManagedGitHubRepositories()
        }
    }

    package func previewRepoAllowlistPatch() {
        guard !managedGitHubAvailable || hasVerifiedManagedGitHubSelection else {
            lastError = "Verify the GitHub App binding and select exactly one server-bound repository before previewing the allowlist."
            return
        }
        runRepoSelectionPatch(dryRun: true)
    }

    package func applyRepoAllowlistPatch() {
        guard !managedGitHubAvailable || hasVerifiedManagedGitHubSelection else {
            lastError = "Verify the GitHub App binding and select exactly one server-bound repository before applying the allowlist."
            return
        }
        runRepoSelectionPatch(dryRun: false)
    }

    package func storeProviderKey() {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard let account = selectedProviderKeyAccount else {
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = "Select a valid provider before storing an API key."
            return
        }
        do {
            try dependencies.secretStore.setSecret(pendingProviderKey, account: account)
            pendingProviderKey = ""
            providerKeyRevision &+= 1
            invalidateProviderVerificationContext(status: "Stored key changed. Verify it when ready.")
            providers.providerKeyStored = true
            onboardingFlow.providerKeyStored = true
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func clearProviderKey() {
        guard providerVerificationSafetyLatchMessage == nil else {
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard let account = selectedProviderKeyAccount else {
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = "Select a valid provider before clearing an API key."
            return
        }
        do {
            try dependencies.secretStore.deleteSecret(account: account)
            pendingProviderKey = ""
            providerKeyRevision &+= 1
            invalidateProviderVerificationContext(status: "Stored key cleared. Store a key before verification.")
            providers.providerKeyStored = false
            onboardingFlow.providerKeyStored = false
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func verifyProviderKey() {
        guard requireProductionUsefulWorkAuthorization() else {
            providerVerification = nil
            providerVerificationStatus = lastError ?? productionActivationBoundaryMessage
            return
        }
        if let providerVerificationSafetyLatchMessage {
            providerVerification = nil
            providerVerificationStatus = providerVerificationSafetyLatchMessage
            lastError = providerVerificationSafetyLatchMessage
            return
        }
        guard !isProviderVerificationInProgress else { return }
        guard let providerKeyAccount = selectedProviderKeyAccount,
              providers.providerKeyStored,
              dependencies.secretStore.containsSecret(account: providerKeyAccount)
        else {
            providerVerification = nil
            providerVerificationStatus = "Store a provider API key in Keychain before verification."
            lastError = "Provider verification requires a stored Keychain item."
            return
        }

        persistLocalSettings()
        guard let providerId = providers.selectedRegistryTarget?.id,
              let expectedRevision = providerLoadedRevision,
              canVerifyProviderKey
        else {
            providerVerification = nil
            providerVerificationStatus = "Apply and reload an eligible saved provider before verification."
            lastError = "Provider verification requires an applied openai-compatible api-key-env provider."
            return
        }
        let arguments = [
            "providers", "verify",
            "--config", configPath,
            "--provider", providerId,
            "--expected-config-revision", expectedRevision,
            "--api-key-stdin", "true",
            "--allow-remote-smoke", "true",
            "--json"
        ]
        let executablePath = cliPath
        let requestContext = currentProviderVerificationContext
        let requestContextGeneration = providerVerificationContextGeneration
        providerVerificationRequestGeneration &+= 1
        let requestGeneration = providerVerificationRequestGeneration
        let providerVerifier = dependencies.providerVerifier

        providerVerification = nil
        providerVerificationStatus = "Verifying the stored API key…"
        isProviderVerificationInProgress = true
        isProviderVerificationCancelling = false
        activeProviderVerificationRequestGeneration = requestGeneration
        lastError = nil
        lastCommandLine = "\(shellQuote(executablePath)) providers verify --config \(shellQuote(configPath)) --provider \(shellQuote(providerId)) --expected-config-revision \(shellQuote(expectedRevision)) --api-key-stdin true --allow-remote-smoke true --json < [secure Keychain input]"

        providerVerificationTask = Task { [weak self] in
            let outcome: Result<ProviderVerificationSnapshot, Error>
            do {
                outcome = .success(try await providerVerifier.verify(
                    executablePath: executablePath,
                    account: providerKeyAccount,
                    expectedProviderId: providerId,
                    expectedConfigRevision: expectedRevision,
                    arguments: arguments,
                    timeout: 15
                ))
            } catch {
                outcome = .failure(error)
            }

            guard let self else { return }
            let wasCancelled = Task.isCancelled
            guard self.activeProviderVerificationRequestGeneration == requestGeneration else { return }
            self.providerVerificationTask = nil
            self.activeProviderVerificationRequestGeneration = nil
            self.isProviderVerificationInProgress = false
            self.isProviderVerificationCancelling = false
            if case .failure(NeonDiffCLIError.cleanupTimedOut) = outcome {
                let message = "Provider verification process cleanup could not be proven. Restart NeonDiff before any further provider, config, or CLI operation."
                self.providerVerificationSafetyLatchMessage = message
                self.providerVerification = nil
                self.providerVerificationStatus = message
                self.lastError = message
                return
            }
            guard
                !wasCancelled,
                self.providerVerificationContextGeneration == requestContextGeneration,
                self.currentProviderVerificationContext == requestContext
            else {
                self.providerVerification = nil
                self.providerVerificationStatus = "Provider or config changed during verification. Verify again."
                self.lastError = nil
                return
            }
            switch outcome {
            case .success(let snapshot):
                self.providerVerification = snapshot
                self.lastError = nil
                switch snapshot.state {
                case .healthy:
                    self.providerVerificationStatus = "Provider API key verified."
                case .configuredUnverified:
                    self.providerVerificationStatus = "Provider is configured but not verified."
                case .blocked:
                    self.providerVerificationStatus = "Provider verification was blocked."
                }
            case .failure:
                self.providerVerification = nil
                self.providerVerificationStatus = "Verification failed safely. Confirm the stored key, provider config, and NeonDiff CLI, then retry."
                self.lastError = "Provider verification failed without retaining provider output."
            }
        }
    }

    private var currentProviderVerificationContext: ProviderVerificationRequestContext {
        ProviderVerificationRequestContext(
            configPath: configPath,
            cliPath: cliPath,
            providers: providers,
            loadedConfigRevision: controlCenterLoadedRevision,
            providerKeyRevision: providerKeyRevision
        )
    }

    private var selectedProviderKeyAccount: String? {
        ProviderKeychainAccount.account(providerId: providers.selectedProviderId)
    }

    private func refreshSelectedProviderKeyState() {
        let stored = selectedProviderKeyAccount.map(dependencies.secretStore.containsSecret(account:)) == true
        providers.providerKeyStored = stored
        onboardingFlow.providerKeyStored = stored
    }

    private func invalidateProviderVerificationContext(
        status: String = "Provider or config changed. Verify the stored key again."
    ) {
        providerVerificationContextGeneration &+= 1
        let isCancellingActiveRequest = isProviderVerificationInProgress
        if isCancellingActiveRequest {
            isProviderVerificationCancelling = true
            providerVerificationStatus = "Cancelling provider verification safely…"
            providerVerificationTask?.cancel()
        }
        providerVerification = nil
        if !isCancellingActiveRequest {
            providerVerificationStatus = status
        }
    }

    package func storeLicenseKey() {
        guard requireVerifiedNativeActivationBroker() else { return }
        do {
            try dependencies.secretStore.setSecret(pendingLicenseKey, account: licenseKeyAccount)
            pendingLicenseKey = ""
            license = LicenseStatus(keyStored: true, entitlement: "stored locally", updateChannel: license.updateChannel)
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    package func activateLicenseForOnboarding() {
        guard requireVerifiedNativeActivationBroker() else {
            onboardingFlow.licenseActivation = .servicePending
            license.entitlement = "activation unavailable"
            return
        }
        if !pendingLicenseKey.isEmpty {
            storeLicenseKey()
        }
        onboardingFlow.licenseActivation = .servicePending
        license.entitlement = "service pending"
        lastError = nil
        logText = "License activation is pending the hosted license service deployment."
    }

    // MARK: - Native activation handoff (#612)

    /// The new return/redeem surface is feature-flagged off by default; enabling
    /// it is the rollback control per the issue AC. Existing validated licenses
    /// are untouched either way.
    package var activationHandoffEnabled: Bool {
        dependencies.preferences.bool(forKey: activationHandoffEnabledKey)
    }

    /// Production checkout stays disabled pending #562 + website #46. Until then
    /// the private route renders the honest `checkout_paused` state.
    package var activationCheckoutEnabled: Bool {
        dependencies.preferences.bool(forKey: activationCheckoutEnabledKey)
    }

    package var activationPresentation: ActivationStatePresentation {
        ActivationStateMachine.presentation(for: activationState, redactedKeyPrefix: activationKeyRedactedPrefix)
    }

    private var activationLicenseClient: (any ActivationLicenseClienting)? {
        if let activationLicenseClientOverride { return activationLicenseClientOverride }
        // Keep the real adapter behind the rollout flag until production billing
        // and activation canaries pass. When enabled, it uses the CLI's explicit
        // no-local-state mode: the app-owned Keychain item remains the only raw
        // credential copy and the key crosses only over bounded stdin.
        guard dependencies.productionBoundary.nativeActivationBrokerVerified,
              dependencies.preferences.bool(forKey: activationCliBackedEnabledKey)
        else {
            return nil
        }
        let enabledRepositories = repos
            .filter(\.enabled)
            .map(\.name)
            .filter(isValidRepoName)
        guard enabledRepositories.count == 1,
              let identity = try? GitHubBrokerDeviceIdentityStore(
                secretStore: dependencies.secretStore
              ).loadOrCreate()
        else {
            return nil
        }
        return DesktopActivationLicenseClient(
            cli: dependencies.cli,
            executablePath: cliPath,
            configPath: configPath,
            machineId: identity.deviceId,
            repository: enabledRepositories[0]
        )
    }

    /// Tags each activation attempt so a slow in-flight result that lands after a
    /// cancellation or a newer request is dropped (resume-exact race guard).
    private var activationRequestGeneration: UInt64 = 0

    package func applyActivationEvent(_ event: ActivationEvent) {
        let next = ActivationStateMachine.reduce(activationState, on: event)
        guard next != activationState else { return }
        if activationState == .active, next != .active {
            activationVerifiedThisLaunch = false
            dependencies.preferences.set("", forKey: activationRepositoryKey)
        }
        activationState = next
        // Persist for resume-exact restore across relaunch / cancel / network loss.
        dependencies.preferences.set(next.rawValue, forKey: activationStateKey)
    }

    /// Enter the activation branch from the chosen onboarding path. The public
    /// path skips straight to a free, license-free state.
    package func enterActivation(for mode: OnboardingMode) {
        applyActivationEvent(mode == .publicReposOnly ? .choosePublicPath : .choosePrivatePath)
    }

    /// Align the activation entry state with the onboarding mode when the flow
    /// first reaches activation, so choosing Public Repos actually skips the
    /// license wall. Only flips between the two entry states — never disturbs a
    /// mid-flow or resumed state (resume-exact).
    package func syncActivationEntryFromOnboardingMode() {
        switch activationState {
        case .purchaseRequired where onboardingFlow.mode == .publicReposOnly:
            applyActivationEvent(.choosePublicPath)
        case .publicFreeSkip where onboardingFlow.mode == .privateRepos:
            applyActivationEvent(.choosePrivatePath)
        default:
            break
        }
    }

    package func beginActivationCheckout() {
        applyActivationEvent(activationCheckoutEnabled ? .beginCheckout : .checkoutUnavailable)
    }

    package func cancelActivationCheckout() {
        // Invalidate any in-flight activation so its late result is ignored.
        activationRequestGeneration &+= 1
        applyActivationEvent(.checkoutCancelled)
    }

    /// Existing keys still activate while checkout is paused. The key is stored in
    /// the Keychain only; only a redacted prefix is retained in memory for display.
    package func provideExistingActivationKey() {
        guard persistPendingActivationKey(requireNonEmpty: true) else { return }
        lastError = nil
        applyActivationEvent(.provideExistingKey)
    }

    /// Upsert the pasted key into the Keychain (single canonical item) and retain
    /// only a redacted prefix in memory. Returns false when there is nothing to
    /// store (or the store failed).
    @discardableResult
    private func persistPendingActivationKey(requireNonEmpty: Bool = false) -> Bool {
        let material = ActivationKeyMaterial(pendingActivationKey)
        guard !material.isEmpty else {
            if requireNonEmpty {
                lastError = "Enter your \(ActivationTerminology.activationKey) to continue."
            }
            return false
        }
        do {
            try dependencies.secretStore.setSecret(pendingActivationKey, account: activationKeyAccount)
            activationKeyRedactedPrefix = material.redactedPrefix
            pendingActivationKey = ""
            return true
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return false
        }
    }

    package func reenterActivationKey() {
        applyActivationEvent(.reenterKey)
    }

    package func renewActivation() {
        applyActivationEvent(.renew)
    }

    /// Single entry the UI calls for the one recovery action a state advertises.
    package func performActivationRecovery() async {
        guard let event = activationPresentation.recovery?.event else { return }
        switch event {
        case .beginCheckout, .checkoutUnavailable:
            beginActivationCheckout()
        case .provideExistingKey:
            provideExistingActivationKey()
        case .submitActivation:
            await submitActivation()
        case .checkoutCancelled:
            cancelActivationCheckout()
        case .reenterKey:
            reenterActivationKey()
        case .renew:
            renewActivation()
        case .retry:
            await retryActivation()
        default:
            applyActivationEvent(event)
        }
    }

    package func requestActivationNotifyWhenCheckoutReopens() {
        logText = "You'll be notified when \(ActivationTerminology.activationKey) checkout reopens. Existing keys still activate now."
    }

    package func submitActivation() async {
        guard activationState == .keyReady else { return }
        // A corrected/replacement key typed on the key-entry screen must be stored
        // (and thus used) before we activate — otherwise the previous, rejected key
        // would be retried.
        if !pendingActivationKey.isEmpty {
            guard persistPendingActivationKey() else { return }
        }
        applyActivationEvent(.submitActivation)
        await performActivation()
    }

    package func retryActivation() async {
        guard activationState == .offline || activationState == .serviceError else { return }
        if !pendingActivationKey.isEmpty {
            guard persistPendingActivationKey() else { return }
        }
        applyActivationEvent(.retry)
        await performActivation()
    }

    /// Runs against `activation_pending`: read the key lazily from the Keychain
    /// (off the launch path) and hand it to the license client over bounded stdin.
    private func performActivation() async {
        activationRequestGeneration &+= 1
        let generation = activationRequestGeneration

        guard let client = activationLicenseClient else {
            // No CLI-backed validation available (default): never invoke the
            // file-persisting CLI. Land in a retryable state instead.
            applyActivationEvent(.activationServiceError)
            lastError = activationPresentation.cause
            return
        }
        let rawKey: String?
        do {
            rawKey = try dependencies.secretStore.readSecret(account: activationKeyAccount, allowUserInteraction: true)
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            applyActivationEvent(.activationServiceError)
            return
        }
        guard let rawKey, !rawKey.isEmpty else {
            // Missing Keychain item mid-activation → back to key entry, not a dead
            // Activating state (reenterKey now transitions from activationPending).
            applyActivationEvent(.reenterKey)
            lastError = "No stored \(ActivationTerminology.activationKey) to activate. Enter it again."
            return
        }
        let outcome: ActivationClientOutcome
        do {
            outcome = try await client.activate(key: ActivationKeyMaterial(rawKey))
        } catch {
            outcome = .offline
        }
        // Drop stale results after a cancellation or a newer activation request.
        guard generation == activationRequestGeneration else { return }
        let resolved = resolveActivationOutcome(outcome)
        applyActivationEvent(ActivationLicenseOutcomeMapping.event(for: resolved))
        applyActivationOutcomeSideEffects(resolved)
    }

    /// A 200-`active` response can still be public-only or `privateRepoAllowed=false`,
    /// which the server review gate rejects for private repos. Downgrade such a
    /// scope-insufficient success to a scope conflict so the pane never reports
    /// private review as unlocked when it is not.
    private func resolveActivationOutcome(_ outcome: ActivationClientOutcome) -> ActivationClientOutcome {
        if case let .active(summary) = outcome, !summary.coversPrivateRepos {
            return .scopeConflict
        }
        return outcome
    }

    private func applyActivationOutcomeSideEffects(_ outcome: ActivationClientOutcome) {
        switch outcome {
        case .active(let summary):
            activationVerifiedThisLaunch = true
            lastError = nil
            let scope = summary.repoVisibilityScope
            let plan = summary.plan.map { " · \($0)" } ?? ""
            license.entitlement = "active (\(scope)\(plan))"
            logText = "\(ActivationTerminology.activationKey) is active. Private repository review is unlocked."
            if let repository = repos.filter(\.enabled).map(\.name).onlyElement {
                dependencies.preferences.set(repository, forKey: activationRepositoryKey)
            } else {
                dependencies.preferences.set("", forKey: activationRepositoryKey)
            }
            // Let onboarding finish through the native handoff (Continue enables).
            onboardingFlow.licenseActivation = .activated
        case .scopeConflict:
            activationVerifiedThisLaunch = false
            lastError = "This \(ActivationTerminology.activationKey) does not cover private repositories. Use a key with a private-repo entitlement."
        case .expired, .revoked, .invalid, .offline, .serviceError, .malformed:
            activationVerifiedThisLaunch = false
            // Cause copy comes from the typed state presentation — never a raw
            // error string, and never any key material.
            lastError = activationPresentation.cause
        }
    }

    package func advanceOnboarding() {
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        guard canAdvanceOnboarding else { return }
        if onboardingFlow.currentStep == .done {
            completeOnboarding()
            return
        }
        onboardingFlow.advance()
    }

    package func goBackOnboarding() {
        onboardingFlow.goBack()
    }

    package func completeOnboarding() {
        guard productionUsefulWorkAvailable,
              dependencies.productionBoundary.managedGitHubBrokerOrigin == nil
                || hasVerifiedManagedGitHubSelection,
              onboardingFlow.licenseActivation == .activated
        else {
            _ = requireVerifiedNativeActivationBroker()
            isOnboardingPresented = true
            return
        }
        dependencies.preferences.set(true, forKey: onboardingCompletedKey)
        isOnboardingPresented = false
    }

    package func openReadOnlyAppFromQuarantinedOnboarding() {
        guard !dependencies.productionBoundary.nativeActivationBrokerVerified else { return }
        isOnboardingPresented = false
        lastError = nil
        logText = "Opened the read-only setup surface. \(productionActivationBoundaryMessage)"
    }

    @discardableResult
    private func requireVerifiedNativeActivationBroker() -> Bool {
        guard dependencies.productionBoundary.nativeActivationBrokerVerified else {
            lastError = productionActivationBoundaryMessage
            logText = productionActivationBoundaryMessage
            return false
        }
        return true
    }

    @discardableResult
    private func requireProductionUsefulWorkAuthorization() -> Bool {
        guard productionUsefulWorkAvailable else {
            let message = dependencies.productionBoundary.nativeActivationBrokerVerified
                ? "Verify the selected repository and its current entitlement before running NeonDiff."
                : productionActivationBoundaryMessage
            lastError = message
            logText = message
            return false
        }
        return true
    }

    package func reopenOnboarding() {
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        isOnboardingPresented = true
    }

    package func copyCommand(_ command: DesktopCommand) {
        _ = dependencies.clipboard.write(command.commandLine)
        lastCommandLine = command.commandLine
    }

    private func runCLI(
        arguments: [String],
        displayCommand: DesktopCommand,
        controlCenterOperation: ControlCenterOperation? = nil,
        providerPatchProof: PendingProviderPatchProof? = nil
    ) {
        if let providerVerificationSafetyLatchMessage {
            lastError = providerVerificationSafetyLatchMessage
            clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            if controlCenterOperation != nil { isControlCenterOperationInProgress = false }
            return
        }
        let isConfigPatchCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "patch"
        let isConfigInspectCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "inspect"
        if (isConfigPatchCommand || isConfigInspectCommand)
            && (isProviderVerificationInProgress || isProviderVerificationCancelling) {
            lastError = "Wait for provider verification cleanup before changing config."
            clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            if controlCenterOperation != nil { isControlCenterOperationInProgress = false }
            return
        }
        if isConfigPatchCommand && (isConfigPatchInProgress || isConfigInspectInProgress) {
            lastError = "Another config operation is still running."
            if controlCenterOperation != nil {
                controlCenterStatus = lastError ?? "Control-center command deferred."
                isControlCenterOperationInProgress = false
            }
            return
        }
        if isConfigInspectCommand && (isConfigPatchInProgress || isConfigInspectInProgress) {
            lastError = "Another config operation is still running."
            return
        }
        if isConfigPatchCommand { isConfigPatchInProgress = true }
        if isConfigInspectCommand { isConfigInspectInProgress = true }
        lastCommandLine = displayCommand.commandLine
        let executablePath = cliPath
        let cli = dependencies.cli
        Task.detached { [configPath, launchdLabel] in
            do {
                let result = try await cli.run(
                    executablePath: executablePath,
                    arguments: arguments,
                    standardInput: nil,
                    timeout: 15
                )
                await MainActor.run {
                    self.applyCLIResult(
                        result,
                        fallbackCommand: displayCommand.commandLine,
                        configPath: configPath,
                        launchdLabel: launchdLabel,
                        isConfigInspectCommand: isConfigInspectCommand,
                        controlCenterOperation: controlCenterOperation,
                        providerPatchProof: providerPatchProof
                    )
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    if isConfigInspectCommand { self.isConfigInspectInProgress = false }
                    if controlCenterOperation != nil { self.isControlCenterOperationInProgress = false }
                    self.clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
                }
            } catch {
                await MainActor.run {
                    self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    self.logText = self.lastError ?? "Unknown CLI error"
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    self.clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
                    if isConfigInspectCommand {
                        self.invalidateProviderConfigAuthorization()
                        self.invalidateControlCenterAfterInspectFailure(self.lastError ?? "Config inspect failed.")
                        self.isConfigInspectInProgress = false
                    }
                    if controlCenterOperation != nil {
                        self.invalidateControlCenterAfterPatchFailure(
                            self.lastError ?? "Control-center command failed before a response was received."
                        )
                        self.isControlCenterOperationInProgress = false
                    }
                }
            }
        }
    }

    private func runProviderConfigPatch(dryRun: Bool) {
        guard !isConfigPatchInProgress, !isConfigInspectInProgress else {
            lastError = "Another config operation is still running."
            return
        }
        guard let expectedRevision = dryRun ? providerLoadedRevision : previewedProviderExpectedRevision else {
            lastError = "Load current config before changing provider settings."
            return
        }
        do {
            try writeProviderPatch()
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return
        }
        var arguments = [
            "config",
            "patch",
            "--config",
            configPath,
            "--input",
            providerPatchPath.path,
            "--dry-run",
            dryRun ? "true" : "false"
        ]
        arguments.append(contentsOf: ["--expected-revision", expectedRevision])
        let proof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: currentProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: dryRun ? .preview : .apply
        )
        pendingProviderPatchProof = proof
        if !dryRun {
            arguments.append(contentsOf: ["--confirm", "true"])
        }
        runCLI(
            arguments: arguments,
            displayCommand: dryRun ? providerPatchPreviewCommand : providerPatchApplyCommand,
            providerPatchProof: proof
        )
    }

    private var providerPatchPath: URL {
        appSupportDirectory.appendingPathComponent("provider-settings-patch.json")
    }

    private var repoSelectionPatchPath: URL {
        appSupportDirectory.appendingPathComponent("repo-allowlist-patch.json")
    }

    private var controlCenterPatchPath: URL {
        appSupportDirectory.appendingPathComponent("control-center-patch.json")
    }

    private var controlCenterRollbackPath: URL {
        appSupportDirectory.appendingPathComponent("control-center-rollback.json")
    }

    private var appSupportDirectory: URL {
        dependencies.fileWriter.applicationSupportDirectory
    }

    private func writeProviderPatch() throws {
        let data = try ProviderRegistryPatchBuilder.data(for: providers)
        try dependencies.fileWriter.write(data, to: providerPatchPath)
    }

    private func writeControlCenterPatch(_ settings: DesktopControlCenterSettings, to path: URL) throws {
        let data = try DesktopControlCenterPatchBuilder.data(for: settings)
        try dependencies.fileWriter.write(data, to: path)
    }

    private func beginControlCenterOperation(_ operation: ControlCenterOperation) -> Bool {
        guard canEditProviderConfiguration else {
            lastError = "Wait for provider verification cleanup before changing config."
            return false
        }
        guard !isControlCenterOperationInProgress else {
            lastError = "Another control-center operation is still running."
            return false
        }
        isControlCenterOperationInProgress = true
        controlCenterStatus = operation.statusText
        return true
    }

    private func runControlCenterPatch(operation: ControlCenterOperation, arguments: [String], command: DesktopCommand) {
        runCLI(arguments: arguments, displayCommand: command, controlCenterOperation: operation)
    }

    private func runRepoSelectionPatch(dryRun: Bool) {
        guard canEditProviderConfiguration else {
            lastError = "Wait for provider verification cleanup before changing config."
            return
        }
        do {
            try writeRepoSelectionPatch()
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
            return
        }
        var arguments = [
            "config",
            "patch",
            "--config",
            configPath,
            "--input",
            repoSelectionPatchPath.path,
            "--dry-run",
            dryRun ? "true" : "false"
        ]
        if !dryRun {
            arguments.append(contentsOf: ["--confirm", "true"])
        }
        runCLI(arguments: arguments, displayCommand: dryRun ? repoSelectionPatchPreviewCommand : repoSelectionPatchApplyCommand)
    }

    private func gitHubAccessTokenForAPI() async throws -> String {
        guard let accessToken = try dependencies.secretStore.readSecret(account: githubUserTokenAccount), !accessToken.isEmpty else {
            clearStoredGitHubAuthorization(status: "connect GitHub first")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("Connect GitHub before refreshing accessible repositories.")
        }
        guard let expiresAt = readGitHubStoredDate(account: githubTokenExpiresAtAccount) else {
            return accessToken
        }
        if expiresAt > dependencies.clock.now.addingTimeInterval(60) {
            return accessToken
        }
        guard let clientId = github.clientId?.trimmingCharacters(in: .whitespacesAndNewlines), !clientId.isEmpty else {
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired and the public client ID is missing. Reconnect GitHub after loading config.")
        }
        guard let refreshToken = try dependencies.secretStore.readSecret(account: githubRefreshTokenAccount), !refreshToken.isEmpty else {
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired. Reconnect GitHub.")
        }
        if let refreshExpiresAt = readGitHubStoredDate(account: githubRefreshTokenExpiresAtAccount), refreshExpiresAt <= dependencies.clock.now {
            clearStoredGitHubAuthorization(status: "refresh expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub refresh token expired. Reconnect GitHub.")
        }
        githubAuthorizationStatus = "refreshing GitHub authorization"
        let refreshedToken: GitHubUserToken
        do {
            refreshedToken = try await dependencies.githubAuthenticator.refreshUserToken(clientId: clientId, refreshToken: refreshToken)
        } catch {
            clearStoredGitHubAuthorization(status: "refresh failed; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization refresh failed. Reconnect GitHub.")
        }
        try storeGitHubToken(refreshedToken)
        githubAuthorizationStatus = "GitHub authorization refreshed"
        return refreshedToken.accessToken
    }

    private func pollGitHubAuthorization(clientId: String, code: GitHubDeviceAuthorizationCode) async {
        var intervalSeconds = code.intervalSeconds
        while !Task.isCancelled && dependencies.clock.now < code.expiresAt {
            do {
                try await dependencies.clock.sleep(for: .seconds(max(1, intervalSeconds)))
                let result = try await dependencies.githubAuthenticator.pollDeviceAuthorization(clientId: clientId, deviceCode: code.deviceCode)
                switch result {
                case .pending(let nextInterval):
                    intervalSeconds = max(1, nextInterval)
                    githubAuthorizationStatus = "waiting for authorization"
                case .authorized(let token):
                    try storeGitHubToken(token)
                    let user = try await dependencies.githubAuthenticator.fetchCurrentUser(accessToken: token.accessToken)
                    let discovered = try await dependencies.githubAuthenticator.listAccessibleRepositories(accessToken: token.accessToken)
                    applyGitHubDiscovery(user: user, discovered: discovered)
                    isGitHubAuthorizationInProgress = false
                    githubAuthorizationCode = nil
                    return
                case .failed(let error, let description):
                    isGitHubAuthorizationInProgress = false
                    githubAuthorizationStatus = error.rawValue
                    github.installationState = "authorization failed"
                    let recovery = GitHubConnectionRecoveryClassifier.deviceAuthorizationFailure(error, description: description)
                    githubRecovery = recovery
                    lastError = recovery.message
                    logText = recovery.message
                    return
                }
            } catch {
                if Task.isCancelled { return }
                isGitHubAuthorizationInProgress = false
                applyGitHubFailure(error, fallbackStatus: "authorization failed")
                return
            }
        }
        if !Task.isCancelled {
            isGitHubAuthorizationInProgress = false
            let recovery = GitHubConnectionRecoveryClassifier.deviceCodeExpired
            githubAuthorizationStatus = recovery.status
            github.installationState = recovery.status
            githubRecovery = recovery
            lastError = recovery.message
            logText = recovery.message
        }
    }

    private func storeGitHubToken(_ token: GitHubUserToken) throws {
        try dependencies.secretStore.setSecret(token.accessToken, account: githubUserTokenAccount)
        if let refreshToken = token.refreshToken {
            try dependencies.secretStore.setSecret(refreshToken, account: githubRefreshTokenAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenAccount)
        }
        if let expiresAt = token.expiresAt {
            try dependencies.secretStore.setSecret(ISO8601DateFormatter().string(from: expiresAt), account: githubTokenExpiresAtAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubTokenExpiresAtAccount)
        }
        if let refreshTokenExpiresAt = token.refreshTokenExpiresAt {
            try dependencies.secretStore.setSecret(ISO8601DateFormatter().string(from: refreshTokenExpiresAt), account: githubRefreshTokenExpiresAtAccount)
        } else {
            try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
        }
        github.userTokenStored = true
    }

    private func applyGitHubDiscovery(user: GitHubAuthenticatedUser, discovered: [GitHubDiscoveredRepository]) {
        discoveredGitHubRepos = discovered
        repos = GitHubRepositoryDiscovery.mergeConfiguredAndDiscoveredRepos(configured: repos, discovered: discovered)
        github.userTokenStored = true
        github.authorizedUserLogin = user.login
        github.installationCount = Set(discovered.map(\.installationId)).count
        github.discoveredRepositoryCount = discovered.count
        github.installationState = discovered.isEmpty
            ? "authorized as \(user.login); no accessible App repositories found"
            : "authorized as \(user.login); \(discovered.count) repositories available"
        githubRecovery = discovered.isEmpty ? GitHubConnectionRecoveryClassifier.noInstallations : nil
        githubAuthorizationStatus = "authorized as \(user.login)"
        lastError = nil
        logText = "GitHub connected as \(user.login). Select repositories, then preview or apply the allowlist patch."
        try? dependencies.secretStore.setSecret(user.login, account: githubUserLoginAccount)
    }

    private func clearStoredGitHubAuthorization(status: String) {
        try? dependencies.secretStore.deleteSecret(account: githubUserTokenAccount)
        try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenAccount)
        try? dependencies.secretStore.deleteSecret(account: githubTokenExpiresAtAccount)
        try? dependencies.secretStore.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
        try? dependencies.secretStore.deleteSecret(account: githubUserLoginAccount)
        github.userTokenStored = false
        github.authorizedUserLogin = nil
        github.installationCount = 0
        github.discoveredRepositoryCount = 0
        github.installationState = status
        githubAuthorizationStatus = status
        githubAuthorizationCode = nil
        discoveredGitHubRepos = []
    }

    private func applyGitHubFailure(_ error: Error, fallbackStatus: String) {
        let recovery = (error as? GitHubDeviceAuthClientError)?.recovery
            ?? GitHubConnectionRecovery(
                status: fallbackStatus,
                message: NeonDiffRedactor.redact(error.localizedDescription),
                action: .retry
            )
        githubRecovery = recovery
        githubAuthorizationStatus = recovery.status
        github.installationState = recovery.status
        lastError = recovery.message
        logText = recovery.message
    }

    private func awaitManagedGitHubBinding(
        broker: any GitHubBrokerConnecting,
        identity: GitHubBrokerDeviceIdentity,
        connection: GitHubBrokerConnection
    ) async throws -> Int {
        while !Task.isCancelled && dependencies.clock.now < connection.expiresAt {
            switch try await broker.completeConnection(
                identity: identity,
                state: connection.state
            ) {
            case .bound(let installationId):
                return installationId
            case .pending:
                try await dependencies.clock.sleep(for: .seconds(2))
            }
        }
        throw ManagedGitHubModelError.authorizationExpired
    }

    private func loadManagedGitHubRepositories(
        broker: any GitHubBrokerConnecting,
        identity: GitHubBrokerDeviceIdentity,
        installationId: Int
    ) async throws {
        var pageNumber = 1
        var repositories: [GitHubBrokerRepository] = []
        while !Task.isCancelled {
            let page = try await broker.listRepositories(
                identity: identity,
                installationId: installationId,
                page: pageNumber
            )
            guard page.installationId == installationId,
                  page.page == pageNumber
            else {
                throw GitHubBrokerClientError.scopeMismatch
            }
            repositories.append(contentsOf: page.repositories)
            guard let nextPage = page.nextPage else { break }
            guard nextPage == pageNumber + 1, nextPage <= 200 else {
                throw GitHubBrokerClientError.scopeMismatch
            }
            pageNumber = nextPage
        }
        guard !Task.isCancelled else { return }
        let names = repositories.map(\.fullName)
        guard !repositories.isEmpty,
              Set(names).count == names.count
        else {
            throw ManagedGitHubModelError.noBoundRepositories
        }
        managedGitHubRepositories = repositories.sorted {
            $0.fullName.localizedCaseInsensitiveCompare($1.fullName) == .orderedAscending
        }
        managedGitHubConnectionState = .bound(installationId: installationId)
        managedGitHubRecovery = nil
        lastError = nil
        logText = "\(repositories.count) server-bound GitHub repositories verified. Select one to continue."
    }

    private func applyManagedGitHubFailure(_ error: Error) {
        managedGitHubConnectionState = .failed
        managedGitHubRepositories = []
        selectedManagedGitHubRepository = nil
        let recovery: GitHubConnectionRecovery
        if let brokerError = error as? GitHubBrokerClientError {
            switch brokerError {
            case .server(reason: .rateLimited),
                 .server(reason: .brokerUnavailable),
                 .server(reason: .entitlementServiceUnavailable),
                 .transportUnavailable:
                recovery = GitHubConnectionRecovery(
                    status: "broker unavailable",
                    message: "The managed GitHub service is unavailable. No repository access was granted. Retry later.",
                    action: .retryLater
                )
            case .server(reason: .installationNotFound),
                 .server(reason: .installationUninstalled),
                 .server(reason: .installationSuspended),
                 .server(reason: .installationAuthorizationUnverified),
                 .server(reason: .bindingNotFound):
                recovery = GitHubConnectionRecovery(
                    status: "App installation unavailable",
                    message: "The GitHub App installation is missing, suspended, or no longer authorized. Reconnect and manage selected repository access.",
                    action: .installOrManageApp
                )
            default:
                recovery = GitHubConnectionRecovery(
                    status: "managed GitHub verification failed",
                    message: "Managed GitHub verification failed closed. Reconnect; if it persists, contact support with redacted diagnostics.",
                    action: .reconnect
                )
            }
        } else if error is GitHubBrokerDeviceIdentityError {
            recovery = GitHubConnectionRecovery(
                status: "device identity unavailable",
                message: "The Keychain-backed GitHub device identity is unavailable. NeonDiff did not create a replacement binding.",
                action: .retry
            )
        } else if let modelError = error as? ManagedGitHubModelError {
            recovery = modelError.recovery
        } else {
            recovery = GitHubConnectionRecovery(
                status: "managed GitHub verification failed",
                message: "Managed GitHub verification failed closed. Retry with the App installed on a selected repository.",
                action: .retry
            )
        }
        managedGitHubRecovery = recovery
        lastError = recovery.message
        logText = recovery.message
    }

    private static func savedManagedGitHubInstallationId(
        preferences: any DesktopPreferences
    ) -> Int? {
        guard let raw = preferences.string(forKey: managedGitHubInstallationIdKey),
              let installationId = Int(raw),
              installationId > 0
        else {
            return nil
        }
        return installationId
    }

    private var activatedRepository: String? {
        guard let repository = dependencies.preferences.string(
            forKey: activationRepositoryKey
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
        isValidRepoName(repository)
        else {
            return nil
        }
        return repository
    }

    private func readGitHubStoredDate(account: String) -> Date? {
        Self.storedDate(secretStore: dependencies.secretStore, account: account)
    }

    private static func storedDate(secretStore: DesktopSecretStoring, account: String) -> Date? {
        guard let value = try? secretStore.readSecret(account: account) else {
            return nil
        }
        return ISO8601DateFormatter().date(from: value)
    }

    private func writeRepoSelectionPatch() throws {
        let selectedRepos = repos
            .filter(\.enabled)
            .map(\.name)
        let uniqueRepos = uniqueSortedRepoNames(selectedRepos)
        let patch: [String: Any] = [
            "pilotRepos": uniqueRepos
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
        try dependencies.fileWriter.write(data, to: repoSelectionPatchPath)
    }

    private func applyCLIResult(
        _ result: CLIRunResult,
        fallbackCommand: String,
        configPath: String,
        launchdLabel: String,
        isConfigInspectCommand: Bool,
        controlCenterOperation: ControlCenterOperation? = nil,
        providerPatchProof: PendingProviderPatchProof? = nil
    ) {
        if let providerPatchProof,
           pendingProviderPatchProof?.id != providerPatchProof.id {
            return
        }
        let redactedStdout = result.redactedStdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let redactedStderr = result.redactedStderr.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = result.exitCode == 0 ? nil : (redactedStderr.isEmpty ? redactedStdout : redactedStderr)
        logText = [result.redactedStdout, result.redactedStderr].filter { !$0.isEmpty }.joined(separator: "\n")

        let commandName = parseCommandName(result.stdout)
        var parsedSnapshot = (commandName == "config inspect" || commandName == "config patch")
            ? ConfigInspectParser.parse(
                result.stdout,
                providerKeyStored: false,
                licenseKeyStored: dependencies.secretStore.containsSecret(account: licenseKeyAccount),
                githubUserTokenStored: dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
            )
            : nil
        if var snapshot = parsedSnapshot {
            snapshot.providers.providerKeyStored = ProviderKeychainAccount.account(
                providerId: snapshot.providers.selectedProviderId
            ).map(dependencies.secretStore.containsSecret(account:)) == true
            parsedSnapshot = snapshot
        }
        var validatedPatchRevisionAfter: String?
        var validatedProviderRevisionAfter: String?
        if let providerPatchProof {
            validatedProviderRevisionAfter = ConfigPatchProofValidator.revisionAfter(
                snapshot: parsedSnapshot,
                expectedRevision: providerPatchProof.expectedRevision,
                mode: providerPatchProof.mode
            )
            guard result.exitCode == 0,
                  commandName == "config patch",
                  validatedProviderRevisionAfter != nil
            else {
                invalidateProviderConfigAuthorization()
                lastError = ConfigInspectParser.error(result.stdout, command: "config patch")
                    ?? lastError
                    ?? "Provider patch returned an invalid or stale response. Reload current config."
                return
            }
        }
        if let operation = controlCenterOperation {
            validatedPatchRevisionAfter = ConfigPatchProofValidator.revisionAfter(
                snapshot: parsedSnapshot,
                expectedRevision: operation.expectedRevision,
                mode: operation.proofMode
            )
            guard
                result.exitCode == 0,
                commandName == "config patch",
                validatedPatchRevisionAfter != nil
            else {
                let patchError = ConfigInspectParser.error(result.stdout, command: "config patch")
                    ?? lastError
                    ?? "Config patch returned an invalid or mismatched response. Reload current config before further edits."
                invalidateControlCenterAfterPatchFailure(patchError)
                return
            }
        }
        if isConfigInspectCommand && (result.exitCode != 0 || commandName != "config inspect") {
            let inspectError = ConfigInspectParser.error(result.stdout)
                ?? lastError
                ?? "Config inspect returned an invalid response."
            invalidateProviderConfigAuthorization()
            invalidateControlCenterAfterInspectFailure(inspectError)
            return
        }
        if commandName == "config inspect" || commandName == "config patch" {
            if result.exitCode == 0,
               commandName == "config inspect",
               let inspectedRevision = parsedSnapshot?.revision,
               inspectedRevision != controlCenterLoadedRevision {
                invalidateProviderVerificationContext(status: "Config changed. Verify the stored provider key again.")
            }
            if result.exitCode == 0,
               commandName == "config patch",
               parsedSnapshot?.dryRun == false,
               parsedSnapshot?.wrote == true {
                invalidateProviderVerificationContext(status: "Config changed. Verify the stored provider key again.")
            }
            if result.exitCode == 0,
               commandName == "config patch",
               providerPatchProof == nil {
                invalidateProviderConfigAuthorization()
            }
            if let snapshot = parsedSnapshot {
                if !snapshot.repos.isEmpty { repos = snapshot.repos }
                providers = snapshot.providers
                license = snapshot.license
                var parsedGitHub = snapshot.github
                parsedGitHub.userTokenStored = dependencies.secretStore.containsSecret(account: githubUserTokenAccount)
                parsedGitHub.authorizedUserLogin = github.authorizedUserLogin
                parsedGitHub.installationCount = github.installationCount
                parsedGitHub.discoveredRepositoryCount = github.discoveredRepositoryCount
                if parsedGitHub.userTokenStored && parsedGitHub.installationState == "not connected" {
                    parsedGitHub.installationState = github.installationState
                }
                github = parsedGitHub
                if commandName == "config inspect" {
                    providerLoadedSnapshot = ProviderConfigurationSnapshot(
                        providers: snapshot.providers,
                        configPath: configPath
                    )
                    providerLoadedRevision = snapshot.revision
                    previewedProviderSnapshot = nil
                    previewedProviderExpectedRevision = nil
                    controlCenter = snapshot.policy
                    controlCenterLoadedSnapshot = DesktopControlCenterSnapshot(
                        settings: snapshot.policy,
                        configPath: configPath
                    )
                    controlCenterLoadedRevision = snapshot.revision
                    controlCenterRollbackSnapshot = nil
                    controlCenterRollbackExpectedRevision = nil
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if self.configPath == configPath {
                        controlCenterStatus = "Current config loaded. Edit settings, then Preview."
                    } else {
                        controlCenterStatus = "Config loaded from a previous path. Reload the current config before editing."
                    }
                }
            }
            if commandName == "config inspect", result.exitCode != 0 || parsedSnapshot == nil {
                let inspectError = ConfigInspectParser.error(result.stdout)
                    ?? lastError
                    ?? "Config inspect returned an invalid response."
                invalidateProviderConfigAuthorization()
                invalidateControlCenterAfterInspectFailure(inspectError)
                return
            }
            if commandName == "config patch",
               let providerPatchProof,
               let revisionAfter = validatedProviderRevisionAfter,
               let snapshot = parsedSnapshot {
                switch providerPatchProof.mode {
                case .preview:
                    previewedProviderSnapshot = providerPatchProof.snapshot
                    previewedProviderExpectedRevision = providerPatchProof.expectedRevision
                    providerVerificationStatus = "Provider preview passed. Apply this exact configuration before verification."
                case .apply:
                    providerLoadedSnapshot = ProviderConfigurationSnapshot(
                        providers: snapshot.providers,
                        configPath: configPath
                    )
                    providerLoadedRevision = revisionAfter
                    previewedProviderSnapshot = nil
                    previewedProviderExpectedRevision = nil
                    providerVerificationStatus = "Provider config applied and read back. Verification is enabled for eligible targets."
                }
                clearPendingProviderPatchProof(ifOwnedBy: providerPatchProof)
            }
            if commandName == "config patch",
               let operation = controlCenterOperation,
               let revisionAfter = validatedPatchRevisionAfter {
                switch operation {
                case .preview(let snapshot, let baseline, let expectedRevision):
                    previewedControlCenterSnapshot = snapshot
                    previewedControlCenterBaseline = baseline
                    previewedControlCenterExpectedRevision = expectedRevision
                    controlCenterStatus = snapshot == currentControlCenterSnapshot
                        ? "Preview passed. Apply is enabled for this exact settings snapshot."
                        : "Preview passed for an earlier settings snapshot. Preview the current edits before Apply."
                case .apply(let snapshot, let baseline, _):
                    controlCenter = snapshot.settings
                    controlCenterLoadedSnapshot = snapshot
                    controlCenterLoadedRevision = revisionAfter
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if parsedSnapshot?.wrote == true {
                        controlCenterRollbackSnapshot = baseline
                        controlCenterRollbackExpectedRevision = revisionAfter
                        controlCenterStatus = self.configPath == snapshot.configPath
                            ? "Config applied. Apply Last Rollback is now available."
                            : "Config applied to the previously selected path. Return to that path to roll back, or load the current config."
                    } else {
                        if controlCenterRollbackSnapshot?.configPath != snapshot.configPath
                            || controlCenterRollbackExpectedRevision != revisionAfter {
                            controlCenterRollbackSnapshot = nil
                            controlCenterRollbackExpectedRevision = nil
                        }
                        controlCenterStatus = "No config changes were needed."
                    }
                case .rollback(let snapshot, _):
                    controlCenter = snapshot.settings
                    controlCenterLoadedSnapshot = snapshot
                    controlCenterLoadedRevision = revisionAfter
                    controlCenterRollbackSnapshot = nil
                    controlCenterRollbackExpectedRevision = nil
                    previewedControlCenterSnapshot = nil
                    previewedControlCenterBaseline = nil
                    previewedControlCenterExpectedRevision = nil
                    if parsedSnapshot?.wrote == true {
                        controlCenterStatus = self.configPath == snapshot.configPath
                            ? "Rollback applied. Reload config before further edits."
                            : "Rollback applied to the previously selected path. Load the current config before further edits."
                    } else {
                        controlCenterStatus = "Config was already at the rollback target. Reload before further edits."
                    }
                }
                if let warning = parsedSnapshot?.warning {
                    lastError = NeonDiffRedactor.redact(warning)
                    controlCenterStatus = lastError ?? "Config patch completed with a lock-cleanup warning."
                }
                isControlCenterOperationInProgress = false
            }
            return
        }

        if let parsed = DaemonStatusParser.parse(result.stdout, launchdLabel: launchdLabel, fallbackCommand: fallbackCommand) {
            status = parsed.0
            onboardingFlow.daemonBootstrapChecked = true
            if !parsed.1.isEmpty {
                repos = parsed.1
            }
        }
    }

    func applyCLIResultForTesting(
        _ result: CLIRunResult,
        fallbackCommand: String,
        configPath: String,
        launchdLabel: String,
        isConfigInspectCommand: Bool
    ) {
        applyCLIResult(
            result,
            fallbackCommand: fallbackCommand,
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: isConfigInspectCommand
        )
    }

    func applyProviderPatchResultForTesting(_ result: CLIRunResult, mode: ConfigPatchProofMode) {
        guard let expectedRevision = mode == .preview ? providerLoadedRevision : previewedProviderExpectedRevision else {
            return
        }
        pendingProviderPatchProof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: currentProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: mode
        )
        let proof = pendingProviderPatchProof
        applyCLIResult(
            result,
            fallbackCommand: "neondiff config patch",
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: false,
            providerPatchProof: proof
        )
    }

    func stageProviderPatchProofForTesting(mode: ConfigPatchProofMode) {
        guard !isConfigPatchInProgress, !isConfigInspectInProgress else { return }
        guard let expectedRevision = mode == .preview ? providerLoadedRevision : previewedProviderExpectedRevision else {
            return
        }
        pendingProviderPatchProof = PendingProviderPatchProof(
            id: UUID(),
            snapshot: currentProviderConfigurationSnapshot,
            expectedRevision: expectedRevision,
            mode: mode
        )
        isConfigPatchInProgress = true
    }

    func applyStagedProviderPatchResultForTesting(_ result: CLIRunResult) {
        let proof = pendingProviderPatchProof
        applyCLIResult(
            result,
            fallbackCommand: "neondiff config patch",
            configPath: configPath,
            launchdLabel: launchdLabel,
            isConfigInspectCommand: false,
            providerPatchProof: proof
        )
        clearPendingProviderPatchProof(ifOwnedBy: proof)
        isConfigPatchInProgress = false
    }

    func attemptOverlappingProviderPatchForTesting() {
        runProviderConfigPatch(dryRun: true)
    }

    private func parseCommandName(_ jsonText: String) -> String? {
        guard
            let data = jsonText.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }
        return root["command"] as? String
    }

    private func invalidateControlCenterAfterInspectFailure(_ message: String) {
        invalidateControlCenterAuthorization(message)
        controlCenterStatus = lastError ?? "Config inspect failed."
    }

    private func invalidateProviderConfigAuthorization() {
        providerLoadedSnapshot = nil
        providerLoadedRevision = nil
        previewedProviderSnapshot = nil
        previewedProviderExpectedRevision = nil
        pendingProviderPatchProof = nil
    }

    private func clearPendingProviderPatchProof(ifOwnedBy proof: PendingProviderPatchProof?) {
        guard let proof, pendingProviderPatchProof?.id == proof.id else { return }
        pendingProviderPatchProof = nil
    }

    private func invalidateControlCenterAfterPatchFailure(_ message: String) {
        invalidateControlCenterAuthorization(message)
        controlCenterStatus = lastError ?? "Config patch failed. Reload current config."
    }

    private func invalidateControlCenterAuthorization(_ message: String) {
        controlCenterLoadedSnapshot = nil
        controlCenterLoadedRevision = nil
        controlCenterRollbackSnapshot = nil
        controlCenterRollbackExpectedRevision = nil
        previewedControlCenterSnapshot = nil
        previewedControlCenterBaseline = nil
        previewedControlCenterExpectedRevision = nil
        lastError = NeonDiffRedactor.redact(message)
    }

}

private struct ProviderVerificationRequestContext: Equatable {
    let configPath: String
    let cliPath: String
    let providers: ProviderSettings
    let loadedConfigRevision: String?
    let providerKeyRevision: UInt64
}

private struct ProviderConfigurationSnapshot: Equatable, Sendable {
    let configPath: String
    let zcodeModel: String
    let zcodeCliPath: String
    let zcodeAppConfigPath: String
    let selectedProviderId: String
    let registryTargets: [ProviderRegistryTarget]

    init(providers: ProviderSettings, configPath: String) {
        self.configPath = configPath
        zcodeModel = providers.zcodeModel
        zcodeCliPath = providers.zcodeCliPath
        zcodeAppConfigPath = providers.zcodeAppConfigPath
        selectedProviderId = providers.selectedProviderId
        registryTargets = providers.registryTargets
    }
}

private struct PendingProviderPatchProof: Sendable {
    let id: UUID
    let snapshot: ProviderConfigurationSnapshot
    let expectedRevision: String
    let mode: ConfigPatchProofMode
}

private enum ControlCenterOperation: Sendable {
    case preview(
        snapshot: DesktopControlCenterSnapshot,
        baseline: DesktopControlCenterSnapshot,
        expectedRevision: String
    )
    case apply(
        snapshot: DesktopControlCenterSnapshot,
        baseline: DesktopControlCenterSnapshot,
        expectedRevision: String
    )
    case rollback(snapshot: DesktopControlCenterSnapshot, expectedRevision: String)

    var statusText: String {
        switch self {
        case .preview: "Previewing control-center patch..."
        case .apply: "Applying validated control-center patch..."
        case .rollback: "Applying last control-center rollback..."
        }
    }

    var expectedRevision: String {
        switch self {
        case .preview(_, _, let expectedRevision),
             .apply(_, _, let expectedRevision),
             .rollback(_, let expectedRevision):
            expectedRevision
        }
    }

    var proofMode: ConfigPatchProofMode {
        switch self {
        case .preview: .preview
        case .apply, .rollback: .apply
        }
    }
}

private enum GitHubDesktopAuthorizationStateError: LocalizedError {
    case reconnectRequired(String)

    var errorDescription: String? {
        switch self {
        case .reconnectRequired(let message):
            message
        }
    }
}

private let licenseKeyAccount = "license/default"
private let githubUserTokenAccount = "github/user-access-token"
private let githubRefreshTokenAccount = "github/user-refresh-token"
private let githubTokenExpiresAtAccount = "github/user-token-expires-at"
private let githubRefreshTokenExpiresAtAccount = "github/user-refresh-token-expires-at"
private let githubUserLoginAccount = "github/user-login"
private let onboardingCompletedKey = "neondiff.hasCompletedActivationOnboarding.v2"
// Issue #612 — native activation handoff. The activation state machine and the
// production license CLI share one canonical Keychain item; there is no second
// raw activation-key copy.
private let activationKeyAccount = "license/default"
private let activationStateKey = "neondiff.activationState.v1"
private let activationRepositoryKey = "neondiff.activationRepository.v1"
private let activationHandoffEnabledKey = "neondiff.activationHandoffEnabled"
private let activationCheckoutEnabledKey = "neondiff.activationCheckoutEnabled"
private let activationCliBackedEnabledKey = "neondiff.activationCliBackedValidation"
private let managedGitHubInstallationIdKey = "neondiff.managedGitHubInstallationId"

private enum ManagedGitHubModelError: Error {
    case installPageOpenFailed
    case authorizationExpired
    case noBoundRepositories

    var recovery: GitHubConnectionRecovery {
        switch self {
        case .installPageOpenFailed:
            GitHubConnectionRecovery(
                status: "GitHub install page unavailable",
                message: "NeonDiff could not open the GitHub App installation page. No repository binding was granted.",
                action: .retry
            )
        case .authorizationExpired:
            GitHubConnectionRecovery(
                status: "GitHub authorization expired",
                message: "GitHub authorization expired before the server binding completed. Start a new connection.",
                action: .reconnect
            )
        case .noBoundRepositories:
            GitHubConnectionRecovery(
                status: "no bound repositories",
                message: "The GitHub App binding contains no selected repositories. Manage App access, then refresh.",
                action: .installOrManageApp
            )
        }
    }
}

private func isValidRepoName(_ value: String) -> Bool {
    let parts = value.split(separator: "/", omittingEmptySubsequences: false)
    guard parts.count == 2 else { return false }
    return parts.allSatisfy { part in
        !part.isEmpty && part != "." && part != ".." && part.allSatisfy { character in
            character.isLetter || character.isNumber || character == "-" || character == "_" || character == "."
        }
    }
}

private func uniqueSortedRepoNames(_ names: [String]) -> [String] {
    var seen = Set<String>()
    return names
        .filter(isValidRepoName)
        .sorted { $0.localizedCaseInsensitiveCompare($1) == .orderedAscending }
        .filter { seen.insert($0.lowercased()).inserted }
}

private extension Collection {
    var onlyElement: Element? {
        count == 1 ? first : nil
    }
}
