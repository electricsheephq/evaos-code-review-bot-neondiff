import { createHash } from "node:crypto";
import { validateFindingLocations } from "./diff.js";
import {
  decideReviewEvent,
  normalizeFindingsForReview,
  normalizeTitleForDedup,
  sanitizeDroppedFinding,
  SAME_RUN_DEDUP_MAX_LINE_DELTA,
  titlesAreNearDuplicate
} from "./findings.js";
import type { PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { countCategories, isRequestChangesEligible, normalizeFindingCategory, type CategoryPrecisionFloors, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
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

/**
 * A remembered false-positive, structured so the gate can match it two ways (#302): the exact
 * sha256 `fingerprint` (unchanged #294 semantics) AND a coarse fallback consulted only on exact-miss
 * (path + normalized category + line window + normalized-title near-match). Coarse fields must be
 * carried on the note so a diff-churn line shift or model rewording can still be learned away.
 * `confirmedByHuman` gates the P0/P1 override: auto-learned notes stay P2/P3-only.
 */
export interface RepoMemoryFalsePositiveEntry {
  fingerprint: string;
  path: string;
  category: string;
  line: number;
  title: string;
  confirmedByHuman?: boolean;
}

export function applyDeterministicReviewGate(input: {
  findings: Finding[];
  files: PullFilePatch[];
  droppedFromSchema?: DroppedFinding[];
  maxInlineComments?: number;
  repoMemoryFalsePositiveFingerprints?: string[];
  repoMemoryFalsePositives?: RepoMemoryFalsePositiveEntry[];
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  requestChangesConfidenceFloors?: RequestChangesConfidenceFloors;
  categoryPrecisionFloors?: CategoryPrecisionFloors;
}): DeterministicReviewGateResult {
  const located = validateFindingLocations(input.findings, input.files);
  // Memory suppression intentionally precedes normalization; dropReasonCounts reflects that ordering.
  const repoMemoryFiltered = applyRepoMemoryFalsePositiveSuppressions(
    located.valid,
    input.repoMemoryFalsePositiveFingerprints ?? [],
    input.repoMemoryFalsePositives ?? []
  );
  const normalized = normalizeFindingsForReview(repoMemoryFiltered.findings, {
    maxInlineComments: input.maxInlineComments,
    publicConfidencePolicy: input.publicConfidencePolicy
  });
  // Enforce redaction at the module boundary (#283): every drop the gate emits — repo-memory
  // suppressions, location drops, and schema drops that may still carry raw finding text — is
  // sanitized here so a leak cannot depend on the caller re-sanitizing. normalized.dropped is
  // already sanitized inside normalizeFindingsForReview; re-running the idempotent sanitizer on it
  // is a no-op, and the same idempotency makes worker.ts's second pass a no-op too.
  const dropped = [
    ...(input.droppedFromSchema ?? []),
    ...located.dropped,
    ...repoMemoryFiltered.dropped,
    ...normalized.dropped
  ].map((finding) => sanitizeDroppedFinding(finding, input.publicConfidencePolicy));
  const comments = normalized.comments;
  const event = decideReviewEvent(comments, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors);

  return {
    event,
    comments,
    dropped,
    summary: {
      inputFindings: input.findings.length,
      acceptedComments: comments.length,
      droppedFindings: dropped.length,
      event,
      requestChangesEligible: comments.filter((comment) => isRequestChangesEligible(comment, input.requestChangesConfidenceFloors, input.categoryPrecisionFloors)).length,
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
  fingerprints: string[],
  entries: RepoMemoryFalsePositiveEntry[]
): { findings: Finding[]; dropped: DroppedFinding[] } {
  if (!fingerprints.length && !entries.length) return { findings, dropped: [] };
  // Exact fingerprints from the legacy input and from the structured entries share one exact index.
  const exactFingerprints = new Map<string, RepoMemoryFalsePositiveEntry | undefined>();
  for (const fingerprint of fingerprints) if (!exactFingerprints.has(fingerprint)) exactFingerprints.set(fingerprint, undefined);
  for (const entry of entries) if (!exactFingerprints.has(entry.fingerprint)) exactFingerprints.set(entry.fingerprint, entry);
  const accepted: Finding[] = [];
  const dropped: DroppedFinding[] = [];
  for (const finding of findings) {
    const fingerprint = buildFindingFingerprint(finding);
    // Exact match first: unchanged #294 semantics. Auto-learned notes stay P2/P3-only; a matched
    // entry known to be human-confirmed may suppress any severity even on the exact path.
    if (exactFingerprints.has(fingerprint)) {
      const exactEntry = exactFingerprints.get(fingerprint);
      if (isMemorySuppressible(finding, exactEntry?.confirmedByHuman)) {
        dropped.push({ ...finding, reason: "repo_memory_false_positive_match", fingerprint });
        continue;
      }
      accepted.push(finding);
      continue;
    }
    // Coarse fallback: ONLY on exact-miss, reusing the #294 near-match semantics so the two can
    // never drift. A missed FP is cheaper than suppressing a genuine distinct finding.
    const coarse = findCoarseFalsePositiveMatch(finding, entries);
    if (coarse && isMemorySuppressible(finding, coarse.confirmedByHuman)) {
      dropped.push({ ...finding, reason: "repo_memory_false_positive_coarse_match", fingerprint: coarse.fingerprint });
      continue;
    }
    accepted.push(finding);
  }
  return { findings: accepted, dropped };
}

function findCoarseFalsePositiveMatch(
  finding: Finding,
  entries: RepoMemoryFalsePositiveEntry[]
): RepoMemoryFalsePositiveEntry | undefined {
  if (!entries.length) return undefined;
  const category = normalizeFindingCategory(finding);
  const normalizedTitle = normalizeTitleForDedup(finding.title);
  return entries.find(
    (entry) =>
      entry.path === finding.path &&
      entry.category === category &&
      Math.abs(entry.line - finding.line) <= SAME_RUN_DEDUP_MAX_LINE_DELTA &&
      titlesAreNearDuplicate(normalizedTitle, normalizeTitleForDedup(entry.title))
  );
}

function isMemorySuppressible(finding: Finding, confirmedByHuman?: boolean): boolean {
  // Human-confirmed false positives may suppress ANY severity; auto-learned notes stay P2/P3-only.
  if (confirmedByHuman === true) return true;
  return finding.severity === "P2" || finding.severity === "P3";
}

function countDropReasons(dropped: DroppedFinding[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const finding of dropped) counts[finding.reason] = (counts[finding.reason] ?? 0) + 1;
  return counts;
}
