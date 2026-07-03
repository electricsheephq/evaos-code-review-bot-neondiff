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
    @Published var logText = "No logs loaded."
    @Published var lastError: String?
    @Published var lastCommandLine = ""
    @Published var pendingProviderKey = ""
    @Published var pendingLicenseKey = ""

    private let userDefaults: UserDefaults
    private let keychain: KeychainSecretStore

    init(
        userDefaults: UserDefaults = .standard,
        keychain: KeychainSecretStore = KeychainSecretStore()
    ) {
        self.userDefaults = userDefaults
        self.keychain = keychain
        self.configPath = userDefaults.string(forKey: "neondiff.configPath") ?? "config.local.json"
        self.cliPath = userDefaults.string(forKey: "neondiff.cliPath") ?? "neondiff"
        self.launchdLabel = userDefaults.string(forKey: "neondiff.launchdLabel") ?? "com.electricsheephq.evaos-code-review-bot"
        self.providers.providerKeyStored = keychain.containsSecret(account: providerKeyAccount)
        self.license.keyStored = keychain.containsSecret(account: licenseKeyAccount)
        self.lastCommandLine = statusCommand.commandLine
    }

    var statusCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonStatus(cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var startDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "start", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
    }

    var stopDaemonDryRunCommand: DesktopCommand {
        NeonDiffCommandBuilder.daemonControl(action: "stop", cliPath: cliPath, configPath: configPath, launchdLabel: launchdLabel)
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

    func persistLocalSettings() {
        userDefaults.set(configPath, forKey: "neondiff.configPath")
        userDefaults.set(cliPath, forKey: "neondiff.cliPath")
        userDefaults.set(launchdLabel, forKey: "neondiff.launchdLabel")
    }

    func refreshStatus() {
        persistLocalSettings()
        runCLI(arguments: ["daemon", "status", "--config", configPath, "--launchd-label", launchdLabel], displayCommand: statusCommand)
    }

    func previewStartDaemon() {
        runCLI(arguments: ["daemon", "start", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: startDaemonDryRunCommand)
    }

    func previewStopDaemon() {
        runCLI(arguments: ["daemon", "stop", "--config", configPath, "--launchd-label", launchdLabel, "--dry-run", "true"], displayCommand: stopDaemonDryRunCommand)
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

    func storeProviderKey() {
        do {
            try keychain.setSecret(pendingProviderKey, account: providerKeyAccount)
            pendingProviderKey = ""
            providers.providerKeyStored = true
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

    func copyCommand(_ command: DesktopCommand) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(command.commandLine, forType: .string)
        lastCommandLine = command.commandLine
    }

    private func runCLI(arguments: [String], displayCommand: DesktopCommand) {
        lastCommandLine = displayCommand.commandLine
        let executablePath = cliPath
        Task.detached { [configPath, launchdLabel] in
            let client = NeonDiffCLIClient(executablePath: executablePath)
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

    private func applyCLIResult(_ result: CLIRunResult, fallbackCommand: String, configPath: String, launchdLabel: String) {
        lastError = result.exitCode == 0 ? nil : result.redactedStderr
        logText = [result.redactedStdout, result.redactedStderr].filter { !$0.isEmpty }.joined(separator: "\n")

        let commandName = parseCommandName(result.stdout)
        if commandName == "config inspect" || commandName == "config patch" {
            if let snapshot = ConfigInspectParser.parse(
                result.stdout,
                providerKeyStored: keychain.containsSecret(account: providerKeyAccount),
                licenseKeyStored: keychain.containsSecret(account: licenseKeyAccount)
            ) {
                if !snapshot.repos.isEmpty { repos = snapshot.repos }
                providers = snapshot.providers
                license = snapshot.license
            }
            return
        }

        if let parsed = DaemonStatusParser.parse(result.stdout, launchdLabel: launchdLabel, fallbackCommand: fallbackCommand) {
            status = parsed.0
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
