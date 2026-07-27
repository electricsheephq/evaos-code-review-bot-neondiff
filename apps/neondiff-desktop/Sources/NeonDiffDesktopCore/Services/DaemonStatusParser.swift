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
        let reportedRuntimeOk = json["runtimeOk"] as? Bool ?? effective["runtimeOk"] as? Bool
        let rawReportedHealthState = (effective["healthState"] as? String)
            ?? (json["healthState"] as? String)
        let reportedHealthState = rawReportedHealthState.flatMap { state in
            let normalized = state.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? nil : normalized
        }
        let wrapperOk = json["ok"] as? Bool
        let effectiveOk = effective["ok"] as? Bool
        let launchd = effective["launchd"] as? [String: Any]
        let launchdState = (launchd?["state"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let isCurrentDaemonStatusEnvelope =
            statusPayload != nil
            && json["command"] as? String == "daemon status"
            && json["operation"] as? String == "status"
            && effectiveOk != nil
            && launchdState?.isEmpty == false
            && effective["gates"] is [[String: Any]]
        let hasSubstantiveStatusShape = reportedRuntimeOk != nil
            || reportedHealthState?.isEmpty == false
            || isCurrentDaemonStatusEnvelope
        guard hasSubstantiveStatusShape else {
            return nil
        }

        let monitoredRepos = (effective["monitoredRepos"] as? [String])
            ?? (json["pilotRepos"] as? [String])
            ?? (effective["pilotRepos"] as? [String])
            ?? []
        let repos = monitoredRepos.map { RepoMonitor(name: $0, enabled: true) }
        let ok = wrapperOk ?? effectiveOk ?? false
        let runtimeOk = reportedRuntimeOk
            ?? (isCurrentDaemonStatusEnvelope ? effectiveOk : nil)
            ?? ok
        let inferredHealthOk = isCurrentDaemonStatusEnvelope
            ? (effectiveOk ?? false)
            : ok
        let healthState = reportedHealthState
            ?? (inferredHealthOk ? "runtime_ok" : "runtime_blocked")
        let launchdLabel = launchdLabel ?? launchd?["label"] as? String
        let status = DaemonStatus(
            ok: ok,
            runtimeOk: runtimeOk,
            healthState: healthState,
            checkedAt: effective["checkedAt"] as? String ?? json["checkedAt"] as? String,
            monitoredRepos: monitoredRepos,
            launchdLabel: launchdLabel,
            lastCommand: fallbackCommand
        )
        return (status, repos)
    }
}
