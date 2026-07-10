import AppKit
import Foundation
import NeonDiffDesktopCore

@MainActor
final class NeonDiffDesktopModel: ObservableObject {
    @Published var selectedSection: DesktopSection = .overview
    @Published var configPath: String
    @Published var cliPath: String
    @Published var launchdLabel: String
    @Published var status: DaemonStatus = .unknown
    @Published var repos: [RepoMonitor] = []
    @Published var providers = ProviderSettings()
    @Published var license = LicenseStatus()
    @Published var controlCenter = DesktopControlCenterSettings()
    @Published var controlCenterStatus = "Load current config before editing."
    @Published var isControlCenterOperationInProgress = false
    @Published var isConfigPatchInProgress = false
    @Published var isConfigInspectInProgress = false
    @Published var pendingIssueRepoName = ""
    @Published var github = GitHubConnectionStatus()
    @Published var githubAuthorizationCode: GitHubDeviceAuthorizationCode?
    @Published var githubAuthorizationStatus = "not connected"
    @Published var githubRecovery: GitHubConnectionRecovery?
    @Published var discoveredGitHubRepos: [GitHubDiscoveredRepository] = []
    @Published var isGitHubAuthorizationInProgress = false
    @Published var isGitHubRepositoryRefreshInProgress = false
    @Published var logText = "No logs loaded."
    @Published var lastError: String?
    @Published var lastCommandLine = ""
    @Published var dashboardLaunchStatus = "not opened"
    @Published var dashboardProcessIdentifier: Int32?
    @Published var pendingRepoName = ""
    @Published var pendingProviderKey = ""
    @Published var providerVerification: ProviderVerificationSnapshot?
    @Published var providerVerificationStatus = "Verify the stored API key when ready."
    @Published var isProviderVerificationInProgress = false
    @Published var pendingLicenseKey = ""
    @Published var onboardingFlow = OnboardingFlow()
    @Published var isOnboardingPresented = false

    private let userDefaults: UserDefaults
    private let keychain: DesktopSecretStoring
    private let githubAuthClient: GitHubDesktopAuthenticating
    private let providerVerificationService: ProviderVerificationService?
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

    init(
        userDefaults: UserDefaults = .standard,
        keychain: DesktopSecretStoring = KeychainSecretStore(),
        githubAuthClient: GitHubDesktopAuthenticating = GitHubDeviceAuthClient(),
        providerVerificationService: ProviderVerificationService? = nil
    ) {
        self.userDefaults = userDefaults
        self.keychain = keychain
        self.githubAuthClient = githubAuthClient
        self.providerVerificationService = providerVerificationService
        self.configPath = userDefaults.string(forKey: "neondiff.configPath") ?? "config.local.json"
        self.cliPath = userDefaults.string(forKey: "neondiff.cliPath") ?? "neondiff"
        self.launchdLabel = userDefaults.string(forKey: "neondiff.launchdLabel") ?? "com.electricsheephq.evaos-code-review-bot"
        let providerKeyStored = keychain.containsSecret(account: providerKeyAccount)
        let githubUserTokenStored = keychain.containsSecret(account: githubUserTokenAccount)
        let githubRefreshTokenStored = keychain.containsSecret(account: githubRefreshTokenAccount)
        self.providers.providerKeyStored = providerKeyStored
        self.license.keyStored = keychain.containsSecret(account: licenseKeyAccount)
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
        self.isOnboardingPresented = !userDefaults.bool(forKey: onboardingCompletedKey)
        self.lastCommandLine = statusCommand.commandLine
    }

