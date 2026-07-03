import type { BotConfig } from "./config.js";
import type { ReviewQueueJobRecord } from "./state.js";

export type ReviewQueueDelayReason =
  | "provider_cooldown"
  | "provider_capacity"
  | "org_capacity"
  | "repo_capacity"
  | "manual_reserve"
  | "proof_cooldown"
  | "lease_limit";

export interface ReviewBudgetDelay {
  reason: ReviewQueueDelayReason;
  jobId: string;
  source: ReviewQueueJobRecord["source"];
  lane: ReviewQueueJobRecord["lane"];
  repo: string;
  org: string;
  pullNumber: number;
  headSha: string;
  providerId: string;
  priority: number;
  state: ReviewQueueJobRecord["state"];
  nextEligibleAt?: string;
}

export interface ReviewBudgetCandidate {
  jobId: string;
  source: ReviewQueueJobRecord["source"];
  lane: ReviewQueueJobRecord["lane"];
  repo: string;
  org: string;
  pullNumber: number;
  headSha: string;
  providerId: string;
  priority: number;
  state: ReviewQueueJobRecord["state"];
  nextEligibleAt?: string;
}

export interface ReviewBudgetCapacity {
  name: string;
  active: number;
  limit: number;
  remaining: number;
}

export interface ReviewBudgetStatus {
  enabled: boolean;
  checkedAt: string;
  config: {
    reviewConcurrency: {
      maxActiveRuns: number;
      leaseTtlMs: number;
    };
    scheduler: {
      enabled: boolean;
      maxProviderActive: number;
      maxOrgActive: number;
      maxRepoActive: number;
      maxQueuedPerRepo: number;
      manualCommandReserve: number;
      backgroundPriority: number;
    };
  };
  active: {
    total: number;
    leased: number;
    running: number;
    manual: number;
    background: number;
    byProvider: ReviewBudgetCapacity[];
    byOrg: ReviewBudgetCapacity[];
    byRepo: ReviewBudgetCapacity[];
  };
  queued: {
    total: number;
    manual: number;
    background: number;
    providerDeferred: number;
    retryableProviderDeferred: number;
  };
  providerDeferred: {
    total: number;
    retryable: number;
    readyToRetry: number;
    waitingCooldown: number;
    waitingProviderCapacity: number;
    waitingOrgCapacity: number;
    waitingRepoCapacity: number;
    waitingManualReserve: number;
    waitingLeaseLimit: number;
  };
  manualReserve: {
    configured: number;
    activeManual: number;
    queuedManual: number;
    reservedSlotsOpen: number;
    backgroundSlotsAvailableBeforeReserve: number;
  };
  wouldLeaseCount: number;
  delayedCount: number;
  details: {
    included: boolean;
    detailLimit?: number;
    wouldLeaseReturned: number;
    delayedReturned: number;
    detailsTruncated: boolean;
    inputJobs: number;
    inputJobLimit?: number;
    inputJobsTruncated?: boolean;
  };
  wouldLease: ReviewBudgetCandidate[];
  delayed: ReviewBudgetDelay[];
  delayedByReason: Partial<Record<ReviewQueueDelayReason, number>>;
}

export class ReviewRunBudget {
  private readonly maxRuns: number;
  private currentRuns = 0;

  constructor(maxActiveRuns: number) {
    if (!Number.isInteger(maxActiveRuns)) throw new Error("maxActiveRuns must be an integer");
    if (maxActiveRuns < 1) throw new Error("maxActiveRuns must be at least 1");
    this.maxRuns = maxActiveRuns;
  }

  get activeRuns(): number {
    return this.currentRuns;
  }

  tryStart(): boolean {
    if (this.currentRuns >= this.maxRuns) return false;
    this.currentRuns += 1;
    return true;
  }

  finish(): void {
    this.currentRuns = Math.max(0, this.currentRuns - 1);
  }
}

