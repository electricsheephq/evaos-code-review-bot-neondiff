import { createHash } from "node:crypto";

export const SEVERE_EVIDENCE_SCHEMA = "severe-evidence/v2" as const;
export const SEVERE_RECEIPT_SCHEMA = "severe-verifier-receipt/v2" as const;
export const MAX_SEVERE_FILE_BYTES = 64 * 1024;
export const MAX_SEVERE_TOTAL_BYTES = 256 * 1024;
export const MAX_SEVERE_ENTRIES = 64;

export type SevereState = "confirmed" | "refuted" | "failed" | "malformed" | "timeout" | "unavailable" | "stale_head" | "incomplete";
export type SevereDisposition = "retain" | "suppress";
export type SevereEvidenceKind = "whole_file" | "module";
export type SevereFailureCode = "not_read" | "refuted" | "malformed" | "timeout" | "unavailable" | "stale_head" | "incomplete" | "schema_invalid" | "identity_mismatch" | "evidence_incomplete" | "provider_unavailable" | "cap_exceeded" | "receipt_invalid";

export interface SevereHostSubject {
  repo: string; pull: number; base: string; head: string; fingerprint: string;
  path: string; line: number; side: "RIGHT"; lineSha256: string; hunkSha256: string;
}
export interface SevereEvidenceFile {
  path: string; kind: SevereEvidenceKind; sha256: string; bytes: number; complete: boolean;
  lineStart?: number; lineEnd?: number;
}
export interface SevereEvidenceOmission { path: string; code: SevereFailureCode; }
export interface SevereEvidence {
  schema: typeof SEVERE_EVIDENCE_SCHEMA; files: SevereEvidenceFile[]; omissions: SevereEvidenceOmission[]; complete: boolean;
}
export interface SevereVerificationReceipt {
  schema: typeof SEVERE_RECEIPT_SCHEMA; subject: SevereHostSubject; state: SevereState; disposition: SevereDisposition;
  confidence?: number; reasonCode?: SevereFailureCode; evidence: SevereEvidence;
}
export type SevereValidation = { ok: true; value: SevereVerificationReceipt } | { ok: false; errors: string[] };

