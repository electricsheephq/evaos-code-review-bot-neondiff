import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets.js";
import type { OutcomeLedgerPostMergeStatus } from "./outcome-ledger.js";
import type {
  FindingOutcomeLabelRecord,
  FindingOutcomeLabelSource,
  FindingOutcomeVerdict,
  ReviewStateStore
} from "./state.js";
import type { Severity } from "./types.js";

const OUTCOME_LINE_WINDOW = 3;

export interface ObservedFinding {
  fingerprint: string;
  path: string;
  line: number;
  severity: Severity;
  category: string;
  confidence: number;
}

/**
 * The read-only post-merge signals the observer derives labels from. `mergedFixLines`/`hotfixLines`
 * are path -> changed-line sets, produced by collectRightSideLines over the relevant diffs so the
 * "touches flagged lines" logic reuses the same matching primitive as the review gate (no fork).
 */
export interface ObservedPullOutcome {
  merged: boolean;
  revertedFlaggedChange: boolean;
  hotfixLines: Map<string, Set<number>>;
  mergedFixLines: Map<string, Set<number>>;
  humanThreadResolved: boolean;
  evidenceRef?: string;
}

export interface DerivedOutcomeLabel {
  labelSource: FindingOutcomeLabelSource;
  verdict: FindingOutcomeVerdict;
  postMergeStatus: OutcomeLedgerPostMergeStatus;
  riskClaimStatus: "validated" | "dismissed" | "unvalidated";
}

/**
 * Pure precedence resolver (#286 PR A): revert > hotfix-touching-flagged > merged-fix-diff-touching-
 * flagged > human-thread-resolution > none_observed. Revert/hotfix/merged-fix all VALIDATE the
 * finding (true_positive); a human thread that resolved it without any code touching the flagged
 * lines DISMISSES it (false_positive); nothing observed stays unvalidated.
 */
export function deriveOutcomeLabel(input: { finding: ObservedFinding; observed: ObservedPullOutcome }): DerivedOutcomeLabel {
  const { finding, observed } = input;
  if (observed.revertedFlaggedChange) {
    return { labelSource: "revert", verdict: "true_positive", postMergeStatus: "reverted", riskClaimStatus: "validated" };
  }
  if (diffTouchesFinding(observed.hotfixLines, finding)) {
    return { labelSource: "hotfix", verdict: "true_positive", postMergeStatus: "hotfixed", riskClaimStatus: "validated" };
  }
  if (diffTouchesFinding(observed.mergedFixLines, finding)) {
    return { labelSource: "merged_fix", verdict: "true_positive", postMergeStatus: "regression_seen", riskClaimStatus: "validated" };
  }
  if (observed.humanThreadResolved) {
    return { labelSource: "human_thread", verdict: "false_positive", postMergeStatus: "no_incident_seen", riskClaimStatus: "dismissed" };
  }
  return { labelSource: "none_observed", verdict: "unvalidated", postMergeStatus: "no_incident_seen", riskClaimStatus: "unvalidated" };
}

function diffTouchesFinding(lines: Map<string, Set<number>>, finding: ObservedFinding): boolean {
  const touched = lines.get(finding.path);
  if (!touched) return false;
  for (const line of touched) {
    if (Math.abs(line - finding.line) <= OUTCOME_LINE_WINDOW) return true;
  }
  return false;
}

export interface OutcomeObserverReview {
  repo: string;
  pullNumber: number;
  headSha: string;
  findings: ObservedFinding[];
}

export interface OutcomeObserverResult {
  ok: boolean;
  observed: number;
  skipped: number;
  labeled: number;
  observations: OutcomeObserverObservation[];
}

interface OutcomeObserverObservation {
  repo: string;
  pullNumber: number;
  headSha: string;
  postMergeOutcome: { status: OutcomeLedgerPostMergeStatus };
  riskClaims: Array<{ fingerprint: string; severity: Severity; category: string; status: string; labelSource: FindingOutcomeLabelSource }>;
}

