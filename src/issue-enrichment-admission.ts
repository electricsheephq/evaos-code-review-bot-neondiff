export type IssueEnrichmentAdmissionAction = "would_enrich" | "would_comment";
export type IssueEnrichmentAdmissionProjection = IssueEnrichmentAdmissionAction | "deferred";
export type IssueEnrichmentAdmissionReason = "eligible" | "already_recorded" | "released" | "repository_blocked" | "repo_max_issues_per_cycle" | "repo_max_comments_per_cycle" | "burst_threshold_exceeded" | "global_max_issues_per_cycle" | "global_max_comments_per_cycle";

export interface IssueEnrichmentAdmissionScanItem { readonly repo: string; readonly issueNumber: number; readonly state: string; readonly action: IssueEnrichmentAdmissionAction | "skipped" | "deferred"; readonly issueUpdatedAt?: string; readonly url?: string; }
export interface IssueEnrichmentAdmissionRecord { readonly repo: string; readonly issueNumber: number; readonly issueUpdatedAt?: string; readonly analysisInputHash?: string; readonly status: "dry_run" | "posted" | "deferred" | "failed" | "skipped"; }
export interface IssueEnrichmentAdmissionRepoLimits { readonly maxIssuesPerCycle: number; readonly maxCommentsPerCycle: number; readonly maxIssuesPerBurst: number; }
export interface IssueEnrichmentAdmissionLimits { readonly globalMaxIssuesPerCycle: number; readonly globalMaxCommentsPerCycle: number; readonly repos: Readonly<Record<string, IssueEnrichmentAdmissionRepoLimits>>; }
export interface IssueEnrichmentAdmissionInput { readonly allowlist: readonly string[]; readonly items: readonly IssueEnrichmentAdmissionScanItem[]; readonly records?: readonly IssueEnrichmentAdmissionRecord[]; readonly limits: IssueEnrichmentAdmissionLimits; readonly checkedAt: string; }
export interface IssueEnrichmentAdmissionCandidate { readonly key: string; readonly repo: string; readonly issueNumber: number; readonly state: string; readonly issueUpdatedAt: string; readonly record?: IssueEnrichmentAdmissionRecord; readonly intendedAction: IssueEnrichmentAdmissionAction; readonly sourceDependent: boolean; readonly pending: boolean; readonly scanItem: Readonly<IssueEnrichmentAdmissionScanItem>; }
export interface IssueEnrichmentAdmissionDecision { readonly candidate: IssueEnrichmentAdmissionCandidate; readonly outputAction: IssueEnrichmentAdmissionProjection; readonly reason: IssueEnrichmentAdmissionReason; }
export interface IssueEnrichmentAdmissionLedger { readonly candidates: readonly IssueEnrichmentAdmissionCandidate[]; next(): IssueEnrichmentAdmissionDecision | undefined; snapshot(): readonly IssueEnrichmentAdmissionDecision[]; release(candidate: IssueEnrichmentAdmissionCandidate): void; blockRepo(repo: string): void; }
export interface IssueEnrichmentAdmission { readonly candidates: readonly IssueEnrichmentAdmissionCandidate[]; readonly ledger: IssueEnrichmentAdmissionLedger; }

type RepoUsage = { issues: number; comments: number; burst: number };
type Usage = { repos: Map<string, RepoUsage>; globalIssues: number; globalComments: number };

export function createIssueEnrichmentAdmission(input: IssueEnrichmentAdmissionInput): IssueEnrichmentAdmission {
  const records = new Map((input.records ?? []).map((record) => [`${record.repo}#${record.issueNumber}`, record]));
  const candidates: IssueEnrichmentAdmissionCandidate[] = [];
  for (const repo of input.allowlist) for (const item of input.items) {
    if (item.repo !== repo || item.action === "skipped" || item.action === "deferred") continue;
    const key = `${repo}#${item.issueNumber}`;
    if (candidates.some((candidate) => candidate.key === key)) continue;
    const record = records.get(key), intendedAction = item.action;
    const pending = record?.status !== "skipped" && !(record?.status === "dry_run" && intendedAction === "would_enrich");
    candidates.push(Object.freeze({ key, repo, issueNumber: item.issueNumber, state: item.state,
      issueUpdatedAt: canonicalDate(item.issueUpdatedAt ?? record?.issueUpdatedAt, input.checkedAt),
      ...(record ? { record: Object.freeze({ ...record }) } : {}), intendedAction,
      sourceDependent: record?.status === "posted", pending, scanItem: Object.freeze({ ...item }) }));
  }
  return { candidates: Object.freeze(candidates), ledger: makeLedger(candidates, input.limits) };
}

