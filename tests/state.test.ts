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

  it("stores normalized issue enrichment body hashes and rejects invalid hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-body-hash-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const record = store.recordIssueEnrichment({
      repo: "owner/issue-repo",
      issueNumber: 17,
      issueUpdatedAt: "2026-07-03T00:00:00.000Z",
      bodyHash: "A".repeat(64),
      status: "posted",
      commentUrl: "https://github.test/owner/issue-repo/issues/17#issuecomment-17",
      now: new Date("2026-07-03T00:00:01.000Z")
    });

    expect(record).toMatchObject({
      repo: "owner/issue-repo",
      issueNumber: 17,
      issueUpdatedAt: "2026-07-03T00:00:00.000Z",
      bodyHash: "a".repeat(64),
      status: "posted",
      commentUrl: "https://github.test/owner/issue-repo/issues/17#issuecomment-17"
    });
    expect(() => store.recordIssueEnrichment({
      repo: "owner/issue-repo",
      issueNumber: 18,
      bodyHash: "not-a-64-hex-digest",
      status: "dry_run"
    })).toThrow("bodyHash must be a 64-character hex digest");
    store.close();
  });

  it("migrates pre-body-hash issue enrichment records before storing hashes", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-body-hash-migration-"));
    roots.push(root);
    const dbPath = join(root, "state.sqlite");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
      create table issue_enrichment_records (
        repo text not null,
        issue_number integer not null,
        issue_updated_at text,
        status text not null,
        reason text,
        comment_url text,
        error text,
        next_eligible_at text,
        created_at text not null,
        updated_at text not null,
        primary key (repo, issue_number)
      );
    `);
    legacyDb.close();

    const store = new ReviewStateStore(dbPath);
    const bodyHash = "b".repeat(64);
    const record = store.recordIssueEnrichment({
      repo: "owner/issue-repo",
      issueNumber: 19,
      issueUpdatedAt: "2026-07-03T00:00:00.000Z",
      bodyHash,
      status: "dry_run",
      reason: "dry_run_only",
      now: new Date("2026-07-03T00:00:01.000Z")
    });
    store.close();

    const migratedDb = new DatabaseSync(dbPath);
    try {
      const columns = migratedDb.prepare("pragma table_info(issue_enrichment_records)").all() as Array<{ name: string }>;
      const row = migratedDb
        .prepare("select body_hash from issue_enrichment_records where repo = ? and issue_number = ?")
        .get("owner/issue-repo", 19) as { body_hash: string } | undefined;

      expect(columns.map((column) => column.name)).toContain("body_hash");
      expect(record).toMatchObject({ status: "dry_run", bodyHash });
      expect(row).toEqual({ body_hash: bodyHash });
    } finally {
      migratedDb.close();
    }
  });

  it("leases issue enrichment live workers separately from PR review runs", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-lease-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date("2026-07-03T05:00:00.000Z"), process.pid);
    const second = store.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date("2026-07-03T05:01:00.000Z"), process.pid);

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(store.tryAcquireReviewRunLease(1, 1_200_000, new Date("2026-07-03T05:01:00.000Z"), process.pid)).toBeDefined();

    store.releaseIssueEnrichmentRunLease(first!.leaseId);
    const afterRelease = store.tryAcquireIssueEnrichmentRunLease(1, 1_200_000, new Date("2026-07-03T05:02:00.000Z"), process.pid);
    expect(afterRelease).toBeDefined();
    store.close();
  });

  it("keeps non-expired issue enrichment leases until TTL even when owner pid is not alive", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-lease-ttl-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.tryAcquireIssueEnrichmentRunLease(1, 1_000, new Date("2026-07-03T05:00:00.000Z"), 999_999_999);
    const beforeExpiry = store.tryAcquireIssueEnrichmentRunLease(1, 1_000, new Date("2026-07-03T05:00:00.500Z"), process.pid);
    const afterExpiry = store.tryAcquireIssueEnrichmentRunLease(1, 1_000, new Date("2026-07-03T05:00:01.001Z"), process.pid);

    expect(first).toBeDefined();
    expect(beforeExpiry).toBeUndefined();
    expect(afterExpiry).toBeDefined();
    store.close();
  });

  it("clears issue enrichment worker leases only after an explicit non-dry-run request", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-lease-clear-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const first = store.tryAcquireIssueEnrichmentRunLease(1, 60_000, new Date("2026-07-03T05:00:00.000Z"), process.pid);
    const dryRun = store.clearIssueEnrichmentRunLeases({
      now: new Date("2026-07-03T05:00:30.000Z"),
      dryRun: true
    });
    const stillBlocked = store.tryAcquireIssueEnrichmentRunLease(1, 60_000, new Date("2026-07-03T05:00:31.000Z"), process.pid);
    const cleared = store.clearIssueEnrichmentRunLeases({
      now: new Date("2026-07-03T05:00:32.000Z"),
      dryRun: false
    });
    const afterClear = store.tryAcquireIssueEnrichmentRunLease(1, 60_000, new Date("2026-07-03T05:00:33.000Z"), process.pid);

    expect(first).toBeDefined();
    expect(dryRun).toMatchObject({
      expiredOnly: false,
      dryRun: true,
      matched: 1,
      expiredMatched: 0,
      activeMatched: 1,
      deleted: 0,
      leases: [
        expect.objectContaining({
          leaseId: first!.leaseId,
          ownerPid: process.pid,
          expired: false
        })
      ]
    });
    expect(stillBlocked).toBeUndefined();
    expect(cleared).toMatchObject({ expiredOnly: false, dryRun: false, matched: 1, expiredMatched: 0, activeMatched: 1, deleted: 1 });
    expect(afterClear).toBeDefined();
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

  it("stores issue enrichment activation separately from PR review activation", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-issue-enrichment-watermark-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(store.getIssueEnrichmentRepoWatermark("electricsheephq/WorldOS")).toBeUndefined();

    const first = store.recordIssueEnrichmentRepoWatermark({
      repo: "electricsheephq/WorldOS",
      activatedAt: "2026-07-03T00:00:00.000Z",
      lastCheckedAt: "2026-07-03T00:00:00.000Z",
      now: new Date("2026-07-03T00:00:01.000Z")
    });
    const advanced = store.recordIssueEnrichmentRepoWatermark({
      repo: "electricsheephq/WorldOS",
      activatedAt: "2026-07-03T01:00:00.000Z",
      lastCheckedAt: "2026-07-03T00:05:00.000Z",
      now: new Date("2026-07-03T00:05:01.000Z")
    });

    expect(first).toMatchObject({
      repo: "electricsheephq/WorldOS",
      activatedAt: "2026-07-03T00:00:00.000Z",
      lastCheckedAt: "2026-07-03T00:00:00.000Z"
    });
    expect(advanced).toMatchObject({
      repo: "electricsheephq/WorldOS",
      activatedAt: "2026-07-03T00:00:00.000Z",
      lastCheckedAt: "2026-07-03T00:05:00.000Z"
    });
    expect(store.hasRepoActivation("electricsheephq/WorldOS")).toBe(false);
    store.close();
  });

  it("persists review readiness transitions without touching updatedAt on no-op repeats", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-readiness-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const queued = store.recordReviewReadiness({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1236,
      headSha: "head-a",
      state: "queued",
      reason: "automatic_enqueue",
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const repeated = store.recordReviewReadiness({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1236,
      headSha: "head-a",
      state: "queued",
      reason: "automatic_enqueue",
      now: new Date("2026-07-01T00:01:00.000Z")
    });
    const reviewed = store.recordReviewReadiness({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1236,
      headSha: "head-a",
      state: "needs_fix",
      reason: "request_changes_review_posted",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1236#pullrequestreview-1",
      now: new Date("2026-07-01T00:02:00.000Z")
    });
    const stale = store.recordReviewReadiness({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1236,
      headSha: "head-a",
      state: "stale",
      reason: "superseded_by_head=head-b",
      now: new Date("2026-07-01T00:03:00.000Z")
    });

    expect(queued).toMatchObject({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1236,
      headSha: "head-a",
      state: "queued",
      reason: "automatic_enqueue"
    });
    expect(repeated.updatedAt).toBe(queued.updatedAt);
    expect(reviewed).toMatchObject({
      state: "needs_fix",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1236#pullrequestreview-1"
    });
    expect(stale).toMatchObject({
      state: "stale",
      reason: "superseded_by_head=head-b",
      event: "REQUEST_CHANGES",
      reviewUrl: "https://github.com/electricsheephq/WorldOS/pull/1236#pullrequestreview-1"
    });
    expect(reviewed.createdAt).toBe(queued.createdAt);
    expect(reviewed.updatedAt).toBe("2026-07-01T00:02:00.000Z");
    expect(stale.createdAt).toBe(queued.createdAt);
    expect(stale.updatedAt).toBe("2026-07-01T00:03:00.000Z");
    expect(store.listReviewReadiness({ states: ["stale"] })).toEqual([stale]);
    store.close();
  });

  it("records command metadata on review readiness rows", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-readiness-command-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const readiness = store.recordReviewReadiness({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 289,
      headSha: "head-command",
      state: "awaiting_re_review",
      reason: "trusted_re_review_command",
      commandAction: "re-review",
      commandCommentId: 222,
      now: new Date("2026-07-01T00:00:00.000Z")
    });

    expect(readiness).toMatchObject({
      state: "awaiting_re_review",
      commandAction: "re-review",
      commandCommentId: 222
    });
    expect(store.getReviewReadiness("100yenadmin/Lossless-Codex-Orchestrator-LCO", 289, "head-command")).toEqual(readiness);
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
    const queueJob = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 212,
      headSha: "failed-head",
      baseSha: "base-head",
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: "ZCode failed before completion: spawnSync node ETIMEDOUT",
      now: new Date("2026-07-03T00:01:00.000Z")
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
    expect(store.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: expect.stringContaining("retired_failed_head:closed_or_stale_after_coverage_audit")
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

  it("finishes queue retirement for an already retired failed head", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-state-retire-idempotent-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    store.recordProcessed({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "failed-head",
      status: "skipped",
      error: "retired_failed_head:old_operator_run; previous_error=ENOENT"
    });
    const queueJob = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "failed-head",
      baseSha: "base-head"
    }).job;
    store.updateReviewQueueJobState({
      jobId: queueJob.jobId,
      state: "failed",
      lastError: "ENOENT"
    });

    const retired = store.retireFailedReview({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "failed-head",
      reason: "rerun_after_partial_retirement"
    });

    expect(retired).toMatchObject({
      status: "skipped",
      error: "retired_failed_head:old_operator_run; previous_error=ENOENT"
    });
    expect(store.getReviewQueueJob(queueJob.jobId)).toMatchObject({
      state: "stale_retired",
      lastError: "retired_failed_head:old_operator_run; previous_error=ENOENT"
    });
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
      ttlMs: 60_000,
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
      session: expect.objectContaining({ state: "draining", headCountUsed: 1, headCountLimit: 1 })
    });
    expect(second).toMatchObject({ assigned: true, assignmentReason: "session_expired_new_session" });
    if (!first.assigned || !second.assigned) throw new Error("expected both session assignments to succeed");
    expect(first.session.sessionId).not.toBe(second.session.sessionId);
    expect(store.getReviewerSession(first.session.sessionId)).toMatchObject({ state: "draining" });
    store.updateReviewerSessionJobState({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "head-a",
      jobState: "completed",
      processedReviewStatus: "posted",
      now: new Date("2026-07-01T00:00:03.000Z")
    });
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

  it("globally reconciles expired and dead-worker reviewer sessions without same-repo assignment", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-reviewer-session-reconcile-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const expired = store.assignReviewerSessionJob({
      repo: "org/repo-expired",
      pullNumber: 1,
      headSha: "expired-head",
      ttlMs: 1_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const deadWorker = store.assignReviewerSessionJob({
      repo: "org/repo-dead",
      pullNumber: 2,
      headSha: "dead-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      workerPid: 999_999_999,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const healthy = store.assignReviewerSessionJob({
      repo: "org/repo-healthy",
      pullNumber: 3,
      headSha: "healthy-head",
      ttlMs: 60_000,
      headCountLimit: 10,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    if (!expired.assigned || !deadWorker.assigned || !healthy.assigned) throw new Error("expected assignments");

    expect(store.reconcileReviewerSessions(new Date("2026-07-01T00:00:02.000Z"))).toEqual({
      expired: 1,
      failedDeadWorkers: 1
    });
    expect(store.getReviewerSession(expired.session.sessionId)).toMatchObject({ state: "expired" });
    expect(store.getReviewerSession(deadWorker.session.sessionId)).toMatchObject({
      state: "failed",
      lastError: "owner_pid_not_alive:999999999"
    });
    expect(store.getReviewerSession(healthy.session.sessionId)).toMatchObject({ state: "active" });
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

  it("dedupes automatic queue attempts while preserving distinct manual attempts", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-attempts-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const automatic = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-a",
      providerId: "builtin:zai-coding-plan",
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const duplicateAutomatic = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-a",
      providerId: "builtin:zai-coding-plan",
      now: new Date("2026-07-01T00:00:01.000Z")
    });
    const sameHeadNewBase = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-b",
      providerId: "builtin:zai-coding-plan",
      now: new Date("2026-07-01T00:00:02.000Z")
    });
    const manual = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      source: "manual_command",
      commentId: 9876,
      now: new Date("2026-07-01T00:00:03.000Z")
    });

    expect(automatic).toMatchObject({
      enqueued: true,
      job: {
        attemptId: "automatic:100yenadmin/Lossless-Codex-Orchestrator-LCO#220@head-a:base=base-a",
        lane: "background",
        priority: 50,
        state: "queued"
      }
    });
    expect(duplicateAutomatic).toMatchObject({
      enqueued: false,
      reason: "already_queued",
      job: { jobId: automatic.job.jobId }
    });
    expect(sameHeadNewBase).toMatchObject({
      enqueued: true,
      job: {
        attemptId: "automatic:100yenadmin/Lossless-Codex-Orchestrator-LCO#220@head-a:base=base-b"
      }
    });
    expect(manual).toMatchObject({
      enqueued: true,
      job: {
        attemptId: "manual:100yenadmin/Lossless-Codex-Orchestrator-LCO#220@head-a:9876",
        lane: "manual",
        priority: 10,
        commentId: 9876
      }
    });
    expect(store.listReviewQueueJobs({ repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO" })).toHaveLength(3);
    store.close();
  });

  it("allows same-attempt queue jobs to be re-enqueued after terminal retirement", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-terminal-reenqueue-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const first = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-a",
      now: new Date("2026-07-01T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: first.jobId,
      state: "stale_retired",
      lastError: "superseded_by_head=head-b",
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    const second = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-a",
      now: new Date("2026-07-01T00:02:00.000Z")
    });
    expect(second).toMatchObject({
      enqueued: true,
      job: {
        repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        pullNumber: 220,
        headSha: "head-a",
        state: "queued"
      }
    });
    expect(second.job.attemptId).toContain(":after-terminal:");
    store.updateReviewQueueJobState({
      jobId: second.job.jobId,
      state: "blocked_on_proof",
      nextEligibleAt: "2026-07-01T00:20:00.000Z",
      lastError: "license proof required",
      now: new Date("2026-07-01T00:02:30.000Z")
    });
    const third = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 220,
      headSha: "head-a",
      baseSha: "base-a",
      now: new Date("2026-07-01T00:03:00.000Z")
    });
    expect(third).toMatchObject({
      enqueued: false,
      reason: "already_queued",
      job: { jobId: second.job.jobId }
    });
    expect(store.listReviewQueueJobs({ repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO" })).toHaveLength(2);
    store.close();
  });

  it("updates queued job priority without losing provider deferral metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-priority-update-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 172,
      headSha: "head-a",
      baseSha: "base-a",
      priority: 50,
      now: new Date("2026-07-03T00:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-03T00:05:00.000Z",
      lastError: "provider_rate_limit_cooldown_until=2026-07-03T00:05:00.000Z; reason=provider_overloaded",
      now: new Date("2026-07-03T00:00:01.000Z")
    });

    const updated = store.updateReviewQueueJobPriority({
      jobId: job.jobId,
      priority: 1,
      now: new Date("2026-07-03T00:00:02.000Z")
    });

    expect(updated).toMatchObject({
      priority: 1,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-03T00:05:00.000Z",
      lastError: "provider_rate_limit_cooldown_until=2026-07-03T00:05:00.000Z; reason=provider_overloaded",
      updatedAt: "2026-07-03T00:00:02.000Z"
    });
    expect(() => store.updateReviewQueueJobPriority({ jobId: job.jobId, priority: -1 })).toThrow(
      "priority must be a non-negative integer"
    );
    store.close();
  });

  it("leases bounded queue jobs by provider org repo and manual reserve", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-lease-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const now = new Date("2026-07-01T00:00:00.000Z");

    const manual = store.enqueueReviewQueueJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 497,
      headSha: "manual-head",
      source: "manual_command",
      commentId: 1,
      providerId: "zai",
      now
    }).job;
    const sameRepoBackground = store.enqueueReviewQueueJob({
      repo: "100yenadmin/evaOS-GUI",
      pullNumber: 498,
      headSha: "same-repo-head",
      providerId: "zai",
      now
    }).job;
    const otherRepoBackground = store.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "world-head",
      providerId: "zai",
      now
    }).job;
    store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 88,
      headSha: "bot-head",
      providerId: "zai",
      now
    });

    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 2,
      maxOrgActive: 2,
      maxRepoActive: 1,
      manualCommandReserve: 1,
      limit: 3,
      now: new Date("2026-07-01T00:00:10.000Z")
    });

    expect(leased.map((job) => job.jobId)).toEqual([manual.jobId, otherRepoBackground.jobId]);
    expect(store.getReviewQueueJob(manual.jobId)).toMatchObject({ state: "leased", leaseId: expect.any(String) });
    expect(store.getReviewQueueJob(otherRepoBackground.jobId)).toMatchObject({ state: "leased", leaseId: expect.any(String) });
    expect(store.getReviewQueueJob(sameRepoBackground.jobId)).toMatchObject({ state: "queued" });
    store.close();
  });

  it("honors repo-specific active caps while leasing queued work", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-repo-specific-lease-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const now = new Date("2026-07-04T00:00:00.000Z");

    const firstLco = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 461,
      headSha: "lco-head-a",
      providerId: "zai",
      now
    }).job;
    const secondLco = store.enqueueReviewQueueJob({
      repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
      pullNumber: 462,
      headSha: "lco-head-b",
      providerId: "zai",
      now: new Date("2026-07-04T00:00:01.000Z")
    }).job;
    const otherRepo = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot-neondiff",
      pullNumber: 218,
      headSha: "self-head",
      providerId: "zai",
      now: new Date("2026-07-04T00:00:02.000Z")
    }).job;

    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 3,
      maxOrgActive: 3,
      maxRepoActive: 3,
      maxRepoActiveByRepo: {
        "100yenadmin/lossless-codex-orchestrator-lco": 1
      },
      manualCommandReserve: 0,
      limit: 3,
      now: new Date("2026-07-04T00:00:10.000Z")
    });

    expect(leased.map((job) => job.jobId)).toEqual([firstLco.jobId, otherRepo.jobId]);
    expect(store.getReviewQueueJob(firstLco.jobId)).toMatchObject({ state: "leased" });
    expect(store.getReviewQueueJob(secondLco.jobId)).toMatchObject({ state: "queued" });
    expect(store.getReviewQueueJob(otherRepo.jobId)).toMatchObject({ state: "leased" });
    store.close();
  });

  it("requeues expired durable queue leases before leasing new work", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-expired-lease-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 89,
      headSha: "head-a",
      providerId: "zai",
      now: new Date("2026-07-01T00:00:00.000Z")
    }).job;

    const firstLease = store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 1_000,
      now: new Date("2026-07-01T00:00:01.000Z")
    });
    expect(firstLease).toHaveLength(1);
    expect(firstLease[0]).toMatchObject({
      jobId: job.jobId,
      state: "leased",
      leaseExpiresAt: "2026-07-01T00:00:02.000Z"
    });

    expect(store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 1_000,
      now: new Date("2026-07-01T00:00:01.500Z")
    })).toEqual([]);

    const renewedLease = store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 1_000,
      now: new Date("2026-07-01T00:00:02.001Z")
    });
    expect(renewedLease).toHaveLength(1);
    expect(renewedLease[0]).toMatchObject({
      jobId: job.jobId,
      state: "leased",
      lastError: "queue_lease_expired_requeued",
      leaseExpiresAt: "2026-07-01T00:00:03.001Z"
    });
    expect(renewedLease[0].leaseId).not.toEqual(firstLease[0].leaseId);
    store.close();
  });

  it("dry-runs and clears expired review queue leases without manual SQL", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-lease-clear-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 174,
      headSha: "head-a",
      providerId: "zai",
      now: new Date("2026-07-03T08:00:00.000Z")
    }).job;
    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 1_000,
      now: new Date("2026-07-03T08:00:01.000Z")
    })[0]!;

    const dryRun = store.clearReviewQueueLeases({
      dryRun: true,
      expiredOnly: true,
      now: new Date("2026-07-03T08:00:02.001Z")
    });
    expect(dryRun).toMatchObject({
      dryRun: true,
      expiredOnly: true,
      matched: 1,
      expiredMatched: 1,
      activeMatched: 0,
      requeued: 0,
      jobs: [
        expect.objectContaining({
          jobId: job.jobId,
          state: "leased",
          staleReason: "expired"
        })
      ]
    });
    expect(store.getReviewQueueJob(job.jobId)).toMatchObject({ state: "leased", leaseId: leased.leaseId });

    const cleared = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: true,
      now: new Date("2026-07-03T08:00:02.002Z")
    });
    expect(cleared).toMatchObject({ dryRun: false, matched: 1, expiredMatched: 1, requeued: 1 });
    expect(store.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "queued",
      lastError: "queue_lease_operator_requeued:expired"
    });
    expect(store.getReviewQueueJob(job.jobId)?.leaseId).toBeUndefined();
    store.close();
  });

  it("marks proof-blocked queue jobs when leasing so status suppression is stable", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-proof-lease-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 174,
      headSha: "head-proof",
      providerId: "zai",
      now: new Date("2026-07-03T08:00:00.000Z")
    }).job;
    store.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "blocked_on_proof",
      nextEligibleAt: "2026-07-03T08:00:01.000Z",
      lastError: "repo visibility is unknown; private repo entitlement gate fails closed",
      now: new Date("2026-07-03T08:00:00.500Z")
    });

    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 60_000,
      now: new Date("2026-07-03T08:00:02.000Z")
    })[0]!;

    expect(leased).toMatchObject({
      jobId: job.jobId,
      state: "leased",
      lastError: expect.stringContaining("blocked_on_proof")
    });
    store.close();
  });

  it("requires force-active semantics before requeueing active review queue leases", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-force-active-clear-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const runLease = store.tryAcquireReviewRunLease(
      1,
      60_000,
      new Date("2026-07-03T08:10:00.000Z"),
      process.pid
    );
    expect(runLease).toBeDefined();
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 175,
      headSha: "head-active",
      providerId: "zai",
      now: new Date("2026-07-03T08:10:00.000Z")
    }).job;
    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 60_000,
      now: new Date("2026-07-03T08:10:01.000Z")
    })[0]!;

    expect(store.clearReviewQueueLeases({
      dryRun: true,
      expiredOnly: true,
      now: new Date("2026-07-03T08:10:02.000Z")
    })).toMatchObject({ matched: 0, activeMatched: 0 });

    const forcedDryRun = store.clearReviewQueueLeases({
      dryRun: true,
      expiredOnly: false,
      forceActive: true,
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 175,
      now: new Date("2026-07-03T08:10:02.000Z")
    });
    expect(forcedDryRun).toMatchObject({
      matched: 1,
      expiredMatched: 0,
      activeMatched: 1,
      requeued: 0,
      filters: {
        repo: "electricsheephq/evaos-code-review-bot",
        pullNumber: 175
      },
      jobs: [
        expect.objectContaining({
          jobId: job.jobId,
          active: true,
          staleReason: "forced_active"
        })
      ]
    });
    expect(store.getReviewQueueJob(job.jobId)).toMatchObject({ state: "leased", leaseId: leased.leaseId });

    const cleared = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: false,
      forceActive: true,
      jobId: job.jobId,
      now: new Date("2026-07-03T08:10:03.000Z")
	    });
	    expect(cleared).toMatchObject({ matched: 1, activeMatched: 1, requeued: 1, deletedRunLeases: 0, runLeases: [] });
	    expect(store.getReviewQueueJob(job.jobId)).toMatchObject({
	      state: "queued",
	      lastError: "queue_lease_operator_requeued:forced_active"
	    });
	    expect(store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-03T08:10:04.000Z"), process.pid)).toBeUndefined();
	    store.close();
	  });

  it("uses the queue lease TTL fallback for fresh legacy null lease expiries", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-null-lease-fallback-"));
    roots.push(root);
    const dbPath = join(root, "state.sqlite");
    const store = new ReviewStateStore(dbPath);
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 176,
      headSha: "head-null-expiry",
      providerId: "zai",
      now: new Date("2026-07-03T08:30:00.000Z")
    }).job;
    store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      leaseTtlMs: 60_000,
      now: new Date("2026-07-03T08:30:01.000Z")
    });
    const db = new DatabaseSync(dbPath);
    try {
      db.prepare("update review_queue_jobs set lease_expires_at = null, updated_at = ? where job_id = ?")
        .run("2026-07-03T08:30:01.000Z", job.jobId);
    } finally {
      db.close();
    }

    expect(store.clearReviewQueueLeases({
      dryRun: true,
      expiredOnly: true,
      leaseTtlMs: 60_000,
      now: new Date("2026-07-03T08:30:30.000Z")
    })).toMatchObject({ matched: 0, expiredMatched: 0 });

    const expired = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: true,
      leaseTtlMs: 60_000,
      now: new Date("2026-07-03T08:31:01.001Z")
    });
    expect(expired).toMatchObject({
      matched: 1,
      expiredMatched: 1,
      requeued: 1,
      jobs: [expect.objectContaining({ jobId: job.jobId, staleReason: "missing_lease_expiry" })]
    });
    expect(store.getReviewQueueJob(job.jobId)).toMatchObject({
      state: "queued",
      lastError: "queue_lease_operator_requeued:missing_lease_expiry"
    });
    store.close();
  });

  it("deletes stale review run leases owned by dead workers", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-run-lease-clear-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const lease = store.tryAcquireReviewRunLease(
      1,
      60_000,
      new Date("2026-07-03T08:20:00.000Z"),
      999_999_999
    );

    const dryRun = store.clearReviewQueueLeases({
      dryRun: true,
      expiredOnly: true,
      now: new Date("2026-07-03T08:20:01.000Z")
    });
    expect(dryRun).toMatchObject({
      matched: 1,
      expiredMatched: 1,
      deletedRunLeases: 0,
      runLeases: [
        expect.objectContaining({
          leaseId: lease!.leaseId,
          ownerAlive: false,
          staleReason: "owner_not_running"
        })
      ]
    });

    const cleared = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: true,
      now: new Date("2026-07-03T08:20:02.000Z")
    });
    expect(cleared).toMatchObject({ matched: 1, deletedRunLeases: 1 });
    expect(store.tryAcquireReviewRunLease(1, 60_000, new Date("2026-07-03T08:20:03.000Z"), process.pid)).toBeDefined();
    store.close();
  });

  it("does not delete unrelated stale run leases during scoped queue cleanup", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-run-lease-scoped-clear-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const lease = store.tryAcquireReviewRunLease(
      1,
      60_000,
      new Date("2026-07-03T08:25:00.000Z"),
      999_999_999
    );
    expect(lease).toBeDefined();
    store.enqueueReviewQueueJob({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 176,
      headSha: "head-scoped",
      providerId: "zai",
      now: new Date("2026-07-03T08:25:00.000Z")
    });

    const scoped = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: true,
      repo: "electricsheephq/evaos-code-review-bot",
      now: new Date("2026-07-03T08:25:01.000Z")
    });
    expect(scoped).toMatchObject({ matched: 0, deletedRunLeases: 0, runLeases: [] });

    const unscoped = store.clearReviewQueueLeases({
      dryRun: false,
      expiredOnly: true,
      now: new Date("2026-07-03T08:25:02.000Z")
    });
    expect(unscoped).toMatchObject({
      matched: 1,
      deletedRunLeases: 1,
      runLeases: [expect.objectContaining({ leaseId: lease!.leaseId, staleReason: "owner_not_running" })]
    });
    store.close();
  });

  it("defers and later leases provider-deferred queue jobs after next eligible time", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-deferred-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "head-a",
      providerId: "zai",
      now: new Date("2026-07-01T00:00:00.000Z")
    }).job;

    store.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "2026-07-01T00:05:00.000Z",
      lastError: "provider 1302 with ghp_fake_token",
      now: new Date("2026-07-01T00:00:05.000Z")
    });
    expect(store.leaseNextReviewQueueJobs({
      maxProviderActive: 2,
      maxOrgActive: 2,
      maxRepoActive: 1,
      now: new Date("2026-07-01T00:04:00.000Z")
    })).toEqual([]);

    const leased = store.leaseNextReviewQueueJobs({
      maxProviderActive: 2,
      maxOrgActive: 2,
      maxRepoActive: 1,
      now: new Date("2026-07-01T00:05:01.000Z")
    });
    expect(leased).toHaveLength(1);
    expect(leased[0]).toMatchObject({ jobId: job.jobId, state: "leased", lastError: "provider 1302 with [redacted-secret]" });
    store.close();
  });

  it("treats malformed provider-deferred eligibility timestamps as retryable backlog", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-queue-malformed-deferred-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const job = store.enqueueReviewQueueJob({
      repo: "electricsheephq/WorldOS",
      pullNumber: 1214,
      headSha: "head-b",
      providerId: "zai",
      now: new Date("2026-07-01T00:00:00.000Z")
    }).job;

    store.updateReviewQueueJobState({
      jobId: job.jobId,
      state: "provider_deferred",
      nextEligibleAt: "not-a-date",
      lastError: "legacy provider cooldown",
      now: new Date("2026-07-01T00:00:05.000Z")
    });

    expect(store.leaseNextReviewQueueJobs({
      maxProviderActive: 1,
      maxOrgActive: 1,
      maxRepoActive: 1,
      now: new Date("2026-07-01T00:00:10.000Z")
    })).toEqual([
      expect.objectContaining({ jobId: job.jobId, state: "leased" })
    ]);
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
      error: "request failed with ghp_fake_token",
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
    expect(parseProviderCooldownError(
      "provider_rate_limit_cooldown_until=2026-07-01T00:15:00.000Z; reason=provider_overloaded; retry_attempt=3; provider_code=1305; retry_after_ms=45000"
    )).toEqual({
      cooldownUntil: "2026-07-01T00:15:00.000Z",
      reason: "provider_overloaded",
      retryAttempt: 3,
      providerCode: "1305",
      retryAfterMs: 45000
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

  it("deduplicates processed command comments per repo, PR, and comment id", () => {
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
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-b", 123)).toBe(true);
    expect(store.hasProcessedCommand("electricsheephq/WorldOS", 1161, "head-a", 124)).toBe(false);
    store.close();
  });

  it("atomically consumes a trusted owner authorization once per exact review head", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-event-authorization-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const authorization = {
      repo: "owner/repo",
      pullNumber: 7,
      headSha: "A".repeat(40),
      commentId: 41,
      author: "100yenadmin"
    };

    expect(store.getReviewEventAuthorizationConsumption("owner/repo", 7, "A".repeat(40))).toBeUndefined();
    expect(store.tryConsumeReviewEventAuthorization({ ...authorization, now: new Date("2026-07-13T00:00:00.000Z") })).toBe(true);
    expect(store.getReviewEventAuthorizationConsumption("owner/repo", 7, "A".repeat(40))).toEqual({
      repo: "owner/repo",
      pullNumber: 7,
      headSha: "a".repeat(40),
      commentId: 41,
      author: "100yenadmin",
      consumedAt: "2026-07-13T00:00:00.000Z"
    });
    expect(store.tryConsumeReviewEventAuthorization({ ...authorization, commentId: 42 })).toBe(false);
    expect(store.tryConsumeReviewEventAuthorization({ ...authorization, commentId: 42, headSha: "b".repeat(40) })).toBe(true);
    expect(() => store.tryConsumeReviewEventAuthorization({ ...authorization, repo: "invalid" })).toThrow("repo must be an owner/repo name");
    expect(() => store.tryConsumeReviewEventAuthorization({ ...authorization, pullNumber: 0 })).toThrow("pullNumber must be a positive integer");
    expect(() => store.tryConsumeReviewEventAuthorization({ ...authorization, headSha: "short" })).toThrow("headSha must be a 40-character hexadecimal SHA");
    expect(() => store.tryConsumeReviewEventAuthorization({ ...authorization, commentId: 0 })).toThrow("commentId must be a positive integer");
    expect(() => store.tryConsumeReviewEventAuthorization({ ...authorization, author: "" })).toThrow("author must be a non-empty string");
    store.close();
  });

  it("uses the SQLite one-shot key across independent state-store connections", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-event-authorization-connections-"));
    roots.push(root);
    const dbPath = join(root, "state.sqlite");
    const first = new ReviewStateStore(dbPath);
    const second = new ReviewStateStore(dbPath);
    const authorization = {
      repo: "owner/repo",
      pullNumber: 7,
      headSha: "e".repeat(40),
      commentId: 41,
      author: "100yenadmin"
    };

    try {
      expect(first.tryConsumeReviewEventAuthorization(authorization)).toBe(true);
      expect(second.tryConsumeReviewEventAuthorization({ ...authorization, commentId: 42 })).toBe(false);
      expect(second.tryConsumeReviewEventAuthorization({ ...authorization, commentId: 43, headSha: "f".repeat(40) })).toBe(true);
    } finally {
      first.close();
      second.close();
    }
  });

  it("adds authorization state to a legacy database without losing prior rows", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-event-authorization-legacy-"));
    roots.push(root);
    const dbPath = join(root, "state.sqlite");
    const legacyDb = new DatabaseSync(dbPath);
    legacyDb.exec(`
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
      insert into processed_reviews (repo, pull_number, head_sha, status) values ('owner/repo', 7, '${"c".repeat(40)}', 'posted');
    `);
    legacyDb.close();

    const store = new ReviewStateStore(dbPath);
    expect(store.hasProcessed("owner/repo", 7, "c".repeat(40))).toBe(true);
    expect(store.tryConsumeReviewEventAuthorization({
      repo: "owner/repo",
      pullNumber: 7,
      headSha: "d".repeat(40),
      commentId: 42,
      author: "100yenadmin"
    })).toBe(true);
    store.close();

    const migratedDb = new DatabaseSync(dbPath);
    try {
      expect(migratedDb.prepare("select count(*) as count from processed_reviews").get()).toEqual({ count: 1 });
      expect(migratedDb.prepare("select count(*) as count from review_event_authorization_consumptions").get()).toEqual({ count: 1 });
    } finally {
      migratedDb.close();
    }
  });

  it("records finishing-touch draft outputs per command and head", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-finishing-touch-state-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const draft = store.recordFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      commandCommentId: 456,
      action: "explain_risk",
      author: "100yenadmin",
      trigger: "@evaos-code-review-bot explain risk",
      status: "drafted",
      proposedOutput: {
        mode: "draft_only",
        markdown: "Draft only: explain runtime risk. No branch was pushed."
      },
      now: new Date("2026-07-03T00:00:00.000Z")
    });

    expect(draft).toMatchObject({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      commandCommentId: 456,
      action: "explain_risk",
      author: "100yenadmin",
      status: "drafted"
    });
    expect(store.getFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      commandCommentId: 456
    })).toMatchObject({
      action: "explain_risk",
      outputSha: expect.stringMatching(/^[a-f0-9]{64}$/),
      proposedOutput: {
        markdown: expect.stringContaining("No branch was pushed")
      }
    });
    expect(() => store.recordFinishingTouchDraft({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      headSha: "head-a",
      commandCommentId: 457,
      action: "generate_tests",
      author: "100yenadmin",
      trigger: "@evaos-code-review-bot generate tests",
      status: "rejected",
      proposedOutput: { markdown: "token ghp_fake_token" }
    })).toThrow(/secret-like/);
    store.close();
  });

  it("grants an atomic per-head review claim to exactly one concurrent claimant (#295)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-head-claim-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const head = { repo: "electricsheephq/WorldOS", pullNumber: 289, headSha: "head-abc" };

    const first = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:00.000Z") });
    const second = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:06.000Z") });

    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    store.close();
  });

  it("lets a NEW head on the same PR claim while another head is held (#295)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-head-claim-newhead-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const held = store.tryClaimReviewHead({ repo: "r/x", pullNumber: 1, headSha: "sha-1", claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:00.000Z") });
    const newHead = store.tryClaimReviewHead({ repo: "r/x", pullNumber: 1, headSha: "sha-2", claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:01.000Z") });

    expect(held).toBeDefined();
    expect(newHead).toBeDefined();
    store.close();
  });

  it("expires a stale per-head claim after its TTL so a new claimant can proceed (#295)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-head-claim-ttl-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const head = { repo: "r/x", pullNumber: 2, headSha: "sha-ttl" };

    const first = store.tryClaimReviewHead({ ...head, claimTtlMs: 1_000, now: new Date("2026-07-06T00:00:00.000Z"), ownerPid: 999_999_999 });
    const beforeExpiry = store.tryClaimReviewHead({ ...head, claimTtlMs: 1_000, now: new Date("2026-07-06T00:00:00.500Z") });
    const afterExpiry = store.tryClaimReviewHead({ ...head, claimTtlMs: 1_000, now: new Date("2026-07-06T00:00:01.001Z") });

    expect(first).toBeDefined();
    expect(beforeExpiry).toBeUndefined();
    expect(afterExpiry).toBeDefined();
    store.close();
  });

  it("releases a per-head claim so it can be re-acquired (#295)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-head-claim-release-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const head = { repo: "r/x", pullNumber: 3, headSha: "sha-rel" };

    const first = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:00.000Z") });
    store.releaseReviewHeadClaim(first!.claimId);
    const afterRelease = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:01.000Z") });

    expect(first).toBeDefined();
    expect(afterRelease).toBeDefined();
    store.close();
  });

  it("retires the per-head claim when the review is recorded so it is not re-claimed (#295)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-head-claim-retire-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const head = { repo: "r/x", pullNumber: 4, headSha: "sha-done" };

    const claim = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:00.000Z") });
    expect(claim).toBeDefined();
    store.recordProcessed({ repo: head.repo, pullNumber: head.pullNumber, headSha: head.headSha, status: "posted" });

    // A completed review supersedes the claim: the claim row is retired (no stale row lingers to TTL).
    const afterRecord = store.tryClaimReviewHead({ ...head, claimTtlMs: 900_000, now: new Date("2026-07-06T00:00:02.000Z") });
    expect(afterRecord).toBeDefined();
    store.close();
  });

  it("stores finding outcome labels idempotently with a redacted evidence_ref (#286 PR A)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-outcome-labels-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const fingerprint = `finding:${"d".repeat(64)}`;
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");
    const record = {
      fingerprint,
      repo: "electricsheephq/WorldOS",
      pullNumber: 289,
      headSha: "sha-label",
      severity: "P1",
      category: "data_loss",
      confidence: 0.9,
      labelSource: "merged_fix" as const,
      verdict: "true_positive" as const,
      observedAt: "2026-07-06T00:00:00.000Z",
      evidenceRef: `merge commit ${token}`
    };

    store.recordFindingOutcomeLabel(record);
    store.recordFindingOutcomeLabel({ ...record, verdict: "false_positive", labelSource: "human_thread" });

    const labels = store.listFindingOutcomeLabels();
    expect(labels).toHaveLength(1); // UPSERT on the unique key ⇒ no duplicate row
    expect(labels[0]).toMatchObject({ verdict: "false_positive", labelSource: "human_thread" });
    expect(labels[0]?.evidenceRef).not.toContain(token);
    expect(store.hasFindingOutcomeLabel(fingerprint, record.repo, 289, "sha-label")).toBe(true);
    expect(store.hasFindingOutcomeLabel(fingerprint, record.repo, 289, "other-head")).toBe(false);

    expect(() => store.recordFindingOutcomeLabel({ ...record, fingerprint: "not-a-fingerprint" })).toThrow(/finding:<64-hex>/);
    store.close();
  });

  it("rescues a past-max-wait job ahead of a fresh elevated job, but not a fresh docs job (#346)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-queue-rescue-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    // Starved docs job (demoted to 70) that has waited 90m (> 60m maxWait) ⇒ RESCUED.
    const starvedDocs = store.enqueueReviewQueueJob({ repo: "owner/repo", pullNumber: 1, headSha: "starved-docs", priority: 70, now: new Date(now.getTime() - 90 * 60_000) }).job;
    // Fresh elevated (20) and fresh docs (70), both enqueued now (sub-maxWait, NOT rescued).
    store.enqueueReviewQueueJob({ repo: "owner/repo2", pullNumber: 2, headSha: "fresh-elevated", priority: 20, now });
    store.enqueueReviewQueueJob({ repo: "owner/repo3", pullNumber: 3, headSha: "fresh-docs", priority: 70, now });

    const aging = { enabled: true, maxWaitMinutes: 60 };
    // The rescued starved job overtakes even the fresh elevated job — the anti-starvation backstop.
    const first = store.leaseNextReviewQueueJobs({ maxProviderActive: 3, maxOrgActive: 5, maxRepoActive: 5, limit: 3, now, aging });
    expect(first.map((job) => job.headSha)).toEqual(["starved-docs", "fresh-elevated", "fresh-docs"]);
    // And a FRESH docs job (not past maxWait) does NOT overtake fresh elevated — strict priority holds.
    expect(first[0]?.jobId).toBe(starvedDocs.jobId);
    store.close();
  });

  it("orders multiple rescued jobs FIFO by enqueue time, oldest first (#346)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-queue-rescue-fifo-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    // Two rescued jobs (both past maxWait); the OLDER one leases first regardless of priority number.
    const older = store.enqueueReviewQueueJob({ repo: "owner/repo", pullNumber: 1, headSha: "older", priority: 70, now: new Date(now.getTime() - 120 * 60_000) }).job;
    const newer = store.enqueueReviewQueueJob({ repo: "owner/repo2", pullNumber: 2, headSha: "newer", priority: 20, now: new Date(now.getTime() - 90 * 60_000) }).job;

    const leased = store.leaseNextReviewQueueJobs({ maxProviderActive: 2, maxOrgActive: 5, maxRepoActive: 5, limit: 2, now, aging: { enabled: true, maxWaitMinutes: 60 } });
    expect(leased.map((job) => job.jobId)).toEqual([older.jobId, newer.jobId]);
    store.close();
  });

  it("leaves lease order byte-identical to today when aging is unset (#346)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-queue-noaging-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const now = new Date("2026-07-06T12:00:00.000Z");
    store.enqueueReviewQueueJob({ repo: "owner/repo", pullNumber: 1, headSha: "docs-old", priority: 70, now: new Date(now.getTime() - 90 * 60_000) });
    store.enqueueReviewQueueJob({ repo: "owner/repo2", pullNumber: 2, headSha: "baseline-new", priority: 50, now });

    // No aging config ⇒ pure priority ASC then FIFO: baseline (50) leases before docs (70) despite age.
    const leased = store.leaseNextReviewQueueJobs({ maxProviderActive: 1, maxOrgActive: 5, maxRepoActive: 5, limit: 1, now });
    expect(leased.map((job) => job.headSha)).toEqual(["baseline-new"]);
    store.close();
  });

  it("atomically rate-limits a public command per {repo,pr,head,author,action} within the cooldown window (#345)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-pubcmd-cooldown-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const tuple = { repo: "owner/repo", pullNumber: 42, headSha: "head-a", author: "randopublic", action: "review", cooldownMs: 10 * 60_000 };
    const t0 = new Date("2026-07-06T12:00:00.000Z");

    // First invocation is allowed and recorded.
    expect(store.tryRecordPublicCommandInvocation({ ...tuple, now: t0 })).toBe(true);
    // Second within the window is denied (cooled down), no new record.
    expect(store.tryRecordPublicCommandInvocation({ ...tuple, now: new Date(t0.getTime() + 5 * 60_000) })).toBe(false);
    // After the window it is allowed again.
    expect(store.tryRecordPublicCommandInvocation({ ...tuple, now: new Date(t0.getTime() + 11 * 60_000) })).toBe(true);
    store.close();
  });

  it("scopes the public-command cooldown per head, author, and action (#345)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-pubcmd-scope-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    const base = { repo: "owner/repo", pullNumber: 42, headSha: "head-a", author: "randopublic", action: "review", cooldownMs: 10 * 60_000 };
    const t0 = new Date("2026-07-06T12:00:00.000Z");
    const soon = new Date(t0.getTime() + 60_000);

    expect(store.tryRecordPublicCommandInvocation({ ...base, now: t0 })).toBe(true);
    // Same tuple within window → denied.
    expect(store.tryRecordPublicCommandInvocation({ ...base, now: soon })).toBe(false);
    // A NEW head (genuinely new push) is not blocked by the prior head's invocation.
    expect(store.tryRecordPublicCommandInvocation({ ...base, headSha: "head-b", now: soon })).toBe(true);
    // A different author on the same head is independent.
    expect(store.tryRecordPublicCommandInvocation({ ...base, author: "otherpublic", now: soon })).toBe(true);
    // A different action on the same head/author is independent.
    expect(store.tryRecordPublicCommandInvocation({ ...base, action: "re-review", now: soon })).toBe(true);
    store.close();
  });
});
