import { execFileSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  cleanupStaleReviewWorktrees,
  probeOpenReviewWorktreePaths,
  type ReviewWorktreeCleanupOps
} from "../src/worktree-cleanup.js";

const REPO = "electricsheephq/example";
const SAFE_REPO = "electricsheephq__example";
const NOW = new Date("2026-07-22T12:00:00.000Z");
const TWO_HOURS_MS = 2 * 60 * 60_000;

describe("stale review worktree cleanup", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("removes a stale clean daemon-owned worktree through its mirror", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    makeStale(fixture.paths[0]);

    const result = cleanupStaleReviewWorktrees(baseInput(fixture));

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: fixture.paths[0], status: "deleted", reason: "stale_clean_owned" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(false);
    expect(existsSync(fixture.mirrorPath)).toBe(true);
  });

  it("preserves recent and dirty worktrees", () => {
    const fixture = createFixture(roots, ["111111111111", "222222222222"]);
    makeStale(fixture.paths[1]);
    writeFileSync(join(fixture.paths[1], "untracked.txt"), "keep\n");

    const result = cleanupStaleReviewWorktrees(baseInput(fixture));

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixture.paths[0], status: "skipped", reason: "recent" }),
      expect.objectContaining({ path: fixture.paths[1], status: "skipped", reason: "dirty" })
    ]));
    expect(fixture.paths.every(existsSync)).toBe(true);
  });

  it("preserves a worktree containing only ignored artifacts", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    makeStale(fixture.paths[0]);
    writeFileSync(join(fixture.paths[0], "review-cache.log"), "keep\n");

    const result = cleanupStaleReviewWorktrees(baseInput(fixture));

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: fixture.paths[0], status: "skipped", reason: "dirty" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(true);
  });

  it("preserves a clean worktree whose detached HEAD no longer matches its generated name", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    writeFileSync(join(fixture.paths[0], "README.md"), "local commit\n");
    execFileSync("git", ["-C", fixture.paths[0], "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", fixture.paths[0], "commit", "-m", "local-only"], { stdio: "ignore" });
    makeStale(fixture.paths[0]);

    const result = cleanupStaleReviewWorktrees(baseInput(fixture));

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: fixture.paths[0], status: "skipped", reason: "unexpected_head" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(true);
  });

  it("preserves symlinks and paths that resolve outside the owned root", () => {
    const fixture = createFixture(roots, []);
    const outside = mkdtempSync(join(tmpdir(), "neondiff-cleanup-outside-"));
    roots.push(outside);
    const path = join(fixture.worktreesRoot, `${SAFE_REPO}__pr-1__111111111111`);
    symlinkSync(outside, path, "dir");

    const result = cleanupStaleReviewWorktrees(baseInput(fixture));

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path, status: "skipped", reason: "symlink" })
    ]);
    expect(existsSync(outside)).toBe(true);
  });

  it("preserves an active head and an open worktree", () => {
    const fixture = createFixture(roots, ["111111111111", "222222222222"]);
    fixture.paths.forEach(makeStale);

    const result = cleanupStaleReviewWorktrees({
      ...baseInput(fixture),
      activeReviewHeads: [{ repo: REPO, pullNumber: 1, headSha: "111111111111aaaaaaaaaaaaaaaaaaaaaaaaaaaa" }],
      openWorktreePaths: new Set([fixture.paths[1]])
    });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixture.paths[0], status: "skipped", reason: "active_head" }),
      expect.objectContaining({ path: fixture.paths[1], status: "skipped", reason: "open_or_in_use" })
    ]));
    expect(fixture.paths.every(existsSync)).toBe(true);
  });

  it("preserves an open worktree when workRoot uses a symlink spelling", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    makeStale(fixture.paths[0]);
    const linkedWorkRoot = join(fixture.root, "runtime-link");
    symlinkSync(fixture.workRoot, linkedWorkRoot, "dir");

    const result = cleanupStaleReviewWorktrees({
      ...baseInput(fixture),
      workRoot: linkedWorkRoot,
      openWorktreePaths: new Set([realpathSync(fixture.paths[0])])
    });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ status: "skipped", reason: "open_or_in_use" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(true);
  });

  it("finds a deleted open file beneath a symlinked worktree root", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-open-probe-"));
    roots.push(root);
    const workRoot = join(root, "runtime");
    const worktreePath = join(workRoot, "worktrees", `${SAFE_REPO}__pr-1__111111111111`);
    const linkedWorkRoot = join(root, "runtime-link");
    const openPath = join(worktreePath, "open-then-deleted.txt");
    mkdirSync(worktreePath, { recursive: true });
    symlinkSync(workRoot, linkedWorkRoot, "dir");
    writeFileSync(openPath, "keep open\n");
    const descriptor = openSync(openPath, "r");

    try {
      rmSync(openPath);
      const result = probeOpenReviewWorktreePaths(linkedWorkRoot);

      expect(result.ok).toBe(true);
      expect([...result.paths].map((path) => realpathSync(path))).toContain(realpathSync(worktreePath));
    } finally {
      closeSync(descriptor);
    }
  }, 20_000);

  it("fails closed when the lsof probe is unavailable", () => {
    const result = probeOpenReviewWorktreePaths("/tmp/neondiff-missing-lsof", {
      runLsof: () => ({
        status: null,
        stdout: "",
        stderr: "",
        error: new Error("lsof unavailable")
      })
    });

    expect(result).toEqual({
      ok: false,
      paths: new Set(),
      error: "lsof unavailable"
    });
  });

  it("fails closed for every candidate while another review run holds a live lease", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    makeStale(fixture.paths[0]);

    const result = cleanupStaleReviewWorktrees({ ...baseInput(fixture), activeReviewRun: true });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: fixture.paths[0], status: "skipped", reason: "active_review_run" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(true);
  });

  it("keeps the active duplicate PR head while deleting a different stale head", () => {
    const fixture = createFixture(roots, ["111111111111", "222222222222"]);
    fixture.paths.forEach(makeStale);

    const result = cleanupStaleReviewWorktrees({
      ...baseInput(fixture),
      activeReviewHeads: [{ repo: REPO, pullNumber: 1, headSha: "222222222222bbbbbbbbbbbbbbbbbbbbbbbbbbbb" }]
    });

    expect(result.outcomes).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: fixture.paths[0], status: "deleted" }),
      expect.objectContaining({ path: fixture.paths[1], status: "skipped", reason: "active_head" })
    ]));
    expect(existsSync(fixture.paths[0])).toBe(false);
    expect(existsSync(fixture.paths[1])).toBe(true);
  });

  it("preserves a candidate when ordinary git removal refuses", () => {
    const fixture = createFixture(roots, ["111111111111"]);
    makeStale(fixture.paths[0]);
    const ops: ReviewWorktreeCleanupOps = {
      removeWorktree: () => ({ ok: false, error: "simulated git refusal" })
    };

    const result = cleanupStaleReviewWorktrees({ ...baseInput(fixture), ops });

    expect(result.outcomes).toEqual([
      expect.objectContaining({ path: fixture.paths[0], status: "error", reason: "git_remove_refused" })
    ]);
    expect(existsSync(fixture.paths[0])).toBe(true);
  });

  it("refuses retention shorter than the two-hour and active-lease safety floors", () => {
    const fixture = createFixture(roots, []);
    expect(() => cleanupStaleReviewWorktrees({
      ...baseInput(fixture),
      retentionMs: TWO_HOURS_MS - 1
    })).toThrow(/retentionMs must be at least/);
    expect(() => cleanupStaleReviewWorktrees({
      ...baseInput(fixture),
      retentionMs: TWO_HOURS_MS,
      leaseTtlMs: TWO_HOURS_MS + 1
    })).toThrow(/retentionMs must be at least/);
  });

  it("scales an implicit retention default to a legacy long review lease", () => {
    const config = loadConfigFromObject({
      reviewConcurrency: { maxActiveRuns: 1, leaseTtlMs: 24 * 60 * 60_000 }
    });
    expect(config.worktreeCleanup?.retentionMs).toBe(24 * 60 * 60_000);
  });

  it("does not mutate cleanup defaults after loading a legacy long review lease", () => {
    const longLease = loadConfigFromObject({
      reviewConcurrency: { maxActiveRuns: 1, leaseTtlMs: 24 * 60 * 60_000 }
    });
    const normalLease = loadConfigFromObject({});

    expect(longLease.worktreeCleanup?.retentionMs).toBe(24 * 60 * 60_000);
    expect(normalLease.worktreeCleanup?.retentionMs).toBe(TWO_HOURS_MS);
  });

  it("rejects an explicitly configured retention below the active review lease", () => {
    expect(() => loadConfigFromObject({
      reviewConcurrency: { maxActiveRuns: 1, leaseTtlMs: 24 * 60 * 60_000 },
      worktreeCleanup: { enabled: true, retentionMs: TWO_HOURS_MS, intervalMs: 30 * 60_000 }
    })).toThrow(/config\.worktreeCleanup\.retentionMs must be at least/);
  });
});

