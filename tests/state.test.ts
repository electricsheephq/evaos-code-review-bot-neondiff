import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it } from "vitest";
import { parseProviderCooldownError, ReviewStateStore } from "../src/state.js";

describe("review state store", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("deduplicates one review per repo, PR, and head SHA", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.hasProcessed("electricsheephq/WorldOS", 1205, "abc123")).toBe(false);
    store.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1205,
      headSha: "abc123",
      status: "dry_run",
      event: "COMMENT"
    });

    expect(store.hasProcessed("electricsheephq/WorldOS", 1205, "abc123")).toBe(true);
    expect(store.hasProcessed("electricsheephq/WorldOS", 1205, "def456")).toBe(false);
    store.close();
  });

  it("stores one activation watermark per repository", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.hasRepoActivation("electricsheephq/WorldOS")).toBe(false);
    store.recordRepoActivation("electricsheephq/WorldOS", "2026-07-01T00:00:00.000Z");

    expect(store.hasRepoActivation("electricsheephq/WorldOS")).toBe(true);
    expect(store.hasRepoActivation("100yenadmin/evaOS-GUI")).toBe(false);
    store.close();
  });

  it("retires an exact failed head into a nonblocking historical skip", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-retire-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordProcessed({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 212,
      headSha: "failed-head",
      status: "failed",
      error: "ZCode failed before completion: spawnSync node ETIMEDOUT"
    });

    const retired = store.retireFailedReview({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 212,
      headSha: "failed-head",
      reason: "closed_or_stale_after_coverage_audit"
    });

    expect(retired).toMatchObject({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 212,
      headSha: "failed-head",
      status: "skipped",
      error: "retired_failed_head:closed_or_stale_after_coverage_audit; previous_error=ZCode failed before completion: spawnSync node ETIMEDOUT"
    });
    expect(store.getProcessedReview("100yenadmin/Lossless-Codex-Orchestrator-LCO", 212, "failed-head")).toMatchObject({
      status: "skipped",
      error: expect.stringContaining("retired_failed_head:closed_or_stale_after_coverage_audit")
    });
    expect(store.hasProcessed("100yenadmin/Lossless-Codex-Orchestrator-LCO", 212, "failed-head")).toBe(true);
    store.close();
  });

  it("refuses to retire a non-failed processed head", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-retire-posted-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordProcessed({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "posted-head",
      status: "posted",
      event: "COMMENT"
    });

    expect(() => store.retireFailedReview({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "posted-head",
      reason: "operator_request"
    })).toThrow("status is posted, not failed");
    store.close();
  });

  it("caps active review leases and releases them", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:00.000Z"));
    const blocked = store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:01.000Z"));

    expect(first).toBeDefined();
    expect(blocked).toBeUndefined();
    store.releaseReviewRunLease(first!.leaseId);
    expect(store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:02.000Z"))).toBeDefined();
    store.close();
  });

  it("expires stale active review leases", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.tryAcquireReviewRunLease(1, 1_000, new Date("2026-07-01T00:00:00.000Z"))).toBeDefined();
    expect(store.tryAcquireReviewRunLease(1, 1_000, new Date("2026-07-01T00:00:02.000Z"))).toBeDefined();
    store.close();
  });

  it("prunes dead-owner review leases before enforcing capacity", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:00.000Z"), 999_999_999)).toBeDefined();
    const next = store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:01.000Z"));

    expect(next).toBeDefined();
    expect(next?.ownerPid).toBe(process.pid);
    store.close();
  });

  it("prunes legacy ownerless review leases before enforcing capacity", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-"));
    roots.push(root);
    const dbPath = join(root, "state.sqlite");
    const store = new ReviewStateStore(dbPath);
    const db = new DatabaseSync(dbPath);
    db.prepare("insert into review_run_leases (lease_id, started_at, expires_at) values (?, ?, ?)")
      .run("legacy-ownerless", "2026-07-01T00:00:00.000Z", "2026-07-01T00:15:00.000Z");

    expect(store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-01T00:00:01.000Z"))).toBeDefined();
    const rows = db.prepare("select lease_id from review_run_leases where lease_id = ?").all("legacy-ownerless");
    expect(rows).toHaveLength(0);
    db.close();
    store.close();
  });

  it("assigns repo-sticky reviewer session jobs and reuses active sessions for the same repo", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      ttlMs: 60_000,
      headCountLimit: 3,
      now: new Date("2026-07-01T00:00:00.000Z"),
      model: "GLM-5.2",
      provider: "builtin:zai-coding-plan"
    });
    const second = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 498,
      headSha: "head-b",
      ttlMs: 60_000,
      headCountLimit: 3,
      now: new Date("2026-07-01T00:00:10.000Z")
    });

    expect(first).toMatchObject({
      assigned: true,
      assignmentReason: "new_session",
      job: { jobState: "assigned" }
    });
    expect(second).toMatchObject({
      assigned: true,
      assignmentReason: "same_repo_active_session"
    });
    if (!first.assigned || !second.assigned) throw new Error("expected both session assignments to succeed");
    expect(second.session.sessionId).toBe(first.session.sessionId);
    expect(store.listReviewerSessions({ repo: "100yenadmin/evaOS-GUI" })).toEqual([
      expect.objectContaining({
        repo: "100yenadmin/evaOS-GUI",
        state: "active",
        headCountUsed: 2,
        headCountLimit: 3,
        model: "GLM-5.2",
        provider: "builtin:zai-coding-plan"
      })
    ]);
    store.close();
  });

  it("keeps repo-sticky reviewer sessions isolated by repo", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-repo-isolation-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const gui = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "gui-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const lco = store.assignReviewerSessionJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 253,
      headSha: "lco-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:01.000Z")
    });

    if (!gui.assigned || !lco.assigned) throw new Error("expected both repo session assignments to succeed");
    expect(gui.session.sessionId).not.toBe(lco.session.sessionId);
    expect(store.listReviewerSessions()).toHaveLength(2);
    store.close();
  });

  it("does not create session jobs for already processed or already assigned heads", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-dedupe-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordProcessed({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "processed-head",
      status: "posted",
      event: "COMMENT"
    });

    expect(store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "processed-head",
      ttlMs: 60_000,
      headCountLimit: 10
    })).toEqual({ assigned: false, reason: "already_processed" });

    const first = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "new-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const duplicate = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "new-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:01.000Z")
    });

    expect(first).toMatchObject({ assigned: true });
    expect(duplicate).toMatchObject({
      assigned: false,
      reason: "already_assigned",
      job: expect.objectContaining({ headSha: "new-head" })
    });
    store.close();
  });

  it("expires reviewer sessions by TTL or head-count limit before new assignments", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-expiry-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      ttlMs: 1_000,
      headCountLimit: 1,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const second = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 498,
      headSha: "head-b",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:02.000Z")
    });

    expect(first).toMatchObject({
      assigned: true,
      session: expect.objectContaining({ state: "expired", headCountUsed: 1, headCountLimit: 1 })
    });
    expect(second).toMatchObject({ assigned: true, assignmentReason: "session_expired_new_session" });
    if (!first.assigned || !second.assigned) throw new Error("expected both session assignments to succeed");
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(store.listReviewerSessions({ state: "expired" })).toHaveLength(1);
    expect(store.listReviewerSessions({ activeOnly: true, now: new Date("2026-07-01T00:00:02.000Z") })).toHaveLength(1);
    store.close();
  });

  it("does not reuse reviewer sessions owned by dead workers", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-dead-worker-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      ttlMs: 60_000,
      headCountLimit: 10,
      workerPid: 999_999_999,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const second = store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 498,
      headSha: "head-b",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:01.000Z")
    });

    if (!first.assigned || !second.assigned) throw new Error("expected both session assignments to succeed");
    expect(second.session.sessionId).not.toBe(first.session.sessionId);
    expect(store.getReviewerSession(first.session.sessionId)).toMatchObject({
      state: "failed",
      lastError: "owner_pid_not_alive:999999999"
    });
    expect(store.listReviewerSessions({ activeOnly: true, now: new Date("2026-07-01T00:00:01.000Z") })).toHaveLength(1);
    store.close();
  });

  it("filters active reviewer sessions without mutating stale rows from read APIs", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-active-read-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      ttlMs: 1_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(store.listReviewerSessions({ activeOnly: true, now: new Date("2026-07-01T00:00:02.000Z") })).toHaveLength(0);
    expect(store.listReviewerSessions({ state: "active" })).toHaveLength(1);
    expect(store.expireReviewerSessions(new Date("2026-07-01T00:00:02.000Z"), "100yenadmin/evaOS-GUI")).toBe(1);
    expect(store.listReviewerSessions({ state: "expired" })).toHaveLength(1);
    store.close();
  });

  it("tracks reviewer session job lifecycle without calling ZCode", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-jobs-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.assignReviewerSessionJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      ttlMs: 60_000,
      headCountLimit: 10,
      assignmentReason: "manual_command_priority",
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const running = store.updateReviewerSessionJobState({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      jobState: "running",
      now: new Date("2026-07-01T00:00:01.000Z")
    });
    const completed = store.updateReviewerSessionJobState({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      jobState: "completed",
      processedReviewStatus: "posted",
      now: new Date("2026-07-01T00:00:10.000Z")
    });

    expect(running).toMatchObject({
      jobState: "running",
      assignmentReason: "manual_command_priority",
      startedAt: "2026-07-01T00:00:01.000Z"
    });
    expect(completed).toMatchObject({
      jobState: "completed",
      processedReviewStatus: "posted",
      startedAt: "2026-07-01T00:00:01.000Z",
      finishedAt: "2026-07-01T00:00:10.000Z"
    });
    store.close();
  });

  it("stores the latest daemon heartbeat as a singleton", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-daemon-heartbeat-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordDaemonHeartbeat({
      cycle: 1,
      event: "daemon_cycle_start",
      dryRun: false,
      recordedAt: new Date("2026-07-01T00:00:00.000Z")
    });
    store.recordDaemonHeartbeat({
      cycle: 1,
      event: "daemon_cycle_complete",
      dryRun: false,
      recordedAt: new Date("2026-07-01T00:00:05.000Z")
    });

    expect(store.getDaemonHeartbeat()).toEqual({
      cycle: 1,
      event: "daemon_cycle_complete",
      dryRun: false,
      recordedAt: "2026-07-01T00:00:05.000Z",
      startedCycle: 1,
      startedAt: "2026-07-01T00:00:00.000Z"
    });
    store.close();
  });

  it("does not treat a start-only heartbeat as a terminal daemon heartbeat", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-daemon-heartbeat-start-only-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordDaemonHeartbeat({
      cycle: 7,
      event: "daemon_cycle_start",
      dryRun: false,
      recordedAt: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(store.getDaemonHeartbeat()).toBeUndefined();
    store.close();
  });

  it("redacts daemon heartbeat errors", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-daemon-heartbeat-redact-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordDaemonHeartbeat({
      cycle: 2,
      event: "daemon_cycle_failed",
      dryRun: false,
      error: "request failed with ghp_1234567890abcdefghijklmnopqrstuvwx",
      recordedAt: new Date("2026-07-01T00:00:10.000Z")
    });

    expect(store.getDaemonHeartbeat()).toMatchObject({
      cycle: 2,
      event: "daemon_cycle_failed",
      error: "request failed with [redacted-secret]"
    });
    store.close();
  });

  it("parses and filters provider cooldown review rows by expiry", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-provider-cooldown-list-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordProcessed({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 219,
      headSha: "expired-head",
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2026-07-01T00:15:00.000Z; reason=provider_rate_limit"
    });
    store.recordProcessed({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "active-head",
      status: "skipped",
      error: "provider_rate_limit_cooldown_until=2026-07-01T00:45:00.000Z; reason=provider_rate_limit"
    });
    store.recordProcessed({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 221,
      headSha: "baseline-head",
      status: "skipped",
      error: "activation_baseline_existing_head"
    });

    expect(parseProviderCooldownError("provider_rate_limit_cooldown_until=2026-07-01T00:15:00.000Z; reason=provider_rate_limit")).toEqual({
      cooldownUntil: "2026-07-01T00:15:00.000Z",
      reason: "provider_rate_limit"
    });
    expect(store.listProviderCooldownReviews({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      now: new Date("2026-07-01T00:30:00.000Z")
    })).toHaveLength(2);
    expect(store.listProviderCooldownReviews({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      expiredOnly: true,
      now: new Date("2026-07-01T00:30:00.000Z")
    })).toEqual([
      expect.objectContaining({
        pullNumber: 219,
        headSha: "expired-head",
        cooldownUntil: "2026-07-01T00:15:00.000Z",
        reason: "provider_rate_limit",
        expired: true
      })
    ]);
    store.close();
  });

  it("deduplicates processed command comments per repo, PR, head SHA, and comment id", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-command-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-a", 123)).toBe(false);
    store.recordProcessedCommand({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1161,
      headSha: "head-a",
      commentId: 123,
      action: "review",
      status: "triggered"
    });

    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-a", 123)).toBe(true);
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-b", 123)).toBe(false);
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-a", 124)).toBe(false);
    store.close();
  });
});
