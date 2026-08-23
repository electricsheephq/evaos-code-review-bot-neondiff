import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_SEVERE_EVIDENCE_FILE_BYTES, parseSevereVerificationReceipt, type SevereVerificationReceipt } from "./severe-verification-receipt.js";

export interface SevereVerificationEvidenceSubject {
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
  findingFingerprint: string;
  path: string;
}

export interface SevereVerificationEvidenceRead {
  subject: SevereVerificationEvidenceSubject;
  content: string;
  evidence: SevereVerificationReceipt["evidence"];
}

export function readSevereVerificationEvidence(worktreePath: string, subject: SevereVerificationEvidenceSubject): SevereVerificationEvidenceRead {
  assertSafeRelativePath(subject.path);
  const root = resolve(worktreePath);
  const candidate = resolve(root, subject.path);
  assertContained(root, candidate, "lexical");
  assertNoSymlinkComponents(root, subject.path);
  const realRoot = realpathSync.native(root);
  const realCandidate = realpathSync.native(candidate);
  assertContained(realRoot, realCandidate, "real");
  const bytes = readBoundedRegularFile(candidate);
  let content: string;
  try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes); } catch { throw new Error("severe_evidence_malformed"); }
  const evidence = { files: [{ path: subject.path, kind: "whole_file" as const, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.byteLength, complete: true }], omitted: [], complete: true };
  parseSevereVerificationReceipt({
    schemaVersion: "severe-verifier-v1", repo: subject.repo, pullNumber: subject.pullNumber, baseSha: subject.baseSha,
    findingFingerprint: subject.findingFingerprint, headSha: subject.headSha, state: "confirmed", disposition: "retain", evidence
  }, { expectedRepo: subject.repo, expectedPullNumber: subject.pullNumber, expectedBaseSha: subject.baseSha, expectedHeadSha: subject.headSha, expectedFindingFingerprint: subject.findingFingerprint, expectedPath: subject.path });
  return { subject: { ...subject }, content, evidence };
}

function assertSafeRelativePath(path: string): void {
  if (!path || Buffer.byteLength(path, "utf8") > 4096 || path.startsWith("/") || /^[A-Za-z]:/.test(path) || /[\\\0\r\n]/.test(path) || path.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new Error("severe_evidence_incomplete");
  }
}

function assertContained(root: string, candidate: string, kind: string): void {
  const rel = relative(root, candidate);
  if (!rel || rel === ".." || rel.startsWith(".." + sep) || isAbsolute(rel)) throw new Error("severe_evidence_incomplete:" + kind);
}

function assertNoSymlinkComponents(root: string, requestedPath: string): void {
  let current = root;
  const parts = requestedPath.split("/");
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    let stat;
    try { stat = lstatSync(current); } catch { throw new Error("severe_evidence_incomplete"); }
    if (stat.isSymbolicLink() || (index < parts.length - 1 && !stat.isDirectory())) throw new Error("severe_evidence_incomplete");
  }
}

function readBoundedRegularFile(path: string): Uint8Array {
  const descriptor = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(descriptor);
    if (!before.isFile()) throw new Error("severe_evidence_incomplete");
    if (before.size > MAX_SEVERE_EVIDENCE_FILE_BYTES) throw new Error("severe_evidence_cap_exceeded");
    const bytes = Buffer.alloc(before.size);
    let offset = 0;
    while (offset < bytes.byteLength) {
      const count = readSync(descriptor, bytes, offset, bytes.byteLength - offset, offset);
      if (count === 0) throw new Error("severe_evidence_incomplete");
      offset += count;
    }
    const after = fstatSync(descriptor);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) throw new Error("severe_evidence_incomplete");
    return bytes;
  } finally { closeSync(descriptor); }
}
