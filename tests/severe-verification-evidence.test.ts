import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { buildFindingFingerprint } from "../src/findings.js";
import { buildSevereVerificationTransport } from "../src/severe-verification-transport.js";
import { collectSevereVerificationEvidence, MAX_EVIDENCE_BYTES, MAX_MODULES, readSevereVerificationEvidenceContents } from "../src/severe-verification-evidence.js";

const root = process.cwd(), finding = "src/π space.ts", moduleA = "lib/alpha.ts", moduleB = "lib/β.ts", bomFile = "lib/bom.ts";
let fixture = "", head = "";
const git = (args: string[]) => execFileSync("git", args, { cwd: fixture, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
const input = (relevantModulePaths: readonly string[], changedHunk: string | Uint8Array = "@@ -1 +1 @@\n+changed") => ({
  repo: "owner/repo", pullNumber: 1040, baseSha: "b".repeat(40), expectedHeadSha: head, worktreePath: fixture,
  findingPath: finding, changedHunk, relevantModulePaths
});

beforeAll(async () => {
  fixture = await mkdtemp(join(root, ".severe-evidence-")); await mkdir(join(fixture, "src")); await mkdir(join(fixture, "lib"));
  await writeFile(join(fixture, finding), "const π = 'finding';\n"); await writeFile(join(fixture, moduleA), "export const alpha = true;\n"); await writeFile(join(fixture, moduleB), "export const beta = true;\n"); await writeFile(join(fixture, bomFile), Buffer.from([0xef, 0xbb, 0xbf, 0x65, 0x78, 0x70, 0x6f, 0x72, 0x74, 0x20, 0x63, 0x6f, 0x6e, 0x73, 0x74, 0x20, 0x62, 0x6f, 0x6d, 0x20, 0x3d, 0x20, 0x74, 0x72, 0x75, 0x65, 0x3b, 0x0a]));
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

  it("transports immutable blob content when the filtered worktree differs", async () => {
    const evidence = await collectSevereVerificationEvidence(input([]));
    await writeFile(join(fixture, finding), "tampered transport content\n");
    const findingFields = { path: finding, line: 1, severity: "P1" as const, title: "Immutable verifier input", body: "Use the exact committed blob.", category: "security_boundary" as const, why_this_matters: "The verifier must not trust the filtered worktree." };
    const messages = buildSevereVerificationTransport({
      repo: "owner/repo", pullNumber: 1040, baseSha: "b".repeat(40), headSha: head,
      finding: { ...findingFields, fingerprint: buildFindingFingerprint(findingFields) }, changedHunk: "@@ -1 +1 @@\n+changed",
      evidence, files: readSevereVerificationEvidenceContents(input([]), evidence)
    });
    const payload = JSON.parse(messages[1].content);
    expect(payload.data.files[0].content).toBe("const π = 'finding';\n");
    expect(payload.data.files[0].content).not.toContain("tampered transport content");
  });

  it("preserves UTF-8 BOM bytes when decoding immutable content", async () => {
    const evidence = await collectSevereVerificationEvidence(input([bomFile]));
    const contents = readSevereVerificationEvidenceContents(input([bomFile]), evidence);
    const bom = contents.find((file) => file.path === bomFile);
    expect(bom?.content.codePointAt(0)).toBe(0xfeff);
    expect(Buffer.from(bom?.content ?? "", "utf8").subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));
    expect(bom?.content).toContain("export const bom = true;");
  });

  it("accepts an explicit empty module set", async () => {
    const result = await collectSevereVerificationEvidence(input([])); expect(result.complete).toBe(true); expect(result.files.map((item) => item.kind)).toEqual(["whole_file"]);
    const overridden = [moduleA]; Object.defineProperty(overridden, "map", { value: () => Array(MAX_MODULES + 1).fill(moduleA) }); expect((await collectSevereVerificationEvidence(input(overridden))).files.map((item) => item.path)).toEqual([finding, moduleA]);
  });

  it("rejects stale identity and caps hunks using intrinsic bytes before hashing", async () => {
    const disguised = new Uint8Array(MAX_EVIDENCE_BYTES + 1); Object.defineProperty(disguised, "byteLength", { value: 1 });
    const stringCap = await collectSevereVerificationEvidence(input([], "a".repeat(MAX_EVIDENCE_BYTES + 1))); const byteCap = await collectSevereVerificationEvidence(input([], disguised));
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

  it("does not lazily fetch missing partial-clone blobs", async () => {
    const partial = await mkdtemp(join(root, ".severe-partial-"));
    try { git(["config", "uploadpack.allowFilter", "true"]); execFileSync("git", ["clone", "--quiet", "--filter=blob:none", "--no-checkout", `file://${fixture}`, partial]); const partialHead = execFileSync("git", ["rev-parse", "HEAD"], { cwd: partial, encoding: "utf8" }).trim();
      const result = await collectSevereVerificationEvidence({ ...input([]), expectedHeadSha: partialHead, worktreePath: partial }); expect(result.files).toEqual([]); expect(result.omitted).toEqual([{ path: finding, code: "not_read" }]);
    } finally { await rm(partial, { recursive: true, force: true }); }
  });
});
