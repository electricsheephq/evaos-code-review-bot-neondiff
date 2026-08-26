import { types as utilTypes } from "node:util";
import type { IssueEnrichmentAdmissionAction, IssueEnrichmentAdmissionCandidate, IssueEnrichmentAdmissionSnapshot } from "./issue-enrichment-admission-snapshot.js";
import { classifyIssueEnrichmentAdmission, type IssueEnrichmentAdmissionDecision } from "./issue-enrichment-admission-decision.js";

export type IssueEnrichmentAdmissionLedgerReason = "eligible" | "held" | "already_recorded" | "released" | "repository_blocked" | "burst_threshold_exceeded" | "repo_max_issues_per_cycle" | "repo_max_comments_per_cycle" | "global_max_issues_per_cycle" | "global_max_comments_per_cycle";
export interface IssueEnrichmentAdmissionLedgerCandidate { candidate: Readonly<IssueEnrichmentAdmissionCandidate>; classification: Readonly<IssueEnrichmentAdmissionDecision>; intendedAction: IssueEnrichmentAdmissionAction; }
export interface IssueEnrichmentAdmissionLedgerDecision extends IssueEnrichmentAdmissionLedgerCandidate { outputAction: IssueEnrichmentAdmissionAction | "deferred"; reason: IssueEnrichmentAdmissionLedgerReason; }
export interface IssueEnrichmentAdmissionLedger { candidates: readonly Readonly<IssueEnrichmentAdmissionCandidate>[]; next(): Readonly<IssueEnrichmentAdmissionLedgerDecision> | undefined; snapshot(): readonly Readonly<IssueEnrichmentAdmissionLedgerDecision>[]; release(candidate: Readonly<IssueEnrichmentAdmissionCandidate>): void; blockRepo(repo: string): void; }

type RepoLimits = { issues: number; comments: number; burst: number };
type Limits = { globalIssues: number; globalComments: number; repos: Map<string, RepoLimits> };
type Usage = { globalIssues: number; globalComments: number; repos: Map<string, { issues: number; comments: number }> };

