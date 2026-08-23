import { describe, expect, it } from "vitest";
import type { SevereVerificationEvidenceRead, SevereVerificationEvidenceSubject } from "../src/severe-verification-evidence.js";
import { buildSevereFailureReceipt, buildSevereVerificationPrompt, parseSevereVerificationVerdict, severeVerificationFailureCode, type SevereVerificationFinding } from "../src/severe-verification-transport.js";

const subject: SevereVerificationEvidenceSubject = { repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), headSha: "a".repeat(40), findingFingerprint: "finding:" + "f".repeat(64), path: "src/safe file+λ.ts" };
const finding: SevereVerificationFinding = { path: subject.path, line: 3, severity: "P1", title: "Import context", body: "The import context is wrong.", fingerprint: subject.findingFingerprint };
const evidence: SevereVerificationEvidenceRead = { subject, content: "const π = 1;\n", evidence: { files: [{ path: subject.path, kind: "whole_file", sha256: "c".repeat(64), bytes: 15, complete: true }], omitted: [], complete: true } };
const raw = (value: unknown) => JSON.stringify(value);

describe("severe verification transport", () => {
  it("binds the atomic exact evidence and bounded finding/hunk in the prompt", () => {
    const prompt = buildSevereVerificationPrompt(finding, "+added();", evidence);
    for (const value of [subject.repo, String(subject.pullNumber), subject.baseSha, subject.headSha, subject.findingFingerprint, subject.path, evidence.content, "+added();", finding.title]) expect(prompt).toContain(value);
  });

  it("accepts only direct strict confirm/refute JSON and binds every parser coordinate", () => {
    expect(parseSevereVerificationVerdict(raw({ verdict: "confirm", confidence: 0.8 }), evidence, finding)).toMatchObject({ repo: subject.repo, pullNumber: 7, baseSha: subject.baseSha, headSha: subject.headSha, findingFingerprint: subject.findingFingerprint, state: "confirmed", disposition: "retain" });
    expect(parseSevereVerificationVerdict(raw({ verdict: "refute", confidence: 0.2 }), evidence, finding).state).toBe("refuted");
    for (const value of [{ response: { verdict: "confirm", confidence: 1 } }, [], { verdict: "maybe", confidence: 1 }, { verdict: "confirm", confidence: "1" }, { verdict: "confirm", confidence: 1, extra: true }, "confirm prose"]) expect(() => parseSevereVerificationVerdict(raw(value), evidence, finding)).toThrow("severe_verifier_malformed");
  });

  it("maps fixed failure codes to parser states and binds expected path", () => {
    const expected: Record<string, string> = { identity_mismatch: "stale_head", timeout: "timeout", provider_unavailable: "failed", receipt_invalid: "failed", malformed: "malformed", schema_invalid: "malformed", unavailable: "unavailable", incomplete: "incomplete", cap_exceeded: "incomplete", not_read: "incomplete", evidence_incomplete: "incomplete" };
    for (const [code, state] of Object.entries(expected)) { const receipt = buildSevereFailureReceipt(subject, finding, code as never); expect(receipt.state).toBe(state); expect(receipt.reasonCode).toBe(code); expect(receipt.evidence.omitted[0]?.path).toBe(subject.path); expect(JSON.stringify(receipt)).not.toContain("provider prose"); }
    expect(buildSevereFailureReceipt(subject, finding, "timeout" as never, evidence).evidence.files[0]?.path).toBe(subject.path);
  });

  it("rejects every mismatched supplied evidence identity", () => {
    for (const change of [{ repo: "other/repo" }, { pullNumber: 8 }, { baseSha: "c".repeat(40) }, { headSha: "d".repeat(40) }, { findingFingerprint: "finding:" + "e".repeat(64) }, { path: "other.ts" }]) expect(() => buildSevereFailureReceipt(subject, finding, "timeout" as never, { ...evidence, subject: { ...subject, ...change } })).toThrow("severe_verifier_identity_mismatch");
  });

  it("classifies timeout spellings and current provider timeout shapes", () => {
    for (const message of ["timeout", "timed out", "TIME-OUT", "spawn node ETIMEDOUT", "request Timed_Out"]) expect(severeVerificationFailureCode(new Error(message))).toBe("timeout");
    expect(severeVerificationFailureCode({ code: "ETIMEDOUT" })).toBe("timeout");
    expect(severeVerificationFailureCode(new Error("provider unavailable"))).toBe("provider_unavailable");
    expect(severeVerificationFailureCode(new Error("receipt identity mismatch"))).toBe("identity_mismatch");
  });
});
