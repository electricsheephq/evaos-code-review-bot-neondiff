import Foundation

public struct ConfigInspectSnapshot: Equatable {
    public var repos: [RepoMonitor]
    public var providers: ProviderSettings
    public var license: LicenseStatus
    public var github: GitHubConnectionStatus
    public var policy: DesktopControlCenterSettings
    public var revision: String?
    public var revisionBefore: String?
    public var revisionAfter: String?
    public var warning: String?
    public var dryRun: Bool?
    public var wrote: Bool?

    public init(
        repos: [RepoMonitor],
        providers: ProviderSettings,
        license: LicenseStatus,
        github: GitHubConnectionStatus = GitHubConnectionStatus(),
        policy: DesktopControlCenterSettings = DesktopControlCenterSettings(),
        revision: String? = nil,
        revisionBefore: String? = nil,
        revisionAfter: String? = nil,
        warning: String? = nil,
        dryRun: Bool? = nil,
        wrote: Bool? = nil
    ) {
        self.repos = repos
        self.providers = providers
        self.license = license
        self.github = github
        self.policy = policy
        self.revision = revision
        self.revisionBefore = revisionBefore
        self.revisionAfter = revisionAfter
        self.warning = warning
        self.dryRun = dryRun
        self.wrote = wrote
    }
}

public enum ConfigInspectParser {
    public static func error(_ jsonText: String, command: String = "config inspect") -> String? {
        guard
            let data = jsonText.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            root["command"] as? String == command,
            root["ok"] as? Bool == false,
            let error = root["error"] as? String,
            !error.isEmpty
        else {
            return nil
        }
        return error
    }

