import { describe, expect, it } from "vitest";
import { canonicalizeSevereVerificationReceipt } from "../src/severe-verification-receipt-canonical.js";
import type { SevereVerificationReceipt } from "../src/severe-verification-receipt-schema.js";

const receipt = (): SevereVerificationReceipt => ({
  schemaVersion: "severe-verifier-v1",
  repo: "owner/repo",
  pullNumber: 7,
  baseSha: "b".repeat(40),
  headSha: "a".repeat(40),
  findingFingerprint: `finding:${"f".repeat(64)}`,
  state: "incomplete",
  disposition: "suppress",
  reasonCode: "not_read",
  evidence: {
    files: [
      { path: "src/z.ts", kind: "module", sha256: "d".repeat(64), bytes: 20, complete: false },
      { path: "src/a.ts", kind: "whole_file", sha256: "c".repeat(64), bytes: 10, complete: false }
    ],
    omitted: [
      { path: "src/y.ts", code: "cap_exceeded" },
      { path: "src/b.ts", code: "not_read" }
    ],
    complete: false
  }
});
const serialized = (value: unknown) => JSON.stringify(value);

describe("severe verification receipt canonicalization", () => {
  it("sorts evidence sets and produces stable canonical bytes and digest", () => {
    const first = receipt();
    const reordered = receipt();
    reordered.evidence.files.reverse();
    reordered.evidence.omitted.reverse();

    const a = canonicalizeSevereVerificationReceipt(serialized(first));
    const b = canonicalizeSevereVerificationReceipt(new TextEncoder().encode(serialized(reordered)));

    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.parse(a.canonicalJson)).toEqual(a.receipt);
    expect(a.receipt.evidence.files.map((item) => item.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(a.receipt.evidence.omitted.map((item) => item.path)).toEqual(["src/b.ts", "src/y.ts"]);
    expect(first.evidence.files.map((item) => item.path)).toEqual(["src/z.ts", "src/a.ts"]);
  });

  it("changes the digest when receipt semantics change", () => {
    const first = receipt();
    const changed = receipt();
    changed.headSha = "e".repeat(40);

    expect(canonicalizeSevereVerificationReceipt(serialized(first)).digest)
      .not.toBe(canonicalizeSevereVerificationReceipt(serialized(changed)).digest);
  });

  it("requires serialized input and rejects caller-owned hostile data without traps", () => {
    const extra = { ...receipt(), extra: true };
    expect(() => canonicalizeSevereVerificationReceipt(serialized(extra))).toThrow("schema_invalid");

    let touched = false;
    const hostile = new Proxy(receipt(), {
      ownKeys() { touched = true; throw new Error("trap"); },
      get() { touched = true; throw new Error("trap"); }
    });
    expect(() => canonicalizeSevereVerificationReceipt(hostile as unknown as string)).toThrow("serialized_input");
    expect(touched).toBe(false);
  });

  it("does not invoke inherited serialization hooks", () => {
    let touched = false;
    const input = serialized(receipt());
    const previous = Object.getOwnPropertyDescriptor(Object.prototype, "toJSON");
    Object.defineProperty(Object.prototype, "toJSON", { configurable: true, get() { touched = true; throw new Error("trap"); } });
    try {
      expect(canonicalizeSevereVerificationReceipt(input).digest).toMatch(/^[a-f0-9]{64}$/);
      expect(touched).toBe(false);
    } finally {
      if (previous) Object.defineProperty(Object.prototype, "toJSON", previous);
      else delete (Object.prototype as { toJSON?: unknown }).toJSON;
    }
  });

  it("orders valid Unicode paths by scalar code point", () => {
    const value = receipt();
    value.evidence.files[0].path = "src/😀.ts";
    value.evidence.files[1].path = "src/.ts";
    expect(canonicalizeSevereVerificationReceipt(serialized(value)).receipt.evidence.files.map((item) => item.path))
      .toEqual(["src/.ts", "src/😀.ts"]);
  });

  it("uses the captured primitive JSON encoder", () => {
    const input = serialized(receipt());
    const previous = JSON.stringify;
    let touched = 0;
    JSON.stringify = (() => { touched += 1; return "\"evil\""; }) as typeof JSON.stringify;
    try {
      expect(canonicalizeSevereVerificationReceipt(input).canonicalJson).not.toContain("evil");
      expect(touched).toBe(0);
    } finally {
      JSON.stringify = previous;
    }
  });
});
