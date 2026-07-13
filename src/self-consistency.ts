import { decideReviewEvent } from "./findings.js";
import { isRequestChangesEligible, type CategoryPrecisionFloors, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
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

export interface SelfConsistencySecondDrawResult {
  verified: boolean;
  confidence: number;
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
  error?: string;
}

const DEFAULT_SEVERITIES: Array<"P0" | "P1"> = ["P0", "P1"];
const DEFAULT_MAX_FINDINGS = 5;

/**
 * Opt-in P0/P1 self-consistency re-check (#303). For each gate-accepted comment at a configured
 * severity (post-dedup, pre-event-decision; capped by maxFindingsPerReview in the ranked order the
 * gate already produced), issue ONE bounded second draw asking verify/refute + confidence. The merge
 * is strictly QUIETER-ONLY: agreement keeps the original confidence (never raised); refutation sets
 * confidence to min(original, second) AND strips REQUEST_CHANGES eligibility for that comment. Any
 * second-draw failure leaves the comment untouched (never blocks/drops the review). The event is then
 * re-derived from the comments that retain eligibility. Disabled ⇒ no second draw, byte-identical
 * output. The second-draw runner is injected so callers pick the provider and tests stay hermetic.
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
  const refutedKeys = new Set<string>();
  let rechecked = 0;

  // input.comments is already in the gate's ranked (highest-confidence-first) order.
  const comments: ReviewComment[] = [];
  for (const comment of input.comments) {
    if (rechecked >= maxFindings || !severities.has(comment.severity)) {
      comments.push(comment);
      continue;
    }
    rechecked += 1;

    const base: SelfConsistencyVerdict = {
      path: comment.path,
      line: comment.line,
      severity: comment.severity,
      title: comment.title,
      originalConfidence: comment.confidence
    };

    let draw: SelfConsistencySecondDrawResult;
    try {
      draw = await input.secondDraw({ comment, hunk: extractHunk(comment, input.files) });
    } catch (error) {
      // Failure posture: keep the finding untouched; the re-check can only make output quieter.
      verdicts.push({ ...base, error: error instanceof Error ? error.message : String(error) });
      comments.push(comment);
      continue;
    }

    if (draw.verified) {
      // Agreement: never raise confidence; keep the original.
      verdicts.push({ ...base, secondConfidence: draw.confidence, agreed: true, refuted: false });
      comments.push(comment);
      continue;
    }

    // Refutation: quieter-only — lower confidence and strip REQUEST_CHANGES eligibility.
    verdicts.push({ ...base, secondConfidence: draw.confidence, agreed: false, refuted: true });
    refutedKeys.add(commentKey(comment));
    comments.push({ ...comment, confidence: Math.min(comment.confidence, draw.confidence) });
  }

  // Re-derive the event: a refuted comment still POSTS but no longer counts toward REQUEST_CHANGES.
  const eligibleComments = comments.filter((comment) => !refutedKeys.has(commentKey(comment)));
  const event = eligibleComments.some((comment) => isRequestChangesEligible(comment, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors))
    ? "REQUEST_CHANGES"
    : "COMMENT";

  return { comments, event, verdicts };
}

function commentKey(comment: Pick<ReviewComment, "path" | "line" | "title">): string {
  return `${comment.path}${comment.line}${comment.title}`;
}

/**
 * The relevant diff hunk for a finding: the changed file's patch (bounded, already redacted upstream).
 * Reuses the main prompt's read-only posture — no repo files are read, only the provided patch.
 */
export function extractHunk(comment: Pick<ReviewComment, "path">, files: PullFilePatch[]): string {
  const file = files.find((candidate) => candidate.filename === comment.path);
  return file?.patch ?? "";
}
