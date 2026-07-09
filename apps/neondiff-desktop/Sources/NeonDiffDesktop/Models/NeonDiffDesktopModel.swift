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
    @Published var github = GitHubConnectionStatus()
    @Published var logText = "No logs loaded."
    @Published var lastError: String?
    @Published var lastCommandLine = ""
    @Published var dashboardLaunchStatus = "not opened"
    @Published var dashboardProcessIdentifier: Int32?
    @Published var pendingRepoName = ""
    @Published var pendingProviderKey = ""
    @Published var pendingLicenseKey = ""
    @Published var onboardingFlow = OnboardingFlow()
    @Published var isOnboardingPresented = false

    private let userDefaults: UserDefaults
    private let keychain: DesktopSecretStoring

    init(
        userDefaults: UserDefaults = .standard,
        keychain: DesktopSecretStoring = KeychainSecretStore()
    ) {
        self.userDefaults = userDefaults
        self.keychain = keychain
        self.configPath = userDefaults.string(forKey: "neondiff.configPath") ?? "config.local.json"
        self.cliPath = userDefaults.string(forKey: "neondiff.cliPath") ?? "neondiff"
        self.launchdLabel = userDefaults.string(forKey: "neondiff.launchdLabel") ?? "com.electricsheephq.evaos-code-review-bot"
        let providerKeyStored = keychain.containsSecret(account: providerKeyAccount)
        self.providers.providerKeyStored = providerKeyStored
        self.license.keyStored = keychain.containsSecret(account: licenseKeyAccount)
        self.github.userTokenStored = keychain.containsSecret(account: githubUserTokenAccount)
        self.github.installationState = self.github.userTokenStored ? "user authorized" : "not connected"
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

    func persistLocalSettings() {
        userDefaults.set(configPath, forKey: "neondiff.configPath")
        userDefaults.set(cliPath, forKey: "neondiff.cliPath")
        userDefaults.set(launchdLabel, forKey: "neondiff.launchdLabel")
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
        let arguments = ["dashboard", "--config", configPath, "--launchd-label", launchdLabel, "--open", openBrowser ? "true" : "false"]
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
        runCLI(arguments: ["config", "inspect", "--config", configPath], displayCommand: configInspectCommand)
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

    func removeRepoFromAllowlist(_ repo: RepoMonitor) {
        repos.removeAll { $0.id == repo.id }
        lastError = nil
        logText = "Repo removed locally. Preview or apply the config patch to persist it."
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
            onboardingFlow.providerKeyStored = true
            lastError = nil
        } catch {
            lastError = NeonDiffRedactor.redact(error.localizedDescription)
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

    private func runCLI(arguments: [String], displayCommand: DesktopCommand) {
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
                    self.applyCLIResult(result, fallbackCommand: displayCommand.commandLine, configPath: configPath, launchdLabel: launchdLabel)
                }
            } catch {
                await MainActor.run {
                    self.lastError = NeonDiffRedactor.redact(error.localizedDescription)
                    self.logText = self.lastError ?? "Unknown CLI error"
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

    private func applyCLIResult(_ result: CLIRunResult, fallbackCommand: String, configPath: String, launchdLabel: String) {
        let redactedStdout = result.redactedStdout.trimmingCharacters(in: .whitespacesAndNewlines)
        let redactedStderr = result.redactedStderr.trimmingCharacters(in: .whitespacesAndNewlines)
        lastError = result.exitCode == 0 ? nil : (redactedStderr.isEmpty ? redactedStdout : redactedStderr)
        logText = [result.redactedStdout, result.redactedStderr].filter { !$0.isEmpty }.joined(separator: "\n")

        let commandName = parseCommandName(result.stdout)
        if commandName == "config inspect" || commandName == "config patch" {
            if let snapshot = ConfigInspectParser.parse(
                result.stdout,
                providerKeyStored: keychain.containsSecret(account: providerKeyAccount),
                licenseKeyStored: keychain.containsSecret(account: licenseKeyAccount),
                githubUserTokenStored: keychain.containsSecret(account: githubUserTokenAccount)
            ) {
                if !snapshot.repos.isEmpty { repos = snapshot.repos }
                providers = snapshot.providers
                license = snapshot.license
                github = snapshot.github
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
}

private let providerKeyAccount = "provider/glm/api-key"
private let licenseKeyAccount = "license/default"
private let githubUserTokenAccount = "github/user-access-token"
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
