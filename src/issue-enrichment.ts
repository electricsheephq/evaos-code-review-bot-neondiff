import { buildIssueEnrichmentDryRunOutput } from "./enrichment.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import { redactSecrets } from "./secrets.js";

export interface IssueEnrichmentConfig {
  enabled: boolean;
  postIssueComment: boolean;
  allowlist: string[];
  maxIssuesPerCycle: number;
  maxCommentsPerCycle: number;
  cooldownMs: number;
  burstWindowMs: number;
  maxIssuesPerBurst: number;
  lookbackMs: number;
  processExistingOpenIssuesOnActivation: boolean;
  repos?: Record<string, IssueEnrichmentRepoOverride>;
}

export const DEFAULT_ISSUE_ENRICHMENT_CONFIG: IssueEnrichmentConfig = {
  enabled: false,
  postIssueComment: false,
  allowlist: [],
  maxIssuesPerCycle: 5,
  maxCommentsPerCycle: 0,
  cooldownMs: 60 * 60_000,
  burstWindowMs: 60 * 60_000,
  maxIssuesPerBurst: 10,
  lookbackMs: 10 * 60_000,
  processExistingOpenIssuesOnActivation: false,
  repos: {}
};

export interface IssueEnrichmentRepoOverride {
  enabled?: boolean;
  maxIssuesPerCycle?: number;
  maxCommentsPerCycle?: number;
  cooldownMs?: number;
  burstWindowMs?: number;
  maxIssuesPerBurst?: number;
  lookbackMs?: number;
  processExistingOpenIssuesOnActivation?: boolean;
}

export interface IssueEnrichmentStatus {
  ok: boolean;
  checkedAt: string;
  state: "disabled" | "dry_run_only" | "ready" | "blocked";
  enabled: boolean;
  postIssueComment: boolean;
  separateAllowlist: true;
  allowlist: string[];
  throttleDefaults: IssueEnrichmentThrottlePolicy;
  repoOverrides: Array<{ repo: string } & IssueEnrichmentRepoOverride>;
  blockers: IssueEnrichmentBlocker[];
}

export interface IssueEnrichmentThrottlePolicy {
  maxIssuesPerCycle: number;
  maxCommentsPerCycle: number;
  cooldownMs: number;
  burstWindowMs: number;
  maxIssuesPerBurst: number;
  lookbackMs: number;
  processExistingOpenIssuesOnActivation: boolean;
}

export type IssueEnrichmentBlocker =
  | "issue_enrichment_disabled"
  | "issue_enrichment_allowlist_empty"
  | "issue_enrichment_live_posting_disabled"
  | "github_app_credentials_required_for_live_issue_comments";

export interface IssueEnrichmentReader {
  listIssuesForEnrichment(
    repo: string,
    options?: {
      state?: "open" | "closed" | "all";
      since?: string;
      perPage?: number;
      pageLimit?: number;
    }
  ): Promise<GitHubRelatedIssueOrPull[]>;
}

export interface IssueEnrichmentScanResult {
  ok: boolean;
  checkedAt: string;
  dryRun: boolean;
  status: IssueEnrichmentStatus;
  summary: {
    reposScanned: number;
    reposSkipped: number;
    readFailures: number;
    issuesSeen: number;
    eligible: number;
    skipped: number;
    wouldEnrich: number;
    wouldComment: number;
    deferred: number;
  };
  repos: IssueEnrichmentRepoScan[];
  items: IssueEnrichmentScanItem[];
  recommendedActions: string[];
}

export interface IssueEnrichmentRepoScan {
  repo: string;
  ok: boolean;
  allowed: boolean;
  enabled: boolean;
  postIssueComment: boolean;
  since?: string;
  throttle: IssueEnrichmentThrottlePolicy;
  issuesSeen: number;
  eligible: number;
  skipped: number;
  wouldEnrich: number;
  wouldComment: number;
  deferred: number;
  readFailure?: string;
  skipReason?: "not_issue_enrichment_allowlisted" | "issue_enrichment_repo_disabled";
}

