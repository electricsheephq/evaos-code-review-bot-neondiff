import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { planPullWorktreePaths } from "../src/git.js";

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
});
