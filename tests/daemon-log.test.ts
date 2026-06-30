import { describe, expect, it } from "vitest";
import { formatDaemonLog } from "../src/daemon-log.js";

describe("daemon heartbeat logs", () => {
  it("emits structured JSON with cycle and result counters", () => {
    const log = JSON.parse(formatDaemonLog({
      event: "daemon_cycle_complete",
      cycle: 2,
      dryRun: true,
      result: {
        reposScanned: 2,
        pullsSeen: 4,
        reviewed: 0,
        skippedDraft: 1,
        skippedCanary: 2,
        skippedProcessed: 1
      }
    }, new Date("2026-07-01T00:00:00.000Z")));

    expect(log).toMatchObject({
      ts: "2026-07-01T00:00:00.000Z",
      level: "info",
      event: "daemon_cycle_complete",
      cycle: 2,
      dryRun: true,
      result: {
        reposScanned: 2,
        reviewed: 0,
        skippedProcessed: 1
      }
    });
  });

  it("redacts secret-looking strings before they reach launchd logs", () => {
    const log = formatDaemonLog({
      event: "daemon_cycle_failed",
      level: "error",
      error: "request failed with ghp_1234567890abcdefghijklmnopqrstuvwx"
    }, new Date("2026-07-01T00:00:00.000Z"));

    expect(log).toContain("[redacted-secret]");
    expect(log).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });
});