export type IssueEnrichmentScanAction = "would_enrich" | "would_comment" | "skipped" | "deferred";
export type IssueEnrichmentScanReason =
  | "eligible"
  | "stale_issue_closed"
  | "issue_is_pull_request"
  | "repo_max_issues_per_cycle"
  | "repo_max_comments_per_cycle"
  | "burst_threshold_exceeded";

export interface IssueEnrichmentScanItem {
  repo: string;
  issueNumber: number;
  state: string;
  action: IssueEnrichmentScanAction;
  reason: IssueEnrichmentScanReason;
  url?: string;
}

const DEFAULT_REPO_SCAN_OPTIONS = {
  state: "all" as const,
  perPage: 100,
  pageLimit: 1
};

export function buildIssueEnrichmentStatus(input: {
  config: { issueEnrichment?: IssueEnrichmentConfig };
  canPostAsApp: boolean;
  checkedAt?: string;
}): IssueEnrichmentStatus {
  const config = input.config.issueEnrichment ?? DEFAULT_ISSUE_ENRICHMENT_CONFIG;
  const blockers: IssueEnrichmentBlocker[] = [];
  if (!config.enabled) blockers.push("issue_enrichment_disabled");
  if (config.allowlist.length === 0) blockers.push("issue_enrichment_allowlist_empty");
  if (!config.postIssueComment) blockers.push("issue_enrichment_live_posting_disabled");
  if (config.enabled && config.postIssueComment && !input.canPostAsApp) {
    blockers.push("github_app_credentials_required_for_live_issue_comments");
  }

  const blocking = blockers.filter((blocker) =>
    blocker === "github_app_credentials_required_for_live_issue_comments" ||
    (config.enabled && blocker === "issue_enrichment_allowlist_empty")
  );
  const state = !config.enabled
    ? "disabled"
    : blocking.length > 0
      ? "blocked"
      : config.postIssueComment
        ? "ready"
        : "dry_run_only";

  return {
    ok: blocking.length === 0,
    checkedAt: input.checkedAt ?? new Date().toISOString(),
    state,
    enabled: config.enabled,
    postIssueComment: config.postIssueComment,
    separateAllowlist: true,
    allowlist: [...config.allowlist],
    throttleDefaults: {
      maxIssuesPerCycle: config.maxIssuesPerCycle,
      maxCommentsPerCycle: config.maxCommentsPerCycle,
      cooldownMs: config.cooldownMs,
      burstWindowMs: config.burstWindowMs,
      maxIssuesPerBurst: config.maxIssuesPerBurst,
      lookbackMs: config.lookbackMs,
      processExistingOpenIssuesOnActivation: config.processExistingOpenIssuesOnActivation
    },
    repoOverrides: Object.entries(config.repos ?? {}).map(([repo, override]) => ({ repo, ...override })),
    blockers
  };
}

