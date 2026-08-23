import { describe, expect, it } from "vitest";
import {
  canonicalizeSevereVerificationReceipt,
  idempotencyKey,
  isSevereVerificationReceipt,
  parseSevereVerificationReceipt,
  severeVerificationDigest,
  type SevereHostSubject
} from "../src/severe-verification-contract.js";

const subject: SevereHostSubject = {
  repo: "owner/repo",
  pull: 7,
  base: "b".repeat(40),
  head: "a".repeat(40),
  fingerprint: `finding:${"f".repeat(64)}`,
  path: "src/Δ file.ts",
  line: 12,
  side: "RIGHT",
  lineSha256: "d".repeat(64),
  hunkSha256: "e".repeat(64)
};

const file = (overrides: Record<string, unknown> = {}) => ({
  path: subject.path,
  kind: "module",
  sha256: "c".repeat(64),
  bytes: 42,
  complete: true,
  lineStart: 10,
  lineEnd: 14,
  ...overrides
});

const evidence = (overrides: Record<string, unknown> = {}) => ({
  schema: "severe-evidence/v2",
  files: [file()],
  omissions: [],
  complete: true,
  ...overrides
});

const receipt = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  schema: "severe-verifier-receipt/v2",
  subject,
  state: "confirmed",
  disposition: "retain",
  confidence: 0.9,
  evidence: evidence(),
  ...overrides
});

