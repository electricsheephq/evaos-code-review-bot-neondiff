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
});
