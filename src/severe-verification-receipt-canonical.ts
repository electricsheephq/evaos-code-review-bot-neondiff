import { createHash } from "node:crypto";
import type { SerializedSevereVerificationInput } from "./severe-verification-receipt-parser-a.js";
import { parseSevereVerificationReceiptJson } from "./severe-verification-receipt-parser-b.js";
import { parseSevereVerificationReceipt } from "./severe-verification-receipt-parser-c.js";
import type {
  SevereVerificationEvidenceFile,
  SevereVerificationEvidenceOmission,
  SevereVerificationReceipt
} from "./severe-verification-receipt-schema.js";

const intrinsicStringify = JSON.stringify;

export interface CanonicalSevereVerificationReceipt {
  receipt: SevereVerificationReceipt;
  canonicalJson: string;
  digest: string;
}

/** Revalidate, order, and hash a metadata-only severe-verification receipt. */
export function canonicalizeSevereVerificationReceipt(input: SerializedSevereVerificationInput): CanonicalSevereVerificationReceipt {
  const parsed = parseSevereVerificationReceipt(parseSevereVerificationReceiptJson(input));
  const files = parsed.evidence.files.map(copyFile).sort(compareFiles);
  const omitted = parsed.evidence.omitted.map(copyOmission).sort(compareOmissions);
  const receipt: SevereVerificationReceipt = {
    schemaVersion: parsed.schemaVersion,
    repo: parsed.repo,
    pullNumber: parsed.pullNumber,
    baseSha: parsed.baseSha,
    headSha: parsed.headSha,
    findingFingerprint: parsed.findingFingerprint,
    state: parsed.state,
    disposition: parsed.disposition,
    ...(parsed.confidence === undefined ? {} : { confidence: parsed.confidence }),
    ...(parsed.reasonCode === undefined ? {} : { reasonCode: parsed.reasonCode }),
    evidence: { files, omitted, complete: parsed.evidence.complete }
  };
  const canonicalJson = serializeReceipt(receipt);
  return {
    receipt,
    canonicalJson,
    digest: createHash("sha256").update(canonicalJson, "utf8").digest("hex")
  };
}

function copyFile(file: SevereVerificationEvidenceFile): SevereVerificationEvidenceFile {
  return { path: file.path, kind: file.kind, sha256: file.sha256, bytes: file.bytes, complete: file.complete };
}

function copyOmission(item: SevereVerificationEvidenceOmission): SevereVerificationEvidenceOmission {
  return { path: item.path, code: item.code };
}

function compareFiles(a: SevereVerificationEvidenceFile, b: SevereVerificationEvidenceFile): number {
  return compareText(a.path, b.path) || compareText(a.kind, b.kind) || compareText(a.sha256, b.sha256)
    || a.bytes - b.bytes || Number(a.complete) - Number(b.complete);
}

function compareOmissions(a: SevereVerificationEvidenceOmission, b: SevereVerificationEvidenceOmission): number {
  return compareText(a.path, b.path) || compareText(a.code, b.code);
}

function compareText(a: string, b: string): number {
  let left = 0;
  let right = 0;
  while (left < a.length && right < b.length) {
    const aCode = a.codePointAt(left)!;
    const bCode = b.codePointAt(right)!;
    if (aCode !== bCode) return aCode < bCode ? -1 : 1;
    left += aCode > 0xffff ? 2 : 1;
    right += bCode > 0xffff ? 2 : 1;
  }
  return a.length - b.length;
}

function serializeReceipt(receipt: SevereVerificationReceipt): string {
  const quote = (value: string): string => intrinsicStringify(value);
  let output = `{"schemaVersion":${quote(receipt.schemaVersion)},"repo":${quote(receipt.repo)},"pullNumber":${receipt.pullNumber},"baseSha":${quote(receipt.baseSha)},"headSha":${quote(receipt.headSha)},"findingFingerprint":${quote(receipt.findingFingerprint)},"state":${quote(receipt.state)},"disposition":${quote(receipt.disposition)}`;
  if (receipt.confidence !== undefined) output += `,"confidence":${intrinsicStringify(receipt.confidence)}`;
  if (receipt.reasonCode !== undefined) output += `,"reasonCode":${quote(receipt.reasonCode)}`;
  output += `,"evidence":{"files":[`;
  for (let index = 0; index < receipt.evidence.files.length; index += 1) {
    if (index > 0) output += ",";
    const file = receipt.evidence.files[index];
    output += `{"path":${quote(file.path)},"kind":${quote(file.kind)},"sha256":${quote(file.sha256)},"bytes":${file.bytes},"complete":${file.complete}}`;
  }
  output += `],"omitted":[`;
  for (let index = 0; index < receipt.evidence.omitted.length; index += 1) {
    if (index > 0) output += ",";
    const item = receipt.evidence.omitted[index];
    output += `{"path":${quote(item.path)},"code":${quote(item.code)}}`;
  }
  return `${output}],"complete":${receipt.evidence.complete}}}`;
}
