import { buildIssueEnrichmentStatus, DEFAULT_ISSUE_ENRICHMENT_CONFIG, type IssueEnrichmentBlocker } from "./issue-enrichment.js";

export const ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP = 1_000_000;
export const ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT = 32;
export const ISSUE_ENRICHMENT_RECEIPT_MESSAGE_LIMIT = 256;
export const ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS = Object.freeze([
  "reposScanned", "reposSkipped", "readFailures", "issuesSeen", "eligible", "skipped", "wouldEnrich",
  "wouldComment", "deferred", "baselinedRepos", "truncatedRepos", "workerSkipped", "posted", "dryRunRecorded",
  "skippedRecorded", "deferredRecorded", "alreadyProcessed", "failed"
] as const);
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

const enabledConfig = { ...DEFAULT_ISSUE_ENRICHMENT_CONFIG, enabled: true, postIssueComment: true, allowlist: ["owner/repo"] };
const BLOCKERS = new Set<IssueEnrichmentBlocker>([
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: DEFAULT_ISSUE_ENRICHMENT_CONFIG }, canPostAsApp: false }).blockers,
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: enabledConfig }, canPostAsApp: false, modelAnalysisAvailable: false }).blockers,
  ...buildIssueEnrichmentStatus({ config: { issueEnrichment: enabledConfig }, canPostAsApp: true, modelAnalysisAvailable: true,
    issueReadChecks: [{ repo: "owner/repo", ok: false }] }).blockers
]);
const BLOCKER_RANK = new Map([...BLOCKERS].map((blocker, index) => [blocker, index]));
type RecordValue = Record<string, unknown>;
type Read = { ok: boolean; value?: unknown };
const isOrdinaryObject = (value: unknown): value is RecordValue => {
  try {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch { return false; }
};
const read = (value: RecordValue | undefined, key: string): Read => {
  if (!value) return { ok: false };
  try { if (!Object.prototype.hasOwnProperty.call(value, key)) return { ok: false }; return { ok: true, value: value[key] }; } catch { return { ok: false }; }
};
const frozen = <T extends object>(value: T): Readonly<T> => Object.freeze(value);

function snapshotSummary(value: unknown): Readonly<{ valid: false }> | Readonly<{ valid: true; counts: IssueEnrichmentReceiptCounts }> {
  if (!isOrdinaryObject(value)) return frozen({ valid: false });
  const counts = {} as { -readonly [K in typeof ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS[number]]: number };
  let valid = true;
  for (const key of ISSUE_ENRICHMENT_RECEIPT_COUNT_KEYS) {
    const count = read(value, key);
    if (!count.ok || typeof count.value !== "number" || !Number.isFinite(count.value) || !Number.isInteger(count.value) || count.value < 0) valid = false;
    else counts[key] = Math.min(ISSUE_ENRICHMENT_RECEIPT_COUNT_CAP, count.value);
  }
  return valid ? frozen({ valid: true, counts: frozen(counts) }) : frozen({ valid: false });
}
function snapshotBlockers(value: unknown): IssueEnrichmentBlockersSnapshot {
  try {
    if (!Array.isArray(value)) return frozen({ readable: false, complete: false, reasons: frozen([]) });
    const length = (value as unknown[]).length;
    if (!Number.isSafeInteger(length) || length < 0) return frozen({ readable: false, complete: false, reasons: frozen([]) });
    const reasons: IssueEnrichmentBlocker[] = [];
    let readable = true; let complete = length <= ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT;
    for (let index = 0; index < Math.min(length, ISSUE_ENRICHMENT_RECEIPT_BLOCKER_LIMIT); index += 1) {
      try {
        const present = Object.prototype.hasOwnProperty.call(value, index);
        const blocker = (value as unknown[])[index];
        if (!present || typeof blocker !== "string" || !BLOCKERS.has(blocker as IssueEnrichmentBlocker)) complete = false;
        else reasons.push(blocker as IssueEnrichmentBlocker);
      } catch { readable = false; complete = false; }
    }
    reasons.sort((left, right) => (BLOCKER_RANK.get(left) ?? 0) - (BLOCKER_RANK.get(right) ?? 0));
    return frozen({ readable, complete: complete && value.length === length, reasons: frozen(reasons) });
  } catch { return frozen({ readable: false, complete: false, reasons: frozen([]) }); }
}
function snapshotThrown(error: unknown): IssueEnrichmentReceiptSnapshot {
  let message: unknown;
  try { message = typeof error === "string" ? error : error && typeof error === "object" ? (error as RecordValue).message : undefined; } catch { /* fail closed */ }
  if (typeof message === "string") {
    const prefix = message.slice(0, ISSUE_ENRICHMENT_RECEIPT_MESSAGE_LIMIT).trim();
    for (const blocker of BLOCKERS) {
      const next = prefix[blocker.length];
      if (prefix === blocker || (prefix.startsWith(blocker) && !/[A-Za-z0-9_]/.test(next ?? ""))) return frozen({ kind: "thrown", reason: blocker });
    }
  }
  return frozen({ kind: "thrown", reason: "unknown_failure" });
}
function snapshotResult(result: unknown): IssueEnrichmentReceiptSnapshot {
  const root = isOrdinaryObject(result) ? result : undefined;
  const summary = read(root, "summary"), status = read(root, "status"), dryRun = read(root, "dryRun"), ok = read(root, "ok");
  const statusValue = status.ok && isOrdinaryObject(status.value) ? status.value : undefined;
  const state = read(statusValue, "state"), blockers = read(statusValue, "blockers");
  const readable = Boolean(statusValue && state.ok && (state.value === "disabled" || state.value === "blocked" || state.value === "ready" || state.value === "dry_run_only"));
  const statusSnapshot: IssueEnrichmentStatusSnapshot = frozen({
    readable, state: !state.ok || typeof state.value !== "string" ? "unreadable" : state.value === "disabled" ? "disabled" : state.value === "blocked" ? "blocked" : state.value === "ready" || state.value === "dry_run_only" ? "other" : "unreadable",
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
  if (kind !== "result") return frozen({ kind: "thrown", reason: "unknown_failure" });
  let result: unknown;
  try { result = (input as { kind: "result"; result: unknown }).result; } catch { /* malformed result */ }
  return snapshotResult(result);
}
