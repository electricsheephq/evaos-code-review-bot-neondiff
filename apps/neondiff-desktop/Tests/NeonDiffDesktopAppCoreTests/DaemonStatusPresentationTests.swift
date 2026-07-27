import Testing
@testable import NeonDiffDesktopAppCore
import NeonDiffDesktopCore

@MainActor
@Suite struct DaemonStatusPresentationTests {
    @Test func parsedBlockedStatusStaysBehindDiagnostics() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": false,
          "command": "daemon status",
          "status": {
            "ok": false,
            "runtimeOk": false,
            "healthState": "runtime_blocked",
            "checkedAt": "2026-07-27T00:36:22.385Z",
            "launchd": {
              "state": "not_running"
            },
            "summary": {
              "failedQueueJobs": 2
            }
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 1, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status.healthState == "runtime_blocked")
        #expect(fixture.model.status.runtimeOk == false)
        #expect(fixture.model.lastError == nil)
        #expect(fixture.model.statusRefreshFailureMessage == nil)
        #expect(fixture.model.logText.contains(#""failedQueueJobs": 2"#))
        #expect(fixture.model.customerSurfaceStatus == "WORKER ATTENTION")
        #expect(
            fixture.model.customerLocalWorkerStatusDetail
                == "Review worker needs attention — open Advanced Diagnostics"
        )
    }

    @Test func currentDaemonStatusEnvelopeIsActionableNotAParseFailure() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": false,
          "command": "daemon status",
          "operation": "status",
          "status": {
            "ok": false,
            "healthState": "",
            "checkedAt": "2026-07-27T02:14:31.507Z",
            "launchd": {
              "state": "running"
            },
            "gates": [
              {
                "name": "launchd_running",
                "ok": true
              },
              {
                "name": "launchd_config",
                "ok": true
              },
              {
                "name": "launchd_node_system_ca",
                "ok": true
              },
              {
                "name": "live_db_no_errors",
                "ok": true
              },
              {
                "name": "provider_cooldown_backlog",
                "ok": true
              },
              {
                "name": "queue_no_failed_jobs",
                "ok": false,
                "detail": "2 failed durable queue job(s)"
              },
              {
                "name": "queue_no_zcode_timeout_failed_jobs",
                "ok": true
              },
              {
                "name": "queue_no_stale_review_leases",
                "ok": true
              },
              {
                "name": "queue_no_retryable_provider_deferred_jobs",
                "ok": true
              },
              {
                "name": "daemon_heartbeat_recent",
                "ok": true
              }
            ]
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 1, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status.healthState == "runtime_blocked")
        #expect(fixture.model.status.runtimeOk == false)
        #expect(fixture.model.lastError == nil)
        #expect(fixture.model.statusRefreshFailureMessage == nil)
        #expect(fixture.model.customerSurfaceStatus == "WORKER ATTENTION")
        #expect(
            fixture.model.customerLocalWorkerStatusDetail
                == "Review worker needs attention — open Advanced Diagnostics"
        )
    }

    @Test func currentDaemonStatusRejectsNumericGateBooleans() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": true,
          "command": "daemon status",
          "operation": "status",
          "status": {
            "ok": true,
            "launchd": {
              "state": "running"
            },
            "gates": [
              {"name": "launchd_running", "ok": 1},
              {"name": "launchd_config", "ok": 1},
              {"name": "launchd_node_system_ca", "ok": 1},
              {"name": "live_db_no_errors", "ok": 1},
              {"name": "provider_cooldown_backlog", "ok": 1},
              {"name": "queue_no_failed_jobs", "ok": 1},
              {"name": "queue_no_zcode_timeout_failed_jobs", "ok": 1},
              {"name": "queue_no_stale_review_leases", "ok": 1},
              {"name": "queue_no_retryable_provider_deferred_jobs", "ok": 1},
              {"name": "daemon_heartbeat_recent", "ok": 1}
            ]
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status == .unknown)
        #expect(
            fixture.model.statusRefreshFailureMessage
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(fixture.model.customerSurfaceStatus == "NOT CHECKED")
    }

    @Test func currentDaemonStatusIgnoresContradictoryLegacyHealthFields() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": false,
          "command": "daemon status",
          "operation": "status",
          "runtimeOk": true,
          "healthState": "runtime_ok",
          "status": {
            "ok": false,
            "runtimeOk": true,
            "healthState": "runtime_ok",
            "launchd": {
              "state": "running"
            },
            "gates": [
              {"name": "launchd_running", "ok": true},
              {"name": "launchd_config", "ok": true},
              {"name": "launchd_node_system_ca", "ok": true},
              {"name": "live_db_no_errors", "ok": true},
              {"name": "provider_cooldown_backlog", "ok": true},
              {"name": "queue_no_failed_jobs", "ok": false},
              {"name": "queue_no_zcode_timeout_failed_jobs", "ok": true},
              {"name": "queue_no_stale_review_leases", "ok": true},
              {"name": "queue_no_retryable_provider_deferred_jobs", "ok": true},
              {"name": "daemon_heartbeat_recent", "ok": true}
            ]
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 1, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status.runtimeOk == false)
        #expect(fixture.model.status.healthState == "runtime_blocked")
        #expect(fixture.model.customerSurfaceStatus == "WORKER ATTENTION")
    }

    @Test func releaseReadinessFailureDoesNotMislabelAHealthyWorker() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": false,
          "command": "daemon status",
          "operation": "status",
          "status": {
            "ok": false,
            "checkedAt": "2026-07-27T02:14:31.507Z",
            "launchd": {
              "state": "running"
            },
            "gates": [
              {"name": "clean_checkout", "ok": false},
              {"name": "release_branch", "ok": false},
              {"name": "launchd_running", "ok": true},
              {"name": "launchd_config", "ok": true},
              {"name": "launchd_node_system_ca", "ok": true},
              {"name": "live_db_no_errors", "ok": true},
              {"name": "provider_cooldown_backlog", "ok": true},
              {"name": "queue_no_failed_jobs", "ok": true},
              {"name": "queue_no_zcode_timeout_failed_jobs", "ok": true},
              {"name": "queue_no_stale_review_leases", "ok": true},
              {"name": "queue_no_retryable_provider_deferred_jobs", "ok": true},
              {"name": "daemon_heartbeat_recent", "ok": true}
            ]
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 1, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status.healthState == "runtime_ok")
        #expect(fixture.model.status.runtimeOk == true)
        #expect(fixture.model.statusRefreshFailureMessage == nil)
        #expect(fixture.model.customerSurfaceStatus == "WORKER READY")
        #expect(fixture.model.customerLocalWorkerStatusDetail == "Running and ready")
    }

    @Test func malformedCurrentStatusEnvelopeFailsClosed() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": true,
          "command": "daemon status",
          "operation": "status",
          "runtimeOk": true,
          "healthState": "runtime_ok",
          "status": {
            "ok": true,
            "launchd": {
              "state": "invalid"
            },
            "gates": [
              {}
            ]
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status == .unknown)
        #expect(
            fixture.model.statusRefreshFailureMessage
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(fixture.model.customerSurfaceStatus == "NOT CHECKED")
    }

    @Test func structuredStatusErrorRemainsActionableAndFailClosed() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let healthyResponse = #"""
        {
          "ok": true,
          "command": "daemon status",
          "status": {
            "ok": true,
            "runtimeOk": true,
            "healthState": "runtime_ok",
            "checkedAt": "2026-07-27T00:35:00.000Z"
          }
        }
        """#
        let response = #"""
        {
          "ok": false,
          "command": "daemon status",
          "error": {
            "code": "config_invalid",
            "message": "The selected config could not be loaded."
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: healthyResponse, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )
        #expect(fixture.model.status.runtimeOk == true)

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 1, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status == .unknown)
        #expect(
            fixture.model.lastError
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(
            fixture.model.statusRefreshFailureMessage
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(fixture.model.logText.contains("config_invalid"))
        #expect(fixture.model.customerSurfaceStatus == "NOT CHECKED")
        #expect(
            fixture.model.customerLocalWorkerStatusDetail
                == "Status check failed — retry"
        )
    }

    @Test func emptyNestedStatusEnvelopeFailsClosed() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": true,
          "command": "daemon status",
          "status": {}
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status == .unknown)
        #expect(
            fixture.model.statusRefreshFailureMessage
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(fixture.model.customerSurfaceStatus == "NOT CHECKED")
    }

    @Test func timestampOnlyNestedStatusEnvelopeFailsClosed() {
        let fixture = ModelDependencyFixture(suspendCLIRuns: true)
        fixture.model.isOnboardingPresented = false
        let response = #"""
        {
          "ok": true,
          "command": "daemon status",
          "status": {
            "checkedAt": "2026-07-27T00:35:00.000Z"
          }
        }
        """#

        fixture.model.applyCLIResultForTesting(
            CLIRunResult(exitCode: 0, stdout: response, stderr: ""),
            fallbackCommand: "neondiff daemon status",
            configPath: fixture.model.configPath,
            launchdLabel: fixture.model.launchdLabel,
            isConfigInspectCommand: false,
            isDaemonStatusCommand: true
        )

        #expect(fixture.model.status == .unknown)
        #expect(
            fixture.model.statusRefreshFailureMessage
                == "Local worker status check failed. Retry or open Advanced Diagnostics."
        )
        #expect(fixture.model.customerSurfaceStatus == "NOT CHECKED")
    }
}
