import { createHash } from "node:crypto";
import { validateFindingLocations } from "./diff.js";
import { decideReviewEvent, normalizeFindingsForReview } from "./findings.js";
import type { PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { countCategories, isRequestChangesEligible, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
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
  repoMemoryFalsePositiveFingerprints?: string[];
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  requestChangesConfidenceFloors?: RequestChangesConfidenceFloors;
}): DeterministicReviewGateResult {
  const located = validateFindingLocations(input.findings, input.files);
  // Memory suppression intentionally precedes normalization; dropReasonCounts reflects that ordering.
  const repoMemoryFiltered = applyRepoMemoryFalsePositiveSuppressions(
    located.valid,
    input.repoMemoryFalsePositiveFingerprints ?? []
  );
  const normalized = normalizeFindingsForReview(repoMemoryFiltered.findings, {
    maxInlineComments: input.maxInlineComments,
    publicConfidencePolicy: input.publicConfidencePolicy
  });
  const dropped = [
    ...(input.droppedFromSchema ?? []),
    ...located.dropped,
    ...repoMemoryFiltered.dropped,
    ...normalized.dropped
  ];
  const comments = normalized.comments;
  const event = decideReviewEvent(comments, input.requestChangesConfidenceFloors);

  return {
    event,
    comments,
    dropped,
    summary: {
      inputFindings: input.findings.length,
      acceptedComments: comments.length,
      droppedFindings: dropped.length,
      event,
      requestChangesEligible: comments.filter((comment) => isRequestChangesEligible(comment, input.requestChangesConfidenceFloors)).length,
      categoryCounts: countCategories(comments),
      dropReasonCounts: countDropReasons(dropped)
    }
  };
}

export function buildFindingFingerprint(
  finding: Pick<Finding, "severity" | "path" | "line" | "title" | "body" | "category" | "why_this_matters">
): string {
  const canonical = JSON.stringify({
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    title: finding.title.trim().toLowerCase(),
    body: finding.body.trim().toLowerCase(),
    why_this_matters: finding.why_this_matters?.trim().toLowerCase() ?? "",
    category: finding.category ?? "unknown"
  });
  return `finding:${createHash("sha256").update(canonical).digest("hex")}`;
}

function applyRepoMemoryFalsePositiveSuppressions(
  findings: Finding[],
  fingerprints: string[]
): { findings: Finding[]; dropped: DroppedFinding[] } {
  if (!fingerprints.length) return { findings, dropped: [] };
  const fingerprintSet = new Set(fingerprints);
  const accepted: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  for (const finding of findings) {
    const fingerprint = buildFindingFingerprint(finding);
    if (isMemorySuppressible(finding) && fingerprintSet.has(fingerprint)) {
      dropped.push({ ...finding, reason: "repo_memory_false_positive_match", fingerprint });
      continue;
    }
    accepted.push(finding);
  }
  return { findings: accepted, dropped };
}

function isMemorySuppressible(finding: Finding): boolean {
  return finding.severity === "P2" || finding.severity === "P3";
}

function countDropReasons(dropped: DroppedFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of dropped) counts[finding.reason] = (counts[finding.reason] ?? 0) + 1;
  return counts;
}
