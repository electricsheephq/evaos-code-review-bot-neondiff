import { describe, expect, it } from "vitest";
import { compileSevereVerificationReceiptSchema, type SevereVerificationReceipt } from "../src/severe-verification-receipt-schema.js";

const path = "src/safe file+λ.ts";
const receipt = (): SevereVerificationReceipt => ({
  schemaVersion: "severe-verifier-v1", repo: "owner/repo", pullNumber: 7,
  baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: `finding:${"f".repeat(64)}`,
  state: "confirmed", disposition: "retain",
  evidence: { files: [{ path, kind: "whole_file", sha256: "c".repeat(64), bytes: 42, complete: true }], omitted: [], complete: true }
});
const validate = compileSevereVerificationReceiptSchema();

describe("strict severe verification receipt schema", () => {
  it("accepts exact identity and bounded whole-file/module evidence", () => {
    expect(validate(receipt())).toBe(true);
    expect(validate({ ...receipt(), repo: "Electric-Sheep/.github", evidence: { files: [{ ...receipt().evidence.files[0], kind: "module" }], omitted: [], complete: true } })).toBe(true);
    expect(validate({ ...receipt(), repo: "owner/repo--name" })).toBe(true);
  });

  it("rejects extra fields, invalid identities, hashes, and evidence bounds", () => {
    for (const invalid of [
      { ...receipt(), extra: true }, { ...receipt(), repo: "owner" }, { ...receipt(), repo: "_owner/repo" },
      { ...receipt(), repo: "owner-/repo" }, { ...receipt(), repo: "owner--name/repo" }, { ...receipt(), repo: "owner/repo name" },
      { ...receipt(), repo: `${"o".repeat(40)}/repo` }, { ...receipt(), repo: `owner/${"r".repeat(101)}` },
      { ...receipt(), pullNumber: 0 }, { ...receipt(), headSha: "A".repeat(40) }, { ...receipt(), findingFingerprint: "f".repeat(64) },
      { ...receipt(), evidence: { files: [], omitted: [], complete: false } },
      { ...receipt(), evidence: { files: [{ ...receipt().evidence.files[0], complete: false }], omitted: [], complete: true } },
      { ...receipt(), evidence: { files: receipt().evidence.files, omitted: [{ path: "src/missing.ts", code: "not_read" }], complete: true } },
      { ...receipt(), evidence: { files: [{ ...receipt().evidence.files[0], bytes: 65_537 }], omitted: [], complete: true } }
    ]) expect(validate(invalid)).toBe(false);
  });

  it("rejects duplicate/conflicting whole-file identities and file/omission overlap", () => {
    const file = receipt().evidence.files[0];
    for (const duplicate of [{ ...file }, { ...file, sha256: "d".repeat(64), bytes: 43 }]) {
      const invalid = receipt(); invalid.evidence.files.push(duplicate);
      expect(validate(invalid)).toBe(false);
    }
    const overlap = receipt();
    overlap.state = "incomplete"; overlap.disposition = "suppress"; overlap.reasonCode = "evidence_incomplete";
    overlap.evidence.complete = false; overlap.evidence.omitted = [{ path, code: "evidence_incomplete" }];
    expect(validate(overlap)).toBe(false);
  });

  it("rejects C0/C1, absolute, traversal, and backslash paths while accepting Unicode", () => {
    const astral = receipt(); astral.evidence.files[0].path = "src/🧪.ts";
    expect(validate(astral)).toBe(true);
    for (const unsafe of ["/src/x.ts", "../x.ts", "src/../x.ts", "C:/x.ts", "src\\x.ts", "src/\u0001x.ts", "src/\u0085x.ts"]) {
      const invalid = receipt(); invalid.evidence.files[0].path = unsafe;
      expect(validate(invalid), unsafe).toBe(false);
    }
  });

  it("rejects lone high/low surrogate path code units at every position", () => {
    for (const unsafe of ["\uD800x.ts", "src/\uD800x.ts", "src/x\uD800.ts", "\uDC00x.ts", "src/\uDC00x.ts", "src/x\uDC00.ts"]) {
      const invalid = receipt(); invalid.evidence.files[0].path = unsafe;
      expect(validate(invalid), unsafe).toBe(false);
    }
    const valid = receipt(); valid.evidence.files[0].path = "src/🧪.ts";
    expect(validate(valid)).toBe(true);
  });

  it("enforces retain/suppress, reason, and completeness semantics", () => {
    const refuted = { ...receipt(), state: "refuted", disposition: "suppress", reasonCode: "refuted" };
    expect(validate(refuted)).toBe(true);
    for (const invalid of [
      { ...receipt(), disposition: "suppress" }, { ...receipt(), reasonCode: "refuted" },
      { ...refuted, disposition: "retain" }, { ...receipt(), state: "timeout", disposition: "suppress", reasonCode: "malformed" },
      { ...receipt(), state: "incomplete", disposition: "suppress", reasonCode: "incomplete" }
    ]) expect(validate(invalid)).toBe(false);
  });
});
