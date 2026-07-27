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
