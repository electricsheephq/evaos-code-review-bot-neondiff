import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planPullWorktreePaths, repairExistingReviewWorktreePathForCheckout } from "../src/git.js";

describe("pull worktree path planning", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("rejects a review workRoot inside the protected live checkout", () => {
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(liveCheckout);

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: join(liveCheckout, "runtime"),
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/workRoot must be outside the protected live checkout/);
  });

  it("keeps self-repo review paths outside the protected live checkout", () => {
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    const isolatedRoot = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(liveCheckout, isolatedRoot);

    const paths = planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: isolatedRoot,
      protectedCheckoutRoot: liveCheckout
    });

    expect(paths.mirrorPath.startsWith(liveCheckout)).toBe(false);
    expect(paths.worktreePath.startsWith(liveCheckout)).toBe(false);
    expect(paths.worktreePath).toContain("electricsheephq__evaos-code-review-bot__pr-157__a679792e7ed7");
  });

  it("rejects a review workRoot symlinked into the protected live checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(root, liveCheckout);
    const insideLiveCheckout = join(liveCheckout, "runtime-target");
    mkdirSync(insideLiveCheckout);
    const runtimeLink = join(root, "runtime-link");
    symlinkSync(insideLiveCheckout, runtimeLink, "dir");

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: runtimeLink,
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/workRoot must be outside the protected live checkout/);
  });

  it("rejects an in-checkout workRoot whose relative segment starts with dots", () => {
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(liveCheckout);

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: join(liveCheckout, "..runtime"),
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/workRoot must be outside the protected live checkout/);
  });

  it("rejects a workRoot that contains the protected live checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    const liveCheckout = join(root, "repos", "evaos-code-review-bot");
    mkdirSync(liveCheckout, { recursive: true });
    roots.push(root);

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: root,
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/workRoot must be outside the protected live checkout/);
  });

  it("rejects a planned worktreePath that resolves through a symlink into the protected live checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(root, liveCheckout);
    const worktreesLink = join(root, "worktrees");
    symlinkSync(liveCheckout, worktreesLink, "dir");

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: root,
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/worktreePath must be outside the protected live checkout/);
  });

  it("rejects a planned mirrorPath that resolves through a symlink into the protected live checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(root, liveCheckout);
    const mirrorsLink = join(root, "mirrors");
    symlinkSync(liveCheckout, mirrorsLink, "dir");

    expect(() => planPullWorktreePaths({
      repo: "electricsheephq/evaos-code-review-bot",
      pullNumber: 157,
      expectedHeadSha: "a679792e7ed7517e7286507cfd7107511c2f60fb",
      workRoot: root,
      protectedCheckoutRoot: liveCheckout
    })).toThrow(/mirrorPath must be outside the protected live checkout/);
  });

  it("repairs an empty existing non-git worktree directory before checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    mkdirSync(worktreePath);

    repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath });

    expect(existsSync(worktreePath)).toBe(false);
    const worktrees = execFileSync("git", ["--git-dir", mirrorPath, "worktree", "list", "--porcelain"], {
      encoding: "utf8"
    });
    expect(worktrees).not.toContain(`worktree ${worktreePath}`);
  });

  it("repairs an existing git worktree directory before checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const sourcePath = join(root, "source");
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", sourcePath], { stdio: "ignore" });
    execFileSync("git", ["-C", sourcePath, "config", "user.email", "bot@example.com"]);
    execFileSync("git", ["-C", sourcePath, "config", "user.name", "Review Bot"]);
    writeFileSync(join(sourcePath, "README.md"), "hello\n");
    execFileSync("git", ["-C", sourcePath, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", sourcePath, "commit", "-m", "initial"], { stdio: "ignore" });
    execFileSync("git", ["clone", "--mirror", sourcePath, mirrorPath], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", mirrorPath, "worktree", "add", "--detach", worktreePath, "HEAD"], { stdio: "ignore" });

    repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath });

    expect(existsSync(worktreePath)).toBe(false);
  });

  it("prunes stale mirror worktree metadata when the worktree path is absent", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const sourcePath = join(root, "source");
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", sourcePath], { stdio: "ignore" });
    execFileSync("git", ["-C", sourcePath, "config", "user.email", "bot@example.com"]);
    execFileSync("git", ["-C", sourcePath, "config", "user.name", "Review Bot"]);
    writeFileSync(join(sourcePath, "README.md"), "hello\n");
    execFileSync("git", ["-C", sourcePath, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", sourcePath, "commit", "-m", "initial"], { stdio: "ignore" });
    execFileSync("git", ["clone", "--mirror", sourcePath, mirrorPath], { stdio: "ignore" });
    execFileSync("git", ["--git-dir", mirrorPath, "worktree", "add", "--detach", worktreePath, "HEAD"], { stdio: "ignore" });
    rmSync(worktreePath, { recursive: true, force: true });

    repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath });

    const worktrees = execFileSync("git", ["--git-dir", mirrorPath, "worktree", "list", "--porcelain"], {
      encoding: "utf8"
    });
    expect(worktrees).not.toContain(`worktree ${worktreePath}`);
  });

  it("rejects an existing git checkout not owned by the mirror", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "unrelated-repo");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    execFileSync("git", ["init", worktreePath], { stdio: "ignore" });
    execFileSync("git", ["-C", worktreePath, "config", "user.email", "bot@example.com"]);
    execFileSync("git", ["-C", worktreePath, "config", "user.name", "Review Bot"]);
    writeFileSync(join(worktreePath, "README.md"), "do not delete\n");
    execFileSync("git", ["-C", worktreePath, "add", "README.md"], { stdio: "ignore" });
    execFileSync("git", ["-C", worktreePath, "commit", "-m", "initial"], { stdio: "ignore" });

    expect(() => repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath })).toThrow(
      /existing_git_worktree_not_owned/
    );
    expect(existsSync(join(worktreePath, "README.md"))).toBe(true);
  });

  it("rejects a symlink repair target before git-worktree deletion", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const gitTarget = join(root, "git-target");
    const worktreePath = join(root, "worktree-link");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    execFileSync("git", ["init", gitTarget], { stdio: "ignore" });
    symlinkSync(gitTarget, worktreePath, "dir");

    expect(() => repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath })).toThrow(/existing_symlink/);
    expect(existsSync(gitTarget)).toBe(true);
  });

  it("repairs a non-git worktree directory containing only ignorable macOS metadata", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, ".DS_Store"), "metadata");

    repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath });

    expect(existsSync(worktreePath)).toBe(false);
  });

  it("fails closed for a non-empty existing non-git worktree directory", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    mkdirSync(worktreePath);
    writeFileSync(join(worktreePath, "leftover.txt"), "not a git checkout");

    expect(() => repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath })).toThrow(
      /checkout preparation failed.*existing_non_git_non_empty/
    );
    expect(existsSync(join(worktreePath, "leftover.txt"))).toBe(true);
  });

  it("fails closed for an existing regular file at the worktree path", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    roots.push(root);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    writeFileSync(worktreePath, "do not delete");

    expect(() => repairExistingReviewWorktreePathForCheckout({ mirrorPath, worktreePath })).toThrow(
      /existing_non_directory/
    );
    expect(existsSync(worktreePath)).toBe(true);
  });

  it("rejects a repair target symlinked into the protected live checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-runtime-"));
    const liveCheckout = mkdtempSync(join(tmpdir(), "evaos-live-checkout-"));
    roots.push(root, liveCheckout);
    const mirrorPath = join(root, "mirror.git");
    const worktreePath = join(root, "worktree");
    execFileSync("git", ["init", "--bare", mirrorPath], { stdio: "ignore" });
    symlinkSync(liveCheckout, worktreePath, "dir");

    expect(() =>
      repairExistingReviewWorktreePathForCheckout({
        mirrorPath,
        worktreePath,
        protectedCheckoutRoot: liveCheckout
      })
    ).toThrow(/worktreePath must be outside the protected live checkout/);
    expect(existsSync(liveCheckout)).toBe(true);
  });
});
