import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import { countCategories, isRequestChangesEligible } from "./regression-taxonomy.js";
import type {
  DeterministicReviewGateSummary,
  DroppedFinding,
  Finding,
  PullFilePatch,
  ReviewComment,
  ReviewEvent
} from "./types.js";

export interface DeterministicReviewGateResult {
  event: ReviewEvent;
  comments: ReviewComment[];
  dropped: DroppedFinding[];
  summary: DeterministicReviewGateSummary;
}

export function applyDeterministicReviewGate(input: {
  findings: Finding[];
  files: PullFilePatch[];
  droppedFromSchema?: DroppedFinding[];
  maxInlineComments?: number;
}): DeterministicReviewGateResult {
  const located = validateFindingLocations(input.findings, input.files);
  const normalized = normalizeFindingsForReview(located.valid, { maxInlineComments: input.maxInlineComments });
  const dropped = [...(input.droppedFromSchema ?? []), ...located.dropped, ...normalized.dropped];
  const comments = normalized.comments;
  const event = decideReviewEvent(comments);

  return {
    event,
    comments,
    dropped,
    summary: {
      inputFindings: input.findings.length,
      acceptedComments: comments.length,
      droppedFindings: dropped.length,
      event,
      requestChangesEligible: comments.filter((comment) => isRequestChangesEligible(comment)).length,
      categoryCounts: countCategories(comments),
      dropReasonCounts: countDropReasons(dropped)
    }
  };
}

function countDropReasons(dropped: DroppedFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of dropped) counts[finding.reason] = (counts[finding.reason] ?? 0) + 1;
  return counts;
}
