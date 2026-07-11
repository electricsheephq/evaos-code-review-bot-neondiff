import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { walkDescriptorTree } from "../scripts/shared/safe-fs.mjs";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("race-safe regular file reads", () => {
  it("pins every directory and file without traversing symlink components", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-safe-read-"));
    const outside = mkdtempSync(join(tmpdir(), "neondiff-safe-read-outside-"));
    roots.push(root);
    roots.push(outside);
    const regular = join(root, "regular.txt");
    const link = join(root, "link.txt");
    const escapedDirectory = join(root, "escaped-directory");
    writeFileSync(regular, "trusted bytes");
    writeFileSync(join(outside, "outside.txt"), "outside bytes");
    symlinkSync("regular.txt", link);
    symlinkSync(outside, escapedDirectory);

    const entries: Array<{ type: string; path: string; text?: string; target?: string }> = [];
    walkDescriptorTree(root, (entry) => {
      entries.push({
        type: entry.type,
        path: entry.relativePath,
        text: entry.type === "file" ? entry.data.toString("utf8") : undefined,
        target: entry.type === "symlink" ? entry.target : undefined
      });
    });

    expect(entries).toContainEqual({ type: "file", path: "regular.txt", text: "trusted bytes", target: undefined });
    expect(entries).toContainEqual({ type: "symlink", path: "link.txt", text: undefined, target: "regular.txt" });
    expect(entries).toContainEqual({ type: "symlink", path: "escaped-directory", text: undefined, target: outside });
    expect(entries.some((entry) => entry.path.includes("outside.txt"))).toBe(false);

    const bounded = spawnSync(
      "/usr/bin/python3",
      ["scripts/helpers/descriptor_tree.py", "--root", root, "--max-bytes", "5"],
      { encoding: "utf8" }
    );
    expect(bounded.status).not.toBe(0);
    expect(bounded.stderr).toMatch(/descriptor traversal bound exceeded/);
  });
});
