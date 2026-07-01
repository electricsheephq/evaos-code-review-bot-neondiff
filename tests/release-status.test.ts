import { mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseStatus, collectReleaseStatus } from "../src/release-status.js";

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

  it("reports active provider cooldown skips without treating them as blocking DB errors", () => {
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
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 1,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 0
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "live_db_no_errors",
      ok: true,
      detail: "0 blocking error row(s); 1 provider cooldown skip row(s) (1 active, 0 expired)"
    });
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "0 expired provider cooldown row(s); 1 active provider cooldown row(s)"
    });
    expect(status.recommendedActions).toEqual([]);
  });

  it("fails the provider cooldown backlog gate and recommends exact retry commands for expired rows", () => {
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
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 2,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 1
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    const retryCommand =
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true";
    expect(status.ok).toBe(false);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: false,
      detail: `1 expired provider cooldown row(s); 1 active provider cooldown row(s); retry: ${retryCommand}`
    });
    expect(status.recommendedActions).toContain(retryCommand);
  });

  it("keeps release status green when expired per-head cooldowns are covered by an active provider throttle", () => {
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
      database: {
        rowCount: 21,
        errorCount: 0,
        skippedCount: 16,
        providerCooldownCount: 2,
        activeProviderCooldownCount: 1,
        expiredProviderCooldownCount: 1,
        providerThrottleState: "active",
        coveredExpiredProviderCooldownCount: 1
      },
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "provider throttle active; 1 expired provider cooldown row(s) deferred by active provider cooldown"
    });
    expect(status.recommendedActions).toEqual([]);
  });

  it("counts active and expired provider cooldown rows from the live state database", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-db-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const expiredUntil = new Date(Date.now() - 60_000).toISOString();
    const activeUntil = new Date(Date.now() + 60_000).toISOString();
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );

        create table daemon_heartbeat (
          id integer primary key check (id = 1),
          cycle integer,
          event text,
          dry_run integer,
          recorded_at text,
          error text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "expired-head",
        `provider_rate_limit_cooldown_until=${expiredUntil}; reason=provider_rate_limit`
      );
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "active-head",
        `provider_rate_limit_cooldown_until=${activeUntil}; reason=provider_rate_limit`
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot"
    });

    expect(status.database.providerCooldownCount).toBe(2);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.activeProviderCooldownCount).toBe(1);
    expect(status.recommendedActions[0]).toBe(
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true"
    );
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("treats malformed provider cooldown timestamps as actionable backlog", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-db-invalid-cooldown-"));
    roots.push(root);
    const dbPath = join(root, "reviews.sqlite");
    const db = new DatabaseSync(dbPath);
    try {
      db.exec(`
        create table processed_reviews (
          repo text not null,
          pull_number integer not null,
          head_sha text not null,
          status text not null,
          event text,
          review_url text,
          error text,
          created_at text not null default (datetime('now')),
          primary key (repo, pull_number, head_sha)
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        220,
        "malformed-head",
        "provider_rate_limit_cooldown_until=not-a-date; reason=provider_rate_limit"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot"
    });

    expect(status.database.providerCooldownCount).toBe(1);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.activeProviderCooldownCount).toBe(0);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
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