const STATES = new Set<SevereState>(["confirmed", "refuted", "failed", "malformed", "timeout", "unavailable", "stale_head", "incomplete"]);
const CODES = new Set<SevereFailureCode>(["not_read", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete", "schema_invalid", "identity_mismatch", "evidence_incomplete", "provider_unavailable", "cap_exceeded", "receipt_invalid"]);
const SHA1 = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const SUBJECT_KEYS = ["repo", "pull", "base", "head", "fingerprint", "path", "line", "side", "lineSha256", "hunkSha256"];

export function validateSevereHostSubject(value: unknown): string[] {
  const errors: string[] = [];
  if (!direct(value) || !exact(value, SUBJECT_KEYS)) return ["subject must be a direct object with exact keys"];
  if (!repo(value.repo)) errors.push("subject.repo is not canonical");
  if (!integer(value.pull) || value.pull < 1) errors.push("subject.pull is invalid");
  if (!sha1(value.base) || !sha1(value.head)) errors.push("subject revision is invalid");
  if (!fingerprint(value.fingerprint)) errors.push("subject.fingerprint is invalid");
  if (!path(value.path)) errors.push("subject.path is not canonical");
  if (!integer(value.line) || value.line < 1) errors.push("subject.line is invalid");
  if (value.side !== "RIGHT") errors.push("subject.side is invalid");
  if (!sha256(value.lineSha256) || !sha256(value.hunkSha256)) errors.push("subject line/hunk digest is invalid");
  return errors;
}

export function parseSevereHostSubject(value: unknown): SevereHostSubject {
  const errors = validateSevereHostSubject(value);
  if (errors.length) throw new Error("severe_subject_invalid: " + errors.join(","));
  return value as SevereHostSubject;
}

export function validateSevereVerificationReceipt(value: unknown, expectedSubject: SevereHostSubject): SevereValidation {
  const errors: string[] = [];
  const expectedErrors = validateSevereHostSubject(expectedSubject);
  if (expectedErrors.length) return { ok: false, errors: ["host subject is invalid", ...expectedErrors] };
  if (!direct(value) || !exact(value, ["schema", "subject", "state", "disposition", "evidence"], ["confidence", "reasonCode"])) return { ok: false, errors: ["receipt must be a direct object with exact keys"] };
  if (value.schema !== SEVERE_RECEIPT_SCHEMA) errors.push("receipt.schema is invalid");
  const subjectErrors = validateSevereHostSubject(value.subject);
  errors.push(...subjectErrors.map((error) => "receipt." + error));
  if (!subjectErrors.length && !sameSubject(value.subject as SevereHostSubject, expectedSubject)) errors.push("receipt subject identity mismatch");
  if (!string(value.state) || !STATES.has(value.state as SevereState)) errors.push("receipt.state is invalid");
  if (value.disposition !== "retain" && value.disposition !== "suppress") errors.push("receipt.disposition is invalid");
  if (Object.hasOwn(value, "confidence") && (!number(value.confidence) || value.confidence < 0 || value.confidence > 1)) errors.push("receipt.confidence is invalid");
  if (Object.hasOwn(value, "reasonCode") && (!string(value.reasonCode) || !CODES.has(value.reasonCode as SevereFailureCode))) errors.push("receipt.reasonCode is invalid");
  const state = value.state as SevereState;
  const reason = value.reasonCode as SevereFailureCode | undefined;
  if (state === "confirmed" && value.disposition !== "retain") errors.push("confirmed receipts must retain");
  if (state !== "confirmed" && value.disposition === "retain") errors.push("only confirmed receipts may retain");
  if (!stateReason(state, reason)) errors.push("receipt state and reasonCode are incompatible");
  if (!subjectErrors.length && direct(value.evidence)) errors.push(...validateEvidence(value.evidence, value.subject as SevereHostSubject, state, reason).map((error) => "receipt." + error));
  else errors.push("receipt.evidence is invalid");
  return errors.length ? { ok: false, errors } : { ok: true, value: value as unknown as SevereVerificationReceipt };
}

export function parseSevereVerificationReceipt(value: unknown, expectedSubject: SevereHostSubject): SevereVerificationReceipt {
  const result = validateSevereVerificationReceipt(value, expectedSubject);
  if (!result.ok) throw new Error("severe_receipt_invalid: " + result.errors.join(","));
  return result.value;
}

export function isSevereVerificationReceipt(value: unknown, expectedSubject: SevereHostSubject): value is SevereVerificationReceipt {
  return validateSevereVerificationReceipt(value, expectedSubject).ok;
}

export function validateSevereEvidence(value: unknown, subject: SevereHostSubject, state: SevereState = "confirmed", reason?: SevereFailureCode): string[] {
  if (!direct(value)) return ["evidence must be a direct object"];
  return validateEvidence(value, subject, state, reason);
}

export function parseSevereEvidence(value: unknown, subject: SevereHostSubject, state: SevereState = "confirmed", reason?: SevereFailureCode): SevereEvidence {
  const errors = validateSevereEvidence(value, subject, state, reason);
  if (errors.length) throw new Error("severe_evidence_invalid: " + errors.join(","));
  return value as SevereEvidence;
}

export const parseSevereReceipt = parseSevereVerificationReceipt;
export const validateSevereReceipt = validateSevereVerificationReceipt;

export function canonicalizeSevereVerificationReceipt(value: unknown, expectedSubject: SevereHostSubject): string {
  return canonical(parseSevereVerificationReceipt(value, expectedSubject));
}
export function severeVerificationDigest(value: unknown, expectedSubject: SevereHostSubject): string {
  return createHash("sha256").update(canonicalizeSevereVerificationReceipt(value, expectedSubject), "utf8").digest("hex");
}
export function idempotencyKey(value: unknown, expectedSubject: SevereHostSubject): string {
  return "severe-verifier/v2:" + severeVerificationDigest(value, expectedSubject);
}

function validateEvidence(value: Record<string, unknown>, subject: SevereHostSubject, state: SevereState, reason: SevereFailureCode | undefined): string[] {
  const errors: string[] = [];
  if (!exact(value, ["schema", "files", "omissions", "complete"]) || value.schema !== SEVERE_EVIDENCE_SCHEMA || !Array.isArray(value.files) || !Array.isArray(value.omissions) || typeof value.complete !== "boolean") return ["evidence shape is invalid"];
  if (value.files.length > MAX_SEVERE_ENTRIES || value.omissions.length > MAX_SEVERE_ENTRIES || value.files.length + value.omissions.length > MAX_SEVERE_ENTRIES) return ["evidence entry count is invalid"];
  const files: SevereEvidenceFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;
  for (const item of value.files) {
    if (!direct(item) || !exact(item, ["path", "kind", "sha256", "bytes", "complete"], ["lineStart", "lineEnd"])) { errors.push("evidence file has unknown or missing keys"); continue; }
    if (!path(item.path) || !string(item.kind) || (item.kind !== "whole_file" && item.kind !== "module") || !sha256(item.sha256) || !integer(item.bytes) || item.bytes < 1 || item.bytes > MAX_SEVERE_FILE_BYTES || typeof item.complete !== "boolean") { errors.push("evidence file is invalid"); continue; }
    if (seen.has(item.path)) errors.push("duplicate or conflicting evidence path");
    seen.add(item.path); totalBytes += item.bytes;
    if (item.kind === "module") {
      if (!integer(item.lineStart) || !integer(item.lineEnd) || item.lineStart < 1 || item.lineEnd < item.lineStart || item.lineEnd > 1_000_000_000) errors.push("module line range is invalid");
      else if (item.path === subject.path && (subject.line < item.lineStart || subject.line > item.lineEnd)) errors.push("module evidence does not contain finding line");
    } else if (Object.hasOwn(item, "lineStart") || Object.hasOwn(item, "lineEnd")) errors.push("whole-file evidence cannot have a module range");
    if ((state === "confirmed" || state === "refuted") && item.complete !== true) errors.push("completed receipt has incomplete evidence");
    files.push(item as unknown as SevereEvidenceFile);
  }
  const omissions: SevereEvidenceOmission[] = [];
  for (const item of value.omissions) {
    if (!direct(item) || !exact(item, ["path", "code"]) || !path(item.path) || !string(item.code) || !CODES.has(item.code as SevereFailureCode)) { errors.push("evidence omission is invalid"); continue; }
    if (seen.has(item.path)) errors.push("file and omission evidence overlap");
    seen.add(item.path); omissions.push(item as unknown as SevereEvidenceOmission);
    if (!omissionAllowed(state, item.code as SevereFailureCode, reason)) errors.push("omission code is incompatible with receipt state");
  }
  if (files.length + omissions.length === 0 || files.length + omissions.length > MAX_SEVERE_ENTRIES) errors.push("evidence entry count is invalid");
  if (totalBytes > MAX_SEVERE_TOTAL_BYTES) errors.push("evidence byte cap exceeded");
  if (!seen.has(subject.path)) errors.push("evidence does not cover host finding path");
  const complete = files.length > 0 && omissions.length === 0 && files.every((item) => item.complete);
  if (value.complete !== complete) errors.push("evidence completeness is contradictory");
  if (state === "confirmed" || state === "refuted") { if (!complete) errors.push("completed state requires complete evidence"); }
  else if (complete) errors.push("failure state requires incomplete or omitted evidence");
  return errors;
}

function stateReason(state: SevereState, reason: SevereFailureCode | undefined): boolean {
  if (state === "confirmed") return reason === undefined;
  if (state === "refuted") return reason === undefined || reason === "refuted";
  const allowed: Record<string, SevereFailureCode[]> = { failed: ["provider_unavailable", "receipt_invalid"], malformed: ["malformed", "schema_invalid", "receipt_invalid"], timeout: ["timeout"], unavailable: ["unavailable", "provider_unavailable"], stale_head: ["stale_head", "identity_mismatch"], incomplete: ["incomplete", "not_read", "evidence_incomplete", "cap_exceeded"] };
  return reason !== undefined && (allowed[state]?.includes(reason) ?? false);
}
function omissionAllowed(state: SevereState, code: SevereFailureCode, reason: SevereFailureCode | undefined): boolean {
  return (state === "confirmed" || state === "refuted") ? false : stateReason(state, code) && (reason === undefined || reason === code);
}
function sameSubject(a: SevereHostSubject, b: SevereHostSubject): boolean { return SUBJECT_KEYS.every((key) => a[key as keyof SevereHostSubject] === b[key as keyof SevereHostSubject]); }
function repo(value: unknown): value is string { if (!string(value) || !unicode(value)) return false; const parts = value.split("/"); return parts.length === 2 && parts.every((part) => /^[a-z0-9][a-z0-9._-]{0,99}$/.test(part) && part !== "." && part !== ".." && byteLength(part) <= 100); }
function path(value: unknown): value is string { if (!string(value) || !unicode(value) || value.length === 0 || byteLength(value) > 4096 || value.startsWith("/") || /^[A-Za-z]:/.test(value) || /[\\\0\r\n\u0000-\u001f\u007f\u2028\u2029]/.test(value)) return false; return value.split("/").every((part) => part !== "." && part !== ".." && part.length > 0 && byteLength(part) <= 255); }
function unicode(value: string): boolean { for (let i = 0; i < value.length; i += 1) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (next < 0xdc00 || next > 0xdfff) return false; i += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return value.normalize("NFC") === value; }
function sha1(value: unknown): value is string { return string(value) && SHA1.test(value); }
function sha256(value: unknown): value is string { return string(value) && SHA256.test(value); }
function fingerprint(value: unknown): value is string { return string(value) && /^finding:[a-f0-9]{64}$/.test(value); }
function integer(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value); }
function number(value: unknown): value is number { return typeof value === "number" && Number.isFinite(value); }
function string(value: unknown): value is string { return typeof value === "string"; }
function byteLength(value: string): number { return Buffer.byteLength(value, "utf8"); }
function direct(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return false;
  return Reflect.ownKeys(value).every((key) => typeof key === "string" && Object.getOwnPropertyDescriptor(value, key)?.enumerable === true && Object.hasOwn(Object.getOwnPropertyDescriptor(value, key)!, "value"));
}
function exact(value: Record<string, unknown>, required: string[], optional: string[] = []): boolean { const keys = Reflect.ownKeys(value); const allowed = new Set([...required, ...optional]); return required.every((key) => Object.hasOwn(value, key) && value[key] !== undefined) && keys.every((key) => typeof key === "string" && allowed.has(key)); }
function canonical(value: unknown): string { if (Array.isArray(value)) return "[" + value.map(canonical).sort().join(",") + "]"; if (value && typeof value === "object") { const entries = Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0); return "{" + entries.map(([key, item]) => JSON.stringify(key) + ":" + canonical(item)).join(",") + "}"; } return JSON.stringify(value); }
