import { types as utilTypes } from "node:util";
export type IssueEnrichmentAdmissionAction = "would_enrich" | "would_comment";
export type IssueEnrichmentAdmissionScanAction = IssueEnrichmentAdmissionAction | "deferred" | "skipped";
export type IssueEnrichmentAdmissionRecordStatus = "dry_run" | "posted" | "skipped" | "deferred" | "failed";

export interface IssueEnrichmentAdmissionScanItem { repo: string; issueNumber: number; state: string; action: IssueEnrichmentAdmissionScanAction; intendedAction?: IssueEnrichmentAdmissionAction; issueUpdatedAt?: string; nextEligibleAt?: string; url?: string; [key: string]: unknown; }
export interface IssueEnrichmentAdmissionRecord { repo: string; issueNumber: number; status: IssueEnrichmentAdmissionRecordStatus; issueUpdatedAt?: string; nextEligibleAt?: string; bodyHash?: string; analysisInputHash?: string; createdAt?: string; updatedAt?: string; [key: string]: unknown; }
export type IssueEnrichmentAdmissionLimits = Readonly<Record<string, unknown>>;
export interface IssueEnrichmentAdmissionInput { allowlist: readonly string[]; items: readonly IssueEnrichmentAdmissionScanItem[]; records?: readonly IssueEnrichmentAdmissionRecord[]; checkedAt: string; fallbackIntendedAction?: IssueEnrichmentAdmissionAction; limits: IssueEnrichmentAdmissionLimits; }
export interface IssueEnrichmentAdmissionCandidate extends IssueEnrichmentAdmissionScanItem { key: string; intendedAction?: IssueEnrichmentAdmissionAction; record?: Readonly<IssueEnrichmentAdmissionRecord>; }
export interface IssueEnrichmentAdmissionSnapshot { checkedAt: string; allowlist: readonly string[]; items: readonly IssueEnrichmentAdmissionScanItem[]; records: readonly IssueEnrichmentAdmissionRecord[]; limits: IssueEnrichmentAdmissionLimits; fallbackIntendedAction?: IssueEnrichmentAdmissionAction; candidates: readonly IssueEnrichmentAdmissionCandidate[]; }
const ACTIONS = new Set<IssueEnrichmentAdmissionAction>(["would_enrich", "would_comment"]), SCAN_ACTIONS = new Set<IssueEnrichmentAdmissionScanAction>([...ACTIONS, "deferred", "skipped"]), STATUSES = new Set<IssueEnrichmentAdmissionRecordStatus>(["dry_run", "posted", "skipped", "deferred", "failed"]), TIMESTAMP_KEYS = new Set(["issueUpdatedAt", "nextEligibleAt", "createdAt", "updatedAt", "deadlineAt"]);

