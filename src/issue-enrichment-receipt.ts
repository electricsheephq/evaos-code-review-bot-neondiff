import {
  DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS,
  type IssueEnrichmentBlocker
} from "./issue-enrichment.js";

export const ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP = 1_000_000;
export const ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS = [
  "reposScanned", "reposSkipped", "readFailures", "issuesSeen", "eligible", "skipped", "wouldEnrich",
  "wouldComment", "deferred", "baselinedRepos", "truncatedRepos", "workerSkipped", "posted", "dryRunRecorded",
  "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"
] as const;
export type IssueEnrichmentReceiptCounts = { [K in typeof ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS[number]]: number };
export type IssueEnrichmentLaneCode =
  | "completed" | "no_candidates" | "lease_skipped" | "disabled" | "blocked" | "result_not_ok" | "cycle_failed" | "malformed_summary";
export type IssueEnrichmentLaneReason =
  | "worker_lease_held" | "read_failure" | "item_failure" | "unknown_failure" | "malformed_summary" | IssueEnrichmentBlocker;
export interface IssueEnrichmentLaneReceipt {
  ok: boolean;
  stage: "issue_enrichment";
  code: IssueEnrichmentLaneCode;
  counts: IssueEnrichmentReceiptCounts;
  reason?: IssueEnrichmentLaneReason;
}

export type IssueEnrichmentReceiptInput =
  | { kind: "thrown"; error: unknown }
  | { kind: "result"; result: unknown };

const BLOCKERS = new Set<IssueEnrichmentBlocker>([
  "issue_enrichment_disabled", "issue_enrichment_allowlist_empty", "issue_enrichment_live_posting_disabled",
  "github_app_credentials_required_for_live_issue_comments", "github_app_issues_permission_required",
  "issue_enrichment_live_repo_thresholds_required", "issue_enrichment_model_runtime_required"
]);
const usefulKeys: ReadonlyArray<keyof IssueEnrichmentReceiptCounts> = [
  "eligible", "wouldEnrich", "wouldComment", "posted", "dryRunRecorded", "skippedRecorded", "deferredRecorded", "alreadyProcessed"
];

const isRecord = (value: unknown): value is Record<string, unknown> =>
  Boolean(value) && typeof value === "object" && !Array.isArray(value);

function zeroCounts(): IssueEnrichmentReceiptCounts {
  return Object.fromEntries(ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.map((key) => [key, 0])) as IssueEnrichmentReceiptCounts;
}

function validSummary(value: unknown): value is Record<string, unknown> {
  return isRecord(value) && ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.every((key) => {
    const count = value[key];
    return typeof count === "number" && Number.isFinite(count) && Number.isInteger(count) && count >= 0;
  });
}

function boundedCounts(summary: Record<string, unknown>): IssueEnrichmentReceiptCounts {
  const counts = zeroCounts();
  for (const key of ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS) {
    counts[key] = Math.min(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP, summary[key] as number);
  }
  return counts;
}

function safeThrownReason(error: unknown): IssueEnrichmentLaneReason {
  const text = typeof error === "string" ? error : isRecord(error) && typeof error.message === "string" ? error.message : error instanceof Error ? error.message : "";
  const blocker = [...BLOCKERS].find((candidate) => text.includes(candidate));
  return blocker ?? "unknown_failure";
}

function safeBlockedReason(value: unknown, dryRun: boolean): IssueEnrichmentLaneReason | undefined {
  if (typeof value !== "string" || !BLOCKERS.has(value as IssueEnrichmentBlocker)) return undefined;
  const blocker = value as IssueEnrichmentBlocker;
  return dryRun && DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.has(blocker) ? undefined : blocker;
}

export function classifyIssueEnrichmentReceipt(input: IssueEnrichmentReceiptInput): IssueEnrichmentLaneReceipt {
  if (input.kind === "thrown") {
    return { ok: false, stage: "issue_enrichment", code: "cycle_failed", counts: zeroCounts(), reason: safeThrownReason(input.error) };
  }
  const result = isRecord(input.result) ? input.result : undefined;
  const summary = result?.summary;
  if (!validSummary(summary)) {
    return { ok: false, stage: "issue_enrichment", code: "malformed_summary", counts: zeroCounts(), reason: "malformed_summary" };
  }
  const counts = boundedCounts(summary);
  if (counts.workerSkipped > 0) {
    return { ok: true, stage: "issue_enrichment", code: "lease_skipped", counts, reason: "worker_lease_held" };
  }
  const status = isRecord(result?.status) ? result.status : undefined;
  if (status?.state === "disabled") {
    return { ok: true, stage: "issue_enrichment", code: "disabled", counts: zeroCounts() };
  }
  if (counts.readFailures > 0 || counts.failed > 0) {
    return { ok: false, stage: "issue_enrichment", code: "result_not_ok", counts, reason: counts.readFailures > 0 ? "read_failure" : "item_failure" };
  }
  const dryRun = result?.dryRun === true;
  const blockers = Array.isArray(status?.blockers) ? status.blockers : [];
  const blockedReason = status?.state === "blocked" ? blockers.map((blocker) => safeBlockedReason(blocker, dryRun)).find(Boolean) : undefined;
  const hasScanEvidence = ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS.some((key) => counts[key] > 0);
  if (blockedReason && !hasScanEvidence) {
    return { ok: false, stage: "issue_enrichment", code: "blocked", counts, reason: blockedReason };
  }
  if (result?.ok !== true) {
    return { ok: false, stage: "issue_enrichment", code: "result_not_ok", counts, reason: "unknown_failure" };
  }
  const noCandidates = usefulKeys.every((key) => counts[key] === 0);
  return { ok: true, stage: "issue_enrichment", code: noCandidates ? "no_candidates" : "completed", counts };
}

/** Compatibility shape for the parent daemon integration; classification remains discriminated internally. */
export function buildIssueEnrichmentLaneReceipt(result?: unknown, failure?: unknown): IssueEnrichmentLaneReceipt {
  return classifyIssueEnrichmentReceipt(result === undefined ? { kind: "thrown", error: failure } : { kind: "result", result });
}
