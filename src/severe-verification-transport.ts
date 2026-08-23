import type { SevereVerificationEvidenceRead, SevereVerificationEvidenceSubject } from "./severe-verification-evidence.js";
import { parseSevereVerificationReceipt, type SevereVerificationCode, type SevereVerificationReceipt } from "./severe-verification-receipt.js";

export interface SevereVerificationFinding { path: string; line: number; severity: "P0" | "P1"; title: string; body: string; fingerprint: string; }
const PROMPT_TEXT_BYTES = 8 * 1024;
const PROMPT_HUNK_BYTES = 32 * 1024;

export function buildSevereVerificationPrompt(finding: SevereVerificationFinding, hunk: string, evidence: SevereVerificationEvidenceRead): string {
  assertBinding(finding, evidence.subject);
  if (!bounded(finding.title) || !bounded(finding.body) || !bounded(hunk, PROMPT_HUNK_BYTES) || !Number.isSafeInteger(finding.line) || finding.line < 1) throw new Error("severe_verifier_prompt_invalid");
  return [
    "Review one finding using only the supplied exact-head evidence. Return direct JSON only: {\"verdict\":\"confirm\"|\"refute\",\"confidence\":0.0}.",
    `Identity repo=${evidence.subject.repo} pull=${evidence.subject.pullNumber} base=${evidence.subject.baseSha} head=${evidence.subject.headSha}`,
    `Finding fingerprint=${evidence.subject.findingFingerprint} path=${evidence.subject.path} line=${finding.line} severity=${finding.severity}`,
    `Title=${finding.title}\nDetail=${finding.body}`, `Hunk:\n${hunk}`, `Exact-head evidence metadata=${JSON.stringify(evidence.evidence)}`, `Exact-head file content:\n${evidence.content}`
  ].join("\n");
}

export function parseSevereVerificationVerdict(rawResponse: string, evidence: SevereVerificationEvidenceRead, finding: SevereVerificationFinding): SevereVerificationReceipt {
  assertBinding(finding, evidence.subject);
  let value: unknown;
  try { value = typeof rawResponse === "string" ? JSON.parse(rawResponse) : undefined; } catch { throw new Error("severe_verifier_malformed"); }
  if (!record(value) || !exactKeys(value, ["verdict", "confidence"]) || (value.verdict !== "confirm" && value.verdict !== "refute") || typeof value.confidence !== "number" || !Number.isFinite(value.confidence) || value.confidence < 0 || value.confidence > 1) throw new Error("severe_verifier_malformed");
  const subject = evidence.subject;
  try {
    return parseSevereVerificationReceipt({ schemaVersion: "severe-verifier-v1", ...identity(subject), state: value.verdict === "confirm" ? "confirmed" : "refuted", disposition: value.verdict === "confirm" ? "retain" : "suppress", confidence: value.confidence, evidence: evidence.evidence }, expected(subject));
  } catch { throw new Error("severe_verifier_receipt_invalid"); }
}

export function buildSevereFailureReceipt(subject: SevereVerificationEvidenceSubject, finding: SevereVerificationFinding, code: SevereVerificationCode, suppliedEvidence?: SevereVerificationEvidenceRead): SevereVerificationReceipt {
  assertBinding(finding, subject);
  if (suppliedEvidence) assertEvidenceBinding(suppliedEvidence, subject);
  const state = failureState(code);
  const proof = state === "incomplete" ? { files: [], omitted: [{ path: subject.path, code }], complete: false } : suppliedEvidence?.evidence ?? { files: [], omitted: [{ path: subject.path, code }], complete: false };
  try { return parseSevereVerificationReceipt({ schemaVersion: "severe-verifier-v1", ...identity(subject), state, disposition: "suppress", reasonCode: code, evidence: proof }, expected(subject)); } catch { throw new Error("severe_verifier_receipt_invalid"); }
}

export function severeVerificationFailureCode(error: unknown): SevereVerificationCode {
  const value = error && typeof error === "object" ? error as { code?: unknown; name?: unknown } : {};
  const text = [error instanceof Error ? error.message : typeof error === "string" ? error : "", value.code, value.name].join(" ").toLowerCase();
  if (/\b(?:time[- _]?out|timed[- _]?out|etimedout)\b/.test(text)) return "timeout";
  if (text.includes("identity_mismatch") || text.includes("identity mismatch") || text.includes("stale_head") || text.includes("stale head")) return "identity_mismatch";
  if (text.includes("provider_unavailable") || text.includes("provider unavailable")) return "provider_unavailable";
  if (text.includes("receipt_invalid") || text.includes("receipt invalid")) return "receipt_invalid";
  if (text.includes("schema_invalid") || text.includes("schema invalid") || text.includes("malformed")) return "malformed";
  if (text.includes("cap_exceeded") || text.includes("cap exceeded")) return "cap_exceeded";
  if (text.includes("evidence_incomplete") || text.includes("evidence incomplete")) return "evidence_incomplete";
  if (text.includes("not_read") || text.includes("not read")) return "not_read";
  if (text.includes("incomplete")) return "incomplete";
  if (text.includes("unavailable")) return "unavailable";
  return "provider_unavailable";
}

function failureState(code: SevereVerificationCode): SevereVerificationReceipt["state"] {
  if (code === "identity_mismatch" || code === "stale_head") return "stale_head";
  if (code === "timeout") return "timeout";
  if (code === "provider_unavailable" || code === "receipt_invalid") return "failed";
  if (code === "malformed" || code === "schema_invalid") return "malformed";
  if (code === "unavailable") return "unavailable";
  return "incomplete";
}
function expected(subject: SevereVerificationEvidenceSubject) { return { expectedRepo: subject.repo, expectedPullNumber: subject.pullNumber, expectedBaseSha: subject.baseSha, expectedHeadSha: subject.headSha, expectedFindingFingerprint: subject.findingFingerprint, expectedPath: subject.path }; }
function identity(subject: SevereVerificationEvidenceSubject) { return { repo: subject.repo, pullNumber: subject.pullNumber, baseSha: subject.baseSha, headSha: subject.headSha, findingFingerprint: subject.findingFingerprint }; }
function assertBinding(finding: SevereVerificationFinding, subject: SevereVerificationEvidenceSubject): void { if (finding.path !== subject.path || finding.fingerprint !== subject.findingFingerprint) throw new Error("severe_verifier_identity_mismatch"); }
function assertEvidenceBinding(evidence: SevereVerificationEvidenceRead, subject: SevereVerificationEvidenceSubject): void { const actual = evidence.subject; if (actual.repo !== subject.repo || actual.pullNumber !== subject.pullNumber || actual.baseSha !== subject.baseSha || actual.headSha !== subject.headSha || actual.findingFingerprint !== subject.findingFingerprint || actual.path !== subject.path) throw new Error("severe_verifier_identity_mismatch"); }
function bounded(value: unknown, max = PROMPT_TEXT_BYTES): value is string { return typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= max; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }
