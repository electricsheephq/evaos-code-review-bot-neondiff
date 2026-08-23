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
export interface SevereVerificationEvidenceFile { path: string; kind: SevereEvidenceKind; sha256: string; bytes: number; complete: boolean; }
export interface SevereVerificationEvidenceOmission { path: string; code: SevereVerificationCode; }
export interface SevereVerificationReceipt { schemaVersion: "severe-verifier-v1"; repo: string; pullNumber: number; baseSha: string; findingFingerprint: string; headSha: string; state: SevereVerificationState; disposition: SevereVerificationDisposition; confidence?: number; reasonCode?: SevereVerificationCode; evidence: { files: SevereVerificationEvidenceFile[]; omitted: SevereVerificationEvidenceOmission[]; complete: boolean }; }
export interface SevereReceiptParseOptions { expectedRepo?: string; expectedPullNumber?: number; expectedBaseSha?: string; expectedHeadSha?: string; expectedFindingFingerprint?: string; expectedPath?: string; }
export interface SerializedSevereVerificationReceipt { receipt: SevereVerificationReceipt; value: SevereVerificationReceipt; canonicalJson: string; canonical: string; sha256: string; digest: string; }

const SHA40 = "^[a-f0-9]{40}$", SHA256 = "^[a-f0-9]{64}$";
const PATH = "^(?!/)(?![A-Za-z]:)(?!.*[\\\\\\u0000-\\u001f\\u007f\\u0080-\\u009f\\r\\n]).+$";
const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype);
const getLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteLength")!.get!;
const getOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, "byteOffset")!.get!;
const getBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, "buffer")!.get!;
export const SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA = { type: "object", additionalProperties: false,
  required: ["schemaVersion", "repo", "pullNumber", "baseSha", "findingFingerprint", "headSha", "state", "disposition", "evidence"],
  properties: { schemaVersion: { const: "severe-verifier-v1" }, repo: { type: "string", minLength: 3, maxLength: 256, pattern: "^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$" }, pullNumber: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, baseSha: { type: "string", pattern: SHA40 }, headSha: { type: "string", pattern: SHA40 }, findingFingerprint: { type: "string", pattern: "^finding:[a-f0-9]{64}$" }, state: { enum: SEVERE_VERIFICATION_STATES }, disposition: { enum: ["retain", "suppress"] }, confidence: { type: "number", minimum: 0, maximum: 1 }, reasonCode: { enum: SEVERE_VERIFICATION_CODES },
    evidence: { type: "object", additionalProperties: false, required: ["files", "omitted", "complete"], properties: {
      files: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["path", "kind", "sha256", "bytes", "complete"], properties: { path: { type: "string", minLength: 1, maxLength: 4096, pattern: PATH }, kind: { enum: ["whole_file", "module"] }, sha256: { type: "string", pattern: SHA256 }, bytes: { type: "integer", minimum: 0, maximum: 65536 }, complete: { type: "boolean" } } } },
      omitted: { type: "array", maxItems: 64, items: { type: "object", additionalProperties: false, required: ["path", "code"], properties: { path: { type: "string", minLength: 1, maxLength: 4096, pattern: PATH }, code: { enum: SEVERE_VERIFICATION_CODES } } } }, complete: { type: "boolean" }
    }, anyOf: [{ properties: { files: { type: "array", minItems: 1 } } }, { properties: { omitted: { type: "array", minItems: 1 } } }] }
  }
} as const;
export const SEVERE_VERIFICATION_RECEIPT_SCHEMA = SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA;
const validateSchema = new Ajv2020({ allErrors: true, strict: true }).compile(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA);
const fail = (code: string, message: string): never => { throw new Error(`severe_receipt_${code}: ${message}`); };