/**
 * Batch, read-only observer (#286 PR A). Walks the supplied merged reviews, derives an outcome label
 * per flagged finding, records labels (idempotent upsert), and writes a redacted evidence packet that
 * fills the ledger's postMergeOutcome/riskClaims.status. UNMERGED reviews are SKIPPED (never labeled).
 * `fetchOutcome` is injected so the caller owns the read-only GitHub access and tests stay hermetic.
 * `dryRun` (default true) still writes the evidence packet but does not persist labels.
 */
export function runOutcomeObserver(input: {
  store: ReviewStateStore;
  evidenceDir: string;
  reviews: OutcomeObserverReview[];
  fetchOutcome: (review: OutcomeObserverReview) => ObservedPullOutcome;
  now?: Date;
  dryRun?: boolean;
}): OutcomeObserverResult {
  const observedAt = (input.now ?? new Date()).toISOString();
  const dryRun = input.dryRun ?? false;
  const observations: OutcomeObserverObservation[] = [];
  let skipped = 0;
  let labeled = 0;

  for (const review of input.reviews) {
    const outcome = input.fetchOutcome(review);
    if (!outcome.merged) {
      // Unmerged PRs are skipped, not labeled: no post-merge signal exists yet.
      skipped += 1;
      continue;
    }

    const riskClaims: OutcomeObserverObservation["riskClaims"] = [];
    let postMergeStatus: OutcomeLedgerPostMergeStatus = "no_incident_seen";
    for (const finding of review.findings) {
      const derived = deriveOutcomeLabel({ finding, observed: outcome });
      postMergeStatus = escalatePostMergeStatus(postMergeStatus, derived.postMergeStatus);
      const record: FindingOutcomeLabelRecord = {
        fingerprint: finding.fingerprint,
        repo: review.repo,
        pullNumber: review.pullNumber,
        headSha: review.headSha,
        severity: finding.severity,
        category: finding.category,
        confidence: finding.confidence,
        labelSource: derived.labelSource,
        verdict: derived.verdict,
        observedAt,
        ...(outcome.evidenceRef ? { evidenceRef: outcome.evidenceRef } : {})
      };
      if (!dryRun) {
        input.store.recordFindingOutcomeLabel(record);
        labeled += 1;
      }
      riskClaims.push({
        fingerprint: finding.fingerprint,
        severity: finding.severity,
        category: finding.category,
        status: derived.riskClaimStatus,
        labelSource: derived.labelSource
      });
    }

    observations.push({
      repo: review.repo,
      pullNumber: review.pullNumber,
      headSha: review.headSha,
      postMergeOutcome: { status: postMergeStatus },
      riskClaims
    });
  }

  const packet = { ok: true, dryRun, observedAt, observed: input.reviews.length, skipped, labeled, observations };
  mkdirSync(input.evidenceDir, { recursive: true });
  writeFileSync(join(input.evidenceDir, "outcome-observer.json"), `${redactSecrets(JSON.stringify(packet, null, 2))}\n`);

  return { ok: true, observed: input.reviews.length, skipped, labeled, observations };
}

interface OutcomeObserverInputEntry {
  review: OutcomeObserverReview;
  observed: ObservedPullOutcome;
}

/**
 * Parse a dry-run observer input file (mirrors the outcome-scorecard dry-run-input CLI posture).
 * Live GitHub walking is intentionally NOT part of PR A — the batch command consumes an evidence-
 * derived input so the observer + label store can ship and be exercised read-only first.
 */
export function readOutcomeObserverInput(path: string): OutcomeObserverInputEntry[] {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof value !== "object" || value === null || !Array.isArray((value as { reviews?: unknown }).reviews)) {
    throw new Error("outcome observer input requires a reviews array");
  }
  return (value as { reviews: unknown[] }).reviews.map((raw, index) => parseObserverInputEntry(raw, index));
}