export function createIssueEnrichmentAdmissionLedger(snapshot: Readonly<IssueEnrichmentAdmissionSnapshot>, decisions: readonly Readonly<IssueEnrichmentAdmissionDecision>[]): IssueEnrichmentAdmissionLedger {
  if (!deepFrozen(snapshot) || !deepFrozen(decisions) || decisions.length !== snapshot.candidates.length) fail("invalid_inputs");
  const canonical = classifyIssueEnrichmentAdmission(snapshot), limits = readLimits(snapshot.limits), candidates: IssueEnrichmentAdmissionLedgerCandidate[] = [];
  for (let index = 0; index < decisions.length; index += 1) {
    const classification = decisions[index]!, canonicalClassification = canonical[index]!, candidate = snapshot.candidates[index]!;
    if (!deepFrozen(classification) || !deepFrozen(candidate)) fail("invalid_inputs");
    if (classification.candidate !== candidate || classification.key !== candidate.key || classification.state !== canonicalClassification.state || classification.reason !== canonicalClassification.reason) fail("decision_mismatch");
    if (candidate.action === "skipped") continue;
    const intendedAction = candidate.action === "deferred" ? candidate.intendedAction : candidate.action;
    if (intendedAction !== "would_enrich" && intendedAction !== "would_comment") fail("missing_intent");
    candidates.push(Object.freeze(Object.assign(Object.create(null), { candidate, classification, intendedAction })));
  }
  const frozenCandidates = Object.freeze(candidates), active = new Set<string>(), released = new Set<string>(), blocked = new Set<string>();
  const deferred = new Map<string, IssueEnrichmentAdmissionLedgerReason>(), issueOnly = new Set<string>(), eligible = (entry: IssueEnrichmentAdmissionLedgerCandidate) => entry.classification.state === "pending" || entry.classification.state === "source_dependent";
  const eligibleByRepo = new Map<string, number>();
  for (const entry of frozenCandidates) if (eligible(entry)) eligibleByRepo.set(repoKey(entry.candidate.repo), (eligibleByRepo.get(repoKey(entry.candidate.repo)) ?? 0) + 1);
  const burstBlocked = new Set(frozenCandidates.filter((entry) => eligible(entry) && (eligibleByRepo.get(repoKey(entry.candidate.repo)) ?? 0) > repoLimits(limits, entry.candidate.repo).burst).map((entry) => entry.candidate.key));

  const ledger: IssueEnrichmentAdmissionLedger = {
    candidates: Object.freeze(frozenCandidates.map((entry) => entry.candidate)),
    next() {
      const usage = currentUsage(frozenCandidates, active, issueOnly);
      for (const entry of frozenCandidates) {
        const key = entry.candidate.key;
        if (!eligible(entry) || active.has(key) || released.has(key) || deferred.has(key)) continue;
        const reason = capReason(entry, usage, limits, blocked, burstBlocked);
        if (reason) { deferred.set(key, reason); if (commentReason(reason)) { issueOnly.add(key); addIssue(usage, entry); } continue; }
        active.add(key); addFull(usage, entry); return projected(entry, entry.intendedAction, "eligible");
      }
    },
    snapshot() {
      const usage = currentUsage(frozenCandidates, active, issueOnly), output: IssueEnrichmentAdmissionLedgerDecision[] = [];
      for (const entry of frozenCandidates) {
        const key = entry.candidate.key;
        if (entry.classification.state === "held") { output.push(projected(entry, "deferred", "held")); continue; }
        if (entry.classification.state === "already_recorded") { output.push(projected(entry, "deferred", "already_recorded")); continue; }
        if (released.has(key)) { output.push(projected(entry, "deferred", "released")); continue; }
        if (active.has(key)) { output.push(projected(entry, entry.intendedAction, "eligible")); continue; }
        const stored = deferred.get(key), reason = stored ?? capReason(entry, usage, limits, blocked, burstBlocked);
        if (reason) { output.push(projected(entry, "deferred", reason)); if (!stored) { deferred.set(key, reason); if (commentReason(reason)) { issueOnly.add(key); addIssue(usage, entry); } } continue; }
        output.push(projected(entry, entry.intendedAction, "eligible")); addFull(usage, entry);
      }
      return Object.freeze(output);
    },
    release(candidate) { if (active.delete(candidate.key)) released.add(candidate.key); },
    blockRepo(repo) { const normalized = repoKey(repo); if (!frozenCandidates.some((entry) => repoKey(entry.candidate.repo) === normalized)) return; blocked.add(normalized); deferred.clear(); issueOnly.clear(); for (const entry of frozenCandidates) if (repoKey(entry.candidate.repo) === normalized) active.delete(entry.candidate.key); }
  };
  return Object.freeze(ledger);
}