export function snapshotIssueEnrichmentAdmission(input: IssueEnrichmentAdmissionInput): IssueEnrichmentAdmissionSnapshot {
  const raw = clonePlain(input, "input") as Record<string, any>;
  if (!Array.isArray(raw.allowlist) || !Array.isArray(raw.items) || (Object.hasOwn(raw, "records") && !Array.isArray(raw.records)) ||
      !raw.limits || typeof raw.limits !== "object" || Array.isArray(raw.limits)) fail("input_shape");
  const checkedAt = timestamp(raw.checkedAt) ?? fail("invalid_checkedAt");
  const allowlist = raw.allowlist.map((repo: unknown) => text(repo, "allowlist"));
  const duplicateRepos = duplicates(allowlist.map((repo) => repo.toLowerCase()));
  if (duplicateRepos.length) fail(`duplicate_allowlist:${duplicateRepos.join(",")}`);
  const fallback = raw.fallbackIntendedAction;
  if (fallback !== undefined && !ACTIONS.has(fallback)) fail("invalid_fallback_intent");

  const items = raw.items.map((value: unknown, index: number) => normalizeItem(value, index));
  const duplicateItems = duplicates(items.map((item) => key(item.repo, item.issueNumber)));
  if (duplicateItems.length) fail(`duplicate_scan:${duplicateItems.join(",")}`);
  const records: IssueEnrichmentAdmissionRecord[] = (raw.records ?? []).map((value: unknown, index: number) => normalizeRecord(value, index));
  const duplicateRecords = duplicates(records.map((record: IssueEnrichmentAdmissionRecord) => key(record.repo, record.issueNumber)));
  if (duplicateRecords.length) fail(`duplicate_record:${duplicateRecords.join(",")}`);
  const recordByKey = new Map<string, IssueEnrichmentAdmissionRecord>(records.map((record: IssueEnrichmentAdmissionRecord) => [key(record.repo, record.issueNumber), record]));
  const candidates: IssueEnrichmentAdmissionCandidate[] = [];
  for (const repo of allowlist) for (const item of items) {
    if (item.repo.toLowerCase() !== repo.toLowerCase()) continue;
    const intendedAction = intentFor(item, fallback);
    const candidate: IssueEnrichmentAdmissionCandidate = {
      ...item,
      key: key(item.repo, item.issueNumber),
      ...(intendedAction ? { intendedAction } : {}),
      record: recordByKey.get(key(item.repo, item.issueNumber))
    };
    candidates.push(candidate);
  }
  const snapshot: IssueEnrichmentAdmissionSnapshot = {
    checkedAt, allowlist, items, records, limits: raw.limits,
    ...(fallback ? { fallbackIntendedAction: fallback } : {}), candidates
  };
  return freezeDeep(snapshot);
}

export const buildIssueEnrichmentAdmissionSnapshot = snapshotIssueEnrichmentAdmission, snapshotIssueEnrichmentAdmissionInputs = snapshotIssueEnrichmentAdmission;

function normalizeItem(value: unknown, index: number): IssueEnrichmentAdmissionScanItem {
  const item = plainRecord(value, `items[${index}]`);
  for (const field of ["record", "status", "bodyHash", "analysisInputHash", "createdAt", "updatedAt", "deadlineAt"]) if (Object.hasOwn(item, field)) fail(`items[${index}].${field}`);
  const repo = text(item.repo, `items[${index}].repo`);
  const issueNumber = positiveInteger(item.issueNumber, `items[${index}].issueNumber`);
  const state = text(item.state, `items[${index}].state`);
  if (!SCAN_ACTIONS.has(item.action)) fail(`items[${index}].action`);
  if (item.intendedAction !== undefined && !ACTIONS.has(item.intendedAction)) fail(`items[${index}].intendedAction`);
  if (item.action !== "deferred" && item.action !== "skipped" && item.intendedAction !== undefined && item.intendedAction !== item.action) {
    fail(`contradictory_intent:${key(repo, issueNumber)}`);
  }
  const normalized = { ...item, repo, issueNumber, state, ...(timestamp(item.issueUpdatedAt) ? { issueUpdatedAt: timestamp(item.issueUpdatedAt) } : {}), ...(timestamp(item.nextEligibleAt) ? { nextEligibleAt: timestamp(item.nextEligibleAt) } : {}) };
  if (item.issueUpdatedAt !== undefined && !timestamp(item.issueUpdatedAt)) delete normalized.issueUpdatedAt;
  if (item.nextEligibleAt !== undefined && !timestamp(item.nextEligibleAt)) delete normalized.nextEligibleAt;
  return normalized as IssueEnrichmentAdmissionScanItem;
}

function normalizeRecord(value: unknown, index: number): IssueEnrichmentAdmissionRecord {
  const record = plainRecord(value, `records[${index}]`);
  const repo = text(record.repo, `records[${index}].repo`);
  const issueNumber = positiveInteger(record.issueNumber, `records[${index}].issueNumber`);
  if (!STATUSES.has(record.status)) fail(`records[${index}].status`);
  const normalized = { ...record, repo, issueNumber } as IssueEnrichmentAdmissionRecord;
  for (const field of ["bodyHash", "analysisInputHash"]) if (record[field] !== undefined && (typeof record[field] !== "string" || !/^[0-9a-f]{64}$/i.test(record[field]))) fail(`records[${index}].${field}`);
  for (const field of TIMESTAMP_KEYS) {
    if (record[field] === undefined) continue;
    const value = timestamp(record[field]);
    if (value) normalized[field] = value;
    else delete normalized[field];
  }
  return normalized;
}