function makeLedger(candidates: readonly IssueEnrichmentAdmissionCandidate[], limits: IssueEnrichmentAdmissionLimits): IssueEnrichmentAdmissionLedger {
  const active = new Set<string>(), released = new Set<string>(), blocked = new Set<string>();
  const usage = (): Usage => {
    const current: Usage = { repos: new Map(), globalIssues: 0, globalComments: 0 };
    for (const candidate of candidates) if (active.has(candidate.key)) add(current, candidate);
    return current;
  };
  const reason = (candidate: IssueEnrichmentAdmissionCandidate, current: Usage): IssueEnrichmentAdmissionReason | undefined => {
    if (blocked.has(candidate.repo)) return "repository_blocked";
    const cap = limits.repos[candidate.repo], repo = current.repos.get(candidate.repo) ?? { issues: 0, comments: 0, burst: 0 };
    if (!cap || repo.issues >= cap.maxIssuesPerCycle) return "repo_max_issues_per_cycle";
    if (candidate.intendedAction === "would_comment" && repo.comments >= cap.maxCommentsPerCycle) return "repo_max_comments_per_cycle";
    if (repo.burst >= cap.maxIssuesPerBurst) return "burst_threshold_exceeded";
    if (current.globalIssues >= limits.globalMaxIssuesPerCycle) return "global_max_issues_per_cycle";
    if (candidate.intendedAction === "would_comment" && current.globalComments >= limits.globalMaxCommentsPerCycle) return "global_max_comments_per_cycle";
  };
  const decide = (candidate: IssueEnrichmentAdmissionCandidate, current: Usage): IssueEnrichmentAdmissionDecision => {
    if (!candidate.pending) return { candidate, outputAction: "deferred", reason: "already_recorded" };
    if (released.has(candidate.key)) return { candidate, outputAction: "deferred", reason: "released" };
    if (active.has(candidate.key)) return { candidate, outputAction: candidate.intendedAction, reason: "eligible" };
    const blockedReason = reason(candidate, current);
    return blockedReason ? { candidate, outputAction: "deferred", reason: blockedReason } : { candidate, outputAction: candidate.intendedAction, reason: "eligible" };
  };
  return { candidates,
    next() {
      const current = usage();
      for (const candidate of candidates) if (candidate.pending && !released.has(candidate.key) && !active.has(candidate.key) && !reason(candidate, current)) {
        active.add(candidate.key); return { candidate, outputAction: candidate.intendedAction, reason: "eligible" };
      }
    },
    snapshot() {
      const current = usage(), projected: IssueEnrichmentAdmissionDecision[] = [];
      for (const candidate of candidates) {
        const item = decide(candidate, current); projected.push(item);
        if (item.outputAction !== "deferred" && !active.has(candidate.key)) add(current, candidate);
      }
      return projected;
    },
    release(candidate) { active.delete(candidate.key); released.add(candidate.key); },
    blockRepo(repo) { blocked.add(repo); for (const candidate of candidates) if (candidate.repo === repo && active.delete(candidate.key)) released.add(candidate.key); }
  };
}

function add(current: Usage, candidate: IssueEnrichmentAdmissionCandidate): void {
  const repo = current.repos.get(candidate.repo) ?? { issues: 0, comments: 0, burst: 0 };
  repo.issues += 1; repo.burst += 1;
  if (candidate.intendedAction === "would_comment") { repo.comments += 1; current.globalComments += 1; }
  current.repos.set(candidate.repo, repo); current.globalIssues += 1;
}

function canonicalDate(value: string | undefined, fallback: string): string {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}
