import { mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseStatus } from "../src/release-status.js";

describe("beta release status", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("fails closed when the live checkout is dirty or not at the expected head", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "actual-head",
        dirtyFiles: ["src/config.ts"]
      },
      expectedHead: "expected-head",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        pid: 123,
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
        dryRun: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "expected_head", ok: false, detail: "actual-head != expected-head" });
    expect(status.gates).toContainEqual({ name: "clean_checkout", ok: false, detail: "1 dirty file(s)" });
    expect(status.rollback.restartCommand).toContain("launchctl kickstart -k");
  });

  it("reports a passing beta release surface without exposing secrets", () => {
    const evidenceRoot = mkdtempSync(join(tmpdir(), "release-status-"));
    roots.push(evidenceRoot);
    mkdirSync(join(evidenceRoot, "nested"), { recursive: true });

    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        pid: 456,
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json",
        dryRun: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.releaseUnit).toMatchObject({
      channel: "local-beta",
      sourceHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/canary-live.json"
    });
    expect(JSON.stringify(status)).not.toMatch(/PRIVATE KEY|ghp_|BEGIN RSA|BEGIN OPENSSH/);
  });

  it("fails closed when launchd config path cannot be verified", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running"
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "launchd_config", ok: false, detail: "not detected" });
  });

  it("fails closed when promotion is attempted from a non-main branch", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "sprint/2-release-cadence",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false
      },
      database: { rowCount: 2, errorCount: 0 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({ name: "release_branch", ok: false, detail: "sprint/2-release-cadence" });
  });

  it("treats baseline skipped rows as non-blocking database state", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({ name: "live_db_no_errors", ok: true, detail: "0 blocking error row(s)" });
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: true,
      detail: "fresh; age 1000ms; max 120000ms; event daemon_cycle_complete; cycle 5"
    });
    expect(status.database.skippedCount).toBe(16);
  });

  it("fails closed when the daemon heartbeat is missing", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: { status: "missing", maxAgeMs: 120_000 },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: false,
      detail: "missing heartbeat row; max age 120000ms"
    });
  });

  it("fails closed when the daemon heartbeat is stale", () => {
    const status = buildReleaseStatus({
      repo: {
        branch: "main",
        head: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
        dirtyFiles: []
      },
      expectedHead: "fcb9484b904a5e4225dc0446b50d5dd83972bb5d",
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchd: {
        label: "com.electricsheephq.evaos-code-review-bot",
        state: "running",
        configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
        dryRun: false
      },
      database: { rowCount: 21, errorCount: 0, skippedCount: 16 },
      heartbeat: {
        status: "stale",
        maxAgeMs: 120_000,
        latestAt: "2026-06-30T23:57:00.000Z",
        ageMs: 180_000,
        cycle: 5,
        event: "daemon_cycle_complete",
        dryRun: false
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: false,
      detail: "stale; age 180000ms; max 120000ms; event daemon_cycle_complete; cycle 5"
    });
  });
});

function freshHeartbeat() {
  return {
    status: "fresh" as const,
    maxAgeMs: 120_000,
    latestAt: "2026-06-30T23:59:59.000Z",
    ageMs: 1_000,
    cycle: 5,
    event: "daemon_cycle_complete",
    dryRun: false
  };
}
