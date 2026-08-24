import { createHash } from "node:crypto";
import { parseSevereVerificationReceipt } from "./severe-verification-receipt-parser-c.js";
import type {
  SevereVerificationEvidenceFile,
  SevereVerificationEvidenceOmission,
  SevereVerificationReceipt
} from "./severe-verification-receipt-schema.js";

export interface CanonicalSevereVerificationReceipt {
  receipt: SevereVerificationReceipt;
  canonicalJson: string;
  digest: string;
}

/** Revalidate, order, and hash a metadata-only severe-verification receipt. */
export function canonicalizeSevereVerificationReceipt(input: unknown): CanonicalSevereVerificationReceipt {
  const parsed = parseSevereVerificationReceipt(input);
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
  const canonicalJson = JSON.stringify(receipt);
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
  return a < b ? -1 : a > b ? 1 : 0;
}
