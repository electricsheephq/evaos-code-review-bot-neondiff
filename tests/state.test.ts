import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewStateStore } from "../src/state.js";

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
