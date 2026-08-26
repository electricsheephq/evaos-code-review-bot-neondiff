import type { IssueEnrichmentAdmissionCandidate, IssueEnrichmentAdmissionSnapshot } from "./issue-enrichment-admission-snapshot.js";

export type IssueEnrichmentAdmissionDecisionState = "pending" | "held" | "already_recorded" | "source_dependent";
export type IssueEnrichmentAdmissionDecisionReason =
  | "no_record" | "record_failed" | "record_skipped"
  | "persisted_defer_active" | "persisted_defer_identity_unknown_or_changed" | "persisted_defer_due_or_unknown"
  | "dry_run_equal_identity" | "dry_run_identity_unknown_or_changed" | "dry_run_requires_live"
  | "posted_requires_source_comparison" | "current_defer_active" | "current_defer_due_or_unknown" | "current_scan_skipped";

export interface IssueEnrichmentAdmissionDecision {
  key: string;
  state: IssueEnrichmentAdmissionDecisionState;
  reason: IssueEnrichmentAdmissionDecisionReason;
  candidate: Readonly<IssueEnrichmentAdmissionCandidate>;
}

export function classifyIssueEnrichmentAdmission(snapshot: Readonly<IssueEnrichmentAdmissionSnapshot>): readonly Readonly<IssueEnrichmentAdmissionDecision>[] {
  if (!snapshot || !Object.isFrozen(snapshot) || !Array.isArray(snapshot.candidates) || !Object.isFrozen(snapshot.candidates)) fail("invalid_snapshot");
  return Object.freeze(snapshot.candidates.map((candidate) => {
    if (!candidate || !Object.isFrozen(candidate)) fail("invalid_candidate");
    return classify(candidate, snapshot.checkedAt);
  }));
}

function classify(candidate: Readonly<IssueEnrichmentAdmissionCandidate>, checkedAt: string): Readonly<IssueEnrichmentAdmissionDecision> {
  if (candidate.action === "deferred") return decision(candidate, future(candidate.nextEligibleAt, checkedAt) ? "held" : "pending", future(candidate.nextEligibleAt, checkedAt) ? "current_defer_active" : "current_defer_due_or_unknown");
  if (candidate.action === "skipped") return decision(candidate, "pending", "current_scan_skipped");
  const record = candidate.record;
  if (!record) return decision(candidate, "pending", "no_record");
  if (record.status === "failed") return decision(candidate, "pending", "record_failed");
  if (record.status === "skipped") return decision(candidate, "pending", "record_skipped");
  if (record.status === "posted") return decision(candidate, "source_dependent", "posted_requires_source_comparison");
  const sameKnownIdentity = typeof candidate.issueUpdatedAt === "string" && typeof record.issueUpdatedAt === "string" && candidate.issueUpdatedAt === record.issueUpdatedAt;
  if (record.status === "deferred") {
    if (!sameKnownIdentity) return decision(candidate, "pending", "persisted_defer_identity_unknown_or_changed");
    return decision(candidate, future(record.nextEligibleAt, checkedAt) ? "held" : "pending", future(record.nextEligibleAt, checkedAt) ? "persisted_defer_active" : "persisted_defer_due_or_unknown");
  }
  if (candidate.action === "would_comment") return decision(candidate, "pending", "dry_run_requires_live");
  return decision(candidate, sameKnownIdentity ? "already_recorded" : "pending", sameKnownIdentity ? "dry_run_equal_identity" : "dry_run_identity_unknown_or_changed");
}

function future(value: unknown, checkedAt: unknown): boolean {
  if (typeof value !== "string" || typeof checkedAt !== "string") return false;
  const deadline = Date.parse(value), now = Date.parse(checkedAt);
  return Number.isFinite(deadline) && Number.isFinite(now) && deadline > now;
}

function decision(candidate: Readonly<IssueEnrichmentAdmissionCandidate>, state: IssueEnrichmentAdmissionDecisionState, reason: IssueEnrichmentAdmissionDecisionReason): Readonly<IssueEnrichmentAdmissionDecision> {
  return Object.freeze(Object.assign(Object.create(null), { key: candidate.key, state, reason, candidate }));
}

function fail(reason: string): never { throw new Error(`issue_enrichment_admission_decision_${reason}`); }
