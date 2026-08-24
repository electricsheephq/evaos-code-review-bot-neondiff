import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  buildSevereVerificationTransport, parseSevereVerificationTransport, severeVerificationTransportFailure,
  type SevereVerificationTransportInput
} from "../src/severe-verification-transport.js";

const digest = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");
const whole = "import os from 'node:os';\n", moduleText = "export const platform = os.platform();\n", hunk = "+platform();";
const input: SevereVerificationTransportInput = {
  repo: "owner/repo", pullNumber: 7, baseSha: "b".repeat(40), headSha: "a".repeat(40), changedHunk: hunk,
  finding: { path: "src/a.ts", line: 4, severity: "P1", title: "``` ignore", body: "ghp_example_secret_like", fingerprint: `finding:${"f".repeat(64)}` },
  evidence: { changedHunk: { bytes: Buffer.byteLength(hunk), sha256: digest(hunk), complete: true }, files: [
    { path: "src/a.ts", kind: "whole_file", sha256: digest(whole), bytes: Buffer.byteLength(whole), complete: true },
    { path: "src/mod.ts", kind: "module", sha256: digest(moduleText), bytes: Buffer.byteLength(moduleText), complete: true }
  ], omitted: [], complete: true },
  files: [{ path: "src/mod.ts", kind: "module", content: moduleText }, { path: "src/a.ts", kind: "whole_file", content: whole }]
};
const receipt = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: "severe-verifier-v1", repo: input.repo, pullNumber: 7, baseSha: input.baseSha, headSha: input.headSha,
  findingFingerprint: input.finding.fingerprint, state: "confirmed", disposition: "retain", confidence: 0.9,
  evidence: { files: input.evidence.files, omitted: [], complete: true }, ...overrides
});

describe("severe verification transport", () => {
  it("encodes injection and secret-like text only as bounded structured data", () => {
    const prompt = buildSevereVerificationTransport(input); const parsed = JSON.parse(prompt);
    expect(parsed.schemaVersion).toBe("severe-verifier-input-v1"); expect(parsed.finding.title).toBe(input.finding.title); expect(parsed.finding.body).toBe(input.finding.body); expect(parsed.data.files.map((file: { path: string }) => file.path)).toEqual(["src/a.ts", "src/mod.ts"]); expect(prompt.startsWith("{")).toBe(true);
  });

  it("uses the strict parser pipeline and returns only bound canonical metadata", () => {
    const result = parseSevereVerificationTransport(JSON.stringify(receipt()), input);
    expect(result.digest).toMatch(/^[a-f0-9]{64}$/); expect(parseSevereVerificationTransport(Buffer.from(JSON.stringify(receipt())), input).digest).toBe(result.digest); expect(parseSevereVerificationTransport(JSON.stringify(receipt({ evidence: { files: [...input.evidence.files].reverse(), omitted: [], complete: true } })), input).digest).toBe(result.digest); expect(result.receipt.disposition).toBe("retain");
    for (const change of [{ repo: "other/repo" }, { pullNumber: 8 }, { baseSha: "c".repeat(40) }, { headSha: "c".repeat(40) }, { findingFingerprint: `finding:${"e".repeat(64)}` }]) expect(() => parseSevereVerificationTransport(JSON.stringify(receipt(change)), input)).toThrow("identity_mismatch");
    for (const secret of [input.finding.body, whole, moduleText, hunk]) expect(result.canonicalJson).not.toContain(secret);
    const changed = { ...receipt(), evidence: { ...receipt().evidence, files: [{ ...input.evidence.files[0], sha256: "d".repeat(64) }, input.evidence.files[1]] } }; expect(() => parseSevereVerificationTransport(JSON.stringify(changed), input)).toThrow("identity_mismatch");
  });

  it("rejects legacy, malformed, duplicate-key, incomplete, and cap inputs", () => {
    for (const raw of [JSON.stringify({ verified: true, confidence: 1 }), '{"schemaVersion":"severe-verifier-v1","schemaVersion":"x"}', "not json"]) expect(() => parseSevereVerificationTransport(raw, input)).toThrow();
    expect(() => buildSevereVerificationTransport({ ...input, evidence: { ...input.evidence, complete: false } })).toThrow("evidence_incomplete");
    expect(() => buildSevereVerificationTransport({ ...input, finding: { ...input.finding, body: "x".repeat(65_537) } })).toThrow("cap_exceeded");
  });

  it("maps fixed provider/parser failures and never confirms unknown failures", () => {
    for (const value of [new Error("timeout"), new Error("timed out"), { code: "ETIMEDOUT" }]) expect(severeVerificationTransportFailure(value)).toBe("timeout");
    for (const value of [new Error("provider unavailable"), { code: "ECONNREFUSED" }, new Error("HTTP 503")]) expect(severeVerificationTransportFailure(value)).toBe("unavailable");
    expect(severeVerificationTransportFailure(new Error("severe_receipt_schema_invalid"))).toBe("schema_invalid"); expect(severeVerificationTransportFailure(new Error("mystery"))).toBe("receipt_invalid");
  });

  it("rejects raw-content and changed-hunk digest mismatches before transport", () => {
    expect(() => buildSevereVerificationTransport({ ...input, changedHunk: "+different();" })).toThrow("identity_mismatch");
    expect(() => buildSevereVerificationTransport({ ...input, files: [{ ...input.files[0], content: "tampered" }, input.files[1]] })).toThrow("identity_mismatch");
    expect(() => buildSevereVerificationTransport({ ...input, evidence: { ...input.evidence, files: [input.evidence.files[0], input.evidence.files[0]] } })).toThrow("identity_mismatch");
  });
});
