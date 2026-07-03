import type {
  ReviewQueueJobRecord,
  ReviewReadinessRecord,
  ReviewStateStore,
  StoredProcessedReviewRecord
} from "./state.js";

export type ReviewHeadGateDecision =
  | "passed"
  | "missing"
  | "queued"
  | "reviewing"
  | "provider_deferred"
  | "failed"
  | "needs_fix"
  | "skipped"
  | "dry_run"
  | "stale"
  | "closed"
  | "blocked";

export interface ReviewHeadGateResult {
  ok: boolean;
  healthState: "review_head_gate_ok" | "review_head_gate_blocked";
  checkedAt: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  decision: ReviewHeadGateDecision;
  processed?: StoredProcessedReviewRecord;
  readiness?: ReviewReadinessRecord;
  queueJobs: ReviewQueueJobRecord[];
  gates: { name: string; ok: boolean; detail: string }[];
  nextAction: string;
}

export function buildReviewHeadGate(input: {
  state: Pick<ReviewStateStore, "getProcessedReview" | "getReviewReadiness" | "listReviewQueueJobsForPull">;
  repo: string;
  pullNumber: number;
  headSha: string;
  now?: Date;
}): ReviewHeadGateResult {
  validateRepoSlug(input.repo);
  validatePullNumber(input.pullNumber);
  validateHeadSha(input.headSha);

  const processed = input.state.getProcessedReview(input.repo, input.pullNumber, input.headSha);
  const readiness = input.state.getReviewReadiness(input.repo, input.pullNumber, input.headSha);
  const queueJobs = input.state
    .listReviewQueueJobsForPull({ repo: input.repo, pullNumber: input.pullNumber })
    .filter((job) => job.headSha === input.headSha);
  const decision = decideReviewHeadGate({ processed, readiness, queueJobs });
  const ok = decision === "passed";
  const gates = [
    {
      name: "exact_head_has_recorded_nonblocking_evaos_review",
      ok,
      detail: gateDetail(decision, processed, readiness, queueJobs)
    }
  ];

  return {
    ok,
    healthState: ok ? "review_head_gate_ok" : "review_head_gate_blocked",
    checkedAt: (input.now ?? new Date()).toISOString(),
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    decision,
    ...(processed ? { processed } : {}),
    ...(readiness ? { readiness } : {}),
    queueJobs,
    gates,
    nextAction: nextAction(decision)
  };
}

function decideReviewHeadGate(input: {
  processed?: StoredProcessedReviewRecord;
  readiness?: ReviewReadinessRecord;
  queueJobs: ReviewQueueJobRecord[];
}): ReviewHeadGateDecision {
  const activeJob = input.queueJobs.find(isActiveQueueJob);
  if (activeJob && (!input.processed || isQueueJobNewerThanProcessed(activeJob, input.processed))) {
    return decisionFromQueueJob(activeJob);
  }
  if (input.processed) return decisionFromProcessed(input.processed);
  const terminalJob = input.queueJobs.find(isTerminalQueueJob);
  if (terminalJob) return decisionFromQueueJob(terminalJob);
  if (input.readiness) return decisionFromReadiness(input.readiness);
  return "missing";
}

function decisionFromProcessed(processed: StoredProcessedReviewRecord): ReviewHeadGateDecision {
  switch (processed.status) {
    case "posted":
      if (processed.event === "REQUEST_CHANGES") return "needs_fix";
      // This gate proves exact-head review state. App authorship is verified by live release-status config.
      return "passed";
    case "dry_run":
      return "dry_run";
    case "skipped":
      return "skipped";
    case "failed":
      return "failed";
    default:
      return assertNever(processed.status);
  }
}

function decisionFromQueueJob(job: ReviewQueueJobRecord): ReviewHeadGateDecision {
  switch (job.state) {
    case "queued":
      return "queued";
    case "leased":
    case "running":
      return "reviewing";
    case "provider_deferred":
      return "provider_deferred";
    case "failed":
      return "failed";
    case "stale_retired":
      return "stale";
    case "closed_retired":
      return "closed";
    case "command_recorded":
      return "blocked";
    case "posted":
      return job.reviewUrl ? "passed" : "blocked";
    default:
      return assertNever(job.state);
  }
}

