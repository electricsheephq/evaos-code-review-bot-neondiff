import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import type { SevereVerificationCode, SevereVerificationEvidenceFile } from "./severe-verification-receipt-schema.js";

export const MAX_EVIDENCE_BYTES = 65_536;
export const MAX_MODULES = 16;
const decoder = new TextDecoder("utf-8", { fatal: true });
type OmissionCode = SevereVerificationCode;

export interface SevereVerificationEvidenceInput {
  expectedHeadSha: string;
  worktreePath: string;
  findingPath: string;
  changedHunk: string | Uint8Array;
  relevantModulePaths: readonly string[];
}
export interface ChangedHunkMetadata { sha256: string; bytes: number; complete: boolean; code?: OmissionCode; }
export interface SevereVerificationEvidenceResult {
  changedHunk: ChangedHunkMetadata;
  files: SevereVerificationEvidenceFile[];
  omitted: { path: string; code: OmissionCode }[];
  complete: boolean;
}

/** Collect exact-head, bounded, metadata-only evidence. This module has no worker/provider call sites. */
export async function collectSevereVerificationEvidence(input: SevereVerificationEvidenceInput): Promise<SevereVerificationEvidenceResult> {
  verifyHead(input.expectedHeadSha, input.worktreePath);
  const root = await realpath(input.worktreePath).catch(() => { throw new Error("head_unavailable"); });
  const finding = safePath(input.findingPath);
  if (!Array.isArray(input.relevantModulePaths) || input.relevantModulePaths.length === 0 || input.relevantModulePaths.length > MAX_MODULES) {
    throw new Error("module_list");
  }
  const modules = input.relevantModulePaths.map(safePath);
  if (new Set(modules).size !== modules.length || modules.includes(finding)) throw new Error("module_list");
  const changedHunk = hunkMetadata(input.changedHunk);
  const files: SevereVerificationEvidenceFile[] = [];
  const omitted: { path: string; code: OmissionCode }[] = [];
  const add = async (path: string, kind: "whole_file" | "module") => {
    const result = await inspectFile(root, path, kind);
    if (result.file) files.push(result.file); else omitted.push(result.omission);
  };
  await add(finding, "whole_file");
  for (const path of [...modules].sort(compareText)) await add(path, "module");
  return { changedHunk, files, omitted, complete: changedHunk.complete && !omitted.length && files.length === modules.length + 1 };
}

function verifyHead(expected: string, worktree: string): void {
  if (!/^[a-f0-9]{40}$/.test(expected) || typeof worktree !== "string" || !isAbsolute(worktree)) throw new Error("invalid_head");
  let actual: string;
  try { actual = execFileSync("git", ["rev-parse", "HEAD"], { cwd: worktree, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim(); }
  catch { throw new Error("head_unavailable"); }
  if (actual !== expected) throw new Error("stale_head");
}

function safePath(value: string): string {
  if (typeof value !== "string" || !value || value.length > 4096 || isAbsolute(value) || /^[A-Za-z]:/.test(value)
    || value.includes("\\") || value.includes("//") || /[\u0000-\u001f\u007f-\u009f]/.test(value)
    || [...value].some((char) => { const code = char.codePointAt(0)!; return code >= 0xd800 && code <= 0xdfff; })
    || value.split("/").some((part) => !part || part === "." || part === "..")) throw new Error("unsafe_path");
  return value;
}

async function inspectFile(root: string, path: string, kind: "whole_file" | "module") {
  try {
    const candidate = resolve(root, path);
    const actual = await realpath(candidate);
    if (actual !== root && !actual.startsWith(`${root}${sep}`)) throw new Error("out_of_root");
    let cursor = root;
    for (const part of path.split("/")) {
      cursor = join(cursor, part);
      if ((await lstat(cursor)).isSymbolicLink()) throw new Error("not_file");
    }
    const stats = await lstat(candidate);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("not_file");
    if (stats.size > MAX_EVIDENCE_BYTES) return { omission: { path, code: "cap_exceeded" as const } };
    const data = await readFile(candidate);
    if (data.length > MAX_EVIDENCE_BYTES) return { omission: { path, code: "cap_exceeded" as const } };
    try { decoder.decode(data); } catch { return { omission: { path, code: "evidence_incomplete" as const } }; }
    return { file: { path, kind, sha256: hash(data), bytes: data.length, complete: true } };
  } catch (error) {
    if (error instanceof Error && ["out_of_root", "not_file", "unsafe_path"].includes(error.message)) throw error;
    return { omission: { path, code: "not_read" as const } };
  }
}

function hunkMetadata(value: string | Uint8Array): ChangedHunkMetadata {
  if (typeof value !== "string" && !(value instanceof Uint8Array)) throw new Error("hunk_invalid");
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : Buffer.from(value);
  const metadata: ChangedHunkMetadata = { sha256: hash(data), bytes: data.length, complete: data.length > 0 && data.length <= MAX_EVIDENCE_BYTES };
  if (!data.length) return { ...metadata, complete: false, code: "not_read" };
  if (data.length > MAX_EVIDENCE_BYTES) return { ...metadata, complete: false, code: "cap_exceeded" };
  try { decoder.decode(data); } catch { return { ...metadata, complete: false, code: "evidence_incomplete" }; }
  return metadata;
}

function hash(data: Uint8Array): string { return createHash("sha256").update(data).digest("hex"); }
function compareText(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