export function runOutcomeObserverFromInput(input: {
  store: ReviewStateStore;
  entries: OutcomeObserverInputEntry[];
  evidenceDir: string;
  dryRun: boolean;
  now?: Date;
}): OutcomeObserverResult {
  const byKey = new Map<string, ObservedPullOutcome>();
  for (const entry of input.entries) {
    byKey.set(`${entry.review.repo}#${entry.review.pullNumber}@${entry.review.headSha}`, entry.observed);
  }
  return runOutcomeObserver({
    store: input.store,
    evidenceDir: input.evidenceDir,
    reviews: input.entries.map((entry) => entry.review),
    fetchOutcome: (review) => byKey.get(`${review.repo}#${review.pullNumber}@${review.headSha}`)!,
    dryRun: input.dryRun,
    ...(input.now ? { now: input.now } : {})
  });
}

function parseObserverInputEntry(raw: unknown, index: number): OutcomeObserverInputEntry {
  if (typeof raw !== "object" || raw === null) throw new Error(`reviews[${index}] must be an object`);
  const record = raw as Record<string, unknown>;
  const repo = requireString(record.repo, `reviews[${index}].repo`);
  const pullNumber = record.pullNumber;
  if (!Number.isInteger(pullNumber) || (pullNumber as number) < 1) throw new Error(`reviews[${index}].pullNumber must be a positive integer`);
  const headSha = requireString(record.headSha, `reviews[${index}].headSha`);
  const findings = Array.isArray(record.findings)
    ? record.findings.map((finding, findingIndex) => parseObservedFinding(finding, `reviews[${index}].findings[${findingIndex}]`))
    : [];
  const observedRaw = (record.observed ?? {}) as Record<string, unknown>;
  const observed: ObservedPullOutcome = {
    merged: observedRaw.merged === true,
    revertedFlaggedChange: observedRaw.revertedFlaggedChange === true,
    hotfixLines: toLineMap(observedRaw.hotfixLines),
    mergedFixLines: toLineMap(observedRaw.mergedFixLines),
    humanThreadResolved: observedRaw.humanThreadResolved === true,
    ...(typeof observedRaw.evidenceRef === "string" ? { evidenceRef: observedRaw.evidenceRef } : {})
  };
  return { review: { repo, pullNumber: pullNumber as number, headSha, findings }, observed };
}

function parseObservedFinding(raw: unknown, label: string): ObservedFinding {
  if (typeof raw !== "object" || raw === null) throw new Error(`${label} must be an object`);
  const record = raw as Record<string, unknown>;
  const line = record.line;
  if (!Number.isInteger(line) || (line as number) < 1) throw new Error(`${label}.line must be a positive integer`);
  return {
    fingerprint: requireString(record.fingerprint, `${label}.fingerprint`),
    path: requireString(record.path, `${label}.path`),
    line: line as number,
    severity: requireString(record.severity, `${label}.severity`) as Severity,
    category: requireString(record.category, `${label}.category`),
    confidence: typeof record.confidence === "number" ? record.confidence : 0
  };
}

function toLineMap(value: unknown): Map<string, Set<number>> {
  const map = new Map<string, Set<number>>();
  if (typeof value !== "object" || value === null) return map;
  for (const [path, lines] of Object.entries(value as Record<string, unknown>)) {
    if (Array.isArray(lines)) map.set(path, new Set(lines.filter((line): line is number => Number.isInteger(line))));
  }
  return map;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

// Prefer the most severe observed post-merge status across a PR's findings for the ledger summary.
function escalatePostMergeStatus(current: OutcomeLedgerPostMergeStatus, next: OutcomeLedgerPostMergeStatus): OutcomeLedgerPostMergeStatus {
  const rank: Record<OutcomeLedgerPostMergeStatus, number> = {
    unknown: 0,
    not_merged: 0,
    no_incident_seen: 1,
    regression_seen: 2,
    hotfixed: 3,
    reverted: 4
  };
  return rank[next] > rank[current] ? next : current;
}
