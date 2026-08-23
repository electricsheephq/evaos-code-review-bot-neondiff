import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";

export const SEVERE_VERIFICATION_STATES = [
  "confirmed", "refuted", "failed", "malformed", "timeout", "unavailable", "stale_head", "incomplete"
] as const;
export const SEVERE_VERIFICATION_CODES = [
  "not_read", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete", "schema_invalid",
  "identity_mismatch", "evidence_incomplete", "provider_unavailable", "cap_exceeded", "receipt_invalid"
] as const;
export type SevereVerificationState = typeof SEVERE_VERIFICATION_STATES[number];
export type SevereVerificationCode = typeof SEVERE_VERIFICATION_CODES[number];
export type SevereVerificationDisposition = "retain" | "suppress";
export type SevereEvidenceKind = "whole_file" | "module";
export interface SevereVerificationEvidenceFile {
  path: string; kind: SevereEvidenceKind; sha256: string; bytes: number; complete: boolean;
}
export interface SevereVerificationEvidenceOmission { path: string; code: SevereVerificationCode; }
export interface SevereVerificationReceipt {
  schemaVersion: "severe-verifier-v1"; repo: string; pullNumber: number; baseSha: string; headSha: string;
  findingFingerprint: string; state: SevereVerificationState; disposition: SevereVerificationDisposition;
  confidence?: number; reasonCode?: SevereVerificationCode;
  evidence: { files: SevereVerificationEvidenceFile[]; omitted: SevereVerificationEvidenceOmission[]; complete: boolean };
}

const SHA40 = "^[a-f0-9]{40}$";
const SHA256 = "^[a-f0-9]{64}$";
const SAFE_PATH = "^(?!/)(?![A-Za-z]:)(?!.*//)(?!.*(?:^|/)\\.{1,2}(?:/|$))(?!.*[\\\\\\u0000-\\u001f\\u007f-\\u009f])(?!.*\\/$).+$";
const STATE_RULES: Record<SevereVerificationState, { disposition: SevereVerificationDisposition; complete: boolean; reasons?: readonly SevereVerificationCode[] }> = {
  confirmed: { disposition: "retain", complete: true }, refuted: { disposition: "suppress", complete: true, reasons: ["refuted"] },
  failed: { disposition: "suppress", complete: false, reasons: ["provider_unavailable", "receipt_invalid"] },
  malformed: { disposition: "suppress", complete: false, reasons: ["malformed", "schema_invalid", "receipt_invalid"] },
  timeout: { disposition: "suppress", complete: false, reasons: ["timeout"] },
  unavailable: { disposition: "suppress", complete: false, reasons: ["unavailable", "provider_unavailable"] },
  stale_head: { disposition: "suppress", complete: false, reasons: ["stale_head", "identity_mismatch"] },
  incomplete: { disposition: "suppress", complete: false, reasons: ["incomplete", "not_read", "evidence_incomplete", "cap_exceeded"] }
};

const path = { type: "string", minLength: 1, maxLength: 4096, pattern: SAFE_PATH } as const;
export const SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA = {
  $id: "https://neondiff.com/schema/severe-verification-receipt-v1.json", type: "object", additionalProperties: false,
  required: ["schemaVersion", "repo", "pullNumber", "baseSha", "headSha", "findingFingerprint", "state", "disposition", "evidence"],
  properties: {
    schemaVersion: { const: "severe-verifier-v1" }, repo: { type: "string", minLength: 3, maxLength: 140, pattern: "^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?/[A-Za-z0-9_.-]{1,100}$" },
    pullNumber: { type: "integer", minimum: 1, maximum: Number.MAX_SAFE_INTEGER }, baseSha: { type: "string", pattern: SHA40 },
    headSha: { type: "string", pattern: SHA40 }, findingFingerprint: { type: "string", pattern: "^finding:[a-f0-9]{64}$" },
    state: { enum: SEVERE_VERIFICATION_STATES }, disposition: { enum: ["retain", "suppress"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }, reasonCode: { enum: SEVERE_VERIFICATION_CODES },
    evidence: {
      type: "object", additionalProperties: false, required: ["files", "omitted", "complete"],
      properties: {
        files: { type: "array", maxItems: 64, uniqueItems: true, uniqueWholeFilePaths: true, items: {
          type: "object", additionalProperties: false, required: ["path", "kind", "sha256", "bytes", "complete"],
          properties: { path, kind: { enum: ["whole_file", "module"] }, sha256: { type: "string", pattern: SHA256 }, bytes: { type: "integer", minimum: 0, maximum: 65_536 }, complete: { type: "boolean" } }
        } },
        omitted: { type: "array", maxItems: 64, items: {
          type: "object", additionalProperties: false, required: ["path", "code"],
          properties: { path, code: { enum: SEVERE_VERIFICATION_CODES } }
        } },
        complete: { type: "boolean" }
      },
      anyOf: [{ properties: { files: { type: "array", minItems: 1 } } }, { properties: { omitted: { type: "array", minItems: 1 } } }],
      allOf: [{ if: { properties: { complete: { const: true } }, required: ["complete"] }, then: { properties: {
        files: { type: "array", minItems: 1, items: { type: "object", properties: { complete: { const: true } } } },
        omitted: { type: "array", maxItems: 0 }
      } } }]
    }
  },
  allOf: SEVERE_VERIFICATION_STATES.map((state) => ({
    if: { properties: { state: { const: state } }, required: ["state"] },
    then: {
      properties: { disposition: { const: STATE_RULES[state].disposition }, evidence: { type: "object", properties: { complete: { const: STATE_RULES[state].complete } } },
        ...(STATE_RULES[state].reasons ? { reasonCode: { enum: STATE_RULES[state].reasons } } : { reasonCode: false }) },
      ...(STATE_RULES[state].reasons ? { required: ["reasonCode"] } : {})
    }
  }))
} as const;

export function compileSevereVerificationReceiptSchema(): ValidateFunction<SevereVerificationReceipt> {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  ajv.addKeyword({ keyword: "uniqueWholeFilePaths", type: "array", schemaType: "boolean", validate: (_schema: boolean, files: unknown[]) => {
    const seen = new Set<string>();
    for (const file of files) if (file && typeof file === "object" && !Array.isArray(file)) {
      const { kind, path } = file as { kind?: unknown; path?: unknown };
      if (kind === "whole_file" && typeof path === "string") { if (seen.has(path)) return false; seen.add(path); }
    }
    return true;
  } });
  return ajv.compile<SevereVerificationReceipt>(SEVERE_VERIFICATION_RECEIPT_JSON_SCHEMA);
}
