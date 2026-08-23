import { createHash } from "node:crypto";
import { Ajv2020 } from "ajv/dist/2020.js";

export const MAX_SEVERE_VERIFICATION_RECEIPT_BYTES = 512 * 1024;
export const SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA_NAME = "severe_verification_receipt";
export const SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA_STRICT = true;
export const SEVERE_VERIFICATION_STATES = ["confirmed", "refuted", "failed", "malformed", "timeout", "unavailable", "stale_head", "incomplete"] as const;
export const SEVERE_VERIFICATION_CODES = ["not_read", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete", "schema_invalid", "identity_mismatch", "evidence_incomplete", "provider_unavailable", "cap_exceeded", "receipt_invalid"] as const;
export type SevereVerificationState = typeof SEVERE_VERIFICATION_STATES[number];
export type SevereVerificationCode = typeof SEVERE_VERIFICATION_CODES[number];
export type SevereVerificationDisposition = "retain" | "suppress";
export type SevereEvidenceKind = "whole_file" | "module";
export type SevereReceiptValidationOptions = SevereReceiptParseOptions;
export interface SevereVerificationEvidenceFile { path: string; kind: SevereEvidenceKind; sha256: string; bytes: number; complete: boolean; }
export interface SevereVerificationEvidenceOmission { path: string; code: SevereVerificationCode; }
export interface SevereVerificationReceipt { schemaVersion: "severe-verifier-v1"; repo: string; pullNumber: number; baseSha: string; findingFingerprint: string; headSha: string; state: SevereVerificationState; disposition: SevereVerificationDisposition; confidence?: number; reasonCode?: SevereVerificationCode; evidence: { files: SevereVerificationEvidenceFile[]; omitted: SevereVerificationEvidenceOmission[]; complete: boolean }; }
export interface SevereReceiptParseOptions { expectedRepo?: string; expectedPullNumber?: number; expectedBaseSha?: string; expectedHeadSha?: string; expectedFindingFingerprint?: string; expectedPath?: string; }
export interface SerializedSevereVerificationReceipt { receipt: SevereVerificationReceipt; value: SevereVerificationReceipt; canonicalJson: string; canonical: string; sha256: string; digest: string; }

const SHA40 = "^[a-f0-9]{40}$";
const SHA256 = "^[a-f0-9]{64}$";
const PATH = "^(?!/)(?![A-Za-z]:)(?!.*[\\\\\\u0000-\\u001f\\u007f\\r\\n]).+$";
export const SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA = {
  type: "object", additionalProperties: false,
  required: ["schemaVersion", "repo", "pullNumber", "baseSha", "findingFingerprint", "headSha", "state", "disposition", "evidence"],
  properties: {
    schemaVersion: { const: "severe-verifier-v1" }, repo: { type: "string", minLength: 3, maxLength: 256, pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" },
    pullNumber: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, baseSha: { type: "string", pattern: SHA40 }, headSha: { type: "string", pattern: SHA40 },
    findingFingerprint: { type: "string", pattern: "^finding:[a-f0-9]{64}$" }, state: { enum: SEVERE_VERIFICATION_STATES }, disposition: { enum: ["retain", "suppress"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }, reasonCode: { enum: SEVERE_VERIFICATION_CODES },
    evidence: {
      type: "object", additionalProperties: false, required: ["files", "omitted", "complete"],
      properties: {
        files: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["path", "kind", "sha256", "bytes", "complete"], properties: {
          path: { type: "string", minLength: 1, maxLength: 4096, pattern: PATH }, kind: { enum: ["whole_file", "module"] }, sha256: { type: "string", pattern: SHA256 }, bytes: { type: "integer", minimum: 0, maximum: 65536 }, complete: { type: "boolean" }
        } } },
        omitted: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["path", "code"], properties: { path: { type: "string", minLength: 1, maxLength: 4096, pattern: PATH }, code: { enum: SEVERE_VERIFICATION_CODES } } } },
        complete: { type: "boolean" }
      },
      anyOf: [{ properties: { files: { type: "array", minItems: 1 } } }, { properties: { omitted: { type: "array", minItems: 1 } } }]
    }
  }
} as const;
export const SEVERE_VERIFICATION_RECEIPT_SCHEMA = SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA;