export async function collectIssueEnrichmentScan(input: {
  config: { issueEnrichment?: IssueEnrichmentConfig };
  reader: IssueEnrichmentReader;
  dryRun: boolean;
  repo?: string;
  includeExisting?: boolean;
  since?: string;
  canPostAsApp?: boolean;
  checkedAt?: string;
}): Promise<IssueEnrichmentScanResult> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const config = input.config.issueEnrichment ?? DEFAULT_ISSUE_ENRICHMENT_CONFIG;
  const status = buildIssueEnrichmentStatus({
    config: input.config,
    canPostAsApp: input.canPostAsApp ?? false,
    checkedAt
  });
  const repos = input.repo ? [input.repo] : config.allowlist;
  const repoScans: IssueEnrichmentRepoScan[] = [];
  const items: IssueEnrichmentScanItem[] = [];

  for (const repo of repos) {
    const policy = resolveIssueEnrichmentRepoPolicy(config, repo);
    if (!policy.allowed) {
      repoScans.push({
        repo,
        ok: true,
        allowed: false,
        enabled: false,
        postIssueComment: config.postIssueComment,
        throttle: policy.throttle,
        issuesSeen: 0,
        eligible: 0,
        skipped: 0,
        wouldEnrich: 0,
        wouldComment: 0,
        deferred: 0,
        skipReason: policy.reason
      });
      continue;
    }

    const since = input.since ?? buildIssueScanSince({
      checkedAt,
      includeExisting: input.includeExisting === true || policy.throttle.processExistingOpenIssuesOnActivation,
      lookbackMs: policy.throttle.lookbackMs
    });
    let issues: GitHubRelatedIssueOrPull[] = [];
    try {
      issues = await input.reader.listIssuesForEnrichment(repo, {
        ...DEFAULT_REPO_SCAN_OPTIONS,
        ...(since ? { since } : {})
      });
    } catch (error) {
      repoScans.push({
        repo,
        ok: false,
        allowed: true,
        enabled: config.enabled,
        postIssueComment: config.postIssueComment,
        ...(since ? { since } : {}),
        throttle: policy.throttle,
        issuesSeen: 0,
        eligible: 0,
        skipped: 0,
        wouldEnrich: 0,
        wouldComment: 0,
        deferred: 0,
        readFailure: redactSecrets(error instanceof Error ? error.message : String(error))
      });
      continue;
    }

    const issueItems = planRepoIssueScan({
      repo,
      issues,
      throttle: policy.throttle,
      postIssueComment: config.postIssueComment
    });
    items.push(...issueItems);
    repoScans.push({
      repo,
      ok: true,
      allowed: true,
      enabled: config.enabled,
      postIssueComment: config.postIssueComment,
      ...(since ? { since } : {}),
      throttle: policy.throttle,
      issuesSeen: issues.length,
      eligible: issueItems.filter((item) => item.reason === "eligible" || item.reason.startsWith("repo_max") || item.reason === "burst_threshold_exceeded").length,
      skipped: issueItems.filter((item) => item.action === "skipped").length,
      wouldEnrich: issueItems.filter((item) => item.action === "would_enrich" || item.action === "would_comment").length,
      wouldComment: issueItems.filter((item) => item.action === "would_comment").length,
      deferred: issueItems.filter((item) => item.action === "deferred").length
    });
  }

  const summary = summarizeScan(repoScans);
  return {
    ok: summary.readFailures === 0,
    checkedAt,
    dryRun: input.dryRun,
    status,
    summary,
    repos: repoScans,
    items,
    recommendedActions: buildScanRecommendedActions(status, summary)
  };
}

export function resolveIssueEnrichmentRepoPolicy(
  config: IssueEnrichmentConfig,
  repo: string
): {
  allowed: boolean;
  reason?: "not_issue_enrichment_allowlisted" | "issue_enrichment_repo_disabled";
  throttle: IssueEnrichmentThrottlePolicy;
} {
  const override = config.repos?.[repo];
  const throttle = {
    maxIssuesPerCycle: override?.maxIssuesPerCycle ?? config.maxIssuesPerCycle,
    maxCommentsPerCycle: override?.maxCommentsPerCycle ?? config.maxCommentsPerCycle,
    cooldownMs: override?.cooldownMs ?? config.cooldownMs,
    burstWindowMs: override?.burstWindowMs ?? config.burstWindowMs,
    maxIssuesPerBurst: override?.maxIssuesPerBurst ?? config.maxIssuesPerBurst,
    lookbackMs: override?.lookbackMs ?? config.lookbackMs,
    processExistingOpenIssuesOnActivation:
      override?.processExistingOpenIssuesOnActivation ?? config.processExistingOpenIssuesOnActivation
  };
  if (!config.allowlist.includes(repo)) return { allowed: false, reason: "not_issue_enrichment_allowlisted", throttle };
  if (override?.enabled === false) return { allowed: false, reason: "issue_enrichment_repo_disabled", throttle };
  return { allowed: true, throttle };
}