function capReason(entry: IssueEnrichmentAdmissionLedgerCandidate, usage: Usage, limits: Limits, blocked: Set<string>, burstBlocked: Set<string>): IssueEnrichmentAdmissionLedgerReason | undefined {
  const repo = repoKey(entry.candidate.repo); if (blocked.has(repo)) return "repository_blocked"; if (burstBlocked.has(entry.candidate.key)) return "burst_threshold_exceeded";
  const used = usage.repos.get(repo) ?? { issues: 0, comments: 0 }, cap = repoLimits(limits, repo);
  if (used.issues >= cap.issues) return "repo_max_issues_per_cycle"; if (usage.globalIssues >= limits.globalIssues) return "global_max_issues_per_cycle";
  if (entry.intendedAction === "would_comment" && used.comments >= cap.comments) return "repo_max_comments_per_cycle";
  if (entry.intendedAction === "would_comment" && usage.globalComments >= limits.globalComments) return "global_max_comments_per_cycle";
}
function currentUsage(entries: readonly IssueEnrichmentAdmissionLedgerCandidate[], active: Set<string>, issueOnly: Set<string>): Usage { const usage: Usage = { globalIssues: 0, globalComments: 0, repos: new Map() }; for (const entry of entries) { if (active.has(entry.candidate.key)) addFull(usage, entry); else if (issueOnly.has(entry.candidate.key)) addIssue(usage, entry); } return usage; }
function addIssue(usage: Usage, entry: IssueEnrichmentAdmissionLedgerCandidate): void { const key = repoKey(entry.candidate.repo), repo = usage.repos.get(key) ?? { issues: 0, comments: 0 }; repo.issues += 1; usage.globalIssues += 1; usage.repos.set(key, repo); }
function addFull(usage: Usage, entry: IssueEnrichmentAdmissionLedgerCandidate): void { addIssue(usage, entry); if (entry.intendedAction === "would_comment") { const repo = usage.repos.get(repoKey(entry.candidate.repo))!; repo.comments += 1; usage.globalComments += 1; } }
function projected(entry: IssueEnrichmentAdmissionLedgerCandidate, outputAction: IssueEnrichmentAdmissionAction | "deferred", reason: IssueEnrichmentAdmissionLedgerReason): Readonly<IssueEnrichmentAdmissionLedgerDecision> { return Object.freeze(Object.assign(Object.create(null), { ...entry, outputAction, reason })); }
function commentReason(reason: IssueEnrichmentAdmissionLedgerReason): boolean { return reason === "repo_max_comments_per_cycle" || reason === "global_max_comments_per_cycle"; }
function repoLimits(limits: Limits, repo: string): RepoLimits { return limits.repos.get(repoKey(repo)) ?? fail(`missing_repo_limits:${repo}`); }
function repoKey(repo: string): string { return repo.toLowerCase(); }
function readLimits(value: Readonly<Record<string, unknown>>): Limits { const root = plain(value), repos = plain(root.repos), parsed = new Map<string, RepoLimits>(); for (const [repo, raw] of Object.entries(repos)) { const normalized = repoKey(repo); if (parsed.has(normalized)) fail("invalid_limit"); const limits = plain(raw), issues = positive(limits.maxIssuesPerCycle), comments = count(limits.maxCommentsPerCycle), burst = positive(limits.maxIssuesPerBurst); if (comments > issues) fail("invalid_limit"); parsed.set(normalized, { issues, comments, burst }); } const globalIssues = positive(root.globalMaxIssuesPerCycle), globalComments = count(root.globalMaxCommentsPerCycle); if (globalComments > globalIssues) fail("invalid_limit"); return { globalIssues, globalComments, repos: parsed }; }
function plain(value: unknown): Record<string, unknown> { if (!value || typeof value !== "object" || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail("invalid_limits"); return value as Record<string, unknown>; }
function count(value: unknown): number { if (!Number.isSafeInteger(value) || (value as number) < 0) fail("invalid_limit"); return value as number; }
function positive(value: unknown): number { const parsed = count(value); if (parsed === 0) fail("invalid_limit"); return parsed; }
function deepFrozen(value: unknown, seen = new WeakSet<object>()): boolean {
  if ((!value || typeof value !== "object") && typeof value !== "function") return true;
  try { if (utilTypes.isProxy(value) || !Object.isFrozen(value)) return false; const prototype = Object.getPrototypeOf(value); if (Array.isArray(value) ? prototype !== Array.prototype : ![Object.prototype, null].includes(prototype)) return false; if (seen.has(value)) return true; seen.add(value);
    return Reflect.ownKeys(value).every((key) => { const descriptor = Object.getOwnPropertyDescriptor(value, key); return Boolean(descriptor && "value" in descriptor && deepFrozen(descriptor.value, seen)); });
  } catch { return false; }
}
function fail(reason: string): never { throw new Error(`issue_enrichment_admission_ledger_${reason}`); }
