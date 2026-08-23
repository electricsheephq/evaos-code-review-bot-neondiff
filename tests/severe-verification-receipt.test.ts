import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { MAX_SEVERE_VERIFICATION_RECEIPT_BYTES, parseSerializedSevereVerificationReceipt, SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA } from "../src/severe-verification-receipt.js";

const path = "src/safe file+λ.ts";
const base = () => ({ schemaVersion: "severe-verifier-v1", repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), findingFingerprint: `finding:${"f".repeat(64)}`, headSha: "a".repeat(40), state: "confirmed", disposition: "retain", evidence: { files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 42, complete: true }], omitted: [], complete: true } });
const stable = (v: unknown): string => Array.isArray(v) ? `[${[...v].sort((a, b) => (a && typeof a === "object" && "path" in a && b && typeof b === "object" && "path" in b) ? String(a.path).localeCompare(String(b.path)) : stable(a).localeCompare(stable(b))).map(stable).join(",")}]` : v && typeof v === "object" ? `{${Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => `${JSON.stringify(k)}:${stable(x)}`).join(",")}}` : JSON.stringify(v);
const serial = (changes: Record<string, unknown> = {}) => stable({ ...base(), ...changes });

describe("serialized severe verification receipt", () => {
  it("accepts primitive strings and genuine Uint8Array/Buffer bytes with a digest", () => {
    const text = serial();
    for (const input of [text, new Uint8Array(Buffer.from(text)), Buffer.from(text)]) { const parsed = parseSerializedSevereVerificationReceipt(input); expect(parsed.receipt).toEqual(base()); expect(parsed.sha256).toBe(createHash("sha256").update(text).digest("hex")); }
  });
  it("caps bytes before decode/parse and rejects malformed UTF-8, proxies, and hostile subclasses", () => {
    expect(() => parseSerializedSevereVerificationReceipt("x".repeat(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1))).toThrow("cap");
    expect(() => parseSerializedSevereVerificationReceipt(new Uint8Array(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1))).toThrow("cap");
    expect(() => parseSerializedSevereVerificationReceipt(Uint8Array.from([0xff]))).toThrow("UTF-8");
    let touched = false; const proxy = new Proxy(new Uint8Array(), { get() { touched = true; throw new Error("trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(proxy)).toThrow("serialized_input"); expect(touched).toBe(false);
    class Hostile extends Uint8Array { get byteLength(): number { touched = true; throw new Error("trap"); } }
    expect(() => parseSerializedSevereVerificationReceipt(new Hostile(Buffer.from(serial())))).toThrow("serialized_input"); expect(touched).toBe(false);
    const accessor = new Uint8Array(Buffer.from(serial())); Object.defineProperty(accessor, "byteLength", { get() { touched = true; throw new Error("trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(accessor)).toThrow("serialized_input"); expect(touched).toBe(false);
  });
  it("proves canonical ordering, strict schema, identity, and exact semantic errors", () => {
    const text = serial({ evidence: { files: [{ path: "z.ts", kind: "module", sha256: "d".repeat(64), bytes: 1, complete: true }, { path, kind: "whole_file", sha256: "c".repeat(64), bytes: 2, complete: true }], omitted: [], complete: true } });
    const parsed = parseSerializedSevereVerificationReceipt(text, { expectedRepo: "owner/repo", expectedPullNumber: 7, expectedBaseSha: "b".repeat(40), expectedHeadSha: "a".repeat(40), expectedFindingFingerprint: `finding:${"f".repeat(64)}`, expectedPath: path });
    expect(parsed.receipt.evidence.files.map((x) => x.path)).toEqual([path, "z.ts"]); expect(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA.properties.evidence.additionalProperties).toBe(false);
    expect(() => parseSerializedSevereVerificationReceipt(serial({ state: "refuted", disposition: "retain" }))).toThrow("state_invalid");
    expect(() => parseSerializedSevereVerificationReceipt(serial({ state: "incomplete", disposition: "suppress", reasonCode: "incomplete", evidence: { files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 1, complete: false }], omitted: [{ path, code: "incomplete" }], complete: false } }))).toThrow("overlap");
    expect(() => parseSerializedSevereVerificationReceipt(serial({ extra: true }))).toThrow(/noncanonical|schema_invalid/);
  });
});
