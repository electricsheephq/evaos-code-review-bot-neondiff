import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { collectSevereVerificationEvidence, MAX_EVIDENCE_BYTES, MAX_MODULES } from "../src/severe-verification-evidence.js";

const root = process.cwd(), finding = "src/π space.ts", moduleA = "lib/alpha.ts", moduleB = "lib/β.ts";
let fixture = "", head = "";
const git = (args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const input = (relevantModulePaths: readonly string[], changedHunk: string | Uint8Array = "@@ -1 +1 @@\n+changed") => ({
  repo: "owner/repo", pullNumber: 1040, baseSha: "b".repeat(40), expectedHeadSha: head, worktreePath: fixture,
  findingPath: finding, changedHunk, relevantModulePaths
});

beforeAll(async () => {
  fixture = await mkdtemp(join(root, ".severe-evidence-")); await mkdir(join(fixture, "src")); await mkdir(join(fixture, "lib"));
  await writeFile(join(fixture, finding), "const π = 'finding';\n"); await writeFile(join(fixture, moduleA), "export const alpha = true;\n"); await writeFile(join(fixture, moduleB), "export const beta = true;\n");
  await writeFile(join(fixture, "bad.bin"), Buffer.from([0xff, 0xfe])); await writeFile(join(fixture, "big.bin"), Buffer.alloc(MAX_EVIDENCE_BYTES + 1, 65)); await symlink("src/π space.ts", join(fixture, "link.ts"));
  execFileSync("git", ["init", "--quiet"], { cwd: fixture }); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "NeonDiff test"]); git(["add", "."]); git(["commit", "--quiet", "-m", "fixture"]); head = git(["rev-parse", "HEAD"]);
});
afterAll(async () => { await rm(fixture, { recursive: true, force: true }); });

describe("exact-head severe evidence collection", () => {
  it("is deterministic, metadata-only, multi-file, and immutable", async () => {
    const result = await collectSevereVerificationEvidence(input([moduleB, moduleA]));
    expect(result.complete).toBe(true); expect(result.changedHunk).toMatchObject({ bytes: 20, complete: true });
    expect(result.files.map((item) => [item.path, item.kind])).toEqual([[finding, "whole_file"], [moduleA, "module"], [moduleB, "module"]]); expect(result.omitted).toEqual([]); expect(JSON.stringify(result)).not.toContain("const π");
    const digest = result.files[0].sha256; await writeFile(join(fixture, finding), "tampered\n"); expect((await collectSevereVerificationEvidence(input([moduleA, moduleB]))).files[0].sha256).toBe(digest);
  });

  it("rejects stale or invalid identity and reports hunk omissions", async () => {
    expect((await collectSevereVerificationEvidence(input([moduleA], new TextEncoder().encode("@@ bytes")))).complete).toBe(true);
    expect((await collectSevereVerificationEvidence(input([moduleA], new Uint8Array([0xff])))).changedHunk).toMatchObject({ complete: false, code: "evidence_incomplete" });
    expect((await collectSevereVerificationEvidence(input([moduleA], new Uint8Array(MAX_EVIDENCE_BYTES + 1)))).changedHunk.code).toBe("cap_exceeded"); expect((await collectSevereVerificationEvidence(input([moduleA], "\ud800"))).changedHunk).toMatchObject({ complete: false, code: "evidence_incomplete" });
    await expect(collectSevereVerificationEvidence({ ...input([moduleA]), expectedHeadSha: "a".repeat(40) })).rejects.toThrow("stale_head"); await expect(collectSevereVerificationEvidence({ ...input([moduleA]), pullNumber: 0 })).rejects.toThrow("invalid_identity");
  });

  it("rejects unsafe paths, symlinks, non-files, duplicates, and unbounded lists", async () => {
    for (const path of ["/etc/passwd", "../outside.ts", "C:/outside.ts", "a\\b.ts", "a\u0000b.ts", "a\ud800b.ts", "src", "link.ts", finding]) await expect(collectSevereVerificationEvidence(input([path]))).rejects.toThrow();
    await expect(collectSevereVerificationEvidence(input(Array(MAX_MODULES + 1).fill(moduleA)))).rejects.toThrow("module_list");
  });

  it("records missing, invalid UTF-8, and capped blobs as explicit omissions", async () => {
    const result = await collectSevereVerificationEvidence(input(["missing.ts", "bad.bin", "big.bin"]));
    expect(result.complete).toBe(false); expect(result.files.map((item) => item.path)).toEqual([finding]); expect(result.omitted).toEqual([{ path: "bad.bin", code: "evidence_incomplete" }, { path: "big.bin", code: "cap_exceeded" }, { path: "missing.ts", code: "not_read" }]);
  });
});
