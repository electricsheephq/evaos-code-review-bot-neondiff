import { describe, expect, it } from "vitest";
import {
  MAX_SEVERE_VERIFICATION_RECEIPT_BYTES,
  parseSevereVerificationReceipt,
  parseSerializedSevereVerificationReceipt
} from "../src/severe-verification-receipt-parser.js";

const receipt = () => ({
  schemaVersion: "severe-verifier-v1", repo: "owner/repo", pullNumber: 7,
  baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: `finding:${"f".repeat(64)}`,
  state: "confirmed", disposition: "retain",
  evidence: { files: [{ path: "src/🧪.ts", kind: "whole_file", sha256: "c".repeat(64), bytes: 42, complete: true }], omitted: [], complete: true }
});
const serialized = () => JSON.stringify(receipt());

describe("serialized severe receipt parser", () => {
  it("accepts strings, Uint8Arrays, and Buffers, then copies validated data", () => {
    for (const input of [serialized(), new TextEncoder().encode(serialized()), Buffer.from(serialized())]) {
      const parsed = parseSerializedSevereVerificationReceipt(input);
      expect(parsed).toEqual(receipt());
      expect(parsed).not.toBe(input);
    }
    const first = parseSerializedSevereVerificationReceipt(serialized());
    const second = parseSerializedSevereVerificationReceipt(serialized());
    expect(first.evidence).not.toBe(second.evidence);
    expect(first.evidence.files).not.toBe(second.evidence.files);
    first.evidence.files[0].path = "changed";
    expect(second.evidence.files[0].path).toBe("src/🧪.ts");
    expect(parseSevereVerificationReceipt(serialized())).toEqual(receipt());
  });

  it("rejects duplicate decoded keys before parsing and accepts ordinary JSON whitespace", () => {
    expect(() => parseSerializedSevereVerificationReceipt(`{"x": {"a": 1, "\\u0061": 2}}`)).toThrow("duplicate_key");
    expect(parseSerializedSevereVerificationReceipt(` \n${serialized()} \t`)).toEqual(receipt());
  });

  it("fails closed for BOM, malformed UTF-8, lone surrogates, schema errors, and cap", () => {
    expect(() => parseSerializedSevereVerificationReceipt(new Uint8Array([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow("bom");
    expect(() => parseSerializedSevereVerificationReceipt(new Uint8Array([0xc0, 0x80]))).toThrow("utf8");
    expect(() => parseSerializedSevereVerificationReceipt(serialized().replace("src/🧪.ts", "src/\\ud800.ts"))).toThrow("unicode");
    expect(() => parseSerializedSevereVerificationReceipt(serialized().replace('"pullNumber":7', '"pullNumber":0'))).toThrow("schema");
    expect(() => parseSerializedSevereVerificationReceipt(new Uint8Array(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1))).toThrow("cap");
  });

  it("does not traverse proxies or hostile subclasses", () => {
    let touched = false;
    const proxy = new Proxy(new Uint8Array(), { get() { touched = true; throw new Error("trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(proxy)).toThrow("serialized_input");
    expect(touched).toBe(false);
    class Hostile extends Uint8Array { get byteLength() { touched = true; throw new Error("trap"); } }
    expect(() => parseSerializedSevereVerificationReceipt(new Hostile())).toThrow("serialized_input");
    expect(touched).toBe(false);
    const accessor = new Uint8Array(); Object.defineProperty(accessor, "byteLength", { get() { throw new Error("trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(accessor)).toThrow("serialized_input");
    const iterator = new Uint8Array(); Object.defineProperty(iterator, Symbol.iterator, { value() { throw new Error("trap"); } }); expect(() => parseSerializedSevereVerificationReceipt(iterator)).toThrow("serialized_input"); const evilAccessor = new Uint8Array(); Object.defineProperty(evilAccessor, "evil", { get() { throw new Error("trap"); } }); expect(() => parseSerializedSevereVerificationReceipt(evilAccessor)).toThrow("serialized_input"); const evilFunction = new Uint8Array(); Object.defineProperty(evilFunction, "evil", { value() { throw new Error("trap"); } }); expect(() => parseSerializedSevereVerificationReceipt(evilFunction)).toThrow("serialized_input"); const spoofedInt8 = new Int8Array(); Object.setPrototypeOf(spoofedInt8, Uint8Array.prototype); expect(() => parseSerializedSevereVerificationReceipt(spoofedInt8)).toThrow("serialized_input"); const spoofedClamped = new Uint8ClampedArray(); Object.setPrototypeOf(spoofedClamped, Uint8Array.prototype); expect(() => parseSerializedSevereVerificationReceipt(spoofedClamped)).toThrow("serialized_input");
  });

  it("rejects excessive nesting, trailing content, and oversized strings", () => {
    const deep = `${"[".repeat(300)}1${"]".repeat(300)}`;
    expect(() => parseSerializedSevereVerificationReceipt(deep)).toThrow("depth");
    expect(() => parseSerializedSevereVerificationReceipt(`${serialized()}{}`)).toThrow("malformed");
    expect(() => parseSerializedSevereVerificationReceipt("x".repeat(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1))).toThrow("cap");
  });
});
