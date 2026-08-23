export const SEVERE_VERIFICATION_STATES = [
  "confirmed", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete"
] as const;
export type SevereVerificationState = typeof SEVERE_VERIFICATION_STATES[number];
export type SevereVerificationDisposition = "retain" | "suppress";
export type SevereEvidenceKind = "whole_file" | "module";
export type SevereVerificationCode =
  | "not_read" | "refuted" | "malformed" | "timeout" | "unavailable" | "stale_head"
  | "incomplete" | "schema_invalid" | "identity_mismatch" | "evidence_incomplete"
  | "provider_unavailable" | "cap_exceeded" | "receipt_invalid";

export interface SevereVerificationEvidenceFile {
  path: string;
  kind: SevereEvidenceKind;
  sha256: string;
  bytes: number;
  complete: boolean;
}
export interface SevereVerificationEvidenceOmission { path: string; code: SevereVerificationCode; }
export interface SevereVerificationEvidence {
  files: SevereVerificationEvidenceFile[];
  omitted: SevereVerificationEvidenceOmission[];
  complete: boolean;
}
export interface SevereVerificationReceipt {
  schemaVersion: "severe-verifier-v1";
  repo: string;
  pullNumber: number;
  baseSha: string;
  findingFingerprint: string;
  headSha: string;
  state: SevereVerificationState;
  disposition: SevereVerificationDisposition;
  confidence?: number;
  reasonCode?: SevereVerificationCode;
  evidence: SevereVerificationEvidence;
}
export interface SevereReceiptValidationOptions { expectedPath?: string; }
export type SevereReceiptValidation =
  | { ok: true; value: SevereVerificationReceipt }
  | { ok: false; errors: string[] };

const CODES = new Set<string>([
  "not_read", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete",
  "schema_invalid", "identity_mismatch", "evidence_incomplete", "provider_unavailable",
  "cap_exceeded", "receipt_invalid"
]);
const KINDS = new Set(["whole_file", "module"]);
const STATES = new Set<string>(SEVERE_VERIFICATION_STATES);
const SHA40 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export function validateSevereVerificationReceipt(value: unknown, options: SevereReceiptValidationOptions = {}): SevereReceiptValidation {
  const errors: string[] = [];
  if (!record(value)) return { ok: false, errors: ["receipt must be an object"] };
  const receipt = value;
  if (!exact(receipt, ["schemaVersion", "repo", "pullNumber", "baseSha", "findingFingerprint", "headSha", "state", "disposition", "evidence"], ["confidence", "reasonCode"])) errors.push("receipt has missing or unknown fields");
  if (receipt.schemaVersion !== "severe-verifier-v1") errors.push("schemaVersion is invalid");
  if (!string(receipt.repo) || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(receipt.repo) || byteLength(receipt.repo) > 256) errors.push("repo is invalid");
  if (typeof receipt.pullNumber !== "number" || !Number.isSafeInteger(receipt.pullNumber) || receipt.pullNumber < 1) errors.push("pullNumber is invalid");
  if (!string(receipt.baseSha) || !SHA40.test(receipt.baseSha)) errors.push("baseSha is invalid");
  if (!string(receipt.headSha) || !SHA40.test(receipt.headSha)) errors.push("headSha is invalid");
  if (!string(receipt.findingFingerprint) || !/^finding:[a-f0-9]{64}$/.test(receipt.findingFingerprint)) errors.push("findingFingerprint is invalid");
  if (!string(receipt.state) || !STATES.has(receipt.state)) errors.push("state is invalid");
  if (receipt.disposition !== "retain" && receipt.disposition !== "suppress") errors.push("disposition is invalid");
  if (receipt.confidence !== undefined && (!number(receipt.confidence) || receipt.confidence < 0 || receipt.confidence > 1)) errors.push("confidence is invalid");
  if (receipt.reasonCode !== undefined && (!string(receipt.reasonCode) || !CODES.has(receipt.reasonCode))) errors.push("reasonCode is invalid");
  if (receipt.state === "confirmed" && receipt.disposition !== "retain") errors.push("confirmed receipts must retain");
  if (receipt.state !== "confirmed" && receipt.disposition === "retain") errors.push("non-confirmed receipts must suppress");
  validateEvidence(receipt.evidence, receipt.state, options.expectedPath, errors);
  return errors.length ? { ok: false, errors } : { ok: true, value: receipt as unknown as SevereVerificationReceipt };
}

export function parseSevereVerificationReceipt(value: unknown, options: SevereReceiptValidationOptions = {}): SevereVerificationReceipt {
  const result = validateSevereVerificationReceipt(value, options);
  if (!result.ok) throw new Error(`severe_verification_receipt_invalid: ${result.errors.join(",")}`);
  return result.value;
}

export function isSevereVerificationReceipt(value: unknown, options: SevereReceiptValidationOptions = {}): value is SevereVerificationReceipt {
  return validateSevereVerificationReceipt(value, options).ok;
}

function validateEvidence(value: unknown, state: unknown, expectedPath: string | undefined, errors: string[]): void {
  if (!record(value) || !exact(value, ["files", "omitted", "complete"])) { errors.push("evidence shape is invalid"); return; }
  if (!Array.isArray(value.files) || !Array.isArray(value.omitted) || typeof value.complete !== "boolean") { errors.push("evidence types are invalid"); return; }
  if (value.files.length + value.omitted.length === 0) errors.push("evidence must be nonempty");
  for (const item of value.files) {
    const file = record(item) ? item : undefined;
    if (!file || !exact(file, ["path", "kind", "sha256", "bytes", "complete"]) || !safePath(file.path) || !string(file.kind) || !KINDS.has(file.kind) || !string(file.sha256) || !SHA256.test(file.sha256) || typeof file.bytes !== "number" || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || file.bytes > 2 ** 32 || typeof file.complete !== "boolean") errors.push("evidence file is invalid");
  }
  for (const item of value.omitted) {
    const omission = record(item) ? item : undefined;
    if (!omission || !exact(omission, ["path", "code"]) || !safePath(omission.path) || !string(omission.code) || !CODES.has(omission.code)) errors.push("evidence omission is invalid");
  }
  const completeFiles = value.files.length > 0 && value.omitted.length === 0 && value.files.every((file) => record(file) && file.complete === true);
  if (value.complete !== completeFiles) errors.push("evidence completeness is inconsistent");
  if ((state === "confirmed" || state === "refuted") && (!value.complete || !completeFiles)) errors.push("confirmed or refuted evidence must be complete");
  if (expectedPath !== undefined && (!safePath(expectedPath) || ![...value.files, ...value.omitted].some((entry) => record(entry) && entry.path === expectedPath))) errors.push("evidence does not cover expected path");
  if (state === "incomplete" && value.complete) errors.push("incomplete state requires incomplete evidence");
}

function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean {
  const allowed = new Set([...required, ...optional]);
  return required.every((key) => Object.hasOwn(value, key)) && Reflect.ownKeys(value).every((key) => typeof key === "string" && allowed.has(key));
}
function string(value: unknown): value is string { return typeof value === "string"; }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function safePath(value: unknown): value is string {
  if (!string(value) || value.length === 0 || byteLength(value) > 4096 || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /[\\\0\r\n]/.test(value)) return false;
  return value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}