describe("severe verifier v2 contract", () => {
  it("accepts a completed host-bound module receipt", () => {
    const parsed = parseSevereVerificationReceipt(receipt(), subject);
    expect(parsed.subject).toEqual(subject);
    expect(parsed.evidence.complete).toBe(true);
  });

  it("rejects spoofing, coercion, arrays, unknown keys, and invalid canonical identity", () => {
    expect(isSevereVerificationReceipt(receipt({ subject: { ...subject, fingerprint: `finding:${"0".repeat(64)}` } }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ subject: { ...subject, pull: "7" } }), subject)).toBe(false);
    expect(isSevereVerificationReceipt([] as unknown, subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ extra: true }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ subject: new String("spoof") }), subject)).toBe(false);
    for (const badPath of ["../x.ts", "src/./x.ts", "/tmp/x.ts", "C:/x.ts", "src\\x.ts", "src/\0x.ts", "src/\nx.ts", `src/${"é".repeat(130)}.ts`, "src/\ud800.ts", "src/e\u0301.ts"]) {
      expect(isSevereVerificationReceipt(receipt({ subject: { ...subject, path: badPath }, evidence: evidence({ files: [file({ path: badPath })] }) }), { ...subject, path: badPath })).toBe(false);
    }
    for (const badRepo of ["../repo", "owner/../repo", "Owner/repo", "own er/repo", "owner\\repo", "é/repo", "owner/"]) {
      expect(isSevereVerificationReceipt(receipt({ subject: { ...subject, repo: badRepo } }), { ...subject, repo: badRepo })).toBe(false);
    }
  });

  it("rejects duplicate/conflicting paths and file/omission overlap", () => {
    expect(isSevereVerificationReceipt(receipt({ evidence: evidence({ files: [file(), file({ sha256: "0".repeat(64) })] }) }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "incomplete", disposition: "suppress", reasonCode: "incomplete", evidence: evidence({ files: [file({ complete: false })], omissions: [{ path: subject.path, code: "incomplete" }], complete: false }) }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "incomplete", disposition: "suppress", reasonCode: "incomplete", evidence: evidence({ files: [], omissions: [{ path: subject.path, code: "incomplete" }, { path: subject.path, code: "not_read" }], complete: false }) }), subject)).toBe(false);
  });

  it("rejects zero-byte, incomplete, oversized, out-of-range, and non-covering modules", () => {
    for (const bad of [
      { bytes: 0 },
      { bytes: 64 * 1024 + 1 },
      { complete: false },
      { lineStart: 13, lineEnd: 11 },
      { lineStart: 13, lineEnd: 20 },
      { lineStart: 1, lineEnd: 11 }
    ]) {
      expect(isSevereVerificationReceipt(receipt({ evidence: evidence({ files: [file(bad)] }) }), subject)).toBe(false);
    }
    expect(isSevereVerificationReceipt(receipt({ evidence: evidence({ files: [file({ kind: "whole_file", lineStart: 10, lineEnd: 14 })] }) }), subject)).toBe(false);
  });

  it("requires explicit state, disposition, reason, and omission compatibility", () => {
    const failures: Array<[string, string, string]> = [
      ["failed", "provider_unavailable", "provider_unavailable"],
      ["malformed", "schema_invalid", "schema_invalid"],
      ["timeout", "timeout", "timeout"],
      ["unavailable", "unavailable", "unavailable"],
      ["stale_head", "identity_mismatch", "identity_mismatch"],
      ["incomplete", "cap_exceeded", "cap_exceeded"]
    ];
    for (const [state, reasonCode, omissionCode] of failures) {
      const value = receipt({ state, disposition: "suppress", reasonCode, evidence: evidence({ files: [], omissions: [{ path: subject.path, code: omissionCode }], complete: false }) });
      expect(parseSevereVerificationReceipt(value, subject).state).toBe(state);
    }
    expect(isSevereVerificationReceipt(receipt({ state: "confirmed", disposition: "suppress" }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "failed", disposition: "suppress", reasonCode: "timeout", evidence: evidence({ files: [], omissions: [{ path: subject.path, code: "timeout" }], complete: false }) }), subject)).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "incomplete", disposition: "retain", reasonCode: "incomplete", evidence: evidence({ files: [], omissions: [{ path: subject.path, code: "incomplete" }], complete: false }) }), subject)).toBe(false);
  });

  it("uses a stable canonical digest and idempotency key", () => {
    const a = receipt();
    const b = { evidence: a.evidence, confidence: a.confidence, disposition: a.disposition, state: a.state, subject: a.subject, schema: a.schema };
    expect(canonicalizeSevereVerificationReceipt(a, subject)).toBe(canonicalizeSevereVerificationReceipt(b, subject));
    expect(severeVerificationDigest(a, subject)).toBe(severeVerificationDigest(b, subject));
    expect(idempotencyKey(a, subject)).toBe(idempotencyKey(b, subject));
    expect(severeVerificationDigest(receipt({ confidence: 0.8 }), subject)).not.toBe(severeVerificationDigest(a, subject));
  });

  it("is order-independent for the validated evidence set", () => {
    const other = file({ path: "src/other.ts", sha256: "1".repeat(64), lineStart: 1, lineEnd: 20 });
    const omitted = { path: "src/omitted.ts", code: "incomplete" };
    const omittedAgain = { path: "src/omitted-again.ts", code: "incomplete" };
    const a = receipt({
      state: "incomplete",
      disposition: "suppress",
      reasonCode: "incomplete",
      evidence: evidence({ files: [file({ complete: false }), other], omissions: [omitted, omittedAgain], complete: false })
    });
    const b = receipt({
      state: "incomplete",
      disposition: "suppress",
      reasonCode: "incomplete",
      evidence: evidence({ files: [other, file({ complete: false })], omissions: [omittedAgain, omitted], complete: false })
    });
    expect(severeVerificationDigest(a, subject)).toBe(severeVerificationDigest(b, subject));
    expect(idempotencyKey(a, subject)).toBe(idempotencyKey(b, subject));
  });

  it("rejects non-enumerable and accessor fields before canonicalization", () => {
    const hidden = { ...subject } as Record<string, unknown>;
    Object.defineProperty(hidden, "lineSha256", { value: subject.lineSha256, enumerable: false });
    expect(isSevereVerificationReceipt(receipt({ subject: hidden }), subject)).toBe(false);

    const accessor = { ...subject } as Record<string, unknown>;
    Object.defineProperty(accessor, "repo", { enumerable: true, get: () => subject.repo });
    expect(isSevereVerificationReceipt(receipt({ subject: accessor }), subject)).toBe(false);

    const hiddenConfidence = receipt();
    Object.defineProperty(hiddenConfidence, "confidence", { value: 0.9, enumerable: false });
    expect(isSevereVerificationReceipt(hiddenConfidence, subject)).toBe(false);
  });

  it("rejects Unicode line separators and paths over the UTF-8 byte cap", () => {
    for (const separator of ["\u2028", "\u2029"]) {
      const badPath = "src/" + separator + "record.ts";
      const badSubject = { ...subject, path: badPath };
      expect(isSevereVerificationReceipt(receipt({ subject: badSubject, evidence: evidence({ files: [file({ path: badPath })] }) }), badSubject)).toBe(false);
    }
    const oversizedPath = Array.from({ length: 17 }, () => "é".repeat(127)).join("/");
    expect(oversizedPath.length).toBeLessThan(4096);
    expect(Buffer.byteLength(oversizedPath, "utf8")).toBeGreaterThan(4096);
    const badSubject = { ...subject, path: oversizedPath };
    expect(isSevereVerificationReceipt(receipt({ subject: badSubject, evidence: evidence({ files: [file({ path: oversizedPath })] }) }), badSubject)).toBe(false);
  });

  it("rejects oversized evidence arrays before traversing their entries", () => {
    const files = new Array(65) as Array<unknown>;
    Object.defineProperty(files, 0, { enumerable: true, get: () => { throw new Error("entry traversed"); } });
    expect(isSevereVerificationReceipt(receipt({ evidence: evidence({ files }) }), subject)).toBe(false);
  });

  it("binds the original finding fingerprint and every host coordinate", () => {
    for (const key of ["repo", "pull", "base", "head", "fingerprint", "path", "line", "side", "lineSha256", "hunkSha256"] as const) {
      const altered = { ...subject, [key]: key === "pull" || key === "line" ? (subject[key] as number) + 1 : `${subject[key]}x` } as SevereHostSubject;
      expect(isSevereVerificationReceipt(receipt({ subject: altered }), subject)).toBe(false);
    }
  });
});