function baseInput(fixture: ReturnType<typeof createFixture>) {
  return {
    workRoot: fixture.workRoot,
    retentionMs: TWO_HOURS_MS,
    leaseTtlMs: 20 * 60_000,
    now: NOW,
    activeReviewRun: false,
    activeReviewHeads: [],
    openWorktreePaths: new Set<string>()
  };
}

function createFixture(roots: string[], shortHeads: string[]) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-cleanup-"));
  roots.push(root);
  const sourcePath = join(root, "source");
  const workRoot = join(root, "runtime");
  const worktreesRoot = join(workRoot, "worktrees");
  const mirrorPath = join(workRoot, "mirrors", `${SAFE_REPO}.git`);
  mkdirSync(worktreesRoot, { recursive: true });
  mkdirSync(join(workRoot, "mirrors"), { recursive: true });
  execFileSync("git", ["init", sourcePath], { stdio: "ignore" });
  execFileSync("git", ["-C", sourcePath, "config", "user.email", "bot@example.com"]);
  execFileSync("git", ["-C", sourcePath, "config", "user.name", "Review Bot"]);
  writeFileSync(join(sourcePath, "README.md"), "hello\n");
  writeFileSync(join(sourcePath, ".gitignore"), "review-cache.log\n");
  execFileSync("git", ["-C", sourcePath, "add", "README.md", ".gitignore"], { stdio: "ignore" });
  execFileSync("git", ["-C", sourcePath, "commit", "-m", "initial"], { stdio: "ignore" });
  execFileSync("git", ["clone", "--mirror", sourcePath, mirrorPath], { stdio: "ignore" });
  const paths = shortHeads.map((shortHead) => {
    const path = join(worktreesRoot, `${SAFE_REPO}__pr-1__${shortHead}`);
    execFileSync("git", ["--git-dir", mirrorPath, "worktree", "add", "--detach", path, "HEAD"], { stdio: "ignore" });
    utimesSync(path, NOW, NOW);
    return path;
  });
  return { root, workRoot, worktreesRoot, mirrorPath, paths };
}

function makeStale(path: string): void {
  const stale = new Date(NOW.getTime() - TWO_HOURS_MS - 1);
  utimesSync(path, stale, stale);
}
