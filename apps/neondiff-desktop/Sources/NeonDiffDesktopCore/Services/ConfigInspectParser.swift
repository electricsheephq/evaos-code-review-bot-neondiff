import Foundation

public struct ConfigInspectSnapshot: Equatable {
    public var repos: [RepoMonitor]
    public var providers: ProviderSettings
    public var license: LicenseStatus
    public var github: GitHubConnectionStatus

    public init(repos: [RepoMonitor], providers: ProviderSettings, license: LicenseStatus, github: GitHubConnectionStatus = GitHubConnectionStatus()) {
        self.repos = repos
        self.providers = providers
        self.license = license
        self.github = github
    }
}

public enum ConfigInspectParser {
    public static func parse(_ jsonText: String, providerKeyStored: Bool, licenseKeyStored: Bool, githubUserTokenStored: Bool = false) -> ConfigInspectSnapshot? {
        guard
            let data = jsonText.data(using: .utf8),
            let root = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
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
            botLogin: botLogin?.isEmpty == false ? botLogin! : "not configured",
            userTokenStored: githubUserTokenStored,
            installationState: githubUserTokenStored ? "user authorized" : "not connected"
        )
        return ConfigInspectSnapshot(repos: repos, providers: providers, license: license, github: github)
    }
}