export function buildReviewBudgetStatus(input: {
  config: BotConfig;
  jobs: ReviewQueueJobRecord[];
  now?: Date;
  includeDetails?: boolean;
  detailLimit?: number;
  inputJobLimit?: number;
  inputJobsTruncated?: boolean;
}): ReviewBudgetStatus {
  const now = input.now ?? new Date();
  const includeDetails = input.includeDetails ?? true;
  const detailLimit = input.detailLimit;
  const scheduler = input.config.reviewScheduler ?? {
    enabled: false,
    maxProviderActive: input.config.reviewConcurrency.maxActiveRuns,
    maxOrgActive: input.config.reviewConcurrency.maxActiveRuns,
    maxRepoActive: 1,
    maxQueuedPerRepo: 10,
    manualCommandReserve: 0,
    backgroundPriority: 50
  };
  const jobs = input.jobs.map((job) =>
    normalizeExpiredLeaseJob(job, now, input.config.reviewConcurrency.leaseTtlMs)
  );
  const active = jobs.filter((job) => isActiveQueueJob(job));
  const activeProvider = countBy(active, (job) => providerKey(job));
  const activeOrg = countBy(active, (job) => job.org);
  const activeRepo = countBy(active, (job) => job.repo);
  const queued = jobs.filter((job) => job.state === "queued" || job.state === "provider_deferred" || job.state === "blocked_on_proof");
  const manualQueued = queued.filter((job) => job.lane === "manual").length;
  const activeManual = active.filter((job) => job.lane === "manual").length;

  const delayed: ReviewBudgetDelay[] = [];
  for (const job of queued) {
    if (job.state === "blocked_on_proof" && !isRetryEligibleByNextEligibleAt(job, now)) {
      delayed.push(delay(job, "proof_cooldown"));
    }
    if (job.state === "provider_deferred" && !isProviderDeferredEligible(job, now)) {
      delayed.push(delay(job, "provider_cooldown"));
    }
  }

  const eligible = queued
    .filter((job) => job.state === "queued" || isRetryEligibleByNextEligibleAt(job, now))
    .sort(compareQueueJobsForBudget);
  const hasManualAfter = buildManualEligibilitySuffix(eligible);
  const wouldLease: ReviewBudgetCandidate[] = [];
  const simulatedProviderActive = new Map(activeProvider);
  const simulatedOrgActive = new Map(activeOrg);
  const simulatedRepoActive = new Map(activeRepo);

  for (const [index, job] of eligible.entries()) {
    const provider = providerKey(job);
    const providerCount = simulatedProviderActive.get(provider) ?? 0;
    const orgCount = simulatedOrgActive.get(job.org) ?? 0;
    const repoCount = simulatedRepoActive.get(job.repo) ?? 0;
    const capacityReason = capacityDelayReason(job, {
      scheduler,
      providerCount,
      orgCount,
      repoCount,
      hasManualAfter: hasManualAfter[index] ?? false
    });
    if (capacityReason) {
      delayed.push(delay(job, capacityReason));
      continue;
    }
    if (wouldLease.length >= scheduler.maxProviderActive) {
      delayed.push(delay(job, "lease_limit"));
      continue;
    }

    wouldLease.push(candidate(job));
    simulatedProviderActive.set(provider, providerCount + 1);
    simulatedOrgActive.set(job.org, orgCount + 1);
    simulatedRepoActive.set(job.repo, repoCount + 1);
  }

  const delayedByReason: Partial<Record<ReviewQueueDelayReason, number>> = {};
  for (const entry of delayed) {
    delayedByReason[entry.reason] = (delayedByReason[entry.reason] ?? 0) + 1;
  }
  const providerDeferredJobs = queued.filter((job) => job.state === "provider_deferred");
  const providerDeferredDelayed = delayed.filter((job) => job.state === "provider_deferred");
  const providerDeferredByReason = countBy(providerDeferredDelayed, (job) => job.reason);
  const returnedWouldLease = includeDetails ? applyDetailLimit(wouldLease, detailLimit) : [];
  const returnedDelayed = includeDetails ? applyDetailLimit(delayed, detailLimit) : [];
  const detailsTruncated =
    returnedWouldLease.length < wouldLease.length ||
    returnedDelayed.length < delayed.length ||
    input.inputJobsTruncated === true;

  return {
    enabled: scheduler.enabled,
    checkedAt: now.toISOString(),
    config: {
      reviewConcurrency: {
        maxActiveRuns: input.config.reviewConcurrency.maxActiveRuns,
        leaseTtlMs: input.config.reviewConcurrency.leaseTtlMs
      },
      scheduler: {
        enabled: scheduler.enabled,
        maxProviderActive: scheduler.maxProviderActive,
        maxOrgActive: scheduler.maxOrgActive,
        maxRepoActive: scheduler.maxRepoActive,
        maxQueuedPerRepo: scheduler.maxQueuedPerRepo,
        manualCommandReserve: scheduler.manualCommandReserve,
        backgroundPriority: scheduler.backgroundPriority
      }
    },
    active: {
      total: active.length,
      leased: active.filter((job) => job.state === "leased").length,
      running: active.filter((job) => job.state === "running").length,
      manual: active.filter((job) => job.lane === "manual").length,
      background: active.filter((job) => job.lane === "background").length,
      byProvider: capacityRows(activeProvider, scheduler.maxProviderActive),
      byOrg: capacityRows(activeOrg, scheduler.maxOrgActive),
      byRepo: capacityRows(activeRepo, scheduler.maxRepoActive)
    },
    queued: {
      total: queued.length,
      manual: manualQueued,
      background: queued.filter((job) => job.lane === "background").length,
      providerDeferred: providerDeferredJobs.length,
      retryableProviderDeferred: providerDeferredJobs.filter((job) => isProviderDeferredEligible(job, now)).length
    },
    providerDeferred: {
      total: providerDeferredJobs.length,
      retryable: providerDeferredJobs.filter((job) => isProviderDeferredEligible(job, now)).length,
      readyToRetry: wouldLease.filter((job) => job.state === "provider_deferred").length,
      waitingCooldown: providerDeferredByReason.get("provider_cooldown") ?? 0,
      waitingProviderCapacity: providerDeferredByReason.get("provider_capacity") ?? 0,
      waitingOrgCapacity: providerDeferredByReason.get("org_capacity") ?? 0,
      waitingRepoCapacity: providerDeferredByReason.get("repo_capacity") ?? 0,
      waitingManualReserve: providerDeferredByReason.get("manual_reserve") ?? 0,
      waitingLeaseLimit: providerDeferredByReason.get("lease_limit") ?? 0
    },
    manualReserve: {
      configured: scheduler.manualCommandReserve,
      activeManual,
      queuedManual: manualQueued,
      reservedSlotsOpen: Math.max(0, scheduler.manualCommandReserve - activeManual),
      backgroundSlotsAvailableBeforeReserve: Math.max(
        0,
        scheduler.maxProviderActive - scheduler.manualCommandReserve - active.length
      )
    },
    wouldLeaseCount: wouldLease.length,
    delayedCount: delayed.length,
    details: {
      included: includeDetails,
      ...(detailLimit !== undefined ? { detailLimit } : {}),
      wouldLeaseReturned: returnedWouldLease.length,
      delayedReturned: returnedDelayed.length,
      detailsTruncated,
      inputJobs: input.jobs.length,
      ...(input.inputJobLimit !== undefined ? { inputJobLimit: input.inputJobLimit } : {}),
      ...(input.inputJobsTruncated !== undefined ? { inputJobsTruncated: input.inputJobsTruncated } : {})
    },
    wouldLease: returnedWouldLease,
    delayed: returnedDelayed,
    delayedByReason
  };
}

