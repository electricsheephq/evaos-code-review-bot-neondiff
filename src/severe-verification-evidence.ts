import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import type { SevereVerificationCode, SevereVerificationEvidenceFile } from "./severe-verification-receipt-schema.js";

export const MAX_EVIDENCE_BYTES = 65_536;
export const MAX_MODULES = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });
type OmissionCode = SevereVerificationCode;

export interface SevereVerificationEvidenceInput {
  repo: string; pullNumber: number; baseSha: string; expectedHeadSha: string; worktreePath: string;
  findingPath: string; changedHunk: string | Uint8Array; relevantModulePaths: readonly string[];
}
export interface ChangedHunkMetadata { sha256: string; bytes: number; complete: boolean; code?: OmissionCode; }
export interface SevereVerificationEvidenceResult {
  changedHunk: ChangedHunkMetadata; files: SevereVerificationEvidenceFile[];
  omitted: { path: string; code: OmissionCode }[]; complete: boolean;
}
type TreeEntry = { mode: string; type: string; object: string; bytes: number };

/** Exact-head, bounded, metadata-only evidence; source bytes come only from immutable Git blobs. */
export async function collectSevereVerificationEvidence(input: SevereVerificationEvidenceInput): Promise<SevereVerificationEvidenceResult> {
  verifyIdentity(input);
  const gitDir = verifyHead(input.expectedHeadSha, input.worktreePath);
  const finding = safePath(input.findingPath);
  if (!Array.isArray(input.relevantModulePaths) || input.relevantModulePaths.length === 0 || input.relevantModulePaths.length > MAX_MODULES) throw new Error("module_list");
  const modules = input.relevantModulePaths.map(safePath);
  if (new Set(modules).size !== modules.length || modules.includes(finding)) throw new Error("module_list");
  const changedHunk = hunkMetadata(input.changedHunk);
  const files: SevereVerificationEvidenceFile[] = [], omitted: { path: string; code: OmissionCode }[] = [];
  const add = (path: string, kind: "whole_file" | "module") => {
    const result = inspectFile(gitDir, input.expectedHeadSha, path, kind);
    if ("file" in result) files.push(result.file); else omitted.push(result.omission);
  };
  add(finding, "whole_file");
  for (const path of [...modules].sort(compareText)) add(path, "module");
  return { changedHunk, files, omitted, complete: changedHunk.complete && !omitted.length && files.length === modules.length + 1 };
}

function verifyIdentity(input: SevereVerificationEvidenceInput): void {
  const repo = /^(?![^/]*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
  if (!input || typeof input !== "object" || !repo.test(input.repo) || !Number.isSafeInteger(input.pullNumber) || input.pullNumber < 1 || !/^[a-f0-9]{40}$/.test(input.baseSha)) throw new Error("invalid_identity");
}

function verifyHead(expected: string, worktree: string): string {
  if (!/^[a-f0-9]{40}$/.test(expected) || typeof worktree !== "string" || !isAbsolute(worktree)) throw new Error("invalid_head");
  let lines: string[];
  try {
    const output = execFileSync("git", ["rev-parse", "--path-format=absolute", "HEAD", "--git-dir"], { cwd: worktree, encoding: "buffer", stdio: ["ignore", "pipe", "ignore"] }) as Buffer;
    lines = output.toString("utf8").trimEnd().split("\n");
  } catch { throw new Error("head_unavailable"); }
  if (lines[0] !== expected) throw new Error("stale_head");
  if (!lines[1] || !isAbsolute(lines[1])) throw new Error("head_unavailable");
  return lines[1];
}

function safePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value) || /^[A-Za-z]:/.test(value) || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f-\u009f]/.test(value) || [...value].some((char) => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; }) || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe_path");
  return value;
}

function inspectFile(gitDir: string, head: string, path: string, kind: "whole_file" | "module"):
  { file: SevereVerificationEvidenceFile } | { omission: { path: string; code: OmissionCode } } {
  let entry: TreeEntry | undefined;
  try { entry = treeEntry(gitDir, head, path); } catch { return { omission: { path, code: "not_read" } }; }
  if (!entry) return { omission: { path, code: "not_read" } };
  if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) throw new Error("not_file");
  if (!Number.isSafeInteger(entry.bytes) || entry.bytes > MAX_EVIDENCE_BYTES) return { omission: { path, code: "cap_exceeded" } };
  let data: Buffer;
  try { data = execFileSync("git", ["--git-dir", gitDir, "cat-file", "blob", entry.object], { encoding: "buffer", maxBuffer: MAX_EVIDENCE_BYTES + 1, stdio: ["ignore", "pipe", "ignore"] }) as Buffer; }
  catch { return { omission: { path, code: "not_read" } };
  }
  if (data.length > MAX_EVIDENCE_BYTES) return { omission: { path, code: "cap_exceeded" } };
  try { decoder.decode(data); } catch { return { omission: { path, code: "evidence_incomplete" } }; }
  return { file: { path, kind, sha256: hash(data), bytes: data.length, complete: true } };
}

function treeEntry(gitDir: string, head: string, path: string): TreeEntry | undefined {
  const raw = execFileSync("git", ["--git-dir", gitDir, "ls-tree", "--full-tree", "-z", "-l", head, "--", `:(literal)${path}`], { encoding: "buffer", maxBuffer: 16_384, stdio: ["ignore", "pipe", "ignore"] }) as Buffer;
  if (!raw.length) return undefined;
  const end = raw.indexOf(0), tab = raw.indexOf(9);
  if (end < 1 || tab < 1 || end !== raw.length - 1 || tab > end) throw new Error("not_file");
  const [mode, type, object, size] = raw.subarray(0, tab).toString("ascii").trim().split(/\s+/);
  const actualPath = decoder.decode(raw.subarray(tab + 1, end));
  if (actualPath !== path || !/^[a-f0-9]{40}$/.test(object)) throw new Error("not_file");
  return { mode, type, object, bytes: Number(size) };
}

function hunkMetadata(value: string | Uint8Array): ChangedHunkMetadata {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("hunk_invalid");
  const invalidString = typeof value === "string" && [...value].some((char) => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; });
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const metadata: ChangedHunkMetadata = { sha256: hash(data), bytes: data.length, complete: data.length > 0 && data.length <= MAX_EVIDENCE_BYTES };
  if (!data.length) return { ...metadata, code: "not_read" };
  if (data.length > MAX_EVIDENCE_BYTES) return { ...metadata, code: "cap_exceeded" };
  if (invalidString) return { ...metadata, complete: false, code: "evidence_incomplete" };
  try { decoder.decode(data); } catch { return { ...metadata, complete: false, code: "evidence_incomplete" }; }
  return metadata;
}

function hash(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
