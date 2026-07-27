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
                == "Running, but review gates need attention"
        )
    }
}
