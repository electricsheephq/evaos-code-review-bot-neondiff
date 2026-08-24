import { buildIssueEnrichmentStatus, DEFAULT_ISSUE_ENRICHMENT_CONFIG, type IssueEnrichmentBlocker } from "./issue-enrichment.js";
export const ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP = 1_000_000;
export const ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT = 32;
export const ISSUE_ENRICHMENT_RECEIPT_MESSAGE_LIMIT = 256;
export const ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS = [
  "reposScanned", "reposSkipped", "readFailures", "issuesSeen", "eligible", "skipped", "wouldEnrich",
  "wouldComment", "deferred", "baselinedRepos", "truncatedRepos", "workerSkipped", "posted", "dryRunRecorded",
  "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"
] as const;
export type IssueEnrichmentReceiptCounts = { readonly [K in typeof ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS[number]]: number };
export type IssueEnrichmentReceiptReason = IssueEnrichmentBlocker | "unknown_failure";
export type IssueEnrichmentReceiptInput = { kind: "result"; result: unknown } | { kind: "thrown"; error: unknown };
export type IssueEnrichmentReceiptSnapshot = Readonly<{ kind: "thrown"; reason: IssueEnrichmentReceiptReason }> | Readonly<{
  kind: "result"; summary: Readonly<{ valid: false }> | Readonly<{ valid: true; counts: IssueEnrichmentReceiptCounts }>;
  status: IssueEnrichmentStatusSnapshot; dryRun: IssueEnrichmentFlagSnapshot; ok: IssueEnrichmentFlagSnapshot;
}>;
export interface IssueEnrichmentStatusSnapshot {
  readonly readable: boolean;
  readonly state: "disabled" | "blocked" | "other" | "unreadable";
  readonly blockers: IssueEnrichmentBlockersSnapshot;
}
export interface IssueEnrichmentBlockersSnapshot {
  readonly readable: boolean;
  readonly complete: boolean;
  readonly reasons: readonly IssueEnrichmentBlocker[];
}
export type IssueEnrichmentFlagSnapshot = "true" | "false" | "unreadable";
const enabledConfig = {
  ...DEFAULT_ISSUE_ENRICHMENT_CONFIG, enabled: true, postIssueComment: true, allowlist: ["owner/repo"]
};
const BLOCKERS = new Set<IssueEnrichmentBlocker>([
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: DEFAULT_ISSUE_ENRICHMENT_CONFIG }, canPostAsApp: false }).blockers,
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: enabledConfig }, canPostAsApp: false, modelAnalysisAvailable: false }).blockers,
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: enabledConfig }, canPostAsApp: true, modelAnalysisAvailable: true,
    issueReadChecks: [{ repo: "owner/repo", ok: false }] }).blockers
]);
type RecordValue = Record<string, unknown>;
type Read = { ok: boolean; value?: unknown };
const isRecord = (value: unknown): value is RecordValue => {
  try { return typeof value === "object" && value !== null && !Array.isArray(value); } catch { return false; }
};
const read = (value: RecordValue | undefined, key: string): Read => {
  if (!value) return { ok: false };
  try { return { ok: true, value: value[key] }; } catch { return { ok: false }; }
};
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);
function snapshotSummary(value: unknown): Readonly<{ valid: false }> | Readonly<{ valid: true; counts: IssueEnrichmentReceiptCounts }> {
  if (!isRecord(value)) return frozen({ valid: false });
  const counts = {} as { -readonly [K in typeof ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS[number]]: number };
  let valid = true;
  for (const key of ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS) {
    try {
      const count = value[key];
      if (typeof count !== "number" || !Number.isFinite(count) || !Number.isInteger(count) || count < 0) valid = false;
      else counts[key] = Math.min(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP, count);
    } catch { valid = false; }
  }
  return valid ? frozen({ valid: true, counts: frozen(counts) }) : frozen({ valid: false });
}
function snapshotBlockers(value: unknown): IssueEnrichmentBlockersSnapshot {
  try {
    if (!Array.isArray(value)) return frozen({ readable: false, complete: false, reasons: [] });
    const length = (value as unknown[]).length;
    if (!Number.isSafeInteger(length) || length < 0) return frozen({ readable: false, complete: false, reasons: [] });
    const reasons: IssueEnrichmentBlocker[] = [];
    let readable = true;
    let complete = length <= ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT;
    for (let index = 0; index < Math.min(length, ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT); index += 1) {
      try {
        const present = Object.prototype.hasOwnProperty.call(value, index);
        const blocker = (value as unknown[])[index];
        if (!present || blocker === undefined) complete = false;
        else if (typeof blocker === "string" && BLOCKERS.has(blocker as IssueEnrichmentBlocker)) reasons.push(blocker as IssueEnrichmentBlocker);
      } catch { readable = false; complete = false; }
    }
    return frozen({ readable, complete, reasons: frozen(reasons) });
  } catch { return frozen({ readable: false, complete: false, reasons: [] }); }
}
function snapshotThrown(error: unknown): IssueEnrichmentReceiptSnapshot {
  let message: unknown;
  try { message = typeof error === "string" ? error : read(isRecord(error) ? error : undefined, "message").value; } catch { /* fail closed */ }
  if (typeof message === "string") {
    const prefix = message.slice(0, ISSUE_ENRICHMENT_RECEIPT_MESSAGE_LIMIT).trim();
    for (const blocker of BLOCKERS) {
      const next = prefix[blocker.length];
      if (prefix === blocker || (prefix.startsWith(blocker) && !/[A-Za-z0-9_]/.test(next ?? ""))) {
        return frozen({ kind: "thrown", reason: blocker });
      }
    }
  }
  return frozen({ kind: "thrown", reason: "unknown_failure" });
}
function snapshotResult(result: unknown): IssueEnrichmentReceiptSnapshot {
  const root = isRecord(result) ? result : undefined;
  const summary = read(root, "summary");
  const status = read(root, "status");
  const dryRun = read(root, "dryRun");
  const ok = read(root, "ok");
  const statusValue = status.ok && isRecord(status.value) ? status.value : undefined;
  const state = read(statusValue, "state");
  const blockers = read(statusValue, "blockers");
  const statusSnapshot: IssueEnrichmentStatusSnapshot = frozen({
    readable: Boolean(statusValue && state.ok && (state.value === "disabled" || state.value === "blocked" || state.value === "ready" || state.value === "dry_run_only")),
    state: !state.ok || typeof state.value !== "string" ? "unreadable" : state.value === "disabled" ? "disabled" : state.value === "blocked" ? "blocked" : state.value === "ready" || state.value === "dry_run_only" ? "other" : "unreadable",
    blockers: snapshotBlockers(blockers.ok ? blockers.value : undefined)
  });
  const flag = (value: Read): IssueEnrichmentFlagSnapshot => value.ok && value.value === true ? "true" : value.ok && value.value === false ? "false" : "unreadable";
  return frozen({ kind: "result", summary: snapshotSummary(summary.ok ? summary.value : undefined), status: statusSnapshot, dryRun: flag(dryRun), ok: flag(ok) });
}
export function snapshotIssueEnrichmentReceipt(input: IssueEnrichmentReceiptInput): IssueEnrichmentReceiptSnapshot {
  let kind: unknown;
  try { kind = (input as unknown as RecordValue).kind; } catch { return frozen({ kind: "thrown", reason: "unknown_failure" }); }
  if (kind === "thrown") {
    let error: unknown;
    try { error = (input as { kind: "thrown"; error: unknown }).error; } catch { /* fail closed */ }
    return snapshotThrown(error);
  }
  let result: unknown;
  try { result = (input as { kind: "result"; result: unknown }).result; } catch { /* malformed result */ }
  return snapshotResult(result);
}