export function parseSerializedSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): SerializedSevereVerificationReceipt {
  const text = decodeSerialized(input); let raw: unknown;
  try { raw = JSON.parse(text); } catch { fail("malformed", "serialized JSON is invalid"); }
  if (canonicalJsonOf(raw) !== text) fail("noncanonical", "serialized JSON is not canonical");
  if (!validateSchema(raw)) fail("schema_invalid", "receipt does not match the strict schema");
  const source = raw as SevereVerificationReceipt; checkIdentity(source, options); checkSemantics(source, options.expectedPath);
  const receipt = copyReceipt(source), canonicalJson = canonicalJsonOf(receipt), sha256 = createHash("sha256").update(canonicalJson).digest("hex");
  return { receipt, value: receipt, canonicalJson, canonical: canonicalJson, sha256, digest: sha256 };
}
export function parseSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): SevereVerificationReceipt { return parseSerializedSevereVerificationReceipt(input, options).receipt; }
export function validateSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): { ok: true; value: SevereVerificationReceipt } | { ok: false; errors: string[] } { try { return { ok: true, value: parseSevereVerificationReceipt(input, options) }; } catch (error) { return { ok: false, errors: [error instanceof Error ? error.message : "invalid receipt"] }; } }
export function isSevereVerificationReceipt(input: unknown, options: SevereReceiptParseOptions = {}): boolean { return validateSevereVerificationReceipt(input, options).ok; }

