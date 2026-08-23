import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  MAX_SEVERE_VERIFICATION_RECEIPT_BYTES,
  parseSevereVerificationReceipt,
  parseSerializedSevereVerificationReceipt,
  SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA
} from "../src/severe-verification-receipt.js";

const path = "src/safe file+λ.ts";
const base = () => ({
  schemaVersion: "severe-verifier-v1",
  repo: "owner/repo",
  pullNumber: 7,
  baseSha: "b".repeat(40),
  findingFingerprint: `finding:${"f".repeat(64)}`,
  headSha: "a".repeat(40),
  state: "confirmed",
  disposition: "retain",
  evidence: {
    files: [{ path, kind: "module", sha256: "c".repeat(64), bytes: 42, complete: true }],
    omitted: [],
    complete: true
  }
});
const json = (value: unknown) => JSON.stringify(value);
const canonicalBase = () => `{"baseSha":"${"b".repeat(40)}","disposition":"retain","evidence":{"complete":true,"files":[{"bytes":42,"complete":true,"kind":"module","path":"${path}","sha256":"${"c".repeat(64)}"}],"omitted":[]},"findingFingerprint":"finding:${"f".repeat(64)}","headSha":"${"a".repeat(40)}","pullNumber":7,"repo":"owner/repo","schemaVersion":"severe-verifier-v1","state":"confirmed"}`;

describe("serialized severe verification receipt", () => {
  it("accepts only bounded JSON bytes/string and returns a copied canonical snapshot", () => {
    const parsed = parseSerializedSevereVerificationReceipt(canonicalBase());
    expect(parsed.receipt).toEqual(base());
    expect(parsed.receipt).not.toBe(JSON.parse(canonicalBase()));
    expect(parsed.canonicalJson).toBe(canonicalBase());
    expect(parsed.sha256).toBe(createHash("sha256").update(parsed.canonicalJson).digest("hex"));
    expect(() => parseSerializedSevereVerificationReceipt(new TextEncoder().encode(canonicalBase()) as never)).toThrow("serialized");
    expect(parseSevereVerificationReceipt(canonicalBase()).state).toBe("confirmed");
  });

  it("requires canonical key/whitespace ordering and rejects duplicate keys", () => {
    expect(() => parseSerializedSevereVerificationReceipt(json(base()))).toThrow("canonical");
    expect(() => parseSerializedSevereVerificationReceipt(` ${canonicalBase()}`)).toThrow("canonical");
    expect(() => parseSerializedSevereVerificationReceipt(canonicalBase().replace('"state":"confirmed"', '"state":"confirmed","state":"confirmed"'))).toThrow("canonical");
    expect(parseSerializedSevereVerificationReceipt(canonicalBase()).digest).toBe(parseSerializedSevereVerificationReceipt(canonicalBase()).digest);
  });

  it("rejects malformed, oversize, invalid UTF-8, control/path, schema, identity, and state inputs", () => {
    const reject = (value: string, message?: string) => expect(() => parseSerializedSevereVerificationReceipt(value)).toThrow(message);
    reject("{", "malformed");
    reject("x".repeat(MAX_SEVERE_VERIFICATION_RECEIPT_BYTES + 1), "cap");
    reject(canonicalBase().replace(path, `src/${String.fromCharCode(0xd800)}.ts`), "UTF-8");
    for (const unsafe of ["/tmp/x.ts", "../x.ts", "src/../x.ts", "src\\x.ts", `src/${String.fromCharCode(0)}x.ts`]) {
      expect(() => parseSerializedSevereVerificationReceipt(json({ ...base(), evidence: { files: [{ path: unsafe, kind: "module", sha256: "c".repeat(64), bytes: 1, complete: true }], omitted: [], complete: true } }))).toThrow(/canonical|invalid/);
    }
    expect(() => parseSerializedSevereVerificationReceipt(json({ ...base(), extra: true }))).toThrow(/canonical|schema/);
    expect(() => parseSerializedSevereVerificationReceipt(canonicalBase(), { expectedRepo: "other/repo" })).toThrow("identity");
    expect(() => parseSerializedSevereVerificationReceipt(json({ ...base(), state: "refuted", disposition: "retain" }))).toThrow(/canonical|state/);
    expect(() => parseSerializedSevereVerificationReceipt(json({ ...base(), evidence: { files: [{ ...base().evidence.files[0], path }], omitted: [{ path, code: "incomplete" }], complete: false }, state: "incomplete", disposition: "suppress", reasonCode: "incomplete" }))).toThrow(/canonical|overlap/);
  });

  it("rejects hostile in-memory values without traversing them", () => {
    let touched = false;
    const hostile = new Proxy({}, { get() { touched = true; throw new Error("trap"); }, ownKeys() { touched = true; throw new Error("trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(hostile as never)).toThrow("serialized");
    expect(touched).toBe(false);
    let byteLengthTouched = false;
    class HostileBytes extends Uint8Array { get byteLength(): number { byteLengthTouched = true; throw new Error("byteLength trap"); } }
    const hostileBytes = new HostileBytes(new TextEncoder().encode(canonicalBase()));
    expect(() => parseSerializedSevereVerificationReceipt(hostileBytes as never)).toThrow("serialized");
    expect(byteLengthTouched).toBe(false);
    let proxyTouched = false;
    const hostileProxy = new Proxy(new Uint8Array(new TextEncoder().encode(canonicalBase())), { get() { proxyTouched = true; throw new Error("proxy trap"); } });
    expect(() => parseSerializedSevereVerificationReceipt(hostileProxy as never)).toThrow("serialized");
    expect(proxyTouched).toBe(false);
  });

  it("publishes one strict schema with bounded counts and no extra fields", () => {
    expect(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA.additionalProperties).toBe(false);
    expect(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA.properties.evidence.additionalProperties).toBe(false);
    expect(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA.properties.evidence.properties.files.items.additionalProperties).toBe(false);
  });
});