function isActiveQueueJob(job: ReviewQueueJobRecord): boolean {
  return job.state === "leased" || job.state === "running";
}

function normalizeExpiredLeaseJob(job: ReviewQueueJobRecord, now: Date, leaseTtlMs: number): ReviewQueueJobRecord {
  if (!isActiveQueueJob(job)) return job;
  if (!isExpiredLeaseJob(job, now, leaseTtlMs)) return job;
  const normalized: ReviewQueueJobRecord = {
    ...job,
    state: "queued",
    lastError: "queue_lease_expired_requeued",
    updatedAt: now.toISOString()
  };
  delete normalized.leaseId;
  delete normalized.leaseExpiresAt;
  return normalized;
}

function isExpiredLeaseJob(job: ReviewQueueJobRecord, now: Date, leaseTtlMs: number): boolean {
  if (job.leaseExpiresAt) {
    const leaseExpiresAtMs = Date.parse(job.leaseExpiresAt);
    return Number.isFinite(leaseExpiresAtMs) && leaseExpiresAtMs <= now.getTime();
  }
  const updatedAtMs = Date.parse(job.updatedAt);
  return Number.isFinite(updatedAtMs) && updatedAtMs <= now.getTime() - leaseTtlMs;
}

function providerKey(job: ReviewQueueJobRecord): string {
  return job.providerId ?? "default";
}