function decodeSerialized(input: unknown): string {
  let bytes: Uint8Array;
  if (typeof input === "string") { if (Buffer.byteLength(input) > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) fail("cap_exceeded", "serialized receipt exceeds byte cap"); bytes = Buffer.from(input); }
  else if (genuineBytes(input)) { const length = Reflect.apply(getLength, input, []); if (length > MAX_SEVERE_VERIFICATION_RECEIPT_BYTES) fail("cap_exceeded", "serialized receipt exceeds byte cap"); if (hostileOwnProperties(input)) return fail("serialized_input", "typed-array accessors and methods are not accepted"); bytes = Buffer.from(Reflect.apply(getBuffer, input, []) as ArrayBuffer, Reflect.apply(getOffset, input, []), length); }
  else return fail("serialized_input", "only a primitive string or genuine Uint8Array is accepted");
  if (bytes.byteLength >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) fail("noncanonical", "UTF-8 BOM is not canonical");
  try { const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes); if (typeof input === "string" && text !== input) fail("invalid_utf8", "string contains invalid UTF-8 code units"); return text; }
  catch { return fail("invalid_utf8", "serialized bytes are not valid UTF-8"); }
}
function genuineBytes(value: unknown): value is Uint8Array { if (!ArrayBuffer.isView(value)) return false; const proto = Object.getPrototypeOf(value); return proto === Uint8Array.prototype || proto === Buffer.prototype; }
function hostileOwnProperties(value: Uint8Array): boolean { return Reflect.ownKeys(value).some((key) => { if (typeof key === "string" && /^\d+$/.test(key)) return false; const descriptor = Object.getOwnPropertyDescriptor(value, key); return Boolean(descriptor && (descriptor.get || descriptor.set || typeof descriptor.value === "function")); }); }
function checkIdentity(r: SevereVerificationReceipt, o: SevereReceiptParseOptions): void { if ((o.expectedRepo !== undefined && r.repo !== o.expectedRepo) || (o.expectedPullNumber !== undefined && r.pullNumber !== o.expectedPullNumber) || (o.expectedBaseSha !== undefined && r.baseSha !== o.expectedBaseSha) || (o.expectedHeadSha !== undefined && r.headSha !== o.expectedHeadSha) || (o.expectedFindingFingerprint !== undefined && r.findingFingerprint !== o.expectedFindingFingerprint)) fail("identity_mismatch", "receipt identity does not match the expected review"); }
function checkSemantics(r: SevereVerificationReceipt, expectedPath?: string): void {
  const { files, omitted, complete } = r.evidence, paths = new Set<string>();
  if (r.repo.split("/").some((part) => part === "." || part === "..")) fail("schema_invalid", "repository path is invalid");
  for (const item of files) { if (!safePath(item.path)) fail("path_invalid", "evidence paths must be safe"); if (paths.has(item.path)) fail("duplicate", "evidence paths must be unique"); paths.add(item.path); }
  for (const item of omitted) { if (!safePath(item.path)) fail("path_invalid", "evidence paths must be safe"); if (paths.has(item.path)) fail("overlap", "file and omission paths may not overlap"); paths.add(item.path); }
  if (files.length + omitted.length === 0 || files.length + omitted.length > 64 || files.reduce((sum, item) => sum + item.bytes, 0) > 262144 || [...paths].reduce((sum, path) => sum + Buffer.byteLength(path), 0) > 65536) fail("evidence_invalid", "evidence is empty or exceeds bounds");
  const completeFiles = files.length > 0 && omitted.length === 0 && files.every((item) => item.complete);
  if (complete !== completeFiles || ((r.state === "confirmed" || r.state === "refuted") && !completeFiles) || (r.state === "incomplete" && complete)) fail("state_invalid", "evidence completeness is inconsistent");
  if ((r.state === "confirmed" && r.disposition !== "retain") || (r.state !== "confirmed" && r.disposition !== "suppress")) fail("state_invalid", "state and disposition are incompatible");
  const reasons: Record<string, string[] | undefined> = { failed: ["provider_unavailable", "receipt_invalid"], malformed: ["malformed", "schema_invalid", "receipt_invalid"], timeout: ["timeout"], unavailable: ["unavailable", "provider_unavailable"], stale_head: ["stale_head", "identity_mismatch"], incomplete: ["incomplete", "not_read", "evidence_incomplete", "cap_exceeded"] };
  if ((r.state === "confirmed" && r.reasonCode !== undefined) || (r.state === "refuted" && r.reasonCode !== undefined && r.reasonCode !== "refuted") || (r.state !== "confirmed" && r.state !== "refuted" && !reasons[r.state]?.includes(r.reasonCode ?? ""))) fail("state_invalid", "state and reason code are incompatible");
  if (expectedPath !== undefined && (!safePath(expectedPath) || !paths.has(expectedPath))) fail("identity_mismatch", "expected evidence path is not covered");
}
function copyReceipt(r: SevereVerificationReceipt): SevereVerificationReceipt { const files = r.evidence.files.map((x) => ({ ...x })).sort((a, b) => compare(canonicalArrayItemKey(a), canonicalArrayItemKey(b))), omitted = r.evidence.omitted.map((x) => ({ ...x })).sort((a, b) => compare(canonicalArrayItemKey(a), canonicalArrayItemKey(b))); return { schemaVersion: r.schemaVersion, repo: r.repo, pullNumber: r.pullNumber, baseSha: r.baseSha, findingFingerprint: r.findingFingerprint, headSha: r.headSha, state: r.state, disposition: r.disposition, ...(r.confidence === undefined ? {} : { confidence: r.confidence }), ...(r.reasonCode === undefined ? {} : { reasonCode: r.reasonCode }), evidence: { files, omitted, complete: r.evidence.complete } }; }
function safePath(path: string): boolean { return validUnicode(path) && path.length > 0 && Buffer.byteLength(path) <= 4096 && !path.startsWith("/") && !/^[A-Za-z]:/.test(path) && !/[\\\0-\u001f\u007f\u0080-\u009f\r\n]/.test(path) && path.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."); }
function validUnicode(value: string): boolean { for (let i = 0; i < value.length; i++) { const code = value.charCodeAt(i); if (code >= 0xd800 && code <= 0xdbff) { const next = value.charCodeAt(i + 1); if (next < 0xdc00 || next > 0xdfff) return false; i++; } else if (code >= 0xdc00 && code <= 0xdfff) return false; } return true; }
function compare(a: string, b: string): number { return a < b ? -1 : a > b ? 1 : 0; }
function canonicalJsonOf(value: unknown): string { if (Array.isArray(value)) { const items = value.map((item) => ({ item, text: canonicalJsonOf(item) })).sort((a, b) => compare(canonicalArrayItemKey(a.item), canonicalArrayItemKey(b.item)) || compare(a.text, b.text)); return `[${items.map((x) => x.text).join(",")}]`; } if (value && typeof value === "object") { const object = value as Record<string, unknown>; return `{${Object.keys(object).sort().map((key) => `${JSON.stringify(key)}:${canonicalJsonOf(object[key])}`).join(",")}}`; } return JSON.stringify(value); }
function canonicalArrayItemKey(value: unknown): string { return value && typeof value === "object" && !Array.isArray(value) && typeof (value as Record<string, unknown>).path === "string" ? `0:${(value as Record<string, unknown>).path}` : `1:${canonicalJsonOf(value)}`; }
