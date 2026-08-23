import { describe, expect, it } from "vitest";
import {
  compileSevereVerificationReceiptSchema,
  type SevereVerificationReceipt
} from "../src/severe-verification-receipt-schema.js";

const path = "src/safe file+λ.ts";
const receipt = (): SevereVerificationReceipt => ({
  schemaVersion: "severe-verifier-v1",
  repo: "owner/repo",
  pullNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  findingFingerprint: `finding:${"f".repeat(64)}`,
  state: "confirmed",
  disposition: "retain",
  evidence: {
    files: [{ path, kind: "whole_file", sha256: "c".repeat(64), bytes: 42, complete: true }],
    omitted: [],
    complete: true
  }
});
const validate = compileSevereVerificationReceiptSchema();

describe("strict severe verification receipt schema", () => {
  it("accepts exact versioned identity and bounded whole-file/module evidence", () => {
    expect(validate(receipt())).toBe(true);
    expect(validate({ ...receipt(), evidence: { files: [{ ...receipt().evidence.files[0], kind: "module" }], omitted: [], complete: true } })).toBe(true);
  });

  it("rejects extra fields, invalid identities, hashes, and evidence bounds", () => {
    expect(validate({ ...receipt(), repo: "Electric-Sheep/.github" })).toBe(true);
    for (const invalid of [
      { ...receipt(), extra: true },
      { ...receipt(), repo: "owner" },
      { ...receipt(), repo: "_owner/repo" },
      { ...receipt(), repo: "owner-/repo" },
      { ...receipt(), repo: `${"o".repeat(40)}/repo` },
      { ...receipt(), repo: `owner/${"r".repeat(101)}` },
      { ...receipt(), pullNumber: 0 },
      { ...receipt(), headSha: "A".repeat(40) },
      { ...receipt(), findingFingerprint: "f".repeat(64) },
      { ...receipt(), evidence: { files: [], omitted: [], complete: false } },
      { ...receipt(), evidence: { files: [{ ...receipt().evidence.files[0], complete: false }], omitted: [], complete: true } },
      { ...receipt(), evidence: { files: receipt().evidence.files, omitted: [{ path: "src/missing.ts", code: "not_read" }], complete: true } },
      { ...receipt(), evidence: { files: [{ ...receipt().evidence.files[0], bytes: 65_537 }], omitted: [], complete: true } }
    ]) expect(validate(invalid)).toBe(false);
  });

  it("rejects duplicate and conflicting whole-file identities for one path", () => {
    const file = receipt().evidence.files[0];
    for (const duplicate of [{ ...file }, { ...file, sha256: "d".repeat(64), bytes: 43 }]) {
      const invalid = receipt(); invalid.evidence.files.push(duplicate);
      expect(validate(invalid)).toBe(false);
    }
  });

  it("rejects C0/C1, absolute, traversal, and backslash paths while accepting Unicode", () => {
    expect(validate(receipt())).toBe(true);
    const astral = receipt(); astral.evidence.files[0].path = "src/🧪.ts";
    expect(validate(astral)).toBe(true);
    for (const unsafe of ["/src/x.ts", "../x.ts", "src/../x.ts", "C:/x.ts", "src\\x.ts", "src/\u0001x.ts", "src/\u0085x.ts"]) {
      const invalid = receipt(); invalid.evidence.files[0].path = unsafe;
      expect(validate(invalid), unsafe).toBe(false);
    }
  });

  it("enforces retain/suppress, reason, and completeness semantics", () => {
    const refuted = { ...receipt(), state: "refuted", disposition: "suppress", reasonCode: "refuted" };
    expect(validate(refuted)).toBe(true);
    for (const invalid of [
      { ...receipt(), disposition: "suppress" },
      { ...receipt(), reasonCode: "refuted" },
      { ...refuted, disposition: "retain" },
      { ...receipt(), state: "timeout", disposition: "suppress", reasonCode: "timeout" },
      { ...receipt(), state: "timeout", disposition: "suppress", reasonCode: "malformed" },
      { ...receipt(), state: "incomplete", disposition: "suppress", reasonCode: "incomplete" }
    ]) expect(validate(invalid)).toBe(false);
  });
});