const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA);
const fail = (code: string, message: string): never => { throw new Error(`severe_receipt_${code}: ${message}`); };

export function parseSerializedSevereVerificationReceipt(input: string, options: SevereReceiptParseOptions = {}): SerializedSevereVerificationReceipt {
  const text = decodeSerialized(input);
  let raw: unknown;
  try { raw = JSON.parse(text) as unknown; } catch { fail("malformed", "serialized JSON is invalid"); }
  if (canonicalJsonOf(raw) !== text) fail("noncanonical", "serialized JSON is not canonical");
  if (!validateSchema(raw)) fail("schema_invalid", "receipt does not match the strict schema");
  const source = raw as SevereVerificationReceipt;
  checkIdentity(source, options);
  checkSemantics(source, options.expectedPath);
  const receipt = copyReceipt(source);
  const canonicalJson = canonicalJsonOf(receipt);
  const sha256 = createHash("sha256").update(canonicalJson, "utf8").digest("hex");
  return { receipt, value: receipt, canonicalJson, canonical: canonicalJson, sha256, digest: sha256 };
}

export function parseSevereVerificationReceipt(input: string, options: SevereReceiptParseOptions = {}): SevereVerificationReceipt {
  return parseSerializedSevereVerificationReceipt(input, options).receipt;
}

export function validateSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): { ok: true; value: SevereVerificationReceipt } | { ok: false; errors: string[] } {
  try { return { ok: true, value: parseSevereVerificationReceipt(input as string, options) }; } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "invalid receipt"] }; }
}
export function isSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): boolean { return validateSevereVerificationReceipt(input, options).ok; }

function decodeSerialized(input: unknown): string {
  const textInput = typeof input === "string" ? input : fail("serialized_input", "only a primitive string is accepted");
  if (Buffer.byteLength(textInput, "utf8") > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) fail("cap_exceeded", "serialized receipt exceeds byte cap");
  const bytes = Buffer.from(textInput, "utf8");
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text !== textInput) fail("invalid_utf8", "string contains invalid UTF-8 code units");
    return text;
  } catch (error) { if (error instanceof Error && error.message.includes("invalid UTF-8")) throw error; return fail("invalid_utf8", "serialized bytes are not valid UTF-8"); }
}

function checkIdentity(receipt: SevereVerificationReceipt, options: SevereReceiptParseOptions): void {
  const mismatch = (options.expectedRepo !== undefined && receipt.repo !== options.expectedRepo) || (options.expectedPullNumber !== undefined && receipt.pullNumber !== options.expectedPullNumber) || (options.expectedBaseSha !== undefined && receipt.baseSha !== options.expectedBaseSha) || (options.expectedHeadSha !== undefined && receipt.headSha !== options.expectedHeadSha) || (options.expectedFindingFingerprint !== undefined && receipt.findingFingerprint !== options.expectedFindingFingerprint);
  if (mismatch) fail("identity_mismatch", "receipt identity does not match the expected review");
}

