import { describe, expect, it } from "vitest";
import { isSevereVerificationReceipt, parseSevereVerificationReceipt, validateSevereVerificationReceipt } from "../src/severe-verification-receipt.js";

const path = "src/safe file+Δ.ts";
const base = () => ({ schemaVersion: "severe-verifier-v1", repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), findingFingerprint: `finding:${"f".repeat(64)}`, headSha: "a".repeat(40), state: "confirmed", disposition: "retain", confidence: 0.9, evidence: { files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 42, complete: true }], omitted: [], complete: true } });
const receipt = (changes: Record<string, unknown> = {}) => ({ ...base(), ...changes });

describe("severe verification receipt parser", () => {
  it("accepts strict identity, bounded metadata, safe Unicode paths, and expected coverage", () => {
    const longPath = `${"a".repeat(4070)} + safe λ.ts`;
    const value = receipt({ evidence: { files: [{ path: longPath, kind: "whole_file", sha256: "d".repeat(64), bytes: 1, complete: true }], omitted: [], complete: true } });
    expect(parseSevereVerificationReceipt(value, { expectedPath: longPath }).evidence.files[0]?.path).toBe(longPath);
  });

  it("rejects malformed, extra-field, coercion, and array values", () => {
    expect(isSevereVerificationReceipt([])).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ extra: true }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ pullNumber: "7" }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ headSha: new String("a".repeat(40)) }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ evidence: { ...base().evidence, files: [base().evidence.files[0], "not an object"] } }))).toBe(false);
  });

  it("rejects absolute, traversal, backslash, NUL, and unrelated evidence paths", () => {
    for (const unsafe of ["/tmp/x.ts", "../x.ts", "src/../x.ts", "src\\x.ts", `src/${String.fromCharCode(0)}x.ts`]) {
      expect(isSevereVerificationReceipt(receipt({ evidence: { files: [{ path: unsafe, kind: "module", sha256: "c".repeat(64), bytes: 1, complete: true }], omitted: [], complete: true } }))).toBe(false);
    }
    expect(isSevereVerificationReceipt(receipt(), { expectedPath: "src/other.ts" })).toBe(false);
  });

  it("rejects dot repositories and mismatched review identities", () => {
    for (const repo of ["./repo", "owner/.."]) expect(isSevereVerificationReceipt(receipt({ repo }))).toBe(false);
    for (const [key, value] of [["expectedRepo", "other/repo"], ["expectedPullNumber", 8], ["expectedBaseSha", "c".repeat(40)], ["expectedHeadSha", "d".repeat(40)], ["expectedFindingFingerprint", `finding:${"e".repeat(64)}`]]) expect(validateSevereVerificationReceipt(receipt(), { [key]: value } as never)).toEqual({ ok: false, errors: ["receipt identity mismatch"] });
  });

  it("requires nonempty, complete, relevant evidence for confirmed/refuted states", () => {
    expect(isSevereVerificationReceipt(receipt({ evidence: { files: [], omitted: [], complete: false } }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "refuted", disposition: "suppress" }), { expectedPath: path })).toBe(true);
    expect(isSevereVerificationReceipt(receipt({ evidence: { files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 1, complete: false }], omitted: [{ path, code: "incomplete" }], complete: false } }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "incomplete", disposition: "suppress", evidence: { files: [], omitted: [{ path: "other.ts", code: "incomplete" }], complete: false } }), { expectedPath: path })).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ reasonCode: "free-form prose" }))).toBe(false);
  });

  it("keeps refuted distinct from timeout, unavailable, malformed, stale-head, and incomplete", () => {
    const states = ["refuted", "timeout", "unavailable", "malformed", "stale_head", "incomplete"] as const;
    for (const state of states) {
      const evidence = state === "incomplete" ? { files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 1, complete: false }], omitted: [{ path, code: "incomplete" }], complete: false } : base().evidence;
      const parsed = parseSevereVerificationReceipt(receipt({ state, disposition: "suppress", reasonCode: state === "refuted" ? "refuted" : state, evidence }));
      expect(parsed.state).toBe(state);
    }
    expect(parseSevereVerificationReceipt(receipt({ state: "failed", disposition: "suppress", reasonCode: "provider_unavailable" })).state).toBe("failed");
    expect(isSevereVerificationReceipt(receipt({ reasonCode: "timeout" }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ state: "refuted", disposition: "suppress", reasonCode: "provider_unavailable" }))).toBe(false);
  });

  it("bounds evidence cardinality and proof sizes", () => {
    expect(isSevereVerificationReceipt(receipt({ state: "incomplete", disposition: "suppress", reasonCode: "incomplete", evidence: { files: [], omitted: Array.from({ length: 10_000 }, () => ({ path, code: "incomplete" })), complete: false } }))).toBe(false);
    expect(isSevereVerificationReceipt(receipt({ evidence: { files: [{ ...base().evidence.files[0], bytes: 2 ** 32 }], omitted: [], complete: true } }))).toBe(false);
  });
});
