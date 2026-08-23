import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { writeFinalOutput } from "../src/final-output-writer.js";

describe("descriptor-bound final output writer", () => {
  const roots: string[] = [];
  const fixture = () => {
    const root = mkdtempSync(join("/tmp", "neondiff-final-output-"));
    roots.push(root);
    mkdirSync(join(root, "nested"));
    return root;
  };

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes nested output with restrictive mode and rejects replay", () => {
    const root = fixture();
    const target = join(realpathSync(root), "nested", "result.json");
    expect(writeFinalOutput({ trustedRoot: root, relativePath: "nested/result.json", contents: "first\n" })).toBe(target);
    expect(readFileSync(target, "utf8")).toBe("first\n");
    expect(statSync(target).mode & 0o777).toBe(0o600);
    expect(() => writeFinalOutput({ trustedRoot: root, relativePath: "nested/result.json", contents: "second\n" })).toThrow(/exists|replay/);
    expect(readFileSync(target, "utf8")).toBe("first\n");
    expect(readdirSync(root).filter((name) => name.startsWith(".neondiff-final-output-")).length).toBe(0);
  });

  it("rejects symlink and hard-link final targets without touching the target", () => {
    const root = fixture();
    const outside = join(root, "outside.txt");
    const target = join(root, "nested", "result.json");
    writeFileSync(outside, "sentinel\n");
    symlinkSync(outside, target);
    expect(() => writeFinalOutput({ trustedRoot: root, relativePath: "nested/result.json", contents: "bad\n" })).toThrow(/linked|symlink/);
    expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
    rmSync(target);
    linkSync(outside, target);
    expect(() => writeFinalOutput({ trustedRoot: root, relativePath: "nested/result.json", contents: "bad\n" })).toThrow(/linked|hard/);
    expect(readFileSync(outside, "utf8")).toBe("sentinel\n");
  });

  it("detects an ancestor replacement before rename and leaves no final file", () => {
    const root = fixture();
    const outside = mkdtempSync(join("/tmp", "neondiff-final-outside-"));
    roots.push(outside);
    const parent = join(root, "nested");
    const moved = join(root, "nested-moved");
    expect(() => writeFinalOutput({
      trustedRoot: root,
      relativePath: "nested/result.json",
      contents: "bad\n",
      beforeCommit: () => { renameSync(parent, moved); symlinkSync(outside, parent); }
    })).toThrow(/ancestor|directory|symlink/);
    expect(existsSync(join(outside, "result.json"))).toBe(false);
    expect(existsSync(join(moved, "result.json"))).toBe(false);
    expect(readdirSync(root).filter((name) => name.startsWith(".neondiff-final-output-")).length).toBe(0);
  });
});
