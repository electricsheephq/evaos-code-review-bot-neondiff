import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { assertGitClean } from "../src/git.js";

describe("assertGitClean", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("fails on untracked files left by a review run", () => {
    const root = mkdtempSync(join(tmpdir(), "git-clean-"));
    roots.push(root);
    const init = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" });
    expect(init.status).toBe(0);
    writeFileSync(join(root, "left-behind.txt"), "mutation\n");

    expect(() => assertGitClean(root)).toThrow(/untracked or modified files/);
  });
});
