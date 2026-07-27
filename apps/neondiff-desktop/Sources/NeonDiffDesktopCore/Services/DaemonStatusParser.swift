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
        let currentEnvelopeRuntimeOk: Bool? = {
            guard statusPayload != nil,
                  json["command"] as? String == "daemon status",
                  json["operation"] as? String == "status",
                  effectiveOk != nil,
                  let launchdState,
                  currentDaemonLaunchdStates.contains(launchdState),
                  let gateRows = effective["gates"] as? [[String: Any]],
                  !gateRows.isEmpty
            else {
                return nil
            }

            var gateResults: [String: Bool] = [:]
            for row in gateRows {
                guard let rawName = row["name"] as? String,
                      let ok = row["ok"] as? Bool
                else {
                    return nil
                }
                let name = rawName.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !name.isEmpty, gateResults[name] == nil else {
                    return nil
                }
                gateResults[name] = ok
            }
            guard currentDaemonWorkerGateNames.allSatisfy({
                gateResults[$0] != nil
            }) else {
                return nil
            }
            return launchdState == "running"
                && currentDaemonWorkerGateNames.allSatisfy({
                    gateResults[$0] == true
                })
        }()
        let isCurrentDaemonStatusEnvelope = currentEnvelopeRuntimeOk != nil
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
            ?? currentEnvelopeRuntimeOk
            ?? ok
        let inferredHealthOk = currentEnvelopeRuntimeOk ?? ok
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

private let currentDaemonLaunchdStates: Set<String> = [
    "running",
    "not_running",
    "unknown"
]

private let currentDaemonWorkerGateNames: Set<String> = [
    "launchd_running",
    "launchd_config",
    "launchd_node_system_ca",
    "live_db_no_errors",
    "provider_cooldown_backlog",
    "queue_no_failed_jobs",
    "queue_no_zcode_timeout_failed_jobs",
    "queue_no_stale_review_leases",
    "queue_no_retryable_provider_deferred_jobs",
    "daemon_heartbeat_recent"
]