function planRepoIssueScan(input: {
  repo: string;
  issues: GitHubRelatedIssueOrPull[];
  throttle: IssueEnrichmentThrottlePolicy;
  postIssueComment: boolean;
}): IssueEnrichmentScanItem[] {
  const eligible = input.issues
    .map((issue) => buildIssueEnrichmentDryRunOutput({
      repo: input.repo,
      issue,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    }))
    .filter((output) => !output.skipped);
  const burstExceeded = eligible.length > input.throttle.maxIssuesPerBurst;
  let enriched = 0;
  let comments = 0;

  return input.issues.map((issue) => {
    const output = buildIssueEnrichmentDryRunOutput({
      repo: input.repo,
      issue,
      maxRelatedRefs: 8,
      maxSuggestions: 8
    });
    if (output.skipped) {
      return {
        repo: input.repo,
        issueNumber: output.issueNumber,
        state: output.state,
        action: "skipped",
        reason: output.reason,
        ...(output.url ? { url: output.url } : {})
      };
    }
    if (burstExceeded) {
      return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "burst_threshold_exceeded", output.url);
    }
    if (enriched >= input.throttle.maxIssuesPerCycle) {
      return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "repo_max_issues_per_cycle", output.url);
    }
    enriched += 1;
    if (input.postIssueComment) {
      if (comments >= input.throttle.maxCommentsPerCycle) {
        return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "repo_max_comments_per_cycle", output.url);
      }
      comments += 1;
      return issueScanItem(input.repo, output.issueNumber, output.state, "would_comment", "eligible", output.url);
    }
    return issueScanItem(input.repo, output.issueNumber, output.state, "would_enrich", "eligible", output.url);
  });
}

function issueScanItem(
  repo: string,
  issueNumber: number,
  state: string,
  action: IssueEnrichmentScanAction,
  reason: IssueEnrichmentScanReason,
  url?: string
): IssueEnrichmentScanItem {
  return {
    repo,
    issueNumber,
    state,
    action,
    reason,
    ...(url ? { url } : {})
  };
}

function buildIssueScanSince(input: {
  checkedAt: string;
  includeExisting: boolean;
  lookbackMs: number;
}): string | undefined {
  if (input.includeExisting) return undefined;
  const checkedAtMs = Date.parse(input.checkedAt);
  const baseMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  return new Date(baseMs - input.lookbackMs).toISOString();
}

function summarizeScan(repoScans: IssueEnrichmentRepoScan[]): IssueEnrichmentScanResult["summary"] {
  return {
    reposScanned: repoScans.filter((repo) => repo.allowed).length,
    reposSkipped: repoScans.filter((repo) => !repo.allowed).length,
    readFailures: repoScans.filter((repo) => !repo.ok).length,
    issuesSeen: sum(repoScans, "issuesSeen"),
    eligible: sum(repoScans, "eligible"),
    skipped: sum(repoScans, "skipped"),
    wouldEnrich: sum(repoScans, "wouldEnrich"),
    wouldComment: sum(repoScans, "wouldComment"),
    deferred: sum(repoScans, "deferred")
  };
}

function buildScanRecommendedActions(status: IssueEnrichmentStatus, summary: IssueEnrichmentScanResult["summary"]): string[] {
  const actions = [];
  if (status.state === "blocked") actions.push("resolve issue-enrichment blockers before live issue comments");
  if (summary.deferred > 0) actions.push("inspect deferred issue-enrichment rows and adjust per-repo throttles only after dry-run review");
  if (summary.readFailures > 0) actions.push("run doctor and inspect GitHub App Issues permissions");
  return actions;
}

function sum<T extends keyof Pick<IssueEnrichmentRepoScan, "issuesSeen" | "eligible" | "skipped" | "wouldEnrich" | "wouldComment" | "deferred">>(
  repos: IssueEnrichmentRepoScan[],
  field: T
): number {
  return repos.reduce((total, repo) => total + repo[field], 0);
}