function checkSemantics(receipt: SevereVerificationReceipt, expectedPath?: string): void {
  const { files, omitted, complete } = receipt.evidence;
  if (files.length + omitted.length === 0 || files.length + omitted.length > 64) fail("evidence_invalid", "evidence must be non-empty and bounded");
  const paths = new Set<string>();
  for (const file of files) { if (!safePath(file.path) || paths.has(file.path)) fail("duplicate", "evidence paths must be unique"); paths.add(file.path); }
  for (const item of omitted) { if (!safePath(item.path) || paths.has(item.path)) fail("overlap", "file and omission paths may not overlap"); paths.add(item.path); }
  if (files.reduce((sum, file) => sum + file.bytes, 0) > 262144 || [...paths].reduce((sum, path) => sum + Buffer.byteLength(path), 0) > 65536) fail("evidence_invalid", "evidence aggregate exceeds bounds");
  const completeFiles = files.length > 0 && omitted.length === 0 && files.every((file) => file.complete);
  if (complete !== completeFiles) fail("evidence_invalid", "evidence completeness is inconsistent");
  if ((receipt.state === "confirmed" || receipt.state === "refuted") && !completeFiles) fail("state_invalid", "confirmed/refuted evidence must be complete");
  if (receipt.state === "incomplete" && complete) fail("state_invalid", "incomplete state requires incomplete evidence");
  if (receipt.state === "confirmed" && receipt.disposition !== "retain") fail("state_invalid", "confirmed receipts retain findings");
  if (receipt.state !== "confirmed" && receipt.disposition !== "suppress") fail("state_invalid", "non-confirmed receipts suppress findings");
  const reasons: Record<string, string[] | undefined> = { failed: ["provider_unavailable", "receipt_invalid"], malformed: ["malformed", "schema_invalid", "receipt_invalid"], timeout: ["timeout"], unavailable: ["unavailable", "provider_unavailable"], stale_head: ["stale_head", "identity_mismatch"], incomplete: ["incomplete", "not_read", "evidence_incomplete", "cap_exceeded"] };
  if (receipt.state === "confirmed" && receipt.reasonCode !== undefined) fail("state_invalid", "confirmed receipts have no reason code");
  if (receipt.state === "refuted" && receipt.reasonCode !== undefined && receipt.reasonCode !== "refuted") fail("state_invalid", "refuted reason code is invalid");
  if (receipt.state !== "confirmed" && receipt.state !== "refuted" && !reasons[receipt.state]?.includes(receipt.reasonCode ?? "")) fail("state_invalid", "state and reason code are incompatible");
  if (expectedPath !== undefined && (!safePath(expectedPath) || !paths.has(expectedPath))) fail("identity_mismatch", "expected evidence path is not covered");
}

function copyReceipt(source: SevereVerificationReceipt): SevereVerificationReceipt {
  const files = source.evidence.files.map((file) => ({ path: file.path, kind: file.kind, sha256: file.sha256, bytes: file.bytes, complete: file.complete })).sort((a, b) => compare(canonicalArrayItemKey(a), canonicalArrayItemKey(b)));
  const omitted = source.evidence.omitted.map((item) => ({ path: item.path, code: item.code })).sort((a, b) => compare(canonicalArrayItemKey(a), canonicalArrayItemKey(b)));
  return { schemaVersion: source.schemaVersion, repo: source.repo, pullNumber: source.pullNumber, baseSha: source.baseSha, findingFingerprint: source.findingFingerprint, headSha: source.headSha, state: source.state, disposition: source.disposition, ...(source.confidence === undefined ? {} : { confidence: source.confidence }), ...(source.reasonCode === undefined ? {} : { reasonCode: source.reasonCode }), evidence: { files, omitted, complete: source.evidence.complete } };
}

function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function safePath(path: string): boolean { return validUnicode(path) && path.length > 0 && Buffer.byteLength(path, "utf8") <= 4096 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\\0-\u001f\u007f\r\n]/.test(path) && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }
function validUnicode(value: string): boolean { for (let index = 0; index < value.length; index += 1) { const code = value.charCodeAt(index); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(index + 1); if (next < 0xdc00 || next > 0xdfff) return false; index += 1; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true; }
function canonicalJsonOf(value: unknown): string { if (Array.isArray(value)) { const items = value.map((item) => ({ item, text: canonicalJsonOf(item) })).sort((a, b) => compare(canonicalArrayItemKey(a.item), canonicalArrayItemKey(b.item)) || compare(a.text, b.text)); return `[${items.map(({ text }) => text).join(",")}]`; } if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonOf(object[key])}`).join(",")}}`; } return JSON.stringify(value); }
function canonicalArrayItemKey(value: unknown): string { if (value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).path === "string") return `0:${(value as Record<string, unknown>).path}`; return `1:${canonicalJsonOf(value)}`; }
