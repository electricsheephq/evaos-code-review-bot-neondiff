import Foundation

public enum DaemonStatusParser {
    public static func parse(_ jsonText: String, launchdLabel: String?, fallbackCommand: String) -> (DaemonStatus, [RepoMonitor])? {
        guard
            let data = jsonText.data(using: .utf8),
            let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        else {
            return nil
        }

        let statusPayload = json["status"] as? [String: Any]
        let effective = statusPayload ?? json
        let wrapperOk = json["ok"] as? Bool
        let effectiveOk = effective["ok"] as? Bool
        let launchd = effective["launchd"] as? [String: Any]

        let monitoredRepos = (effective["monitoredRepos"] as? [String])
            ?? (json["pilotRepos"] as? [String])
            ?? (effective["pilotRepos"] as? [String])
            ?? []
        let repos = monitoredRepos.map { RepoMonitor(name: $0, enabled: true) }
        let ok = wrapperOk ?? effectiveOk ?? false
        let healthState = (effective["healthState"] as? String)
            ?? (json["healthState"] as? String)
            ?? (ok ? "runtime_ok" : "runtime_blocked")
        let launchdLabel = launchdLabel ?? launchd?["label"] as? String
        let status = DaemonStatus(
            ok: ok,
            runtimeOk: json["runtimeOk"] as? Bool ?? effective["runtimeOk"] as? Bool ?? ok,
            healthState: healthState,
            checkedAt: effective["checkedAt"] as? String ?? json["checkedAt"] as? String,
            monitoredRepos: monitoredRepos,
            launchdLabel: launchdLabel,
            lastCommand: fallbackCommand
        )
        return (status, repos)
    }
}