function intentFor(item: IssueEnrichmentAdmissionScanItem, fallback: IssueEnrichmentAdmissionAction | undefined): IssueEnrichmentAdmissionAction | undefined {
  if (item.action === "would_enrich" || item.action === "would_comment") return item.action;
  if (item.action === "deferred") {
    if (item.intendedAction) return item.intendedAction;
    if (fallback) return fallback;
    fail(`missing_intent:${key(item.repo, item.issueNumber)}`);
  }
  return item.intendedAction;
}

function clonePlain(value: unknown, label: string, active = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) fail(`non_plain:${label}`); return value; }
  if (typeof value !== "object") fail(`non_plain:${label}`);
  if (utilTypes.isProxy(value)) fail(`non_plain:${label}`);
  let descriptors: PropertyDescriptorMap;
  try { descriptors = Object.getOwnPropertyDescriptors(value); } catch { fail(`non_plain:${label}`); }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null && !Array.isArray(value)) fail(`non_plain:${label}`);
  for (const descriptor of Object.values(descriptors)) if (!("value" in descriptor)) fail(`accessor:${label}`);
  if (active.has(value)) fail(`cycle:${label}`);
  active.add(value);
  let copy: any;
  if (Array.isArray(value)) { if (prototype !== Array.prototype || Reflect.ownKeys(descriptors).length !== value.length + 1) fail(`non_plain:${label}`);
    copy = new Array(value.length);
    for (const name of Reflect.ownKeys(descriptors)) {
      if (name === "length") continue;
      if (typeof name !== "string" || !/^\d+$/.test(name) || String(Number(name)) !== name || Number(name) >= value.length || !descriptors[name]!.enumerable) fail(`non_plain:${label}`);
      copy[Number(name)] = clonePlain(descriptors[name]!.value, `${label}.${name}`, active);
    }
  } else {
    copy = {};
    for (const name of Reflect.ownKeys(descriptors)) { if (typeof name !== "string") fail(`non_plain:${label}`); const descriptor = descriptors[name]!;
      if (!descriptor.enumerable) fail(`non_plain:${label}.${name}`);
      Object.defineProperty(copy, name, { value: clonePlain(descriptor.value, `${label}.${name}`, active), enumerable: true, writable: true, configurable: true });
    }
  }
  active.delete(value);
  return copy;
}

function freezeDeep<T>(value: T, seen = new WeakSet<object>()): T {
  if (!value || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value as Record<string, unknown>)) freezeDeep(child, seen);
  return Object.freeze(value);
}
function plainRecord(value: unknown, label: string): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) fail(`non_plain:${label}`);
  return value as Record<string, any>;
}
function text(value: unknown, label: string): string { if (typeof value !== "string" || value.length === 0) fail(label); return value; }
function positiveInteger(value: unknown, label: string): number { if (!Number.isSafeInteger(value) || (value as number) < 1) fail(label); return value as number; }
function timestamp(value: unknown): string | undefined { if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return undefined; const local = new Date(`${value.slice(0, 19)}Z`); if (!Number.isFinite(local.getTime()) || local.toISOString().slice(0, 19) !== value.slice(0, 19).toUpperCase()) return undefined; const parsed = Date.parse(value); return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined; }
function key(repo: string, issueNumber: number): string { return `${repo.toLowerCase()}#${issueNumber}`; }
function duplicates(values: readonly string[]): string[] { const counts = new Map<string, number>(); for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1); return [...counts].filter(([, count]) => count > 1).map(([value]) => value).sort(); }
function fail(label: string): never { throw new Error(`issue_enrichment_admission_snapshot_${label}`); }
