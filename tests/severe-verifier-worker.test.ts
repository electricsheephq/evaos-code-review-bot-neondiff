import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildSevereFailureReceipt,
  buildSevereVerificationPrompt,
  MAX_SEVERE_CONTEXT_BYTES,
  parseSevereVerificationVerdict,
  readSevereVerificationEvidence,
  severeVerificationFailureCode
} from "../src/worker.js";
import type { SevereVerificationReviewContext } from "../src/worker.js";
import type { ReviewComment } from "../src/types.js";

const context: SevereVerificationReviewContext = { repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), headSha: "a".repeat(40) };
const comment: ReviewComment = { path: "nested dir/plus+λ/file.ts", line: 3, side: "RIGHT", body: "Import context is wrong.", severity: "P1", category: "runtime_correctness", confidence: 0.9, title: "Import context", fingerprint: "finding:" + "f".repeat(64) };

describe("inert severe verifier transport helpers", () => {
  it("reads safe Unicode/space/plus paths and rejects traversal, symlink escape, and caps", () => {
    const root = mkdtempSync(join("/tmp", "severe-helper-")), outside = mkdtempSync(join("/tmp", "severe-outside-"));
    try {
      mkdirSync(join(root, "nested dir/plus+λ"), { recursive: true });
      writeFileSync(join(root, comment.path), "const value = 1;\n");
      writeFileSync(join(outside, "secret.ts"), "secret");
      symlinkSync(outside, join(root, "link"));
      const evidence = readSevereVerificationEvidence(root, comment.path);
      expect(evidence.content).toContain("value");
      expect(evidence.receipt.files[0]?.complete).toBe(true);
      for (const path of ["../secret.ts", "/tmp/secret.ts", "link/secret.ts", "missing.ts", "nested dir"]) expect(() => readSevereVerificationEvidence(root, path)).toThrow("severe_verifier_incomplete");
      writeFileSync(join(root, "big.ts"), "x".repeat(MAX_SEVERE_CONTEXT_BYTES + 1));
      expect(() => readSevereVerificationEvidence(root, "big.ts")).toThrow("severe_verifier_cap_exceeded");
    } finally { rmSync(root, { recursive: true, force: true }); rmSync(outside, { recursive: true, force: true }); }
  });

  it("binds exact review identity/fingerprint and accepts only strict confirm/refute JSON", () => {
    const prompt = buildSevereVerificationPrompt(comment, "+added();", "const value = 1;", context);
    expect(prompt).toContain("owner/repo#7 base=" + context.baseSha + " head=" + context.headSha);
    expect(prompt).toContain(comment.fingerprint);
    expect(prompt).toContain(comment.path);
    const evidence = { files: [{ path: comment.path, kind: "whole_file" as const, sha256: "c".repeat(64), bytes: 16, complete: true }], omitted: [], complete: true };
    const raw = (value: unknown) => JSON.stringify({ response: JSON.stringify(value) });
    expect(parseSevereVerificationVerdict(raw({ verdict: "confirm", confidence: 0.8 }), context, comment, evidence).state).toBe("confirmed");
    expect(parseSevereVerificationVerdict(raw({ verdict: "refute", confidence: 0.2 }), context, comment, evidence).disposition).toBe("suppress");
    for (const value of [{ verified: true, confidence: 1 }, { verdict: "maybe", confidence: 1 }, { verdict: "confirm", confidence: 2 }, { verdict: "confirm", confidence: 1, extra: true }]) expect(() => parseSevereVerificationVerdict(raw(value), context, comment, evidence)).toThrow("severe_verifier_malformed");
  });

  it("emits parser-accepted bounded failure states with fixed codes", () => {
    for (const code of ["timeout", "unavailable", "malformed", "stale_head", "incomplete", "cap_exceeded", "provider_unavailable", "receipt_invalid"] as const) {
      const receipt = buildSevereFailureReceipt(context, comment, undefined, code);
      expect(receipt.reasonCode).toBe(code);
      expect(receipt.disposition).toBe("suppress");
      expect(["timeout", "unavailable", "malformed", "stale_head", "incomplete", "failed"]).toContain(receipt.state);
    }
    expect(severeVerificationFailureCode(new Error("timed out"))).toBe("timeout");
    expect(severeVerificationFailureCode(new Error("severe_verifier_incomplete"))).toBe("incomplete");
    expect(severeVerificationFailureCode(new Error("provider unavailable"))).toBe("provider_unavailable");
  });
});
