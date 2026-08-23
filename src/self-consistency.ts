import { decideReviewEvent } from "./findings.js";
import type { CategoryPrecisionFloors, RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
import type { PullFilePatch, ReviewComment, ReviewEvent, Severity } from "./types.js";

export interface SelfConsistencyRecheckConfig {
  enabled: boolean;
  severities?: Array<"P0" | "P1">;
  provider?: string;
  maxFindingsPerReview?: number;
}

export interface SelfConsistencySecondDrawInput {
  comment: ReviewComment;
  hunk: string;
}

export type SevereVerificationState = "confirmed" | "refuted" | "malformed" | "timeout" | "unavailable" | "stale_head" | "incomplete";

export interface SevereVerificationReceipt {
  schemaVersion: "severe-verifier-v1";
  repo: string;
  pullNumber: number;
  baseSha: string;
  findingFingerprint: string;
  headSha: string;
  state: SevereVerificationState;
  disposition: "retain" | "suppress";
  confidence?: number;
  reasonCode?: string;
  evidence: {
    files: Array<{ path: string; kind: "whole_file" | "module"; sha256: string; bytes: number; complete: boolean }>;
    omitted: Array<{ path: string; reason: string }>;
    complete: boolean;
  };
}

export type SelfConsistencySecondDrawResult =
  | { receipt: SevereVerificationReceipt }
  | { verified: boolean; confidence: number };

export interface SelfConsistencyVerdict {
  path: string;
  line: number;
  severity: Severity;
  title: string;
  originalConfidence: number;
  secondConfidence?: number;
  agreed?: boolean;
  refuted?: boolean;
  receipt?: SevereVerificationReceipt;
  error?: string;
}

const DEFAULT_SEVERITIES: Array<"P0" | "P1"> = ["P0", "P1"];
const DEFAULT_MAX_FINDINGS = 5;

export const SEVERE_VERIFIER_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "confidence"],
  properties: {
    verdict: { type: "string", enum: ["confirm", "refute"] },
    confidence: { type: "number", minimum: 0, maximum: 1 }
  }
} as const;

export function parseSevereVerifierOutput(value: unknown): { verdict: "confirm" | "refute"; confidence: number } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("severe_verifier_schema_invalid");
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  if (keys.length !== 2 || keys[0] !== "confidence" || keys[1] !== "verdict") throw new Error("severe_verifier_schema_invalid");
  if ((record.verdict !== "confirm" && record.verdict !== "refute") ||
      typeof record.confidence !== "number" || !Number.isFinite(record.confidence) ||
      record.confidence < 0 || record.confidence > 1) throw new Error("severe_verifier_schema_invalid");
  return { verdict: record.verdict, confidence: record.confidence };
}

function exactKeys(value: object, expected: string[], optional: string[] = []): boolean {
  const keys = Object.keys(value).sort();
  return expected.every((key) => keys.includes(key)) && keys.every((key) => expected.includes(key) || optional.includes(key));
}

function metadataString(value: unknown, max = 256): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max && !/[\r\n]/.test(value);
}

export function isSevereVerificationReceipt(value: unknown): value is SevereVerificationReceipt {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const receipt = value as Record<string, unknown>;
  if (!exactKeys(receipt, ["baseSha", "disposition", "evidence", "findingFingerprint", "headSha", "pullNumber", "repo", "schemaVersion", "state"], ["confidence", "reasonCode"])) return false;
  if (receipt.schemaVersion !== "severe-verifier-v1" || !metadataString(receipt.repo) ||
      typeof receipt.pullNumber !== "number" || !Number.isSafeInteger(receipt.pullNumber) || receipt.pullNumber < 1 ||
      !/^[a-f0-9]{40}$/.test(String(receipt.baseSha)) || !/^[a-f0-9]{40}$/.test(String(receipt.headSha)) ||
      !/^finding:[a-f0-9]{64}$/.test(String(receipt.findingFingerprint)) ||
      !["confirmed", "refuted", "malformed", "timeout", "unavailable", "stale_head", "incomplete"].includes(String(receipt.state)) ||
      !["retain", "suppress"].includes(String(receipt.disposition))) return false;
  if (receipt.confidence !== undefined && (typeof receipt.confidence !== "number" || !Number.isFinite(receipt.confidence) || receipt.confidence < 0 || receipt.confidence > 1)) return false;
  if (receipt.reasonCode !== undefined && (!metadataString(receipt.reasonCode, 64) || !/^[a-z0-9_.-]+$/.test(receipt.reasonCode))) return false;
  const evidence = receipt.evidence;
  if (typeof evidence !== "object" || evidence === null || Array.isArray(evidence)) return false;
  const evidenceRecord = evidence as Record<string, unknown>;
  if (!exactKeys(evidenceRecord, ["complete", "files", "omitted"]) || typeof evidenceRecord.complete !== "boolean" ||
      !Array.isArray(evidenceRecord.files) || !Array.isArray(evidenceRecord.omitted)) return false;
  if (!evidenceRecord.files.every((file) => {
    if (typeof file !== "object" || file === null || Array.isArray(file)) return false;
    const entry = file as Record<string, unknown>;
    return exactKeys(entry, ["bytes", "complete", "kind", "path", "sha256"]) && metadataString(entry.path) &&
      ["whole_file", "module"].includes(String(entry.kind)) && /^[a-f0-9]{64}$/.test(String(entry.sha256)) &&
      typeof entry.bytes === "number" && Number.isSafeInteger(entry.bytes) && entry.bytes >= 0 && typeof entry.complete === "boolean";
  })) return false;
  return evidenceRecord.omitted.every((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const omitted = entry as Record<string, unknown>;
    return exactKeys(omitted, ["path", "reason"]) && metadataString(omitted.path) && metadataString(omitted.reason, 64) && /^[a-z0-9_.-]+$/.test(omitted.reason);
  });
}