    public static func parse(_ jsonText: String, providerKeyStored: Bool, licenseKeyStored: Bool, githubUserTokenStored: Bool = false) -> ConfigInspectSnapshot? {
        guard
            let data = jsonText.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            root["ok"] as? Bool == true,
            let command = root["command"] as? String,
            command == "config inspect" || command == "config patch",
            let config = root["config"] as? [String: Any]
        else {
            return nil
        }

        let repoProfiles = ((config["repoProfiles"] as? [String: Any])?["repos"] as? [String: Any]) ?? [:]
        let pilotRepos = config["pilotRepos"] as? [String] ?? []
        let reposToShow = pilotRepos.isEmpty
            ? repoProfiles.keys.filter { repo in
                let profile = repoProfiles[repo] as? [String: Any]
                return profile?["enabled"] as? Bool != false
            }.sorted()
            : pilotRepos
        let repos = reposToShow.map { repo in
            let profile = repoProfiles[repo] as? [String: Any]
            let enabled = profile?["enabled"] as? Bool ?? true
            let displayName = profile?["displayName"] as? String
            let reviewProfile = profile?["reviewProfile"] as? String
            return RepoMonitor(name: repo, enabled: enabled, profile: displayName ?? reviewProfile ?? "default")
        }

        let zcode = config["zcode"] as? [String: Any]
        let desktop = config["desktop"] as? [String: Any]
        let githubConfig = config["github"] as? [String: Any]
        let reviewConcurrency = config["reviewConcurrency"] as? [String: Any]
        let reviewGate = config["reviewGate"] as? [String: Any]
        let issueEnrichment = config["issueEnrichment"] as? [String: Any]
        let providers = ProviderSettings(
            zcodeModel: zcode?["model"] as? String ?? "GLM-5.2",
            zcodeCliPath: zcode?["cliPath"] as? String ?? "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
            zcodeAppConfigPath: zcode?["appConfigPath"] as? String ?? "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
            openAICompatibleEndpoint: desktop?["openAICompatibleEndpoint"] as? String ?? "http://localhost:8000/v1",
            providerKeyStored: providerKeyStored
        )
        let license = LicenseStatus(
            keyStored: licenseKeyStored,
            entitlement: licenseKeyStored ? "stored locally" : "not activated",
            updateChannel: desktop?["updateChannel"] as? String ?? "dev"
        )
        let appId = githubConfig?["appId"] as? String
        let clientId = githubConfig?["clientId"] as? String
        let botLogin = githubConfig?["botLogin"] as? String
        let github = GitHubConnectionStatus(
            appIdConfigured: appId?.isEmpty == false,
            clientIdConfigured: clientId?.isEmpty == false,
            clientId: clientId,
            botLogin: botLogin?.isEmpty == false ? botLogin! : "not configured",
            userTokenStored: githubUserTokenStored,
            installationState: githubUserTokenStored ? "user authorized" : "not connected"
        )
        let policy = DesktopControlCenterSettings(
            pollIntervalMs: config["pollIntervalMs"] as? Int ?? 90_000,
            skipDrafts: config["skipDrafts"] as? Bool ?? true,
            reviewMaxActiveRuns: reviewConcurrency?["maxActiveRuns"] as? Int ?? 1,
            reviewLeaseTtlMs: reviewConcurrency?["leaseTtlMs"] as? Int ?? 900_000,
            maxInlineComments: reviewGate?["maxInlineComments"] as? Int ?? 25,
            issueEnrichmentEnabled: issueEnrichment?["enabled"] as? Bool ?? false,
            issuePostComment: issueEnrichment?["postIssueComment"] as? Bool ?? false,
            issueAllowlist: issueEnrichment?["allowlist"] as? [String] ?? [],
            issueMaxIssuesPerCycle: issueEnrichment?["maxIssuesPerCycle"] as? Int ?? 5,
            issueMaxCommentsPerCycle: issueEnrichment?["maxCommentsPerCycle"] as? Int ?? 1,
            issueGlobalMaxIssuesPerCycle: issueEnrichment?["globalMaxIssuesPerCycle"] as? Int ?? 5,
            issueGlobalMaxCommentsPerCycle: issueEnrichment?["globalMaxCommentsPerCycle"] as? Int ?? 1,
            issueMaxActiveRuns: issueEnrichment?["maxActiveRuns"] as? Int ?? 1,
            issueLeaseTtlMs: issueEnrichment?["leaseTtlMs"] as? Int ?? 1_200_000,
            issueCooldownMs: issueEnrichment?["cooldownMs"] as? Int ?? 3_600_000,
            issueBurstWindowMs: issueEnrichment?["burstWindowMs"] as? Int ?? 3_600_000,
            issueMaxIssuesPerBurst: issueEnrichment?["maxIssuesPerBurst"] as? Int ?? 10,
            issueLookbackMs: issueEnrichment?["lookbackMs"] as? Int ?? 600_000,
            issueProcessExistingOnActivation: issueEnrichment?["processExistingOpenIssuesOnActivation"] as? Bool ?? false
        )
        return ConfigInspectSnapshot(
            repos: repos,
            providers: providers,
            license: license,
            github: github,
            policy: policy,
            revision: nonEmptyString(root["revision"]),
            revisionBefore: nonEmptyString(root["revisionBefore"]),
            revisionAfter: nonEmptyString(root["revisionAfter"]),
            warning: nonEmptyString(root["warning"]),
            dryRun: root["dryRun"] as? Bool,
            wrote: root["wrote"] as? Bool
        )
    }

    private static func nonEmptyString(_ value: Any?) -> String? {
        guard let value = value as? String, !value.isEmpty else { return nil }
        return value
    }
}

public enum ConfigPatchProofMode {
    case preview
    case apply
}

public enum ConfigPatchProofValidator {
    public static func revisionAfter(
        snapshot: ConfigInspectSnapshot?,
        expectedRevision: String,
        mode: ConfigPatchProofMode
    ) -> String? {
        guard
            let snapshot,
            snapshot.revisionBefore == expectedRevision,
            isLowercaseSHA256(expectedRevision),
            let revisionAfter = snapshot.revisionAfter,
            isLowercaseSHA256(revisionAfter),
            let dryRun = snapshot.dryRun,
            let wrote = snapshot.wrote
        else {
            return nil
        }
        switch mode {
        case .preview:
            guard dryRun, !wrote, revisionAfter == expectedRevision else { return nil }
        case .apply:
            guard
                !dryRun,
                wrote ? revisionAfter != expectedRevision : revisionAfter == expectedRevision
            else {
                return nil
            }
        }
        return revisionAfter
    }

    private static func isLowercaseSHA256(_ value: String) -> Bool {
        value.utf8.count == 64 && value.utf8.allSatisfy { byte in
            (48...57).contains(byte) || (97...102).contains(byte)
        }
    }
}
