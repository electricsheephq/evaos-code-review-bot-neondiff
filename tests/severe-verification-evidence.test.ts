import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectSevereVerificationEvidence, MAX_EVIDENCE_BYTES, MAX_MODULES } from "../src/severe-verification-evidence.js";

const root = process.cwd();
let fixture = "";
let head = "";
const finding = "src/π space.ts";
const moduleA = "lib/alpha.ts";
const moduleB = "lib/β.ts";
const input = (relevantModulePaths: readonly string[], changedHunk: string | Uint8Array = "@@ -1 +1 @@\n+changed") => ({
  expectedHeadSha: head, worktreePath: root, findingPath: finding, changedHunk, relevantModulePaths
});

beforeAll(async () => {
  fixture = await mkdtemp(join(root, ".severe-evidence-"));
  await mkdir(join(fixture, "src"));
  await mkdir(join(fixture, "lib"));
  await writeFile(join(fixture, finding), "const π = 'finding';\n");
  await writeFile(join(fixture, moduleA), "export const alpha = true;\n");
  await writeFile(join(fixture, moduleB), "export const beta = true;\n");
  await writeFile(join(fixture, "bad.bin"), Buffer.from([0xff, 0xfe]));
  await writeFile(join(fixture, "big.bin"), Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 65));
  head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

describe("exact-head severe evidence collection", () => {
  it("returns deterministic metadata for the hunk, finding, and explicit modules", async () => {
    const modules = [moduleB, moduleA];
    const result = await collectSevereVerificationEvidence({ ...input(modules), worktreePath: fixture });
    expect(result.complete).toBe(true);
    expect(result.changedHunk).toMatchObject({ bytes: 20, complete: true });
    expect(result.files.map((item) => [item.path, item.kind])).toEqual([
      [finding, "whole_file"], [moduleA, "module"], [moduleB, "module"]
    ]);
    expect(result.files.every((item) => /^[a-f0-9]{64}$/.test(item.sha256) && item.complete)).toBe(true);
    expect(result.omitted).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("const π");
    expect(JSON.stringify(result)).not.toContain("+changed");
    expect(modules).toEqual([moduleB, moduleA]);
    const repeated = await collectSevereVerificationEvidence({ ...input([moduleA, moduleB]), worktreePath: fixture });
    expect(repeated).toEqual(result);
  });

  it("accepts UTF-8 bytes and fails closed on a stale head before reads", async () => {
    const bytes = new TextEncoder().encode("@@ bytes");
    expect((await collectSevereVerificationEvidence({ ...input([moduleA], bytes), worktreePath: fixture })).complete).toBe(true);
    const invalid = await collectSevereVerificationEvidence({ ...input([moduleA], new Uint8Array([0xff])), worktreePath: fixture });
    expect(invalid.changedHunk).toMatchObject({ complete: false, code: "evidence_incomplete" });
    const capped = await collectSevereVerificationEvidence({ ...input([moduleA], new Uint8Array(MAX_EVIDENCE_BYTES + 1)), worktreePath: fixture });
    expect(capped.changedHunk).toMatchObject({ complete: false, code: "cap_exceeded" });
    await expect(collectSevereVerificationEvidence({ ...input([moduleA]), expectedHeadSha: "a".repeat(40), worktreePath: fixture }))
      .rejects.toThrow("stale_head");
  });

  it("rejects unsafe paths, symlinks, directories, duplicate finding modules, and unbounded lists", async () => {
    await symlink(join(fixture, finding), join(fixture, "link.ts"));
    for (const path of ["/etc/passwd", "../outside.ts", "C:/outside.ts", "a\\b.ts", "a\u0000b.ts", "a\ud800b.ts", "src", "link.ts", finding]) {
      await expect(collectSevereVerificationEvidence({ ...input([path]), worktreePath: fixture })).rejects.toThrow();
    }
    await expect(collectSevereVerificationEvidence({ ...input(Array(MAX_MODULES + 1).fill(moduleA)), worktreePath: fixture }))
      .rejects.toThrow("module_list");
  });

  it("records invalid UTF-8, missing, and capped artifacts as explicit omissions", async () => {
    const result = await collectSevereVerificationEvidence({ ...input(["missing.ts", "bad.bin", "big.bin"]), worktreePath: fixture });
    expect(result.complete).toBe(false);
    expect(result.files.map((item) => item.path)).toEqual([finding]);
    expect(result.omitted).toEqual([
      { path: "bad.bin", code: "evidence_incomplete" },
      { path: "big.bin", code: "cap_exceeded" },
      { path: "missing.ts", code: "not_read" }
    ]);
  });
});
