import {
  DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS,
  type IssueEnrichmentBlocker
} from "./issue-enrichment.js";
import {
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS,
  snapshotIssueEnrichmentReceipt,
  type IssueEnrichmentReceiptCounts,
  type IssueEnrichmentReceiptInput,
  type IssueEnrichmentReceiptSnapshot
} from "./issue-enrichment-receipt-snapshot.js";

export type IssueEnrichmentLaneCode =
  | "completed" | "no_candidates" | "lease_skipped" | "disabled" | "blocked"
  | "result_not_ok" | "cycle_failed" | "malformed_summary";
export type IssueEnrichmentLaneReason = IssueEnrichmentBlocker | "worker_lease_held" | "read_failure"
  | "item_failure" | "unknown_failure" | "malformed_summary";
export interface IssueEnrichmentLaneReceipt {
  readonly ok: boolean;
  readonly stage: "issue_enrichment";
  readonly code: IssueEnrichmentLaneCode;
  readonly counts: IssueEnrichmentReceiptCounts;
  readonly reason?: IssueEnrichmentLaneReason;
}

const ZERO_COUNTS = Object.freeze(Object.fromEntries(
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, 0])
)) as IssueEnrichmentReceiptCounts;
const USEFUL_COUNT_KEYS: readonly (keyof IssueEnrichmentReceiptCounts)[] = Object.freeze([
  "eligible", "wouldEnrich", "wouldComment", "posted", "dryRunRecorded", "skippedRecorded",
  "deferredRecorded", "alreadyProcessed"
]);
const BLOCKED_STATE_REASONS = new Set<IssueEnrichmentBlocker>([
  "issue_enrichment_allowlist_empty", "github_app_credentials_required_for_live_issue_comments",
  "github_app_issues_permission_required", "issue_enrichment_live_repo_thresholds_required",
  "issue_enrichment_model_runtime_required"
]);
const receipt = (ok: boolean, code: IssueEnrichmentLaneCode, counts: IssueEnrichmentReceiptCounts,
  reason?: IssueEnrichmentLaneReason): IssueEnrichmentLaneReceipt => Object.freeze({
  ok, stage: "issue_enrichment" as const, code, counts, ...(reason ? { reason } : {})
});

const controlsReadable = (snapshot: Extract<IssueEnrichmentReceiptSnapshot, { kind: "result" }>): boolean =>
  snapshot.status.readable && snapshot.status.blockers.readable && snapshot.status.blockers.complete &&
  snapshot.dryRun !== "unreadable" && snapshot.ok !== "unreadable";
const countsAreZeroExcept = (counts: IssueEnrichmentReceiptCounts, exception?: keyof IssueEnrichmentReceiptCounts): boolean =>
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.every((key) => key === exception ? counts[key] > 0 : counts[key] === 0);

const stateConsistent = (snapshot: Extract<IssueEnrichmentReceiptSnapshot, { kind: "result" }>): boolean => {
  const { state, blockers } = snapshot.status;
  if (state === "ready") return blockers.reasons.length === 0;
  if (state === "dry_run_only") {
    return blockers.reasons.length === 1 && blockers.reasons[0] === "issue_enrichment_live_posting_disabled";
  }
  if (state === "blocked") return blockers.reasons.some((reason) => BLOCKED_STATE_REASONS.has(reason));
  return state === "disabled";
};

export function classifyIssueEnrichmentSnapshot(snapshot: IssueEnrichmentReceiptSnapshot): IssueEnrichmentLaneReceipt {
  if (snapshot.kind === "thrown") return receipt(false, "cycle_failed", ZERO_COUNTS, snapshot.reason);
  if (!snapshot.summary.valid) return receipt(false, "malformed_summary", ZERO_COUNTS, "malformed_summary");
  const counts = snapshot.summary.counts;
  const readable = controlsReadable(snapshot);
  if (counts.workerSkipped > 0) {
    return readable && countsAreZeroExcept(counts, "workerSkipped") && snapshot.ok === "true"
      ? receipt(true, "lease_skipped", counts, "worker_lease_held")
      : receipt(false, "result_not_ok", counts, "unknown_failure");
  }
  if (snapshot.status.state === "disabled") {
    return readable && countsAreZeroExcept(counts) &&
      snapshot.status.blockers.reasons.includes("issue_enrichment_disabled") && snapshot.ok === "true"
      ? receipt(true, "disabled", ZERO_COUNTS)
      : receipt(false, "result_not_ok", counts, "unknown_failure");
  }
  if (counts.readFailures > 0) return receipt(false, "result_not_ok", counts, "read_failure");
  if (counts.failed > 0) return receipt(false, "result_not_ok", counts, "item_failure");
  if (!readable || !stateConsistent(snapshot)) return receipt(false, "result_not_ok", counts, "unknown_failure");

  const ignoredBlockersAllowed = snapshot.status.state === "dry_run_only" ||
    (snapshot.status.state === "blocked" && snapshot.dryRun === "true");
  const effectiveBlocker = snapshot.status.blockers.reasons.find((reason) =>
    !ignoredBlockersAllowed || !DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.has(reason));
  if (effectiveBlocker) {
    const hasScanEvidence = ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.some((key) => counts[key] > 0);
    return hasScanEvidence
      ? receipt(false, "result_not_ok", counts, "unknown_failure")
      : receipt(false, "blocked", counts, effectiveBlocker);
  }
  if (snapshot.ok !== "true") return receipt(false, "result_not_ok", counts, "unknown_failure");
  const completed = USEFUL_COUNT_KEYS.some((key) => counts[key] > 0);
  return receipt(true, completed ? "completed" : "no_candidates", counts);
}

export function classifyIssueEnrichmentReceipt(input: IssueEnrichmentReceiptInput): IssueEnrichmentLaneReceipt {
  return classifyIssueEnrichmentSnapshot(snapshotIssueEnrichmentReceipt(input));
}
