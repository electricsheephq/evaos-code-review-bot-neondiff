import Combine
import Foundation
import NeonDiffDesktopCore

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

    private let dependencies: DesktopAppDependencies
    private var providerVerificationTask: Task<Void, Never>?
    private var providerVerificationRequestGeneration: UInt64 = 0
    private var providerVerificationContextGeneration: UInt64 = 0
    private var activeProviderVerificationRequestGeneration: UInt64?
    private var providerKeyRevision: UInt64 = 0
    private var githubAuthorizationTask: Task<Void, Never>?
    private var githubRepositoryRefreshTask: Task<Void, Never>?
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

    package init(dependencies: DesktopAppDependencies) {
        self.dependencies = dependencies
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
        self.onboardingFlow = OnboardingFlow(providerKeyStored: providerKeyStored)
        self.isOnboardingPresented = !dependencies.preferences.bool(forKey: onboardingCompletedKey)
        self.lastCommandLine = statusCommand.commandLine
    }

    #if DEBUG
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
        let workingDirectory = NeonDiffCLIResolver.defaultWorkingDirectory()

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
        runCLI(arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: startDaemonDryRunCommand)
    }

    package func previewStopDaemon() {
        runCLI(arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: stopDaemonDryRunCommand)
    }

    package func startDaemon() {
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: startDaemonCommand
        )
    }

    package func stopDaemon() {
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
        guard let index = repos.firstIndex(where: { $0.id == repo.id }) else { return }
        repos[index].enabled.toggle()
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    package func githubAccessCue(for repo: RepoMonitor) -> GitHubRepositoryAccessCue? {
        guard let discovered = discoveredGitHubRepos.first(where: {
            $0.fullName.caseInsensitiveCompare(repo.name) == .orderedSame
        }) else {
            return nil
        }
        return GitHubRepositoryAccessPolicy.cue(for: discovered, licenseEntitlement: license.entitlement)
    }

    package func removeRepoFromAllowlist(_ repo: RepoMonitor) {
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
        _ = dependencies.clipboard.write(userCode)
        githubAuthorizationStatus = "code copied"
    }

    package func openGitHubDeviceVerification() {
        guard let verificationURI = githubAuthorizationCode?.verificationURI else { return }
        _ = dependencies.urlOpener.open(verificationURI)
        githubAuthorizationStatus = "verification page opened"
    }

    package func openGitHubAppInstallation() {
        _ = dependencies.urlOpener.open(githubAppInstallURL)
        githubAuthorizationStatus = "App installation page opened"
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

    package func previewRepoAllowlistPatch() {
        runRepoSelectionPatch(dryRun: true)
    }

    package func applyRepoAllowlistPatch() {
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
        if !pendingLicenseKey.isEmpty {
            storeLicenseKey()
        }
        onboardingFlow.licenseActivation = .servicePending
        license.entitlement = "service pending"
        lastError = nil
        logText = "License activation is pending the hosted license service deployment."
    }

    package func advanceOnboarding() {
        onboardingFlow.providerKeyStored = providers.providerKeyStored
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
        dependencies.preferences.set(true, forKey: onboardingCompletedKey)
        isOnboardingPresented = false
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
private let onboardingCompletedKey = "neondiff.hasCompletedOnboarding"

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