function isProviderDeferredEligible(job: ReviewQueueJobRecord, now: Date): boolean {
  if (job.state !== "provider_deferred") return true;
  return isRetryEligibleByNextEligibleAt(job, now);
}

function isRetryEligibleByNextEligibleAt(job: ReviewQueueJobRecord, now: Date): boolean {
  if (!job.nextEligibleAt) return true;
  const eligibleAtMs = Date.parse(job.nextEligibleAt);
  return !Number.isFinite(eligibleAtMs) || eligibleAtMs <= now.getTime();
}

function compareQueueJobsForBudget(left: ReviewQueueJobRecord, right: ReviewQueueJobRecord): number {
  if (left.priority !== right.priority) return left.priority - right.priority;
  const created = Date.parse(left.createdAt) - Date.parse(right.createdAt);
  if (created !== 0) return created;
  return 0;
}

function capacityDelayReason(
  job: ReviewQueueJobRecord,
  input: {
    scheduler: NonNullable<BotConfig["reviewScheduler"]>;
    providerCount: number;
    orgCount: number;
    repoCount: number;
    hasManualAfter: boolean;
  }
): ReviewQueueDelayReason | undefined {
  if (input.providerCount >= input.scheduler.maxProviderActive) return "provider_capacity";
  if (input.orgCount >= input.scheduler.maxOrgActive) return "org_capacity";
  if (input.repoCount >= input.scheduler.maxRepoActive) return "repo_capacity";
  if (
    job.lane === "background" &&
    input.hasManualAfter &&
    input.scheduler.manualCommandReserve > 0 &&
    input.providerCount >= input.scheduler.maxProviderActive - input.scheduler.manualCommandReserve
  ) {
    return "manual_reserve";
  }
  return undefined;
}

function buildManualEligibilitySuffix(jobs: ReviewQueueJobRecord[]): boolean[] {
  const result = new Array<boolean>(jobs.length).fill(false);
  let seenManual = false;
  for (let index = jobs.length - 1; index >= 0; index -= 1) {
    result[index] = seenManual;
    if (jobs[index]?.lane === "manual") seenManual = true;
  }
  return result;
}

function candidate(job: ReviewQueueJobRecord): ReviewBudgetCandidate {
  return {
    jobId: job.jobId,
    source: job.source,
    lane: job.lane,
    repo: job.repo,
    org: job.org,
    pullNumber: job.pullNumber,
    headSha: job.headSha,
    providerId: providerKey(job),
    priority: job.priority,
    state: job.state,
    ...(job.nextEligibleAt ? { nextEligibleAt: job.nextEligibleAt } : {})
  };
}

function delay(job: ReviewQueueJobRecord, reason: ReviewQueueDelayReason): ReviewBudgetDelay {
  return {
    ...candidate(job),
    reason,
    state: job.state,
    ...(job.nextEligibleAt ? { nextEligibleAt: job.nextEligibleAt } : {})
  };
}

function capacityRows(counts: Map<string, number>, limit: number): ReviewBudgetCapacity[] {
  return [...counts.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, active]) => ({
      name,
      active,
      limit,
      remaining: Math.max(0, limit - active)
    }));
}

function applyDetailLimit<T>(items: T[], limit?: number): T[] {
  if (limit === undefined) return items;
  return items.slice(0, Math.max(0, limit));
}

function countBy<T>(items: T[], key: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const itemKey = key(item);
    counts.set(itemKey, (counts.get(itemKey) ?? 0) + 1);
  }
  return counts;
}
