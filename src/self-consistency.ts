import { decideReviewEvent } from "./findings.js";
import { isRequestChangesEligible, type CategoryPrecisionFloors, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
import { canonicalizeSevereVerificationReceipt, type CanonicalSevereVerificationReceipt } from "./severe-verification-receipt-canonical.js";
import type { SevereVerificationReceipt } from "./severe-verification-receipt-schema.js";
import type { PullFilePatch, ReviewComment, ReviewEvent, Severity } from "./types.js";

export type { SevereVerificationReceipt } from "./severe-verification-receipt-schema.js";

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

export interface SelfConsistencyReviewContext {
  repo: string;
  pullNumber: number;
  baseSha: string;
  headSha: string;
}

/** The injected runner must return the canonical result produced by transport parsing. */
export type SelfConsistencySecondDrawResult = unknown;

interface SelfConsistencyCanonicalResult extends CanonicalSevereVerificationReceipt {
  receipt: SevereVerificationReceipt;
}

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

/**
 * Opt-in P0/P1 self-consistency re-check (#303). For each gate-accepted comment at a configured
 * severity (post-dedup, pre-event-decision; capped by maxFindingsPerReview in the ranked order the
 * gate already produced), issue ONE bounded second draw. Only a canonical, complete, confirmed and
 * retained receipt bound to the current review context keeps a severe comment. Every invalid,
 * failed, stale, incomplete, refuted, or capped result suppresses that severe comment. Advisory
 * P2/P3 comments are never sent to the verifier and remain available. Disabled ⇒ no second draw,
 * byte-identical output. The second-draw runner is injected so callers pick the provider and tests
 * stay hermetic.
 */
export async function runSelfConsistencyRecheck(input: {
  comments: ReviewComment[];
  files: PullFilePatch[];
  config: SelfConsistencyRecheckConfig;
  reviewContext?: SelfConsistencyReviewContext;
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
      verdicts.push({ ...base, error: "severe_verifier_cap_exceeded", refuted: true });
      continue;
    }
    rechecked += 1;

    let draw: SelfConsistencySecondDrawResult;
    try {
      draw = await input.secondDraw({ comment, hunk: extractHunk(comment, input.files) });
    } catch {
      verdicts.push({ ...base, error: "severe_verifier_unavailable", refuted: true });
      continue;
    }

    const canonical = parseCanonicalResult(draw);
    if (!canonical) {
      verdicts.push({ ...base, error: "severe_verifier_receipt_invalid", refuted: true });
      continue;
    }
    const receipt = canonical.receipt;
    if (retainsSevereFinding(receipt, comment, input.reviewContext)) {
      // Agreement: never raise confidence; keep the original.
      verdicts.push({ ...base, ...(receipt.confidence === undefined ? {} : { secondConfidence: receipt.confidence }), agreed: true, refuted: false, receipt });
      comments.push(comment);
      continue;
    }

    // Any non-retained receipt is quieter-only: suppress the severe publication.
    verdicts.push({ ...base, ...(receipt.confidence === undefined ? {} : { secondConfidence: receipt.confidence }), agreed: false, refuted: true, receipt });
  }

  // Re-derive the event from only comments that remain publishable after the gate.
  const event = comments.some((comment) => isRequestChangesEligible(comment, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors))
    ? "REQUEST_CHANGES" : "COMMENT";

  return { comments, event, verdicts };
}

function parseCanonicalResult(value: unknown): SelfConsistencyCanonicalResult | undefined {
  if (!isRecord(value)) return undefined;
  const keys = Object.keys(value).sort();
  if (keys.length !== 3 || keys[0] !== "canonicalJson" || keys[1] !== "digest" || keys[2] !== "receipt") return undefined;
  if (typeof value.canonicalJson !== "string" || typeof value.digest !== "string" || !isRecord(value.receipt)) return undefined;
  try {
    const canonical = canonicalizeSevereVerificationReceipt(value.canonicalJson);
    return canonical.canonicalJson === value.canonicalJson && canonical.digest === value.digest && sameJsonData(canonical.receipt, value.receipt)
      ? canonical
      : undefined;
  } catch {
    return undefined;
  }
}

function retainsSevereFinding(receipt: SevereVerificationReceipt, comment: ReviewComment, context: SelfConsistencyReviewContext | undefined): boolean {
  if (!context || receipt.state !== "confirmed" || receipt.disposition !== "retain") return false;
  return receipt.repo === context.repo && receipt.pullNumber === context.pullNumber && receipt.baseSha === context.baseSha && receipt.headSha === context.headSha && receipt.findingFingerprint === comment.fingerprint && hasCompleteEvidence(receipt, comment.path);
}

function hasCompleteEvidence(receipt: SevereVerificationReceipt, findingPath: string): boolean {
  return receipt.evidence.complete && receipt.evidence.changedHunk?.complete === true && receipt.evidence.omitted.length === 0 && receipt.evidence.files.length > 0 && receipt.evidence.files.every((file) => file.complete) && receipt.evidence.files.some((file) => file.kind === "whole_file" && file.path === findingPath);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameJsonData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((value, index) => sameJsonData(value, right[index]));
  if (!isRecord(left) || !isRecord(right)) return false;
  const leftKeys = Object.keys(left).sort(), rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameJsonData(left[key], right[key]));
}

/**
 * The relevant diff hunk for a finding: the changed file's patch (bounded, already redacted upstream).
 * Reuses the main prompt's read-only posture — no repo files are read, only the provided patch.
 */
export function extractHunk(comment: Pick<ReviewComment, "path">, files: PullFilePatch[]): string {
  const file = files.find((candidate) => candidate.filename === comment.path);
  return file?.patch ?? "";
}