function hasCompleteEvidence(receipt: SevereVerificationReceipt): boolean {
  return receipt.evidence.complete && receipt.evidence.omitted.length === 0 && receipt.evidence.files.every((file) => file.complete);
}

function retainsSevereFinding(receipt: SevereVerificationReceipt): boolean {
  return receipt.state === "confirmed" && receipt.disposition === "retain" && hasCompleteEvidence(receipt) && receipt.confidence !== undefined;
}

/**
 * Opt-in P0/P1 self-consistency re-check (#303). For each gate-accepted comment at a configured
 * severity (post-dedup, pre-event-decision; capped by maxFindingsPerReview in ranked order), issue
 * ONE bounded second draw. Only a schema-valid confirmed receipt with complete evidence can retain a
 * severe finding; every other outcome is suppressed. Disabled ⇒ no second draw, byte-identical output.
 */
export async function runSelfConsistencyRecheck(input: {
  comments: ReviewComment[];
  files: PullFilePatch[];
  config: SelfConsistencyRecheckConfig;
  requestChangesConfidenceFloors?: RequestChangesConfidenceFloors;
  categoryPrecisionFloors?: CategoryPrecisionFloors;
  secondDraw: (input: SelfConsistencySecondDrawInput) => SelfConsistencySecondDrawResult | Promise<SelfConsistencySecondDrawResult>;
}): Promise<{ comments: ReviewComment[]; event: ReviewEvent; verdicts: SelfConsistencyVerdict[] }> {
  if (!input.config.enabled) {
    return {
      comments: input.comments,
      event: decideReviewEvent(input.comments, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors),
      verdicts: []
    };
  }

  const severities = new Set<Severity>(input.config.severities ?? DEFAULT_SEVERITIES);
  const maxFindings = input.config.maxFindingsPerReview ?? DEFAULT_MAX_FINDINGS;
  const verdicts: SelfConsistencyVerdict[] = [];
  let rechecked = 0;

  // input.comments is already in the gate's ranked (highest-confidence-first) order.
  const comments: ReviewComment[] = [];
  for (const comment of input.comments) {
    if (!severities.has(comment.severity)) {
      comments.push(comment);
      continue;
    }

    const base: SelfConsistencyVerdict = {
      path: comment.path,
      line: comment.line,
      severity: comment.severity,
      title: comment.title,
      originalConfidence: comment.confidence
    };

    if (rechecked >= maxFindings) {
      verdicts.push({ ...base, error: "severe_verifier_cap_exceeded" });
      continue;
    }
    rechecked += 1;

    let draw: SelfConsistencySecondDrawResult;
    try {
      draw = await input.secondDraw({ comment, hunk: extractHunk(comment, input.files) });
    } catch (error) {
      verdicts.push({ ...base, error: error instanceof Error ? error.message : String(error) });
      continue;
    }

    if (typeof draw !== "object" || draw === null || !("receipt" in draw) || !isSevereVerificationReceipt(draw.receipt)) {
      verdicts.push({ ...base, error: "severe_verifier_receipt_invalid" });
      continue;
    }

    if (retainsSevereFinding(draw.receipt)) {
      verdicts.push({ ...base, secondConfidence: draw.receipt.confidence, agreed: true, refuted: false, receipt: draw.receipt });
      comments.push(comment);
      continue;
    }

    verdicts.push({ ...base, ...(draw.receipt.confidence !== undefined ? { secondConfidence: draw.receipt.confidence } : {}), agreed: false, refuted: true, receipt: draw.receipt });
  }

  const event = decideReviewEvent(comments, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors);

  return { comments, event, verdicts };
}

/**
 * The relevant diff hunk for a finding: the changed file's patch (bounded, already redacted upstream).
 * Reuses the main prompt's read-only posture — no repo files are read, only the provided patch.
 */
export function extractHunk(comment: Pick<ReviewComment, "path">, files: PullFilePatch[]): string {
  const file = files.find((candidate) => candidate.filename === comment.path);
  return file?.patch ?? "";
}