    var statusCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonStatus(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var dashboardCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var dashboardServerCommand: DesktopCommand {
        NeonDiffCommandBuilder.dashboard(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, openBrowser: false)
    }

    var startDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var stopDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var startDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    var stopDaemonCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel, dryRun: false)
    }

    var configInspectCommand: DesktopCommand {
        NeonDiffCommandBuilder.configInspect(cliPath: cliPath, configPath: configPath)
    }

    var providerPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: providerPatchPath.path)
    }

    var providerPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: providerPatchPath.path, dryRun: false)
    }

    var repoSelectionPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path)
    }

    var repoSelectionPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(cliPath: cliPath, configPath: configPath, inputPath: repoSelectionPatchPath.path, dryRun: false)
    }

    var controlCenterPatchPreviewCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            expectedRevision: controlCenterLoadedRevision
        )
    }

    var controlCenterPatchApplyCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterPatchPath.path,
            dryRun: false,
            expectedRevision: previewedControlCenterExpectedRevision
        )
    }

    var controlCenterRollbackCommand: DesktopCommand {
        NeonDiffCommandBuilder.configPatch(
            cliPath: cliPath,
            configPath: configPath,
            inputPath: controlCenterRollbackPath.path,
            dryRun: false,
            expectedRevision: controlCenterRollbackExpectedRevision
        )
    }

    var controlCenterValidationError: String? {
        DesktopControlCenterPatchBuilder.validationError(for: controlCenter)
    }

    var canPreviewControlCenter: Bool {
        controlCenterLoadedSnapshot?.configPath == configPath
            && controlCenterLoadedRevision != nil
            && controlCenterValidationError == nil
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    var canApplyControlCenter: Bool {
        canPreviewControlCenter
            && previewedControlCenterSnapshot == currentControlCenterSnapshot
            && previewedControlCenterBaseline?.configPath == configPath
            && previewedControlCenterExpectedRevision != nil
    }

    var canRollbackControlCenter: Bool {
        controlCenterRollbackSnapshot?.configPath == configPath
            && controlCenterRollbackExpectedRevision != nil
            && controlCenterLoadedRevision == controlCenterRollbackExpectedRevision
            && !isControlCenterOperationInProgress
            && !isConfigPatchInProgress
            && !isConfigInspectInProgress
    }

    private var currentControlCenterSnapshot: DesktopControlCenterSnapshot {
        DesktopControlCenterSnapshot(settings: controlCenter, configPath: configPath)
    }

    var githubAppInstallURL: URL {
        GitHubAppInstallLink.url(botLogin: github.botLogin) ?? GitHubAppInstallLink.publicAppURL
    }

    var githubRecoveryActionTitle: String {
        switch githubRecovery?.action {
        case .reconnect: "Reconnect GitHub"
        case .retryLater, .retry: "Retry Repository Discovery"
        case .installOrManageApp: "Install / Manage App"
        case .contactOrganizationOwner: "Manage App Access"
        case nil: "Retry"
        }
    }

    var githubRecoveryShowsAction: Bool {
        githubRecovery?.action != .contactOrganizationOwner
    }

    func persistLocalSettings() {
        userDefaults.set(configPath, forKey: "neondiff.configPath")
        userDefaults.set(cliPath, forKey: "neondiff.cliPath")
        userDefaults.set(launchdLabel, forKey: "neondiff.launchdLabel")
        if controlCenterLoadedSnapshot?.configPath != configPath {
            previewedControlCenterSnapshot = nil
            previewedControlCenterBaseline = nil
            previewedControlCenterExpectedRevision = nil
            controlCenterStatus = "Config path changed. Load current config before editing."
        }
    }

    func refreshStatus() {
        persistLocalSettings()
        runCLI(arguments: ["daemon", "status", "--config", configPath, "--launchd-label", launchdLabel], displayCommand: statusCommand)
    }

    func openDashboard() {
        launchDashboard(openBrowser: true)
    }

    func startDashboardServer() {
        launchDashboard(openBrowser: false)
    }

    private func launchDashboard(openBrowser: Bool) {
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
        let workingDirectory = NeonDiffCLIResolver.defaultWorkingDirectory()

        Task { [weak self] in
            guard let self else { return }
            do {
                let result = try await Task.detached(priority: .userInitiated) {
                    let client = NeonDiffCLIClient(
                        executablePath: executablePath,
                        workingDirectory: workingDirectory
                    )
                    return try client.launchDetached(arguments: arguments)
                }.value
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

    func previewStartDaemon() {
        runCLI(arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: startDaemonDryRunCommand)
    }

    func previewStopDaemon() {
        runCLI(arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: stopDaemonDryRunCommand)
    }

    func startDaemon() {
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: startDaemonCommand
        )
    }

    func stopDaemon() {
        persistLocalSettings()
        runCLI(
            arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "false", "--confirm", "true"],
            displayCommand: stopDaemonCommand
        )
    }

    func inspectConfig() {
        guard !isConfigPatchInProgress, !isConfigInspectInProgress else { return }
        runCLI(arguments: ["config", "inspect", "--config", configPath], displayCommand: configInspectCommand)
    }

    func addPendingIssueRepo() {
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

    func removeIssueRepo(_ repo: String) {
        controlCenter.issueAllowlist.removeAll { $0.caseInsensitiveCompare(repo) == .orderedSame }
        controlCenterStatus = "Issue-enrichment allowlist changed locally; Preview is required before Apply."
    }

    func previewControlCenterPatch() {
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

    func applyControlCenterPatch() {
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

    func rollbackControlCenterPatch() {
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

    func previewProviderConfigPatch() {
        runProviderConfigPatch(dryRun: true)
    }

    func applyProviderConfigPatch() {
        runProviderConfigPatch(dryRun: false)
    }

    func addPendingRepoToAllowlist() {
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

    func toggleRepoAllowlist(_ repo: RepoMonitor) {
        guard let index = repos.firstIndex(where: { $0.id == repo.id }) else { return }
        repos[index].enabled.toggle()
        lastError = nil
        logText = "Repo allowlist updated locally. Preview or apply the config patch to persist it."
    }

    func githubAccessCue(for repo: RepoMonitor) -> GitHubRepositoryAccessCue? {
        guard let discovered = discoveredGitHubRepos.first(where: {
            $0.fullName.caseInsensitiveCompare(repo.name) == .orderedSame
        }) else {
            return nil
        }
        return GitHubRepositoryAccessPolicy.cue(for: discovered, licenseEntitlement: license.entitlement)
    }

    func removeRepoFromAllowlist(_ repo: RepoMonitor) {
        repos.removeAll { $0.id == repo.id }
        lastError = nil
        logText = "Repo removed locally. Preview or apply the config patch to persist it."
    }

    func startGitHubAuthorization() {
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
                let code = try await githubAuthClient.requestDeviceCode(clientId: clientId)
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

    func cancelGitHubAuthorization() {
        githubAuthorizationTask?.cancel()
        githubAuthorizationTask = nil
        isGitHubAuthorizationInProgress = false
        githubAuthorizationCode = nil
        githubAuthorizationStatus = "cancelled"
        github.installationState = github.userTokenStored ? "user authorized" : "not connected"
    }

    func copyGitHubUserCode() {
        guard let userCode = githubAuthorizationCode?.userCode else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(userCode, forType: .string)
        githubAuthorizationStatus = "code copied"
    }

    func openGitHubDeviceVerification() {
        guard let verificationURI = githubAuthorizationCode?.verificationURI else { return }
        NSWorkspace.shared.open(verificationURI)
        githubAuthorizationStatus = "verification page opened"
    }

    func openGitHubAppInstallation() {
        NSWorkspace.shared.open(githubAppInstallURL)
        githubAuthorizationStatus = "App installation page opened"
    }

    func performGitHubRecoveryAction() {
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

    func refreshGitHubRepositories() {
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
                let user = try await githubAuthClient.fetchCurrentUser(accessToken: accessToken)
                let discovered = try await githubAuthClient.listAccessibleRepositories(accessToken: accessToken)
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

    func previewRepoAllowlistPatch() {
        runRepoSelectionPatch(dryRun: true)
    }

    func applyRepoAllowlistPatch() {
        runRepoSelectionPatch(dryRun: false)
    }

    func storeProviderKey() {
        do {
            try keychain.setSecret(pendingProviderKey, account: providerKeyAccount)
            pendingProviderKey = ""
            providers.providerKeyStored = true
            providerVerification = nil
            providerVerificationStatus = "Stored key changed. Verify it when ready."
            onboardingFlow.providerKeyStored = true
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    func verifyProviderKey() {
        guard !isProviderVerificationInProgress else { return }
        guard providers.providerKeyStored, keychain.containsSecret(account: providerKeyAccount) else {
            providerVerification = nil
            providerVerificationStatus = "Store a provider API key in Keychain before verification."
            lastError = "Provider verification requires a stored Keychain item."
            return
        }

        persistLocalSettings()
        let arguments = [
            "providers", "verify",
            "--config", configPath,
            "--api-key-stdin", "true",
            "--allow-remote-smoke", "true",
            "--json"
        ]
        let executablePath = cliPath
        let service = providerVerificationService ?? ProviderVerificationService(
            keychain: keychain,
            cli: NeonDiffCLIClient(
                executablePath: executablePath,
                workingDirectory: NeonDiffCLIResolver.defaultWorkingDirectory()
            )
        )

        providerVerification = nil
        providerVerificationStatus = "Verifying the stored API key…"
        isProviderVerificationInProgress = true
        lastError = nil
        lastCommandLine = "\(shellQuote(executablePath)) providers verify --config \(shellQuote(configPath)) --api-key-stdin true --allow-remote-smoke true --json < [secure Keychain input]"

        Task { [weak self] in
            let outcome = await Task.detached(priority: .userInitiated) {
                Result {
                    try service.verify(
                        account: providerKeyAccount,
                        arguments: arguments,
                        timeout: 15
                    )
                }
            }.value

            guard let self else { return }
            self.isProviderVerificationInProgress = false
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

    func storeLicenseKey() {
        do {
            try keychain.setSecret(pendingLicenseKey, account: licenseKeyAccount)
            pendingLicenseKey = ""
            license = LicenseStatus(keyStored: true, entitlement: "stored locally", updateChannel: license.updateChannel)
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
        }
    }

    func activateLicenseForOnboarding() {
        if !pendingLicenseKey.isEmpty {
            storeLicenseKey()
        }
        onboardingFlow.licenseActivation = .servicePending
        license.entitlement = "service pending"
        lastError = nil
        logText = "License activation is pending the hosted license service deployment."
    }

    func advanceOnboarding() {
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        if onboardingFlow.currentStep == .done {
            completeOnboarding()
            return
        }
        onboardingFlow.advance()
    }

    func goBackOnboarding() {
        onboardingFlow.goBack()
    }

    func completeOnboarding() {
        userDefaults.set(true, forKey: onboardingCompletedKey)
        isOnboardingPresented = false
    }

    func reopenOnboarding() {
        onboardingFlow.providerKeyStored = providers.providerKeyStored
        isOnboardingPresented = true
    }

    func copyCommand(_ command: DesktopCommand) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command.commandLine, forType: .string)
        lastCommandLine = command.commandLine
    }

    private func runCLI(
        arguments: [String],
        displayCommand: DesktopCommand,
        controlCenterOperation: ControlCenterOperation? = nil
    ) {
        let isConfigPatchCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "patch"
        let isConfigInspectCommand = arguments.count >= 2 && arguments[0] == "config" && arguments[1] == "inspect"
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
        Task.detached { [configPath, launchdLabel] in
            let client = NeonDiffCLIClient(
                executablePath: executablePath,
                workingDirectory: NeonDiffCLIResolver.defaultWorkingDirectory()
            )
            do {
                let result = try client.run(arguments: arguments, timeout: 15)
                await MainActor.run {
                    self.applyCLIResult(
                        result,
                        fallbackCommand: displayCommand.commandLine,
                        configPath: configPath,
                        launchdLabel: launchdLabel,
                        isConfigInspectCommand: isConfigInspectCommand,
                        controlCenterOperation: controlCenterOperation
                    )
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    if isConfigInspectCommand { self.isConfigInspectInProgress = false }
                    if controlCenterOperation != nil { self.isControlCenterOperationInProgress = false }
                }
            } catch {
                await MainActor.run {
                    self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    self.logText = self.lastError ?? "Unknown CLI error"
                    if isConfigPatchCommand { self.isConfigPatchInProgress = false }
                    if isConfigInspectCommand {
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
        if !dryRun {
            arguments.append(contentsOf: ["--confirm", "true"])
        }
        runCLI(arguments: arguments, displayCommand: dryRun ? providerPatchPreviewCommand : providerPatchApplyCommand)
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
        let base = FileManager.default.urls(for: .applicationSupportDirectory, in: .userDomainMask).first
            ?? FileManager.default.temporaryDirectory
        return base.appendingPathComponent("NeonDiffDesktop", isDirectory: true)
    }

    private func writeProviderPatch() throws {
        try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
        let patch: [String: Any] = [
            "zcode": [
                "cliPath": providers.zcodeCliPath,
                "appConfigPath": providers.zcodeAppConfigPath,
                "model": providers.zcodeModel
            ],
            "desktop": [
                "openAICompatibleEndpoint": providers.openAICompatibleEndpoint,
                "updateChannel": license.updateChannel
            ]
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: providerPatchPath, options: [.atomic])
    }

    private func writeControlCenterPatch(_ settings: DesktopControlCenterSettings, to path: URL) throws {
        try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
        let data = try DesktopControlCenterPatchBuilder.data(for: settings)
        try data.write(to: path, options: [.atomic])
    }

    private func beginControlCenterOperation(_ operation: ControlCenterOperation) -> Bool {
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
        guard let accessToken = try keychain.readSecret(account: githubUserTokenAccount), !accessToken.isEmpty else {
            clearStoredGitHubAuthorization(status: "connect GitHub first")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("Connect GitHub before refreshing accessible repositories.")
        }
        guard let expiresAt = readGitHubStoredDate(account: githubTokenExpiresAtAccount) else {
            return accessToken
        }
        if expiresAt > Date().addingTimeInterval(60) {
            return accessToken
        }
        guard let clientId = github.clientId?.trimmingCharacters(in: .whitespacesAndNewlines), !clientId.isEmpty else {
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired and the public client ID is missing. Reconnect GitHub after loading config.")
        }
        guard let refreshToken = try keychain.readSecret(account: githubRefreshTokenAccount), !refreshToken.isEmpty else {
            clearStoredGitHubAuthorization(status: "authorization expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub authorization expired. Reconnect GitHub.")
        }
        if let refreshExpiresAt = readGitHubStoredDate(account: githubRefreshTokenExpiresAtAccount), refreshExpiresAt <= Date() {
            clearStoredGitHubAuthorization(status: "refresh expired; reconnect GitHub")
            throw GitHubDesktopAuthorizationStateError.reconnectRequired("GitHub refresh token expired. Reconnect GitHub.")
        }
        githubAuthorizationStatus = "refreshing GitHub authorization"
        let refreshedToken: GitHubUserToken
        do {
            refreshedToken = try await githubAuthClient.refreshUserToken(clientId: clientId, refreshToken: refreshToken)
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
        while !Task.isCancelled && Date() < code.expiresAt {
            do {
                try await Task.sleep(nanoseconds: UInt64(max(1, intervalSeconds)) * 1_000_000_000)
                let result = try await githubAuthClient.pollDeviceAuthorization(clientId: clientId, deviceCode: code.deviceCode)
                switch result {
                case .pending(let nextInterval):
                    intervalSeconds = max(1, nextInterval)
                    githubAuthorizationStatus = "waiting for authorization"
                case .authorized(let token):
                    try storeGitHubToken(token)
                    let user = try await githubAuthClient.fetchCurrentUser(accessToken: token.accessToken)
                    let discovered = try await githubAuthClient.listAccessibleRepositories(accessToken: token.accessToken)
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
        try keychain.setSecret(token.accessToken, account: githubUserTokenAccount)
        if let refreshToken = token.refreshToken {
            try keychain.setSecret(refreshToken, account: githubRefreshTokenAccount)
        } else {
            try? keychain.deleteSecret(account: githubRefreshTokenAccount)
        }
        if let expiresAt = token.expiresAt {
            try keychain.setSecret(ISO8601DateFormatter().string(from: expiresAt), account: githubTokenExpiresAtAccount)
        } else {
            try? keychain.deleteSecret(account: githubTokenExpiresAtAccount)
        }
        if let refreshTokenExpiresAt = token.refreshTokenExpiresAt {
            try keychain.setSecret(ISO8601DateFormatter().string(from: refreshTokenExpiresAt), account: githubRefreshTokenExpiresAtAccount)
        } else {
            try? keychain.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
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
        try? keychain.setSecret(user.login, account: githubUserLoginAccount)
    }

    private func clearStoredGitHubAuthorization(status: String) {
        try? keychain.deleteSecret(account: githubUserTokenAccount)
        try? keychain.deleteSecret(account: githubRefreshTokenAccount)
        try? keychain.deleteSecret(account: githubTokenExpiresAtAccount)
        try? keychain.deleteSecret(account: githubRefreshTokenExpiresAtAccount)
        try? keychain.deleteSecret(account: githubUserLoginAccount)
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
        Self.storedDate(keychain: keychain, account: account)
    }

    private static func storedDate(keychain: DesktopSecretStoring, account: String) -> Date? {
        guard let value = try? keychain.readSecret(account: account) else {
            return nil
        }
        return ISO8601DateFormatter().date(from: value)
    }

    private func writeRepoSelectionPatch() throws {
        try FileManager.default.createDirectory(at: appSupportDirectory, withIntermediateDirectories: true)
        let selectedRepos = repos
            .filter(\.enabled)
            .map(\.name)
        let uniqueRepos = uniqueSortedRepoNames(selectedRepos)
        let patch: [String: Any] = [
            "pilotRepos": uniqueRepos
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: repoSelectionPatchPath, options: [.atomic])
    }

    private func applyCLIResult(
        _ result: CLIRunResult,
        fallbackCommand: String,
        configPath: String,
        launchdLabel: String,
        isConfigInspectCommand: Bool,
        controlCenterOperation: ControlCenterOperation? = nil
    ) {
        let redactedStdout = result.redactedStdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let redactedStderr = result.redactedStderr.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = result.exitCode == 0 ? nil : (redactedStderr.isEmpty ? redactedStdout : redactedStderr)
        logText = [result.redactedStdout, result.redactedStderr].filter { !$0.isEmpty }.joined(separator: "\n")

        let commandName = parseCommandName(result.stdout)
        let parsedSnapshot = (commandName == "config inspect" || commandName == "config patch")
            ? ConfigInspectParser.parse(
                result.stdout,
                providerKeyStored: keychain.containsSecret(account: providerKeyAccount),
                licenseKeyStored: keychain.containsSecret(account: licenseKeyAccount),
                githubUserTokenStored: keychain.containsSecret(account: githubUserTokenAccount)
            )
            : nil
        var validatedPatchRevisionAfter: String?
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
            invalidateControlCenterAfterInspectFailure(inspectError)
            return
        }
        if commandName == "config inspect" || commandName == "config patch" {
            if let snapshot = parsedSnapshot {
                if !snapshot.repos.isEmpty { repos = snapshot.repos }
                providers = snapshot.providers
                license = snapshot.license
                var parsedGitHub = snapshot.github
                parsedGitHub.userTokenStored = keychain.containsSecret(account: githubUserTokenAccount)
                parsedGitHub.authorizedUserLogin = github.authorizedUserLogin
                parsedGitHub.installationCount = github.installationCount
                parsedGitHub.discoveredRepositoryCount = github.discoveredRepositoryCount
                if parsedGitHub.userTokenStored && parsedGitHub.installationState == "not connected" {
                    parsedGitHub.installationState = github.installationState
                }
                github = parsedGitHub
                if commandName == "config inspect" {
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
                invalidateControlCenterAfterInspectFailure(inspectError)
                return
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

private let providerKeyAccount = "provider/glm/api-key"
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
