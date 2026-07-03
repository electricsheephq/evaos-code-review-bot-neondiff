import { mkdirSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { buildReleaseStatus, collectReleaseStatus } from "../src/release-status.js";
import type { ReviewBudgetStatus } from "../src/review-budget.js";

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
    expect(status.summary).toMatchObject({
      blockingErrorRows: 0,
      failedQueueJobs: 0,
      staleReviewLeases: 0
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

  it("covers expired provider cooldown rows when the same head has an active queue retry", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-covered-cooldown-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "covered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1128,
        "uncovered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "covered-head", undefined, { pullNumber: 1127 });
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    const retryCommand =
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true";
    expect(status.database.providerCooldownCount).toBe(2);
    expect(status.database.expiredProviderCooldownCount).toBe(2);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(1);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: false,
      detail: `1 expired provider cooldown row(s) covered by active queue retry; 1 retryable expired provider cooldown row(s); 0 active provider cooldown row(s); retry: ${retryCommand}`
    });
  });

  it("keeps release status green when all expired provider cooldown rows are covered by active queue retries", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-covered-cooldown-green-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "covered-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "covered-head", undefined, { pullNumber: 1127 });
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database.providerCooldownCount).toBe(1);
    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(1);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(0);
    expect(status.gates).toContainEqual({
      name: "provider_cooldown_backlog",
      ok: true,
      detail: "1 expired provider cooldown row(s) covered by active queue retry; 0 retryable expired provider cooldown row(s); 0 active provider cooldown row(s)"
    });
    expect(status.recommendedActions).not.toContain(
      "npx tsx src/cli.ts retry-provider-cooldowns --config /Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json --expired-only true --dry-run false --zcode true"
    );
  });

  it("does not cover expired provider cooldown rows with expired queue leases", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-expired-lease-cooldown-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "expired-lease-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'leased', ?, ?, ?, ?)`
      ).run(
        "leased-expired-lease-head",
        "automatic:electricsheephq/WorldOS#1127@expired-lease-head",
        "electricsheephq/WorldOS",
        "electricsheephq",
        1127,
        "expired-lease-head",
        "lease-expired",
        "2026-07-01T00:04:00.000Z",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(0);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(0);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("does not cover expired provider cooldown rows with stale null queue leases", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-stale-null-lease-cooldown-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into processed_reviews (repo, pull_number, head_sha, status, error)
         values (?, ?, ?, 'skipped', ?)`
      ).run(
        "electricsheephq/WorldOS",
        1127,
        "stale-null-lease-head",
        "provider_rate_limit_cooldown_until=2026-07-01T00:01:00.000Z; reason=provider_overloaded"
      );
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, null, ?, ?)`
      ).run(
        "running-stale-null-lease-head",
        "automatic:electricsheephq/WorldOS#1127@stale-null-lease-head",
        "electricsheephq/WorldOS",
        "electricsheephq",
        1127,
        "stale-null-lease-head",
        "lease-without-expiry",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:20:00.000Z")
    });

    expect(status.database.expiredProviderCooldownCount).toBe(1);
    expect(status.database.coveredExpiredProviderCooldownCount).toBe(0);
    expect(status.database.coveredByActiveQueueRetryProviderCooldownCount).toBe(0);
    expect(status.database.retryableExpiredProviderCooldownCount).toBe(1);
    expect(status.gates.some((gate) => gate.name === "provider_cooldown_backlog" && !gate.ok)).toBe(true);
  });

  it("reports reviewer session counts from the live state database", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-reviewer-sessions-"));
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

        create table reviewer_sessions (
          session_id text primary key,
          repo text not null,
          repo_family text,
          state text not null,
          started_at text not null,
          last_used_at text not null,
          expires_at text not null,
          head_count_used integer not null,
          head_count_limit integer not null,
          worker_pid integer,
          model text,
          provider text,
          zcode_cli_version text,
          memory_packet_sha text,
          gitnexus_packet_sha text,
          last_error text
        );
      `);
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "active-session",
        "100yenadmin/evaOS-GUI",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        1,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "expired-session",
        "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        "expired",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:10:00.000Z",
        10,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "stale-active-session",
        "electricsheephq/WorldOS",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:10:00.000Z",
        1,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit)
         values (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "limit-reached-active-session",
        "electricsheephq/evaos-code-review-bot",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        10,
        10
      );
      db.prepare(
        `insert into reviewer_sessions
          (session_id, repo, state, started_at, last_used_at, expires_at, head_count_used, head_count_limit, worker_pid)
         values (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        "dead-worker-active-session",
        "electricsheephq/evaos-code-review-bot",
        "active",
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:10.000Z",
        "2026-07-01T00:30:00.000Z",
        1,
        10,
        999_999_999
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:15:00.000Z")
    });

    expect(status.database.reviewerSessionCount).toBe(5);
    expect(status.database.activeReviewerSessionCount).toBe(1);
    expect(status.database.expiredReviewerSessionCount).toBe(3);
    expect(status.database.reviewerSessionsByRepo).toHaveLength(4);
    expect(status.database.reviewerSessionsByRepo).toEqual(
      expect.arrayContaining([
        { repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO", total: 1, active: 0, expired: 1 },
        { repo: "100yenadmin/evaOS-GUI", total: 1, active: 1, expired: 0 },
        { repo: "electricsheephq/WorldOS", total: 1, active: 0, expired: 1 },
        { repo: "electricsheephq/evaos-code-review-bot", total: 2, active: 0, expired: 1 }
      ])
    );
  });

  it("reports durable review queue counts and fails retryable deferred or failed jobs", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-review-queue-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      insertQueueJob(db, "queued", "electricsheephq/WorldOS", "queued-head");
      insertQueueJob(db, "running", "electricsheephq/WorldOS", "running-head");
      insertQueueJob(db, "provider_deferred", "100yenadmin/evaOS-GUI", "deferred-head", "2026-07-01T00:10:00.000Z");
      insertQueueJob(db, "provider_deferred", "100yenadmin/evaOS-GUI", "retryable-head", "2026-07-01T00:01:00.000Z");
      insertQueueJob(db, "failed", "100yenadmin/Lossless-Codex-Orchestrator-LCO", "failed-head");
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.database).toMatchObject({
      reviewQueueJobCount: 5,
      queuedReviewQueueJobCount: 1,
      runningReviewQueueJobCount: 1,
      providerDeferredReviewQueueJobCount: 2,
      retryableProviderDeferredReviewQueueJobCount: 1,
      failedReviewQueueJobCount: 1
    });
    expect(status.budget).toMatchObject({
      active: {
        total: 1,
        running: 1
      },
      queued: {
        total: 3,
        providerDeferred: 2,
        retryableProviderDeferred: 1
      },
      providerDeferred: {
        total: 2,
        retryable: 1,
        readyToRetry: 1,
        waitingCooldown: 1
      },
      delayedByReason: {
        repo_capacity: 1,
        provider_cooldown: 1
      },
      wouldLeaseCount: 1,
      delayedCount: 2,
      details: {
        included: false,
        wouldLeaseReturned: 0,
        delayedReturned: 0,
        detailsTruncated: true
      },
      wouldLease: [],
      delayed: []
    });
    expect(status.database.reviewQueueJobsByRepo).toEqual([
      {
        repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        total: 1,
        queued: 0,
        leased: 0,
        running: 0,
        providerDeferred: 0,
        retryableProviderDeferred: 0,
        failed: 1
      },
      {
        repo: "100yenadmin/evaOS-GUI",
        total: 2,
        queued: 0,
        leased: 0,
        running: 0,
        providerDeferred: 2,
        retryableProviderDeferred: 1,
        failed: 0
      },
      {
        repo: "electricsheephq/WorldOS",
        total: 2,
        queued: 1,
        leased: 0,
        running: 1,
        providerDeferred: 0,
        retryableProviderDeferred: 0,
        failed: 0
      }
    ]);
    expect(status.gates).toContainEqual({
      name: "queue_no_failed_jobs",
      ok: false,
      detail: "1 failed durable queue job(s)"
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: false,
      detail: "1 ready-to-retry provider-deferred queue job(s); provider_deferred total=2 retryable=1 waiting_cooldown=1 waiting_capacity=0; queue total=5 queued=1 leased=0 running=1 provider_deferred=2 failed=1"
    });
    expect(status.recommendedActions).toContain("wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry");

    const detailedStatus = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      budgetDetails: true,
      budgetDetailLimit: 1,
      budgetJobLimit: 3,
      now: new Date("2026-07-01T00:05:00.000Z")
    });
    expect(detailedStatus.budget?.details).toMatchObject({
      included: true,
      detailLimit: 1,
      inputJobLimit: 3,
      inputJobsTruncated: false,
      detailsTruncated: true
    });
    expect(detailedStatus.budget?.wouldLease.length).toBeLessThanOrEqual(1);
    expect(detailedStatus.budget?.delayed.length).toBeLessThanOrEqual(1);
  });

  it("does not fail the provider-deferred gate when retryable jobs are waiting on capacity", () => {
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
        reviewQueueJobCount: 2,
        queuedReviewQueueJobCount: 0,
        leasedReviewQueueJobCount: 0,
        runningReviewQueueJobCount: 1,
        providerDeferredReviewQueueJobCount: 1,
        retryableProviderDeferredReviewQueueJobCount: 1,
        failedReviewQueueJobCount: 0
      },
      budget: releaseBudgetStatus({
        queued: {
          total: 1,
          manual: 0,
          background: 1,
          providerDeferred: 1,
          retryableProviderDeferred: 1
        },
        providerDeferred: {
          total: 1,
          retryable: 1,
          readyToRetry: 0,
          waitingCooldown: 0,
          waitingProviderCapacity: 1,
          waitingOrgCapacity: 0,
          waitingRepoCapacity: 0,
          waitingManualReserve: 0,
          waitingLeaseLimit: 0
        }
      }),
      heartbeat: freshHeartbeat(),
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: true,
      detail: "0 ready-to-retry provider-deferred queue job(s); provider_deferred total=1 retryable=1 waiting_cooldown=0 waiting_capacity=1; queue total=2 queued=0 leased=0 running=1 provider_deferred=1 failed=0"
    });
    expect(status.recommendedActions).not.toContain("wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry");
  });

  it("recommends review queue lease cleanup when stale run leases or active queue leases exist", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-stale-review-leases-"));
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

        create table review_run_leases (
          lease_id text primary key,
          started_at text not null,
          expires_at text not null,
          owner_pid integer
        );

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare("insert into review_run_leases (lease_id, started_at, expires_at, owner_pid) values (?, ?, ?, ?)")
        .run("dead-owner", "2026-07-03T08:00:00.000Z", "2026-07-03T09:00:00.000Z", 999_999_999);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, ?, ?, ?)`
      ).run(
        "stale-running",
        "automatic:electricsheephq/evaos-code-review-bot#174@head-a",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        174,
        "head-a",
        "queue-lease-expired",
        "2026-07-03T08:00:10.000Z",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:00.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.database).toMatchObject({
      reviewRunLeaseCount: 1,
      staleReviewRunLeaseCount: 1,
      staleActiveReviewQueueJobCount: 1
    });
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: false,
      detail: "1 stale review run lease(s); 1 stale active queue job(s)"
    });
    expect(status.recommendedActions).toContain(
      "npx tsx src/cli.ts clear-review-queue-leases --config (default config) --dry-run true --expired-only true"
    );
  });

  it("does not flag fresh legacy null review queue leases before the TTL expires", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-fresh-null-review-lease-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, null, ?, ?)`
      ).run(
        "fresh-null-running",
        "automatic:electricsheephq/evaos-code-review-bot#176@head-null",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        176,
        "head-null",
        "queue-lease-fresh-null",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:59.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.database.staleActiveReviewQueueJobCount).toBe(0);
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: true,
      detail: "0 stale review run lease(s); 0 stale active queue job(s)"
    });
  });

  it("flags malformed active review queue lease expiries as stale", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-malformed-review-lease-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          lease_expires_at text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      db.prepare(
        `insert into review_queue_jobs
          (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
           priority, state, lease_id, lease_expires_at, created_at, updated_at)
         values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, 'running', ?, ?, ?, ?)`
      ).run(
        "malformed-running",
        "automatic:electricsheephq/evaos-code-review-bot#176@head-malformed",
        "electricsheephq/evaos-code-review-bot",
        "electricsheephq",
        176,
        "head-malformed",
        "queue-lease-malformed",
        "not-a-date",
        "2026-07-03T08:00:00.000Z",
        "2026-07-03T08:00:59.000Z"
      );
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      now: new Date("2026-07-03T08:01:00.000Z")
    });

    expect(status.ok).toBe(false);
    expect(status.database.staleActiveReviewQueueJobCount).toBe(1);
    expect(status.gates).toContainEqual({
      name: "queue_no_stale_review_leases",
      ok: false,
      detail: "0 stale review run lease(s); 1 stale active queue job(s)"
    });
  });

  it("filters terminal queue rows and preserves active jobs before applying the budget row cap", () => {
    const root = mkdtempSync(join(tmpdir(), "release-status-budget-cap-terminal-"));
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

        create table review_queue_jobs (
          job_id text primary key,
          attempt_id text not null unique,
          source text not null,
          lane text not null,
          repo text not null,
          org text not null,
          pull_number integer not null,
          head_sha text not null,
          base_sha text,
          provider_id text,
          priority integer not null,
          state text not null,
          next_eligible_at text,
          lease_id text,
          session_id text,
          comment_id integer,
          review_url text,
          last_error text,
          created_at text not null,
          updated_at text not null,
          started_at text,
          finished_at text
        );
      `);
      insertQueueJob(db, "posted", "owner/repo", "terminal-posted");
      insertQueueJob(db, "failed", "owner/repo", "terminal-failed");
      insertQueueJob(db, "queued", "owner/repo-a", "queued-a");
      insertQueueJob(db, "queued", "owner/repo-b", "queued-b");
      insertQueueJob(db, "running", "owner/repo-c", "live-running");
    } finally {
      db.close();
    }

    const status = collectReleaseStatus({
      cwd: process.cwd(),
      statePath: dbPath,
      configPath: undefined,
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      budgetJobLimit: 1,
      now: new Date("2026-07-01T00:05:00.000Z")
    });

    expect(status.budget).toMatchObject({
      active: {
        total: 1,
        running: 1
      },
      queued: {
        total: 1
      },
      details: {
        inputJobs: 2,
        inputJobLimit: 1,
        inputJobsTruncated: true
      }
    });
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

  it("treats a bounded active daemon cycle as a healthy heartbeat", () => {
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
        status: "active",
        maxAgeMs: 120_000,
        activeMaxAgeMs: 420_000,
        latestAt: "2026-06-30T23:57:00.000Z",
        ageMs: 180_000,
        cycle: 5,
        event: "daemon_cycle_complete",
        dryRun: false,
        activeCycle: 6,
        activeStartedAt: "2026-06-30T23:59:00.000Z",
        activeAgeMs: 60_000
      },
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(status.ok).toBe(true);
    expect(status.gates).toContainEqual({
      name: "daemon_heartbeat_recent",
      ok: true,
      detail: "active; active age 60000ms; max 420000ms; started cycle 6; last event daemon_cycle_complete; last cycle 5"
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

function releaseBudgetStatus(overrides: Partial<ReviewBudgetStatus> = {}): ReviewBudgetStatus {
  return {
    enabled: true,
    checkedAt: "2026-07-01T00:00:00.000Z",
    config: {
      reviewConcurrency: {
        maxActiveRuns: 1,
        leaseTtlMs: 60_000
      },
      scheduler: {
        enabled: true,
        maxProviderActive: 1,
        maxOrgActive: 1,
        maxRepoActive: 1,
        maxQueuedPerRepo: 10,
        manualCommandReserve: 0,
        backgroundPriority: 50
      }
    },
    active: {
      total: 1,
      leased: 0,
      running: 1,
      manual: 0,
      background: 1,
      byProvider: [],
      byOrg: [],
      byRepo: []
    },
    queued: {
      total: 0,
      manual: 0,
      background: 0,
      providerDeferred: 0,
      retryableProviderDeferred: 0
    },
    providerDeferred: {
      total: 0,
      retryable: 0,
      readyToRetry: 0,
      waitingCooldown: 0,
      waitingProviderCapacity: 0,
      waitingOrgCapacity: 0,
      waitingRepoCapacity: 0,
      waitingManualReserve: 0,
      waitingLeaseLimit: 0
    },
    manualReserve: {
      configured: 0,
      activeManual: 0,
      queuedManual: 0,
      reservedSlotsOpen: 0,
      backgroundSlotsAvailableBeforeReserve: 1
    },
    wouldLeaseCount: 0,
    delayedCount: 0,
    details: {
      included: false,
      wouldLeaseReturned: 0,
      delayedReturned: 0,
      detailsTruncated: false,
      inputJobs: 0
    },
    wouldLease: [],
    delayed: [],
    delayedByReason: {},
    ...overrides
  };
}

function insertQueueJob(
  db: DatabaseSync,
  state: string,
  repo: string,
  headSha: string,
  nextEligibleAt?: string,
  options: { pullNumber?: number } = {}
): void {
  const pullNumber = options.pullNumber ?? 1;
  db.prepare(
    `insert into review_queue_jobs
      (job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
       priority, state, next_eligible_at, created_at, updated_at)
     values (?, ?, 'automatic', 'background', ?, ?, ?, ?, 50, ?, ?, ?, ?)`
  ).run(
    `${state}-${pullNumber}-${headSha}`,
    `automatic:${repo}#${pullNumber}@${headSha}`,
    repo,
    repo.split("/")[0],
    pullNumber,
    headSha,
    state,
    nextEligibleAt ?? null,
    "2026-07-01T00:00:00.000Z",
    "2026-07-01T00:00:00.000Z"
  );
}
