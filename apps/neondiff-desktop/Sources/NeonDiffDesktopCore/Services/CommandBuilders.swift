import Foundation

public enum NeonDiffCommandBuilder {
    public static func configInspect(cliPath: String, configPath: String) -> DesktopCommand {
        DesktopCommand(
            title: "Inspect config",
            commandLine: "\(shellQuote(cliPath)) config inspect --config \(shellQuote(configPath))"
        )
    }

    public static func configPatch(cliPath: String, configPath: String, inputPath: String, dryRun: Bool = true) -> DesktopCommand {
        var command = "\(shellQuote(cliPath)) config patch --config \(shellQuote(configPath)) --input \(shellQuote(inputPath)) --dry-run \(dryRun ? "true" : "false")"
        if !dryRun {
            command += " --confirm true"
        }
        return DesktopCommand(title: "Patch config", commandLine: command, requiresConfirmation: !dryRun)
    }

    public static func daemonStatus(cliPath: String, configPath: String, launchdLabel: String) -> DesktopCommand {
        DesktopCommand(
            title: "Daemon status",
            commandLine: "\(shellQuote(cliPath)) daemon status --config \(shellQuote(configPath)) --launchd-label \(shellQuote(launchdLabel))"
        )
    }

    public static func dashboard(
        cliPath: String,
        configPath: String,
        launchdLabel: String,
        openBrowser: Bool = true
    ) -> DesktopCommand {
        DesktopCommand(
            title: openBrowser ? "Open local dashboard" : "Start local dashboard",
            commandLine: "\(shellQuote(cliPath)) dashboard --config \(shellQuote(configPath)) --launchd-label \(shellQuote(launchdLabel)) --open \(openBrowser ? "true" : "false") --operator false"
        )
    }

    public static func daemonControl(
        action: String,
        cliPath: String,
        configPath: String,
        launchdLabel: String,
        dryRun: Bool = true
    ) -> DesktopCommand {
        var command = "\(shellQuote(cliPath)) daemon \(action) --config \(shellQuote(configPath)) --launchd-label \(shellQuote(launchdLabel)) --dry-run \(dryRun ? "true" : "false")"
        if !dryRun {
            command += " --confirm true"
        }
        return DesktopCommand(title: "Daemon \(action)", commandLine: command, requiresConfirmation: !dryRun)
    }

    public static func reviewDryRun(cliPath: String, configPath: String, repo: String, pullNumber: Int) -> DesktopCommand {
        DesktopCommand(
            title: "Dry-run review",
            commandLine: "\(shellQuote(cliPath)) review-pr --config \(shellQuote(configPath)) --repo \(shellQuote(repo)) --pr \(pullNumber) --dry-run true --zcode false"
        )
    }
}

public func shellQuote(_ value: String) -> String {
    "'\(value.replacingOccurrences(of: "'", with: "'\\''"))'"
}
