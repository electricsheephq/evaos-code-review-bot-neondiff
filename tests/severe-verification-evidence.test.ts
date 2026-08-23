import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MAX_SEVERE_EVIDENCE_FILE_BYTES, parseSevereVerificationReceipt } from "../src/severe-verification-receipt.js";
import { readSevereVerificationEvidence, type SevereVerificationEvidenceSubject } from "../src/severe-verification-evidence.js";

const subject = (path: string): SevereVerificationEvidenceSubject => ({ repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: "finding:" + "f".repeat(64), path });

describe("severe verification exact evidence read", () => {
  it("binds identity, bytes, digest, completeness, and decoded content", () => {
    const root = mkdtempSync(join("/tmp", "severe-evidence-")), path = "space dir/plus+λ/..hidden/file.ts", content = "const π = 1;\n";
    try {
      mkdirSync(join(root, "space dir/plus+λ/..hidden"), { recursive: true });
      writeFileSync(join(root, path), content);
      const result = readSevereVerificationEvidence(root, subject(path));
      expect(result.subject).toEqual(subject(path));
      expect(result.content).toBe(content);
      expect(result.evidence).toEqual({ files: [{ path, kind: "whole_file", sha256: createHash("sha256").update(content).digest("hex"), bytes: Buffer.byteLength(content), complete: true }], omitted: [], complete: true });
      const parsed = parseSevereVerificationReceipt({ schemaVersion: "severe-verifier-v1", repo: result.subject.repo, pullNumber: result.subject.pullNumber, baseSha: result.subject.baseSha, findingFingerprint: result.subject.findingFingerprint, headSha: result.subject.headSha, state: "confirmed", disposition: "retain", evidence: result.evidence }, { expectedPath: path });
      expect(parsed.findingFingerprint).toBe(result.subject.findingFingerprint);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("allows long contained paths but rejects lexical escapes and prefix lookalikes", () => {
    const root = mkdtempSync(join("/tmp", "severe-evidence-")), parts = Array.from({ length: 20 }, (_, i) => "segment" + i), path = parts.join("/") + "/file.ts";
    try {
      mkdirSync(join(root, parts.join("/")), { recursive: true });
      writeFileSync(join(root, path), "safe");
      expect(readSevereVerificationEvidence(root, subject(path)).content).toBe("safe");
      for (const unsafe of ["../" + root.split("/").pop() + "-evil/file.ts", "../file.ts", "dir/../file.ts", "./file.ts", "dir//file.ts", "/tmp/file.ts", "C:/file.ts", "dir\\file.ts", "dir/" + String.fromCharCode(0) + "x.ts", "dir/\nx.ts"]) {
        expect(() => readSevereVerificationEvidence(root, subject(unsafe))).toThrow("severe_evidence_incomplete");
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("rejects every symlink component, missing/non-file paths, invalid UTF-8, and oversized files", () => {
    const root = mkdtempSync(join("/tmp", "severe-evidence-")), outside = mkdtempSync(join("/tmp", "severe-outside-"));
    try {
      mkdirSync(join(root, "real/dir"), { recursive: true });
      writeFileSync(join(root, "real/file.ts"), "same");
      writeFileSync(join(outside, "file.ts"), "same");
      symlinkSync(join(root, "real/file.ts"), join(root, "inside-link.ts"));
      symlinkSync(join(outside, "file.ts"), join(root, "outside-link.ts"));
      symlinkSync(join(root, "real"), join(root, "dir-link"));
      for (const path of ["inside-link.ts", "outside-link.ts", "dir-link/file.ts", "missing.ts", "real", "real/missing.ts"]) expect(() => readSevereVerificationEvidence(root, subject(path))).toThrow("severe_evidence_incomplete");
      writeFileSync(join(root, "invalid.ts"), Buffer.from([0xff, 0xfe]));
      expect(() => readSevereVerificationEvidence(root, subject("invalid.ts"))).toThrow("severe_evidence_malformed");
      writeFileSync(join(root, "large.ts"), Buffer.alloc(MAX_SEVERE_EVIDENCE_FILE_BYTES + 1));
      expect(() => readSevereVerificationEvidence(root, subject("large.ts"))).toThrow("severe_evidence_cap_exceeded");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });
});
