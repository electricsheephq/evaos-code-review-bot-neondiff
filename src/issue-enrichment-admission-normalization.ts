export type IssueEnrichmentNormalizationAction = "would_enrich" | "would_comment";
export type IssueEnrichmentNormalizationScanAction = IssueEnrichmentNormalizationAction | "deferred" | "skipped";
export type IssueEnrichmentNormalizationStatus = "dry_run" | "posted" | "skipped" | "deferred" | "failed";
export type IssueEnrichmentNormalizationReason = "pending" | "held" | "already_recorded";

export interface IssueEnrichmentNormalizationScanItem {
  repo: string; issueNumber: number; state: string; action: IssueEnrichmentNormalizationScanAction;
  intendedAction?: IssueEnrichmentNormalizationAction; issueUpdatedAt?: string; nextEligibleAt?: string; url?: string;
}
export interface IssueEnrichmentNormalizationRecord {
  repo: string; issueNumber: number; status: IssueEnrichmentNormalizationStatus;
  issueUpdatedAt?: string; bodyHash?: string; analysisInputHash?: string; nextEligibleAt?: string;
  [key: string]: unknown;
}
export interface IssueEnrichmentNormalizationLimits {
  readonly globalMaxIssuesPerCycle?: number; readonly globalMaxCommentsPerCycle?: number;
  readonly repos: Readonly<Record<string, Readonly<Record<string, number>>>>;
  readonly [key: string]: unknown;
}
export interface IssueEnrichmentNormalizationInput {
  allowlist: readonly string[]; items: readonly IssueEnrichmentNormalizationScanItem[];
  records?: readonly IssueEnrichmentNormalizationRecord[]; checkedAt: string;
  fallbackIntendedAction?: IssueEnrichmentNormalizationAction; limits: IssueEnrichmentNormalizationLimits;
}
export interface IssueEnrichmentNormalizationCandidate {
  key: string; repo: string; issueNumber: number; state: string;
  action: IssueEnrichmentNormalizationScanAction; intendedAction: IssueEnrichmentNormalizationAction;
  issueUpdatedAt?: string; nextEligibleAt?: string; identityKnown: boolean;
  sourceDependent: boolean; pending: boolean; reason: IssueEnrichmentNormalizationReason;
  scanItem: Readonly<IssueEnrichmentNormalizationScanItem>;
  record?: Readonly<IssueEnrichmentNormalizationRecord>; limits: IssueEnrichmentNormalizationLimits;
}
export interface IssueEnrichmentNormalizationResult {
  allowlist: readonly string[]; items: readonly IssueEnrichmentNormalizationScanItem[];
  records: readonly IssueEnrichmentNormalizationRecord[]; limits: IssueEnrichmentNormalizationLimits;
  candidates: readonly IssueEnrichmentNormalizationCandidate[];
}

export function normalizeIssueEnrichmentCandidates(input: IssueEnrichmentNormalizationInput): IssueEnrichmentNormalizationResult {
  const checkedAt = parseTimestamp(input.checkedAt);
  if (checkedAt === undefined) throw new Error("issue_enrichment_normalization_invalid_checkedAt");
  const allowlist = deepFreeze(structuredClone(input.allowlist));
  const items = deepFreeze(structuredClone(input.items));
  const records = deepFreeze(structuredClone(input.records ?? []));
  const limits = deepFreeze(structuredClone(input.limits));
  if (input.fallbackIntendedAction !== undefined && !isAction(input.fallbackIntendedAction)) {
    throw new Error("issue_enrichment_normalization_invalid_fallbackIntendedAction");
  }
  const byKey = new Map<string, IssueEnrichmentNormalizationRecord>();
  for (const record of records) {
    const key = `${record.repo}#${record.issueNumber}`;
    if (byKey.has(key)) throw new Error(`issue_enrichment_normalization_duplicate_record:${key}`);
    byKey.set(key, record);
  }
  const candidates: IssueEnrichmentNormalizationCandidate[] = [];
  const seen = new Set<string>();
  for (const repo of allowlist) for (const item of items) {
    if (item.repo !== repo || item.action === "skipped") continue;
    const key = `${repo}#${item.issueNumber}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const record = byKey.get(key);
    const intendedAction = item.intendedAction ?? (item.action === "deferred" ? input.fallbackIntendedAction : item.action);
    if (!intendedAction || !isAction(intendedAction)) throw new Error(`issue_enrichment_normalization_missing_intent:${key}`);
    const issueUpdatedAt = item.issueUpdatedAt === undefined ? undefined : parseTimestamp(item.issueUpdatedAt);
    const recordUpdatedAt = parseTimestamp(record?.issueUpdatedAt);
    const nextEligibleAt = item.nextEligibleAt === undefined ? parseTimestamp(record?.nextEligibleAt) : parseTimestamp(item.nextEligibleAt);
    const held = (item.action === "deferred" || record?.status === "deferred") && nextEligibleAt !== undefined && Date.parse(nextEligibleAt) > Date.parse(checkedAt);
    const knownSame = issueUpdatedAt !== undefined && recordUpdatedAt !== undefined && issueUpdatedAt === recordUpdatedAt;
    const alreadyRecorded = record?.status === "dry_run" && intendedAction === "would_enrich" && knownSame;
    const candidate = {
      key, repo, issueNumber: item.issueNumber, state: item.state, action: item.action, intendedAction,
      ...(issueUpdatedAt ? { issueUpdatedAt } : {}), ...(nextEligibleAt ? { nextEligibleAt } : {}),
      identityKnown: issueUpdatedAt !== undefined, sourceDependent: record?.status === "posted",
      pending: !held && !alreadyRecorded, reason: held ? "held" : alreadyRecorded ? "already_recorded" : "pending",
      scanItem: deepFreeze(structuredClone(item)), ...(record ? { record: deepFreeze(structuredClone(record)) } : {}), limits
    } satisfies IssueEnrichmentNormalizationCandidate;
    candidates.push(deepFreeze(candidate));
  }
  return deepFreeze({ allowlist, items, records, limits, candidates });
}

export const normalizeIssueEnrichmentAdmission = normalizeIssueEnrichmentCandidates;

function isAction(value: unknown): value is IssueEnrichmentNormalizationAction {
  return value === "would_enrich" || value === "would_comment";
}
function parseTimestamp(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}
function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype) throw new Error("issue_enrichment_normalization_non_plain_value");
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