function decisionFromReadiness(readiness: ReviewReadinessRecord): ReviewHeadGateDecision {
  switch (readiness.state) {
    case "ready_for_human":
      return readiness.reviewUrl ? "passed" : "blocked";
    case "needs_fix":
      return "needs_fix";
    case "queued":
      return "queued";
    case "reviewing":
      return "reviewing";
    case "provider_deferred":
      return "provider_deferred";
    case "failed":
      return "failed";
    case "skipped":
    case "command_recorded":
      return "skipped";
    case "stale":
    case "awaiting_re_review":
      return "stale";
    case "closed":
      return "closed";
    case "blocked_on_checks":
    case "blocked_on_proof":
      return "blocked";
    default:
      return assertNever(readiness.state);
  }
}

function isActiveQueueJob(job: ReviewQueueJobRecord): boolean {
  return job.state === "queued" || job.state === "leased" || job.state === "running" || job.state === "provider_deferred";
}

function isTerminalQueueJob(job: ReviewQueueJobRecord): boolean {
  return job.state === "posted" || job.state === "failed" || job.state === "stale_retired" || job.state === "closed_retired" || job.state === "command_recorded";
}

function isQueueJobNewerThanProcessed(job: ReviewQueueJobRecord, processed: StoredProcessedReviewRecord): boolean {
  const jobMs = parseStoreTimestamp(job.updatedAt);
  const processedMs = parseStoreTimestamp(processed.createdAt);
  if (!Number.isFinite(jobMs) || !Number.isFinite(processedMs)) return true;
  return jobMs > processedMs;
}

function parseStoreTimestamp(value: string): number {
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) {
    return Date.parse(`${value.replace(" ", "T")}Z`);
  }
  return Date.parse(value);
}

function gateDetail(
  decision: ReviewHeadGateDecision,
  processed: StoredProcessedReviewRecord | undefined,
  readiness: ReviewReadinessRecord | undefined,
  queueJobs: ReviewQueueJobRecord[]
): string {
  if (decision === "passed" && processed) {
    return `processed_reviews status=${processed.status} event=${processed.event ?? "unknown"} reviewUrl=${processed.reviewUrl ?? "none"}`;
  }
  const activeJob = queueJobs.find(isActiveQueueJob);
  if (activeJob) {
    return `queue_job state=${activeJob.state} priority=${activeJob.priority} lastError=${activeJob.lastError ?? "none"}`;
  }
  const terminalJob = queueJobs.find(isTerminalQueueJob);
  if (terminalJob) {
    return `queue_job state=${terminalJob.state} priority=${terminalJob.priority} reviewUrl=${terminalJob.reviewUrl ?? "none"} lastError=${terminalJob.lastError ?? "none"}`;
  }
  if (decision === "passed" && readiness) {
    return `review_readiness state=${readiness.state} reviewUrl=${readiness.reviewUrl ?? "none"}`;
  }
  if (processed) return `processed_reviews status=${processed.status} error=${processed.error ?? "none"}`;
  if (readiness) return `review_readiness state=${readiness.state} reason=${readiness.reason ?? "none"}`;
  return "no processed review, active queue job, or readiness row for exact head";
}

function nextAction(decision: ReviewHeadGateDecision): string {
  switch (decision) {
    case "passed":
      return "merge gate passed for exact head";
    case "queued":
    case "reviewing":
      return "wait for evaOS review status to reach completed before merging";
    case "provider_deferred":
      return "wait for provider cooldown or retry according to provider-cooldown policy before merging";
    case "missing":
      return "do not merge; wait for the daemon to observe this head or run an explicit review-pr/re-review command";
    case "dry_run":
      return "do not merge from dry-run proof; require a live App-authored review or explicit waiver";
    case "skipped":
      return "do not merge without confirming the skip reason is an approved waiver";
    case "failed":
      return "inspect failure evidence and retry or fix before merging";
    case "needs_fix":
      return "do not merge; address evaOS requested changes or explicitly override with human approval";
    case "stale":
      return "refresh the current PR head and run the gate for the latest SHA";
    case "closed":
      return "PR is already closed or merged; record this as incident evidence if the final head needed review";
    case "blocked":
      return "resolve the blocked readiness state before merging";
    default:
      return assertNever(decision);
  }
}

function validateRepoSlug(repo: string): void {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`Invalid repo slug: ${repo}`);
}

function validatePullNumber(pullNumber: number): void {
  if (!Number.isInteger(pullNumber) || pullNumber < 1) throw new Error(`Invalid PR number: ${pullNumber}`);
}

function validateHeadSha(headSha: string): void {
  if (!/^[0-9a-f]{40}$/i.test(headSha)) throw new Error(`Invalid head SHA: ${headSha}`);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled review-head-gate value: ${String(value)}`);
}
