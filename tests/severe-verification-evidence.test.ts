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
    expect(result.complete).toBe(true); expect(result.files.map((item) => [item.path, item.kind])).toEqual([[finding, "whole_file"], [moduleA, "module"], [moduleB, "module"]]); expect(result.omitted).toEqual([]); expect(JSON.stringify(result)).not.toContain("const π");
    const digest = result.files[0].sha256; await writeFile(join(fixture, finding), "tampered\n"); expect((await collectSevereVerificationEvidence(input([moduleA, moduleB]))).files[0].sha256).toBe(digest);
  });

  it("accepts an explicit empty module set", async () => {
    const result = await collectSevereVerificationEvidence(input([])); expect(result.complete).toBe(true); expect(result.files.map((item) => item.kind)).toEqual(["whole_file"]);
  });

  it("rejects stale identity and caps hunks before hashing", async () => {
    const stringCap = await collectSevereVerificationEvidence(input([], "a".repeat(MAX_EVIDENCE_BYTES + 1))); const byteCap = await collectSevereVerificationEvidence(input([], new Uint8Array(MAX_EVIDENCE_BYTES + 1)));
    expect(stringCap.changedHunk).toEqual({ bytes: MAX_EVIDENCE_BYTES + 1, complete: false, code: "cap_exceeded" }); expect(byteCap.changedHunk).toEqual(stringCap.changedHunk);
    expect((await collectSevereVerificationEvidence(input([], new Uint8Array([0xff])))).changedHunk).toMatchObject({ complete: false, code: "evidence_incomplete" }); expect((await collectSevereVerificationEvidence(input([], "\ud800"))).changedHunk).toEqual({ bytes: 3, complete: false, code: "evidence_incomplete" });
    await expect(collectSevereVerificationEvidence({ ...input([]), expectedHeadSha: "a".repeat(40) })).rejects.toThrow("stale_head"); await expect(collectSevereVerificationEvidence({ ...input([]), pullNumber: 0 })).rejects.toThrow("invalid_identity");
  });

  it("ignores inherited repository selectors and replacement objects", async () => {
    const foreign = await mkdtemp(join(root, ".severe-foreign-")); execFileSync("git", ["init", "--quiet"], { cwd: foreign }); const prior = process.env.GIT_DIR;
    try { process.env.GIT_DIR = join(foreign, ".git"); expect((await collectSevereVerificationEvidence(input([]))).complete).toBe(true); }
    finally { if (prior === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = prior; await rm(foreign, { recursive: true, force: true }); }
    const expected = (await collectSevereVerificationEvidence(input([]))).files[0].sha256; git(["add", finding]); const replacement = git(["commit-tree", git(["write-tree"]), "-m", "replacement"]); git(["replace", head, replacement]); const priorBase = process.env.GIT_REPLACE_REF_BASE, priorNoReplace = process.env.GIT_NO_REPLACE_OBJECTS;
    try { process.env.GIT_REPLACE_REF_BASE = "refs/replace"; process.env.GIT_NO_REPLACE_OBJECTS = "0"; expect((await collectSevereVerificationEvidence(input([]))).files[0].sha256).toBe(expected); }
    finally { if (priorBase === undefined) delete process.env.GIT_REPLACE_REF_BASE; else process.env.GIT_REPLACE_REF_BASE = priorBase; if (priorNoReplace === undefined) delete process.env.GIT_NO_REPLACE_OBJECTS; else process.env.GIT_NO_REPLACE_OBJECTS = priorNoReplace; git(["replace", "-d", head]); }
  });

  it("rejects unsafe paths, non-files, duplicates, and unbounded lists", async () => {
    for (const path of ["/etc/passwd", "../outside.ts", "C:/outside.ts", "a\\b.ts", "a\u0000b.ts", "a\ud800b.ts", "src", "link.ts", finding]) await expect(collectSevereVerificationEvidence(input([path]))).rejects.toThrow();
    await expect(collectSevereVerificationEvidence(input(Array(MAX_MODULES + 1).fill(moduleA)))).rejects.toThrow("module_list");
  });

  it("records missing, invalid UTF-8, and capped blobs as omissions", async () => {
    const result = await collectSevereVerificationEvidence(input(["missing.ts", "bad.bin", "big.bin"])); expect(result.complete).toBe(false); expect(result.files.map((item) => item.path)).toEqual([finding]); expect(result.omitted).toEqual([{ path: "bad.bin", code: "evidence_incomplete" }, { path: "big.bin", code: "cap_exceeded" }, { path: "missing.ts", code: "not_read" }]);
  });
});
