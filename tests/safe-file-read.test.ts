import {
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs";
import { execFileSync, spawnSync } from "node:child_process";
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

  it("does not block when a regular entry is swapped to a FIFO before descriptor open", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-safe-read-fifo-race-"));
    roots.push(root);
    writeFileSync(join(root, "victim"), "trusted bytes");
    const harness = String.raw`
import importlib.util
import os
import sys

spec = importlib.util.spec_from_file_location("descriptor_tree", "scripts/helpers/descriptor_tree.py")
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
original_stat = module.os.stat
swapped = False

def swapping_stat(name, *args, **kwargs):
    global swapped
    metadata = original_stat(name, *args, **kwargs)
    if name == "victim" and not swapped:
        swapped = True
        directory_fd = kwargs.get("dir_fd")
        os.unlink(name, dir_fd=directory_fd)
        os.mkfifo(os.path.join(sys.argv[1], name))
    return metadata

module.os.stat = swapping_stat
root_fd = os.open(sys.argv[1], os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
try:
    module.walk(root_fd, "")
finally:
    os.close(root_fd)
`;
    const result = spawnSync("/usr/bin/python3", ["-c", harness, root], {
      encoding: "utf8",
      timeout: 1_000
    });

    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/entry is not a regular file/);
  });

  it("preserves Python descriptor traversal diagnostics through the Node wrapper", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-safe-read-diagnostic-"));
    roots.push(root);
    execFileSync("/usr/bin/mkfifo", [join(root, "unsupported-fifo")]);
    const result = spawnSync(
      "node",
      [
        "--input-type=module",
        "-e",
        "import { walkDescriptorTree } from './scripts/shared/safe-fs.mjs'; walkDescriptorTree(process.argv.at(-1), () => {});",
        root
      ],
      { encoding: "utf8" }
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/unsupported descriptor tree entry/);
    expect(result.stderr).not.toContain("descriptor-relative tree traversal failed");
  });
});
