import type { IssueEnrichmentBlocker } from "./issue-enrichment.js";
import {
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS, snapshotIssueEnrichmentReceipt,
  type IssueEnrichmentReceiptCounts, type IssueEnrichmentReceiptInput, type IssueEnrichmentReceiptSnapshot
} from "./issue-enrichment-receipt-snapshot.js";

export type IssueEnrichmentLaneCode = "completed" | "no_candidates" | "lease_skipped" | "disabled" | "blocked" | "result_not_ok" | "cycle_failed" | "malformed_summary";
export type IssueEnrichmentLaneReason = IssueEnrichmentBlocker | "worker_lease_held" | "read_failure" | "item_failure" | "unknown_failure" | "malformed_summary";
export interface IssueEnrichmentLaneReceipt {
  readonly ok: boolean; readonly stage: "issue_enrichment"; readonly code: IssueEnrichmentLaneCode;
  readonly counts: IssueEnrichmentReceiptCounts; readonly reason?: IssueEnrichmentLaneReason;
}

const ZERO_COUNTS = Object.freeze(Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, 0]))) as IssueEnrichmentReceiptCounts;
const USEFUL_KEYS: readonly (keyof IssueEnrichmentReceiptCounts)[] = Object.freeze([
  "eligible", "wouldEnrich", "wouldComment", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded", "alreadyProcessed"
]);
const ITEM_KEYS: readonly (keyof IssueEnrichmentReceiptCounts)[] = Object.freeze([
  "eligible", "skipped", "wouldEnrich", "wouldComment", "deferred", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"
]);
const DRY_RUN_FORBIDDEN: readonly (keyof IssueEnrichmentReceiptCounts)[] = Object.freeze([
  "workerSkipped", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded"
]);
const BLOCKING_REASONS = new Set<IssueEnrichmentBlocker>([
  "issue_enrichment_allowlist_empty", "github_app_credentials_required_for_live_issue_comments", "github_app_issues_permission_required",
  "issue_enrichment_live_repo_thresholds_required", "issue_enrichment_model_runtime_required"
]);
const DISABLED_REASONS = new Set<IssueEnrichmentBlocker>([
  "issue_enrichment_disabled", "issue_enrichment_allowlist_empty", "issue_enrichment_live_posting_disabled"
]);
const DRY_RUN_IGNORED_REASONS: readonly IssueEnrichmentBlocker[] = Object.freeze([
  "github_app_credentials_required_for_live_issue_comments", "issue_enrichment_live_posting_disabled", "issue_enrichment_model_runtime_required"
]);
const emit = (ok: boolean, code: IssueEnrichmentLaneCode, counts: IssueEnrichmentReceiptCounts, reason?: IssueEnrichmentLaneReason): IssueEnrichmentLaneReceipt =>
  Object.freeze({ ok, stage: "issue_enrichment" as const, code, counts, ...(reason ? { reason } : {}) });
const zeroExcept = (counts: IssueEnrichmentReceiptCounts, exception?: keyof IssueEnrichmentReceiptCounts): boolean =>
  ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.every((key) => key === exception ? counts[key] === 1 : counts[key] === 0);
const any = (counts: IssueEnrichmentReceiptCounts, keys: readonly (keyof IssueEnrichmentReceiptCounts)[]): boolean => keys.some((key) => counts[key] > 0);

function effectiveBlocker(snapshot: Extract<IssueEnrichmentReceiptSnapshot, { kind: "result" }>): IssueEnrichmentBlocker | undefined {
  const mayIgnore = snapshot.status.state === "dry_run_only" || (snapshot.dryRun === "true" && snapshot.status.state === "blocked");
  return snapshot.status.blockers.reasons.find((reason) => !mayIgnore || !DRY_RUN_IGNORED_REASONS.includes(reason));
}
function matrixAccepts(snapshot: Extract<IssueEnrichmentReceiptSnapshot, { kind: "result" }>, counts: IssueEnrichmentReceiptCounts): boolean {
  const { state, blockers } = snapshot.status;
  if (!snapshot.status.readable || !blockers.readable || !blockers.complete || snapshot.dryRun === "unreadable" || snapshot.ok === "unreadable") return false;
  if (state === "ready" && blockers.reasons.length !== 0) return false;
  if (state === "dry_run_only" && (blockers.reasons.length !== 1 || blockers.reasons[0] !== "issue_enrichment_live_posting_disabled")) return false;
  if (state === "blocked" && !blockers.reasons.some((reason) => BLOCKING_REASONS.has(reason))) return false;
  if (state === "disabled") return blockers.reasons.includes("issue_enrichment_disabled") &&
    blockers.reasons.length === new Set(blockers.reasons).size && blockers.reasons.every((reason) => DISABLED_REASONS.has(reason)) &&
    snapshot.ok === "true" && zeroExcept(counts);
  if (counts.workerSkipped > 0) return snapshot.dryRun === "false" && snapshot.ok === "true" &&
    (state === "ready" || state === "dry_run_only") && zeroExcept(counts, "workerSkipped");
  if (snapshot.dryRun === "true" && any(counts, DRY_RUN_FORBIDDEN)) return false;
  if (snapshot.dryRun === "false" && state === "ready" && counts.dryRunRecorded > 0) return false;
  if (snapshot.dryRun === "false" && state === "dry_run_only" && counts.posted > 0) return false;
  if (counts.posted > 0 && counts.dryRunRecorded > 0) return false;
  if (any(counts, ITEM_KEYS) && counts.issuesSeen === 0) return false;
  if (counts.readFailures > 0 && counts.reposScanned === 0) return false;
  if (snapshot.ok === "true" && (counts.readFailures > 0 || counts.failed > 0)) return false;
  const blocker = effectiveBlocker(snapshot);
  return state !== "blocked" || blocker === undefined || (snapshot.ok === "false" && zeroExcept(counts));
}

export function classifyIssueEnrichmentSnapshot(snapshot: IssueEnrichmentReceiptSnapshot): IssueEnrichmentLaneReceipt {
  if (snapshot.kind === "thrown") return emit(false, "cycle_failed", ZERO_COUNTS, snapshot.reason);
  if (!snapshot.summary.valid) return emit(false, "malformed_summary", ZERO_COUNTS, "malformed_summary");
  const counts = snapshot.summary.counts;
  if (!matrixAccepts(snapshot, counts)) return emit(false, "result_not_ok", counts, "unknown_failure");
  if (counts.workerSkipped === 1) return emit(true, "lease_skipped", counts, "worker_lease_held");
  if (snapshot.status.state === "disabled") return emit(true, "disabled", ZERO_COUNTS);
  if (counts.readFailures > 0) return emit(false, "result_not_ok", counts, "read_failure");
  if (counts.failed > 0) return emit(false, "result_not_ok", counts, "item_failure");
  const blocker = effectiveBlocker(snapshot);
  if (blocker) return emit(false, "blocked", counts, blocker);
  if (snapshot.ok !== "true") return emit(false, "result_not_ok", counts, "unknown_failure");
  return emit(true, any(counts, USEFUL_KEYS) ? "completed" : "no_candidates", counts);
}

export function classifyIssueEnrichmentReceipt(input: IssueEnrichmentReceiptInput): IssueEnrichmentLaneReceipt {
  const snapshot = snapshotIssueEnrichmentReceipt(input);
  return classifyIssueEnrichmentSnapshot(snapshot);
}
