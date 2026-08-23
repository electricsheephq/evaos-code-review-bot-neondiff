import { describe, expect, it } from "vitest";
import { parseSevereVerificationReceiptJson } from "../src/severe-verification-receipt-parser-b.js";
import { prepareSerializedSevereVerificationInput } from "../src/severe-verification-receipt-parser-a.js";
import { parseSevereVerificationReceipt } from "../src/severe-verification-receipt-parser-c.js";
import type { SevereVerificationReceipt } from "../src/severe-verification-receipt-schema.js";

const receipt = (): SevereVerificationReceipt => ({
  schemaVersion: "severe-verifier-v1", repo: "owner/repo", pullNumber: 7,
  baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: `finding:${"f".repeat(64)}`,
  state: "confirmed", disposition: "retain",
  evidence: { files: [{ path: "src/🧪.ts", kind: "whole_file", sha256: "c".repeat(64), bytes: 42, complete: true }], omitted: [], complete: true }
});
const fromB = (value: unknown) => parseSevereVerificationReceiptJson(prepareSerializedSevereVerificationInput(JSON.stringify(value)));

describe("severe receipt Parser C schema/copy boundary", () => {
  it("consumes Parser B output, preserves exact semantics, and copies all containers", () => {
    const source = fromB(receipt()) as SevereVerificationReceipt;
    const parsed = parseSevereVerificationReceipt(source);
    expect(parsed).toEqual(receipt());
    expect(parsed).not.toBe(source);
    expect(parsed.evidence).not.toBe(source.evidence);
    expect(parsed.evidence.files).not.toBe(source.evidence.files);
    expect(parsed.evidence.files[0]).not.toBe(source.evidence.files[0]);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(parsed.evidence.files)).toBe(Array.prototype);
    parsed.evidence.files[0].path = "changed";
    expect(source.evidence.files[0].path).toBe("src/🧪.ts");
    const partial = receipt();
    partial.state = "incomplete"; partial.disposition = "suppress"; partial.reasonCode = "not_read";
    partial.evidence.files[0].complete = false; partial.evidence.omitted = [{ path: "src/missing.ts", code: "not_read" }]; partial.evidence.complete = false;
    expect(parseSevereVerificationReceipt(fromB(partial))).toEqual(partial);
  });

  it("rejects semantic failures and nested additional properties", () => {
    const invalid = [
      { ...receipt(), extra: true },
      { ...receipt(), state: "refuted", disposition: "retain" },
      { ...receipt(), evidence: { ...receipt().evidence, files: [{ ...receipt().evidence.files[0], extra: true }] } },
      { ...receipt(), evidence: { ...receipt().evidence, omitted: [{ path: "src/🧪.ts", code: "not_read" }], complete: false, files: [{ ...receipt().evidence.files[0], complete: false }] }, state: "incomplete", disposition: "suppress", reasonCode: "incomplete" },
      { ...receipt(), evidence: { files: [], omitted: [], complete: false } }
    ];
    for (const value of invalid) expect(() => parseSevereVerificationReceipt(fromB(value))).toThrow("schema_invalid");
  });

  it("rejects caller-owned prototypes, accessors, symbols, and iterators without invoking them", () => {
    let touched = false;
    const accessor = receipt();
    Object.defineProperty(accessor, "repo", { get() { touched = true; throw new Error("trap"); } });
    expect(() => parseSevereVerificationReceipt(accessor)).toThrow("schema_invalid");
    const hostile = receipt();
    Object.setPrototypeOf(hostile, { get repo() { touched = true; throw new Error("trap"); } });
    expect(() => parseSevereVerificationReceipt(hostile)).toThrow("schema_invalid");
    const iterator = receipt();
    Object.defineProperty(iterator.evidence.files, Symbol.iterator, { value() { touched = true; throw new Error("trap"); } });
    expect(() => parseSevereVerificationReceipt(iterator)).toThrow("schema_invalid");
    expect(touched).toBe(false);
  });
});
