import { describe, expect, it } from "vitest";
import { runDaemonCycle } from "../src/daemon.js";

describe("daemon cycle resilience", () => {
  it("logs runtime cycle failures without throwing out of the daemon loop", async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];

    const result = await runDaemonCycle({
      cycle: 8,
      dryRun: false,
      configPath: "/config.json",
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => {
        throw new Error("ZCode failed before completion: spawnSync node ETIMEDOUT with ghp_1234567890abcdefghijklmnopqrstuvwx");
      },
      recordHeartbeatImpl: () => undefined,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line)
    });

    expect(result.ok).toBe(false);
    expect(stdout).toHaveLength(1);
    expect(JSON.parse(stdout[0]!)).toMatchObject({
      event: "daemon_cycle_start",
      cycle: 8,
      dryRun: false
    });
    expect(stderr).toHaveLength(1);
    const failure = JSON.parse(stderr[0]!);
    expect(failure).toMatchObject({
      event: "daemon_cycle_failed",
      level: "error",
      cycle: 8,
      dryRun: false
    });
    expect(failure.error).toContain("ETIMEDOUT");
    expect(failure.error).not.toContain("ghp_1234567890abcdefghijklmnopqrstuvwx");
  });

  it("records start and completion heartbeat events for successful cycles", async () => {
    const heartbeats: string[] = [];

    const result = await runDaemonCycle({
      cycle: 2,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => ({
        reposScanned: 1,
        pullsSeen: 1,
        reviewed: 0,
        failed: 0,
        skippedDraft: 0,
        skippedCanary: 0,
        skippedPolicy: 0,
        skippedCommandStop: 0,
        skippedCommandExplain: 0,
        commandReviewRequested: 0,
        skippedProcessed: 1,
        skippedCapacity: 0,
        skippedStaleHead: 0,
        baselinedExisting: 0,
        policySkips: []
      }),
      recordHeartbeatImpl: (event) => heartbeats.push(event),
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(true);
    expect(heartbeats).toEqual(["daemon_cycle_start", "daemon_cycle_complete"]);
  });

  it("records a failed heartbeat with the failure message", async () => {
    const heartbeats: Array<{ event: string; error?: string }> = [];

    const result = await runDaemonCycle({
      cycle: 3,
      dryRun: false,
      pilotRepos: ["electricsheephq/WorldOS"],
      monitoredRepos: ["electricsheephq/WorldOS"],
      canaryPulls: [],
      commandsEnabled: false,
      runOnceImpl: async () => {
        throw new Error("second timeout");
      },
      recordHeartbeatImpl: (event, error) => heartbeats.push({ event, ...(error ? { error } : {}) }),
      stdout: () => undefined,
      stderr: () => undefined
    });

    expect(result.ok).toBe(false);
    expect(heartbeats).toEqual([
      { event: "daemon_cycle_start" },
      { event: "daemon_cycle_failed", error: "second timeout" }
    ]);
  });
});
