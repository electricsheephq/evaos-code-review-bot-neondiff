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

describe("severe verification receipt canonicalization", () => {
  it("sorts evidence sets and produces stable canonical bytes and digest", () => {
    const first = receipt();
    const reordered = receipt();
    reordered.evidence.files.reverse();
    reordered.evidence.omitted.reverse();

    const a = canonicalizeSevereVerificationReceipt(first);
    const b = canonicalizeSevereVerificationReceipt(reordered);

    expect(a.canonicalJson).toBe(b.canonicalJson);
    expect(a.digest).toBe(b.digest);
    expect(a.digest).toMatch(/^[a-f0-9]{64}$/);
    expect(a.receipt.evidence.files.map((item) => item.path)).toEqual(["src/a.ts", "src/z.ts"]);
    expect(a.receipt.evidence.omitted.map((item) => item.path)).toEqual(["src/b.ts", "src/y.ts"]);
    expect(first.evidence.files.map((item) => item.path)).toEqual(["src/z.ts", "src/a.ts"]);
  });

  it("changes the digest when receipt semantics change", () => {
    const first = receipt();
    const changed = receipt();
    changed.headSha = "e".repeat(40);

    expect(canonicalizeSevereVerificationReceipt(first).digest)
      .not.toBe(canonicalizeSevereVerificationReceipt(changed).digest);
  });

  it("revalidates input and rejects non-schema or caller-owned hostile data", () => {
    const extra = { ...receipt(), extra: true };
    expect(() => canonicalizeSevereVerificationReceipt(extra)).toThrow("schema_invalid");

    let touched = false;
    const hostile = new Proxy(receipt(), {
      ownKeys() { touched = true; throw new Error("trap"); },
      get() { touched = true; throw new Error("trap"); }
    });
    expect(() => canonicalizeSevereVerificationReceipt(hostile)).toThrow("schema_invalid");
    expect(touched).toBe(false);
  });
});
