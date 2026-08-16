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
        let reportedRuntimeOk = strictJSONBool(json["runtimeOk"])
            ?? strictJSONBool(effective["runtimeOk"])
        let rawReportedHealthState = (effective["healthState"] as? String)
            ?? (json["healthState"] as? String)
        let reportedHealthState = rawReportedHealthState.flatMap { state in
            let normalized = state.trimmingCharacters(in: .whitespacesAndNewlines)
            return normalized.isEmpty ? nil : normalized
        }
        let wrapperOk = strictJSONBool(json["ok"])
        let effectiveOk = strictJSONBool(effective["ok"])
        let launchd = effective["launchd"] as? [String: Any]
        let launchdState = (launchd?["state"] as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let hasCurrentDaemonStatusSignature =
            statusPayload != nil
            && json["command"] as? String == "daemon status"
            && json["operation"] as? String == "status"
        let currentEnvelopeRuntimeOk: Bool? = {
            guard hasCurrentDaemonStatusSignature,
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
                      let ok = strictJSONBool(row["ok"])
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
        let hasSubstantiveStatusShape = hasCurrentDaemonStatusSignature
            ? currentEnvelopeRuntimeOk != nil
            : reportedRuntimeOk != nil || reportedHealthState?.isEmpty == false
        guard hasSubstantiveStatusShape else {
            return nil
        }

        let monitoredRepos = (effective["monitoredRepos"] as? [String])
            ?? (json["pilotRepos"] as? [String])
            ?? (effective["pilotRepos"] as? [String])
            ?? []
        let repos = monitoredRepos.map { RepoMonitor(name: $0, enabled: true) }
        let ok = wrapperOk ?? effectiveOk ?? false
        let runtimeOk: Bool
        let healthState: String
        if hasCurrentDaemonStatusSignature, let currentEnvelopeRuntimeOk {
            runtimeOk = currentEnvelopeRuntimeOk
            healthState = currentEnvelopeRuntimeOk ? "runtime_ok" : "runtime_blocked"
        } else {
            runtimeOk = reportedRuntimeOk ?? ok
            healthState = reportedHealthState
                ?? (ok ? "runtime_ok" : "runtime_blocked")
        }
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

private func strictJSONBool(_ value: Any?) -> Bool? {
    guard let number = value as? NSNumber,
          CFGetTypeID(number) == CFBooleanGetTypeID()
    else {
        return nil
    }
    return number.boolValue
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
