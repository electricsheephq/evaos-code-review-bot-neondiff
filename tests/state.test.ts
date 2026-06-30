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
});
