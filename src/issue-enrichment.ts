import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  buildIssueAnalysisEnrichmentComment,
  buildIssueEnrichmentComment,
  buildIssueEnrichmentDryRunOutput,
  ENRICHMENT_MARKER_PREFIX,
  ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION,
  postEnrichmentComment,
  type EnrichmentComment,
  type EnrichmentCommentGithub,
  type IssueEnrichmentLifecycleInput
} from "./enrichment.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import { unpackBoundedGithubList, type BoundedGithubList } from "./github.js";
import {
  buildIssueAnalysisInputHash,
  runIssueAnalysis,
  type IssueAnalysis,
  type IssueAnalysisEvidenceContext,
  type IssueAnalysisPolicyContext
} from "./issue-analysis.js";
import type { CodexReasoningEffort } from "./codex-runtime.js";
import {
  buildReviewLensPacket,
  type ReviewLensConfig,
  type ReviewLensPacket
} from "./review-lenses.js";
import type { PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { redactSecrets } from "./secrets.js";
import type { IssueEnrichmentRecord, IssueEnrichmentRecordStatus, ReviewStateStore } from "./state.js";
import { isAuthenticProductionLicenseAdmission, type ProductionLicenseAdmission } from "./license-admission.js";
import { prepareBranchWorktree, type PreparedWorktree } from "./git.js";
import { getProtectedCheckoutRoots } from "./path-safety.js";
import { writeSecureFileSync } from "./temp-files.js";
import { canonicalIssueEnrichmentRepositories, canonicalIssueEnrichmentRepository } from "./issue-enrichment-repository-policy.js";

export interface IssueEnrichmentConfig {
  enabled: boolean;
  postIssueComment: boolean;
  allowlist: string[];
  allowedLabels: string[];
  allowedReviewers: string[];
  maxIssuesPerCycle: number;
  maxCommentsPerCycle: number;
  globalMaxIssuesPerCycle: number;
  globalMaxCommentsPerCycle: number;
  maxActiveRuns: number;
  leaseTtlMs: number;
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
  allowedLabels: [],
  allowedReviewers: [],
  maxIssuesPerCycle: 5,
  maxCommentsPerCycle: 1,
  globalMaxIssuesPerCycle: 5,
  globalMaxCommentsPerCycle: 1,
  maxActiveRuns: 1,
  leaseTtlMs: 20 * 60_000,
  cooldownMs: 60 * 60_000,
  burstWindowMs: 60 * 60_000,
  maxIssuesPerBurst: 10,
  lookbackMs: 10 * 60_000,
  processExistingOpenIssuesOnActivation: false,
  repos: {}
};

export interface IssueEnrichmentRepoOverride {
  enabled?: boolean;
  allowedLabels?: string[];
  allowedReviewers?: string[];
  advisoryPolicy?: string;
  validationSuggestions?: string[];
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
  labelAliases?: Record<string, string>;
  promotionMaintainers?: Array<{ login: string; validFrom: string; validUntil?: string }>;
  maxIssuesPerCycle?: number;
  maxCommentsPerCycle?: number;
  cooldownMs?: number;
  burstWindowMs?: number;
  maxIssuesPerBurst?: number;
  lookbackMs?: number;
  processExistingOpenIssuesOnActivation?: boolean;
}

export interface IssueEnrichmentRepoPolicy {
  advisoryPolicy?: string;
  validationSuggestions: string[];
  suggestedLabels: string[];
  suggestedReviewers: string[];
  labelAliases: Record<string, string>;
}

export type IssuePromotionPermission = "read" | "triage" | "write" | "maintain" | "admin" | "none";

export interface IssuePromotionEvidence {
  upstreamIntake: boolean;
  activeContinuation: boolean;
  labelEvent: {
    actor: string;
    createdAt: string;
  };
  allowlist: Array<{
    login: string;
    validFrom: string;
    validUntil?: string;
  }>;
  currentPermission: IssuePromotionPermission;
}

export function isTrustedIssuePromotion(evidence: IssuePromotionEvidence): boolean {
  if (!evidence.upstreamIntake || !evidence.activeContinuation) return false;
  if (!["write", "maintain", "admin"].includes(evidence.currentPermission.toLowerCase())) return false;
  const eventTime = Date.parse(evidence.labelEvent.createdAt);
  if (!Number.isFinite(eventTime)) return false;
  const actor = evidence.labelEvent.actor.trim().toLowerCase();
  if (!actor) return false;
  return evidence.allowlist.some((entry) => {
    if (entry.login.trim().toLowerCase() !== actor) return false;
    const validFrom = Date.parse(entry.validFrom);
    const validUntil = entry.validUntil ? Date.parse(entry.validUntil) : Number.POSITIVE_INFINITY;
    return Number.isFinite(validFrom) && !Number.isNaN(validUntil) && eventTime >= validFrom && eventTime <= validUntil;
  });
}

export interface IssueEnrichmentStatus {
  ok: boolean;
  checkedAt: string;
  state: "disabled" | "dry_run_only" | "ready" | "blocked";
  enabled: boolean;
  postIssueComment: boolean;
  separateAllowlist: true;
  allowlist: string[];
  liveThresholdsMissingRepos: string[];
  throttleDefaults: IssueEnrichmentThrottlePolicy;
  globalLimits: IssueEnrichmentGlobalLimits;
  repoOverrides: Array<{ repo: string } & IssueEnrichmentRepoOverride>;
  issueReadChecks?: IssueEnrichmentRepoReadCheck[];
  blockers: IssueEnrichmentBlocker[];
}

export const DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS = new Set<IssueEnrichmentBlocker>([
  "github_app_credentials_required_for_live_issue_comments",
  "issue_enrichment_live_posting_disabled",
  "issue_enrichment_model_runtime_required"
]);

export interface IssueEnrichmentRepoReadCheck {
  repo: string;
  ok: boolean;
  readableIssueCount?: number;
  skippedByPolicy?: "not_issue_enrichment_allowlisted" | "issue_enrichment_repo_disabled";
  error?: string;
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

export interface IssueEnrichmentSuggestionPolicy {
  allowedLabels: string[];
  allowedReviewers: string[];
}

export interface IssueEnrichmentGlobalLimits {
  globalMaxIssuesPerCycle: number;
  globalMaxCommentsPerCycle: number;
  maxActiveRuns: number;
  leaseTtlMs: number;
}

export type IssueEnrichmentBlocker =
  | "issue_enrichment_disabled"
  | "issue_enrichment_allowlist_empty"
  | "issue_enrichment_live_posting_disabled"
  | "github_app_credentials_required_for_live_issue_comments"
  | "github_app_issues_permission_required"
  | "issue_enrichment_live_repo_thresholds_required"
  | "issue_enrichment_model_runtime_required";

export interface IssueAnalysisRunnerInput {
  repo: string;
  issue: GitHubRelatedIssueOrPull;
  repoPolicy: IssueAnalysisPolicyContext;
  allowedLabels: string[];
  suggestedLabels: string[];
  workspacePath: string;
  headSha: string;
  evidenceContext: IssueAnalysisEvidenceContext;
  evidenceDir: string;
  cliPath: string;
  model: string;
  reasoningEffort: CodexReasoningEffort;
  timeoutMs: number;
  maxOutputBytes: number;
}

export type IssueAnalysisRunner = (input: IssueAnalysisRunnerInput) => Promise<IssueAnalysis>;

export interface IssueEnrichmentReader {
  listIssuesForEnrichment(
    repo: string,
    options?: {
      state?: "open" | "closed" | "all";
      since?: string;
      perPage?: number;
      pageLimit?: number;
      excludePullRequests?: boolean;
      minIssueResults?: number;
    }
  ): Promise<IssueEnrichmentIssueList>;
}

export type IssueEnrichmentScanCompletion = "complete" | "page_limit_reached" | "stopped_after_min_issue_results";

export type IssueEnrichmentIssueList = GitHubRelatedIssueOrPull[] & {
  scanCompletion?: IssueEnrichmentScanCompletion;
};

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
    /** Counts issues considered eligible for enrichment, including cap- and burst-deferred issues. Use wouldEnrich/wouldComment for current-cycle throughput. */
    eligible: number;
    skipped: number;
    wouldEnrich: number;
    wouldComment: number;
    deferred: number;
    baselinedRepos: number;
    truncatedRepos: number;
    workerSkipped: number;
  };
  repos: IssueEnrichmentRepoScan[];
  items: IssueEnrichmentScanItem[];
  recommendedActions: string[];
}

export interface IssueEnrichmentCycleResult extends Omit<IssueEnrichmentScanResult, "summary" | "items"> {
  summary: IssueEnrichmentScanResult["summary"] & {
    posted: number;
    dryRunRecorded: number;
    skippedRecorded: number;
    deferredRecorded: number;
    alreadyProcessed: number;
    failed: number;
  };
  items: Array<IssueEnrichmentScanItem & {
    recordStatus?: IssueEnrichmentRecordStatus;
    commentUrl?: string;
    error?: string;
    skippedExisting?: boolean;
  }>;
}

type IssueEnrichmentComment = {
  id: number;
  html_url?: string | null;
  body?: string | null;
  created_at?: string | null;
  updated_at?: string | null;
  user?: { login?: string | null } | null;
};

export type IssueEnrichmentCycleGithub = IssueEnrichmentReader & EnrichmentCommentGithub & {
  getRepo?(repo: string): Promise<{ default_branch?: string; clone_url?: string }>;
  listIssueLabelEvents?(repo: string, issueNumber: number): Promise<Array<{
    event?: string;
    created_at?: string;
    actor?: { login?: string | null } | null;
    label?: { name?: string | null } | null;
  }>>;
  getCollaboratorPermission?(repo: string, login: string): Promise<IssuePromotionPermission>;
  listIssueComments?(repo: string, issueNumber: number): Promise<IssueEnrichmentComment[] | BoundedGithubList<IssueEnrichmentComment>>;
  listIssueCommentsForEnrichment?(repo: string, issueNumber: number): Promise<BoundedGithubList<IssueEnrichmentComment>>;
  getIssueOrPull?(repo: string, issueNumber: number): Promise<GitHubRelatedIssueOrPull | undefined>;
};

export interface IssueEnrichmentRepoScan {
  repo: string;
  ok: boolean;
  allowed: boolean;
  enabled: boolean;
  postIssueComment: boolean;
  since?: string;
  throttle: IssueEnrichmentThrottlePolicy;
  issuesSeen: number;
  /** Counts issues considered eligible for enrichment, including cap- and burst-deferred issues. Use wouldEnrich/wouldComment for current-cycle throughput. */
  eligible: number;
  skipped: number;
  wouldEnrich: number;
  wouldComment: number;
  deferred: number;
  baselined?: boolean;
  truncated?: boolean;
  readFailure?: string;
  skipReason?: "not_issue_enrichment_allowlisted" | "issue_enrichment_repo_disabled";
}

export type IssueEnrichmentScanAction = "would_enrich" | "would_comment" | "skipped" | "deferred";
export type IssueEnrichmentScanReason =
  | "eligible"
  | "stale_issue_closed"
  | "issue_is_pull_request"
  | "preservation_only_upstream_intake"
  | "repo_max_issues_per_cycle"
  | "repo_max_comments_per_cycle"
  | "global_max_issues_per_cycle"
  | "global_max_comments_per_cycle"
  | "burst_threshold_exceeded";

export function shouldDeferPreservationPreviewToPromotion(reason: IssueEnrichmentScanReason): boolean {
  return reason === "preservation_only_upstream_intake";
}

export function assertIssueSnapshotCurrent(
  original: Pick<GitHubRelatedIssueOrPull, "number" | "state" | "updated_at">,
  current: Pick<GitHubRelatedIssueOrPull, "number" | "state" | "updated_at" | "pull_request"> | undefined
): void {
  if (
    !current ||
    current.number !== original.number ||
    current.state !== "open" ||
    Boolean(current.pull_request) ||
    current.updated_at !== original.updated_at
  ) {
    throw new Error("issue_enrichment_stale_issue_state");
  }
}

export interface IssueEnrichmentScanItem {
  repo: string;
  issueNumber: number;
  state: string;
  action: IssueEnrichmentScanAction;
  reason: IssueEnrichmentScanReason;
  url?: string;
  nextEligibleAt?: string;
}

const DEFAULT_REPO_SCAN_OPTIONS = {
  state: "open" as const,
  perPage: 100,
  pageLimit: 10
};

function issueSuggestionAllowlists(policy: IssueEnrichmentSuggestionPolicy): {
  allowedLabels: string[];
  allowedOwners: string[];
} {
  return {
    allowedLabels: policy.allowedLabels,
    allowedOwners: policy.allowedReviewers
  };
}

async function evaluateIssuePromotion(input: {
  repo: string;
  issue: GitHubRelatedIssueOrPull;
  override?: IssueEnrichmentRepoOverride;
  github: IssueEnrichmentCycleGithub;
}): Promise<{ issue: GitHubRelatedIssueOrPull; evidence?: IssuePromotionEvidence }> {
  const labels = (input.issue.labels ?? [])
    .map((label) => typeof label === "string" ? label : label.name ?? "")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean);
  if (!labels.includes("upstream-intake") || !labels.includes("active-continuation")) {
    return { issue: input.issue };
  }
  const allowlist = input.override?.promotionMaintainers ?? [];
  if (allowlist.length === 0 || !input.github.listIssueLabelEvents || !input.github.getCollaboratorPermission) {
    return { issue: input.issue };
  }
  try {
    const events = await input.github.listIssueLabelEvents(input.repo, input.issue.number);
    const labelEvent = events
      .filter((event) => event.event === "labeled" && event.label?.name?.trim().toLowerCase() === "active-continuation")
      .filter((event) => Boolean(event.actor?.login && event.created_at))
      .sort((a, b) => Date.parse(b.created_at!) - Date.parse(a.created_at!))[0];
    if (!labelEvent?.actor?.login || !labelEvent.created_at) return { issue: input.issue };
    const currentPermission = await input.github.getCollaboratorPermission(input.repo, labelEvent.actor.login);
    const evidence: IssuePromotionEvidence = {
      upstreamIntake: true,
      activeContinuation: true,
      labelEvent: { actor: labelEvent.actor.login, createdAt: labelEvent.created_at },
      allowlist,
      currentPermission
    };
    if (!isTrustedIssuePromotion(evidence)) return { issue: input.issue };
    return {
      issue: {
        ...input.issue,
        labels: (input.issue.labels ?? []).filter((label) =>
          (typeof label === "string" ? label : label.name ?? "").trim().toLowerCase() !== "upstream-intake"
        )
      },
      evidence
    };
  } catch {
    return { issue: input.issue };
  }
}

function emptyIssueEvidenceContext(headSha: string): IssueAnalysisEvidenceContext {
  return {
    repository: { defaultBranch: "unknown", headSha },
    comments: [],
    timeline: [],
    linkedItems: [],
    truncation: { comments: false, timeline: false, linkedItems: false }
  };
}

export async function buildIssueEvidenceContext(input: {
  repo: string;
  issue: GitHubRelatedIssueOrPull;
  github: IssueEnrichmentCycleGithub;
  defaultBranch: string;
  headSha: string;
}): Promise<IssueAnalysisEvidenceContext> {
  const commentResult = input.github.listIssueCommentsForEnrichment
    ? await input.github.listIssueCommentsForEnrichment(input.repo, input.issue.number)
    : input.github.listIssueComments
      ? await input.github.listIssueComments(input.repo, input.issue.number)
      : [];
  const { items: rawComments, rawCount: rawCommentCount, truncated: commentsTruncated } = unpackBoundedGithubList(commentResult);
  const externalComments = rawComments.filter((comment) =>
    !(comment.body ?? "").trimStart().startsWith(ENRICHMENT_MARKER_PREFIX)
  );
  const rawTimeline = input.github.listIssueLabelEvents
    ? await input.github.listIssueLabelEvents(input.repo, input.issue.number)
    : [];
  const linkedNumbers = extractIssueReferenceNumbers(`${input.issue.title ?? ""}\n${input.issue.body ?? ""}`, input.issue.number);
  const linkedItems: IssueAnalysisEvidenceContext["linkedItems"] = [];
  if (input.github.getIssueOrPull) {
    for (const number of linkedNumbers.slice(0, 20)) {
      const linked = await input.github.getIssueOrPull(input.repo, number);
      if (!linked) continue;
      linkedItems.push({
        number: linked.number,
        url: boundedIssueContext(redactSecrets(linked.html_url ?? ""), 1_000),
        state: boundedIssueContext(redactSecrets(linked.state ?? "unknown"), 100),
        title: boundedIssueContext(redactSecrets(linked.title ?? "(untitled)"), 1_000),
        labels: (linked.labels ?? []).map((label) =>
          boundedIssueContext(redactSecrets(typeof label === "string" ? label : label.name ?? ""), 200)
        ).filter(Boolean).slice(0, 50)
      });
    }
  }
  return {
    repository: { defaultBranch: input.defaultBranch, headSha: input.headSha },
    comments: externalComments.slice(0, 50).map((comment) => ({
      id: comment.id,
      url: boundedIssueContext(redactSecrets(comment.html_url ?? ""), 1_000),
      author: boundedIssueContext(redactSecrets(comment.user?.login ?? ""), 200),
      createdAt: boundedIssueContext(redactSecrets(comment.created_at ?? ""), 100),
      updatedAt: boundedIssueContext(redactSecrets(comment.updated_at ?? ""), 100),
      body: boundedIssueContext(redactSecrets(comment.body ?? ""), 8_000)
    })),
    timeline: rawTimeline.slice(0, 200).map((event) => ({
      event: boundedIssueContext(redactSecrets(event.event ?? ""), 100),
      actor: boundedIssueContext(redactSecrets(event.actor?.login ?? ""), 200),
      createdAt: boundedIssueContext(redactSecrets(event.created_at ?? ""), 100),
      label: boundedIssueContext(redactSecrets(event.label?.name ?? ""), 200)
    })),
    linkedItems,
    truncation: {
      comments: commentsTruncated || rawCommentCount > rawComments.length || externalComments.length > 50,
      timeline: rawTimeline.length > 200,
      linkedItems: linkedNumbers.length > 20
    }
  };
}

function extractIssueReferenceNumbers(text: string, ownIssueNumber: number): number[] {
  const matches = text.matchAll(/(?:^|[^A-Za-z0-9_])#([1-9]\d*)\b/g);
  return [...new Set([...matches].map((match) => Number(match[1])).filter((number) => number !== ownIssueNumber))];
}

function boundedIssueContext(value: string, maxLength: number): string {
  if (value.length <= maxLength) return value;
  return `${value.slice(0, Math.max(0, maxLength - 16)).trimEnd()} [truncated]`;
}

export function buildIssueEnrichmentStatus(input: {
  config: {
    issueEnrichment?: IssueEnrichmentConfig;
    codexRuntime?: { enabled: boolean };
  };
  canPostAsApp: boolean;
  modelAnalysisAvailable?: boolean;
  checkedAt?: string;
  issueReadChecks?: IssueEnrichmentRepoReadCheck[];
}): IssueEnrichmentStatus {
  const config = input.config.issueEnrichment ?? DEFAULT_ISSUE_ENRICHMENT_CONFIG;
  const blockers: IssueEnrichmentBlocker[] = [];
  const issueReadChecks = (input.issueReadChecks ?? []).map((check) => ({
    ...check,
    ...(check.error ? { error: redactSecrets(check.error) } : {})
  }));
  const issueReadFailures = issueReadChecks.filter((check) => !check.ok);
  if (!config.enabled) blockers.push("issue_enrichment_disabled");
  if (config.allowlist.length === 0) blockers.push("issue_enrichment_allowlist_empty");
  if (!config.postIssueComment) blockers.push("issue_enrichment_live_posting_disabled");
  const liveThresholdsMissingRepos = config.enabled && config.postIssueComment
    ? reposMissingLiveIssueEnrichmentThresholds(config)
    : [];
  if (liveThresholdsMissingRepos.length > 0) blockers.push("issue_enrichment_live_repo_thresholds_required");
  if (
    config.enabled &&
    config.postIssueComment &&
    !(input.modelAnalysisAvailable ?? input.config.codexRuntime?.enabled === true)
  ) {
    blockers.push("issue_enrichment_model_runtime_required");
  }
  if (config.enabled && config.postIssueComment && !input.canPostAsApp) {
    blockers.push("github_app_credentials_required_for_live_issue_comments");
  }
  if (config.enabled && issueReadFailures.length > 0) {
    blockers.push("github_app_issues_permission_required");
  }

  const blocking = blockers.filter((blocker) =>
    blocker === "github_app_credentials_required_for_live_issue_comments" ||
    blocker === "github_app_issues_permission_required" ||
    blocker === "issue_enrichment_live_repo_thresholds_required" ||
    blocker === "issue_enrichment_model_runtime_required" ||
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
    liveThresholdsMissingRepos,
    throttleDefaults: {
      maxIssuesPerCycle: config.maxIssuesPerCycle,
      maxCommentsPerCycle: config.maxCommentsPerCycle,
      cooldownMs: config.cooldownMs,
      burstWindowMs: config.burstWindowMs,
      maxIssuesPerBurst: config.maxIssuesPerBurst,
      lookbackMs: config.lookbackMs,
      processExistingOpenIssuesOnActivation: config.processExistingOpenIssuesOnActivation
    },
    globalLimits: {
      globalMaxIssuesPerCycle: config.globalMaxIssuesPerCycle,
      globalMaxCommentsPerCycle: config.globalMaxCommentsPerCycle,
      maxActiveRuns: config.maxActiveRuns,
      leaseTtlMs: config.leaseTtlMs
    },
    repoOverrides: Object.entries(config.repos ?? {}).map(([repo, override]) => ({ repo, ...override })),
    issueReadChecks,
    blockers
  };
}

const LIVE_REPO_THRESHOLD_FIELDS = [
  "maxIssuesPerCycle",
  "maxCommentsPerCycle",
  "cooldownMs",
  "burstWindowMs",
  "maxIssuesPerBurst",
  "lookbackMs"
] satisfies Array<keyof IssueEnrichmentRepoOverride>;

function reposMissingLiveIssueEnrichmentThresholds(config: IssueEnrichmentConfig): string[] {
  return canonicalIssueEnrichmentRepositories(config).flatMap(({ repo, override }) => {
    if (override?.enabled === false) return [];
    return override === undefined || LIVE_REPO_THRESHOLD_FIELDS.some((field) => override[field] === undefined) ? [repo] : [];
  });
}

export async function collectIssueEnrichmentScan(input: {
  config: {
    issueEnrichment?: IssueEnrichmentConfig;
    enrichment?: { maxSuggestions?: number };
    confidenceCalibration?: { publicDisplay: PublicConfidenceDisplayPolicy };
  };
  reader: IssueEnrichmentReader;
  dryRun: boolean;
  repos?: string[];
  repo?: string;
  includeExisting?: boolean;
  since?: string;
  sinceByRepo?: Record<string, string>;
  canPostAsApp?: boolean;
  checkedAt?: string;
  applyGlobalCaps?: boolean;
  shouldCountItem?: (item: IssueEnrichmentScanItem) => boolean;
}): Promise<IssueEnrichmentScanResult> {
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const config = input.config.issueEnrichment ?? DEFAULT_ISSUE_ENRICHMENT_CONFIG;
  const renderPolicy = resolveIssueEnrichmentRenderPolicy(input.config);
  const status = buildIssueEnrichmentStatus({
    config: input.config,
    canPostAsApp: input.canPostAsApp ?? false,
    checkedAt
  });
  const repos = canonicalIssueEnrichmentRepositories(config, input.repo ? [input.repo] : input.repos ?? config.allowlist).map(({ repo }) => repo);
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

    const since = input.since ?? input.sinceByRepo?.[repo] ?? buildIssueScanSince({
      checkedAt,
      includeExisting: input.includeExisting === true || policy.throttle.processExistingOpenIssuesOnActivation,
      lookbackMs: policy.throttle.lookbackMs,
      burstWindowMs: policy.throttle.burstWindowMs
    });
    const pageLimit = buildIssueScanPageLimit(policy.throttle);
    const perPage = DEFAULT_REPO_SCAN_OPTIONS.perPage;
    const minIssueResults = buildIssueScanMinIssueResults(policy.throttle);
    let issues: IssueEnrichmentIssueList = [];
    try {
      issues = await input.reader.listIssuesForEnrichment(repo, {
        ...DEFAULT_REPO_SCAN_OPTIONS,
        pageLimit,
        excludePullRequests: true,
        minIssueResults,
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
      suggestions: policy.suggestions,
      repoPolicy: policy.repoPolicy,
      renderPolicy,
      postIssueComment: config.postIssueComment,
      checkedAt,
      shouldCountItem: input.shouldCountItem
    });
    items.push(...issueItems);
    const truncated = issueEnrichmentScanWasTruncated({
      issues,
      minIssueResults,
      pageLimit,
      perPage
    });
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
      deferred: issueItems.filter((item) => item.action === "deferred").length,
      truncated
    });
  }

  if (input.applyGlobalCaps !== false) {
    applyGlobalIssueEnrichmentCaps({
      items,
      repoScans,
      config,
      checkedAt,
      shouldCountItem: input.shouldCountItem
    });
  }
  const summary = summarizeScan(repoScans);
  const recommendedActions = buildScanRecommendedActions(status, summary);
  if (summary.deferred > 0 && input.shouldCountItem === undefined && input.applyGlobalCaps !== false) {
    recommendedActions.push(
      "standalone issue-enrichment scans are stateless; live cycles exclude already-processed issue rows from cap accounting"
    );
  }
  return {
    ok: summary.readFailures === 0,
    checkedAt,
    dryRun: input.dryRun,
    status,
    summary,
    repos: repoScans,
    items,
    recommendedActions
  };
}

export async function runIssueEnrichmentCycle(input: {
  config: {
    workRoot?: string;
    evidenceDir?: string;
    codexRuntime?: {
      enabled: boolean;
      cliPath: string;
      model: string;
      reasoningEffort: CodexReasoningEffort;
      timeoutMs: number;
      maxOutputBytes: number;
    };
    issueEnrichment?: IssueEnrichmentConfig;
    reviewLenses?: ReviewLensConfig;
    enrichment?: { maxSuggestions?: number };
    confidenceCalibration?: { publicDisplay: PublicConfidenceDisplayPolicy };
  };
  state: Pick<
    ReviewStateStore,
    "getIssueEnrichmentRecord" |
    "recordIssueEnrichment" |
    "getIssueEnrichmentRepoWatermark" |
    "recordIssueEnrichmentRepoWatermark" |
    "tryAcquireIssueEnrichmentRunLease" |
    "releaseIssueEnrichmentRunLease"
  >;
  github: IssueEnrichmentCycleGithub;
  dryRun: boolean;
  repo?: string;
  includeExisting?: boolean;
  since?: string;
  force?: boolean;
  advanceWatermarks?: boolean;
  checkedAt?: string;
  preacquiredLease?: { leaseId: string };
  licenseAdmission?: ProductionLicenseAdmission;
  analyzeIssue?: IssueAnalysisRunner;
}): Promise<IssueEnrichmentCycleResult> {
  if (!input.licenseAdmission) throw new Error("production license admission is required for issue enrichment cycles");
  if (!isAuthenticProductionLicenseAdmission(input.licenseAdmission, "issue_enrichment")) {
    throw new Error("production license admission is invalid for issue enrichment cycles");
  }
  const checkedAt = input.checkedAt ?? new Date().toISOString();
  const config = input.config.issueEnrichment ?? DEFAULT_ISSUE_ENRICHMENT_CONFIG;
  const shouldCollectModelEvidence = !input.dryRun && config.postIssueComment && input.analyzeIssue === undefined;
  const renderPolicy = resolveIssueEnrichmentRenderPolicy(input.config);
  const releasePreacquiredLeaseBeforeRun = () => {
    if (!input.dryRun && input.preacquiredLease) {
      input.state.releaseIssueEnrichmentRunLease(input.preacquiredLease.leaseId);
    }
  };
  const status = buildIssueEnrichmentStatus({
    config: input.config,
    canPostAsApp: input.github.canPostAsApp(),
    modelAnalysisAvailable: input.analyzeIssue !== undefined || input.config.codexRuntime?.enabled === true,
    checkedAt
  });
  if (!config.enabled) {
    releasePreacquiredLeaseBeforeRun();
    return {
      ok: true,
      checkedAt,
      dryRun: input.dryRun,
      status,
      summary: emptyCycleSummary(),
      repos: [],
      items: [],
      recommendedActions: buildScanRecommendedActions(status, emptyCycleSummary())
    };
  }
  const reviewLensPacket = buildIssueEnrichmentReviewLensPacket(input.config.reviewLenses);
  const blockedForRun = status.state === "blocked" &&
    !(input.dryRun && status.blockers.every((blocker) => DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.has(blocker)));
  if (blockedForRun) {
    releasePreacquiredLeaseBeforeRun();
    const summary = emptyCycleSummary();
    return {
      ok: false,
      checkedAt,
      dryRun: input.dryRun,
      status,
      summary,
      repos: [],
      items: [],
      recommendedActions: buildScanRecommendedActions(status, summary)
    };
  }

  let lease: { leaseId: string } | undefined;
  if (!input.dryRun) {
    lease = input.preacquiredLease ?? input.state.tryAcquireIssueEnrichmentRunLease(config.maxActiveRuns, config.leaseTtlMs, new Date(checkedAt));
    if (!lease) {
      const summary = { ...emptyCycleSummary(), workerSkipped: 1 };
      return {
        ok: status.ok,
        checkedAt,
        dryRun: input.dryRun,
        status,
        summary,
        repos: [],
        items: [],
        recommendedActions: buildCycleRecommendedActions(
          ["issue enrichment worker is busy; retry after the active lease expires"],
          summary
        )
      };
    }
  }

  try {
    const baselineRepos: IssueEnrichmentRepoScan[] = [];
    const reposToScan: string[] = [];
    const sinceByRepo: Record<string, string> = {};
    const candidateRepos = canonicalIssueEnrichmentRepositories(config, input.repo ? [input.repo] : config.allowlist).map(({ repo }) => repo);
    const canUseActivationWatermark = input.includeExisting !== true && input.since === undefined;
    for (const repo of candidateRepos) {
      const policy = resolveIssueEnrichmentRepoPolicy(config, repo);
      if (!policy.allowed) {
        reposToScan.push(repo);
        continue;
      }
      if (!canUseActivationWatermark) {
        reposToScan.push(repo);
        continue;
      }
      const existingWatermark = input.state.getIssueEnrichmentRepoWatermark(repo);
      if (existingWatermark) {
        sinceByRepo[repo] = existingWatermark.lastCheckedAt;
        reposToScan.push(repo);
        continue;
      }
      if (policy.throttle.processExistingOpenIssuesOnActivation) {
        reposToScan.push(repo);
        continue;
      }
      if (!input.dryRun && input.advanceWatermarks !== false) {
        input.state.recordIssueEnrichmentRepoWatermark({
          repo,
          activatedAt: checkedAt,
          lastCheckedAt: checkedAt,
          now: new Date(checkedAt)
        });
      }
      baselineRepos.push({
        repo,
        ok: true,
        allowed: true,
        enabled: config.enabled,
        postIssueComment: config.postIssueComment,
        since: checkedAt,
        throttle: policy.throttle,
        issuesSeen: 0,
        eligible: 0,
        skipped: 0,
        wouldEnrich: 0,
        wouldComment: 0,
        deferred: 0,
        baselined: true,
        truncated: false
      });
    }

    const sourceSnapshots = new Map<string, PreparedWorktree>();
    const defaultBranches = new Map<string, string>();
    if (shouldCollectModelEvidence) {
      if (!input.config.workRoot) throw new Error("issue_enrichment_model_runtime_paths_required");
      if (!input.github.getRepo) throw new Error("issue_enrichment_repository_metadata_required");
      for (const repo of reposToScan) {
        const policy = resolveIssueEnrichmentRepoPolicy(config, repo);
        if (!policy.allowed) continue;
        const metadata = await input.github.getRepo(repo);
        const defaultBranch = metadata.default_branch?.trim();
        if (!defaultBranch) throw new Error(`issue_enrichment_default_branch_missing: ${repo}`);
        sourceSnapshots.set(repo.toLowerCase(), await prepareBranchWorktree({
          repo,
          branch: defaultBranch,
          ...(metadata.clone_url ? { repoUrl: metadata.clone_url } : {}),
          workRoot: input.config.workRoot,
          protectedCheckoutRoots: getProtectedCheckoutRoots()
        }));
        defaultBranches.set(repo.toLowerCase(), defaultBranch);
      }
    }

    const issuesByKey = new Map<string, GitHubRelatedIssueOrPull>();
    const issueEvidenceContextByIssue = new Map<string, IssueAnalysisEvidenceContext>();
    const promotionEvidenceByIssue = new Map<string, IssuePromotionEvidence>();
    const plannedEnrichmentByIssue = new Map<string, EnrichmentComment>();
    const plannedAnalysisInputHashByIssue = new Map<string, string | undefined>();
    const analysisIdentityHash = (repo: string, issue: GitHubRelatedIssueOrPull): string => {
      const policy = resolveIssueEnrichmentRepoPolicy(config, repo);
      const allowlists = issueSuggestionAllowlists(policy.suggestions);
      return buildIssueAnalysisInputHash({
        repo,
        headSha: sourceSnapshots.get(repo.toLowerCase())?.headSha ?? "0".repeat(40),
        evidenceContext: issueEvidenceContextByIssue.get(issueKey(repo, issue.number)),
        issue,
        repoPolicy: policy.repoPolicy,
        allowedLabels: allowlists.allowedLabels,
        allowedOwners: allowlists.allowedOwners,
        suggestedOwners: [],
        publicConfidencePolicy: renderPolicy.publicConfidencePolicy,
        rendererVersion: ISSUE_ANALYSIS_PUBLIC_RENDERER_VERSION,
        model: input.config.codexRuntime?.model ?? "injected-issue-analysis",
        reasoningEffort: input.config.codexRuntime?.reasoningEffort ?? "unspecified",
        maxSuggestions: renderPolicy.maxSuggestions ?? 8
      });
    };
    const plannedEnrichmentForItem = (item: IssueEnrichmentScanItem): EnrichmentComment | undefined => {
      if (!isIssueEnrichmentCommentAction(item.action)) return undefined;
      const key = issueKey(item.repo, item.issueNumber);
      const cached = plannedEnrichmentByIssue.get(key);
      if (cached) return cached;
      const issue = issuesByKey.get(key);
      if (!issue) return undefined;
      const enrichment = buildIssueEnrichmentForCycle(
        config,
        item.repo,
        issue,
        renderPolicy,
        undefined,
        reviewLensPacket
      );
      plannedEnrichmentByIssue.set(key, enrichment);
      return enrichment;
    };
    const plannedAnalysisInputHashForItem = (item: IssueEnrichmentScanItem): string | undefined => {
      if (!isIssueEnrichmentCommentAction(item.action)) return undefined;
      const key = issueKey(item.repo, item.issueNumber);
      if (plannedAnalysisInputHashByIssue.has(key)) return plannedAnalysisInputHashByIssue.get(key);
      const issue = issuesByKey.get(key);
      const analysisInputHash = issue
        ? analysisIdentityHash(item.repo, issue)
        : plannedEnrichmentForItem(item)?.bodyHash;
      plannedAnalysisInputHashByIssue.set(key, analysisInputHash);
      return analysisInputHash;
    };
    const shouldCountItem = (item: IssueEnrichmentScanItem) => {
      if (input.force === true) return true;
      const issue = issuesByKey.get(issueKey(item.repo, item.issueNumber));
      const issueUpdatedAt = canonicalIssueUpdatedAt(issue, checkedAt);
      const existing = input.state.getIssueEnrichmentRecord(item.repo, item.issueNumber);
      const analysisInputHash = issue && shouldCompareIssueEnrichmentAnalysisInputHash(existing)
        ? plannedAnalysisInputHashForItem(item)
        : undefined;
      return !(existing && shouldSkipIssueEnrichmentRecord(existing, issueUpdatedAt, checkedAt, analysisInputHash, item.action));
    };
    const scanned = reposToScan.length
      ? await collectIssueEnrichmentScan({
          config: input.config,
          reader: {
            listIssuesForEnrichment: async (repo, options) => {
              const issues = await input.github.listIssuesForEnrichment(repo, options);
              const prepared: GitHubRelatedIssueOrPull[] = [];
              for (const issue of issues) {
                const promotion = await evaluateIssuePromotion({
                  repo,
                  issue,
                  override: canonicalIssueEnrichmentRepository(config, repo).override,
                  github: input.github
                });
                prepared.push(promotion.issue);
                issuesByKey.set(issueKey(repo, issue.number), promotion.issue);
                if (shouldCollectModelEvidence) {
                  issueEvidenceContextByIssue.set(issueKey(repo, issue.number), await buildIssueEvidenceContext({
                    repo,
                    issue: promotion.issue,
                    github: input.github,
                    defaultBranch: defaultBranches.get(repo.toLowerCase()) ?? "unknown",
                    headSha: sourceSnapshots.get(repo.toLowerCase())?.headSha ?? "0".repeat(40)
                  }));
                }
                if (promotion.evidence) {
                  promotionEvidenceByIssue.set(issueKey(repo, issue.number), promotion.evidence);
                }
              }
              return Object.assign(prepared, { scanCompletion: issues.scanCompletion });
            }
          },
          dryRun: input.dryRun,
          repos: reposToScan,
          includeExisting: input.includeExisting,
          since: input.since,
          sinceByRepo,
          canPostAsApp: input.github.canPostAsApp(),
          checkedAt,
          applyGlobalCaps: false,
          shouldCountItem
        })
      : {
          ok: true,
          checkedAt,
          dryRun: input.dryRun,
          status,
          summary: summarizeScan([]),
          repos: [],
          items: [],
          recommendedActions: buildScanRecommendedActions(status, summarizeScan([]))
        };
    applyGlobalIssueEnrichmentCaps({
      items: scanned.items,
      repoScans: scanned.repos,
      config,
      checkedAt,
      shouldCountItem
    });
    const combinedRepos = [...baselineRepos, ...scanned.repos];
    const combinedSummary = summarizeScan(combinedRepos);
    const scan: IssueEnrichmentScanResult = {
      ...scanned,
      summary: combinedSummary,
      repos: combinedRepos,
      recommendedActions: buildScanRecommendedActions(status, combinedSummary)
    };
    const summary = {
      ...scan.summary,
      posted: 0,
      dryRunRecorded: 0,
      skippedRecorded: 0,
      deferredRecorded: 0,
      alreadyProcessed: 0,
      failed: 0
    };
    const items: IssueEnrichmentCycleResult["items"] = [];

    for (const item of scan.items) {
      const issue = issuesByKey.get(issueKey(item.repo, item.issueNumber));
      const issueUpdatedAt = canonicalIssueUpdatedAt(issue, checkedAt);
      const existing = input.state.getIssueEnrichmentRecord(item.repo, item.issueNumber);
      const analysisInputHash = shouldCompareIssueEnrichmentAnalysisInputHash(existing) ||
        shouldBackfillIssueEnrichmentAnalysisInputHash(existing, issueUpdatedAt, item.action)
        ? plannedAnalysisInputHashForItem(item)
        : undefined;
      if (input.force !== true && existing && shouldSkipIssueEnrichmentRecord(existing, issueUpdatedAt, checkedAt, analysisInputHash, item.action)) {
        const refreshedAnalysisInputHash = existing.analysisInputHash ?? analysisInputHash;
        if (!input.dryRun && (
          existing.issueUpdatedAt !== issueUpdatedAt ||
          refreshedAnalysisInputHash !== existing.analysisInputHash
        )) {
          input.state.recordIssueEnrichment({
            repo: item.repo,
            issueNumber: item.issueNumber,
            issueUpdatedAt,
            ...(existing.bodyHash ? { bodyHash: existing.bodyHash } : {}),
            ...(refreshedAnalysisInputHash ? { analysisInputHash: refreshedAnalysisInputHash } : {}),
            status: existing.status,
            ...(existing.reason ? { reason: existing.reason } : {}),
            ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {}),
            ...(existing.error ? { error: existing.error } : {}),
            ...(existing.nextEligibleAt ? { nextEligibleAt: existing.nextEligibleAt } : {}),
            now: new Date(checkedAt)
          });
        }
        summary.alreadyProcessed += 1;
        items.push({ ...item, skippedExisting: true, recordStatus: existing.status });
        continue;
      }
      if (input.dryRun) {
        items.push({ ...item });
        continue;
      }

      if (item.action === "skipped") {
        input.state.recordIssueEnrichment({
          repo: item.repo,
          issueNumber: item.issueNumber,
          issueUpdatedAt,
          status: "skipped",
          reason: item.reason,
          now: new Date(checkedAt)
        });
        summary.skippedRecorded += 1;
        items.push({ ...item, recordStatus: "skipped" });
        continue;
      }

      if (item.action === "deferred") {
        input.state.recordIssueEnrichment({
          repo: item.repo,
          issueNumber: item.issueNumber,
          issueUpdatedAt,
          status: "deferred",
          reason: item.reason,
          nextEligibleAt: item.nextEligibleAt,
          now: new Date(checkedAt)
        });
        summary.deferredRecorded += 1;
        items.push({ ...item, recordStatus: "deferred" });
        continue;
      }

      if (!config.postIssueComment || item.action === "would_enrich") {
        const dryRunAnalysisInputHash = plannedAnalysisInputHashForItem(item);
        input.state.recordIssueEnrichment({
          repo: item.repo,
          issueNumber: item.issueNumber,
          issueUpdatedAt,
          ...(dryRunAnalysisInputHash ? { analysisInputHash: dryRunAnalysisInputHash } : {}),
          status: "dry_run",
          reason: "dry_run_only",
          now: new Date(checkedAt)
        });
        summary.dryRunRecorded += 1;
        items.push({ ...item, recordStatus: "dry_run" });
        continue;
      }

      try {
        if (!issue) throw new Error(`Issue metadata missing for ${item.repo}#${item.issueNumber}`);
        const policy = resolveIssueEnrichmentRepoPolicy(config, item.repo);
        if (!policy.allowed) throw new Error(`Issue analysis policy is not enabled for ${item.repo}`);
        const allowlists = issueSuggestionAllowlists(policy.suggestions);
        const identityHash = plannedAnalysisInputHashForItem(item);
        if (!identityHash) throw new Error(`Issue analysis identity missing for ${item.repo}#${item.issueNumber}`);
        let workspacePath = "";
        let headSha = "0".repeat(40);
        let analysisEvidenceDir = "";
        if (input.analyzeIssue === undefined) {
          if (!input.config.codexRuntime?.enabled) {
            throw new Error("issue_enrichment_model_runtime_required");
          }
          if (!input.config.workRoot || !input.config.evidenceDir) {
            throw new Error("issue_enrichment_model_runtime_paths_required");
          }
          const sourceSnapshot = sourceSnapshots.get(item.repo.toLowerCase());
          if (!sourceSnapshot) throw new Error(`issue_enrichment_source_snapshot_missing: ${item.repo}`);
          workspacePath = sourceSnapshot.path;
          headSha = sourceSnapshot.headSha;
          analysisEvidenceDir = join(
            input.config.evidenceDir,
            checkedAt.slice(0, 10),
            item.repo.replace("/", "__"),
            `issue-${item.issueNumber}`,
            `analysis-${identityHash.slice(0, 16)}`
          );
          const promotionEvidence = promotionEvidenceByIssue.get(issueKey(item.repo, item.issueNumber));
          if (promotionEvidence) {
            mkdirSync(analysisEvidenceDir, { recursive: true });
            writeSecureFileSync(
              join(analysisEvidenceDir, "active-continuation-authorization.json"),
              `${JSON.stringify(promotionEvidence, null, 2)}\n`
            );
          }
        }
        const analyzer: IssueAnalysisRunner = input.analyzeIssue ?? (async (analysisInput) => {
          const result = await runIssueAnalysis(analysisInput);
          return result.analysis;
        });
        const runtime = input.config.codexRuntime;
        const analysis = await analyzer({
          repo: item.repo,
          issue,
          repoPolicy: policy.repoPolicy,
          allowedLabels: allowlists.allowedLabels,
          suggestedLabels: policy.repoPolicy.suggestedLabels,
          workspacePath,
          headSha,
          evidenceContext: issueEvidenceContextByIssue.get(issueKey(item.repo, item.issueNumber)) ?? emptyIssueEvidenceContext(headSha),
          evidenceDir: analysisEvidenceDir,
          cliPath: runtime?.cliPath ?? "",
          model: runtime?.model ?? "injected-issue-analysis",
          reasoningEffort: runtime?.reasoningEffort ?? "low",
          timeoutMs: runtime?.timeoutMs ?? 1,
          maxOutputBytes: runtime?.maxOutputBytes ?? 1
        });
        if (!input.github.getIssueOrPull && input.analyzeIssue === undefined) {
          throw new Error("issue_enrichment_current_issue_read_required");
        }
        if (input.github.getIssueOrPull) {
          const currentIssue = await input.github.getIssueOrPull(item.repo, item.issueNumber);
          assertIssueSnapshotCurrent(issue, currentIssue);
        }
        // #263: attach the mapped lifecycle state (`enriched`) to the marker at post time. This is a
        // renaming of the decision already made (status=posted) and rides the diagnostic state marker
        // only; bodyHash excludes the marker, so idempotency is unaffected.
        const enrichment = buildIssueAnalysisEnrichmentComment({
          repo: item.repo,
          issue,
          analysis,
          identityHash,
          repoPolicy: policy.repoPolicy,
          allowedLabels: allowlists.allowedLabels,
          allowedOwners: allowlists.allowedOwners,
          ...renderPolicy,
          postIssueComment: true,
          lifecycle: { state: "enriched" }
        });
        const postBodyHash = enrichment.bodyHash;
        if (input.force !== true && existing?.status === "posted" && existing.bodyHash === postBodyHash) {
          input.state.recordIssueEnrichment({
            repo: item.repo,
            issueNumber: item.issueNumber,
            issueUpdatedAt,
            bodyHash: postBodyHash,
            analysisInputHash: identityHash,
            status: "posted",
            ...(existing.reason ? { reason: existing.reason } : {}),
            ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {}),
            now: new Date(checkedAt)
          });
          summary.alreadyProcessed += 1;
          items.push({
            ...item,
            skippedExisting: true,
            recordStatus: "posted",
            ...(existing.commentUrl ? { commentUrl: existing.commentUrl } : {})
          });
          continue;
        }
        const post = await postEnrichmentComment({
          enabled: true,
          dryRun: false,
          github: input.github,
          repo: item.repo,
          pullNumber: item.issueNumber,
          enrichment
        });
        if (!post.posted) throw new Error(`issue enrichment comment not posted: ${post.reason}`);
        const commentUrl = post.html_url ? redactSecrets(post.html_url) : undefined;
        input.state.recordIssueEnrichment({
          repo: item.repo,
          issueNumber: item.issueNumber,
          issueUpdatedAt,
          ...(postBodyHash ? { bodyHash: postBodyHash } : {}),
          analysisInputHash: identityHash,
          status: "posted",
          ...(commentUrl ? { commentUrl } : {}),
          now: new Date(checkedAt)
        });
        summary.posted += 1;
        items.push({ ...item, recordStatus: "posted", ...(commentUrl ? { commentUrl } : {}) });
      } catch (error) {
        const message = redactSecrets(error instanceof Error ? error.message : String(error));
        input.state.recordIssueEnrichment({
          repo: item.repo,
          issueNumber: item.issueNumber,
          issueUpdatedAt,
          ...(analysisInputHash ? { analysisInputHash } : {}),
          status: "failed",
          reason: "analysis_or_post_failed",
          error: message,
          now: new Date(checkedAt)
        });
        summary.failed += 1;
        items.push({ ...item, recordStatus: "failed", error: message });
      }
    }

    if (!input.dryRun && input.advanceWatermarks !== false) {
      for (const repo of scanned.repos) {
        if (!repo.allowed || !repo.ok || repo.baselined) continue;
        const repoItems = items.filter((item) => item.repo === repo.repo);
        if (repo.truncated || repoItems.some((item) => item.recordStatus === "deferred" || item.recordStatus === "failed")) continue;
        const existingWatermark = input.state.getIssueEnrichmentRepoWatermark(repo.repo);
        input.state.recordIssueEnrichmentRepoWatermark({
          repo: repo.repo,
          activatedAt: existingWatermark?.activatedAt ?? checkedAt,
          lastCheckedAt: checkedAt,
          now: new Date(checkedAt)
        });
      }
    }

    return {
      ...scan,
      ok: scan.ok && summary.failed === 0,
      summary,
      items,
      recommendedActions: buildCycleRecommendedActions(scan.recommendedActions, summary)
    };
  } finally {
    if (lease) input.state.releaseIssueEnrichmentRunLease(lease.leaseId);
  }
}

export function resolveIssueEnrichmentRepoPolicy(
  config: IssueEnrichmentConfig,
  repo: string
): {
  allowed: boolean;
  reason?: "not_issue_enrichment_allowlisted" | "issue_enrichment_repo_disabled";
  throttle: IssueEnrichmentThrottlePolicy;
  suggestions: IssueEnrichmentSuggestionPolicy;
  repoPolicy: IssueEnrichmentRepoPolicy;
} {
  const override = canonicalIssueEnrichmentRepository(config, repo).override;
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
  const suggestions = {
    allowedLabels: resolveIssueSuggestionAllowlist(config.allowedLabels, override?.allowedLabels),
    allowedReviewers: resolveIssueSuggestionAllowlist(config.allowedReviewers, override?.allowedReviewers)
  };
  const repoPolicy: IssueEnrichmentRepoPolicy = {
    ...(override?.advisoryPolicy !== undefined ? { advisoryPolicy: override.advisoryPolicy } : {}),
    validationSuggestions: [...(override?.validationSuggestions ?? [])],
    suggestedLabels: [...(override?.suggestedLabels ?? [])],
    suggestedReviewers: [...(override?.suggestedReviewers ?? [])],
    labelAliases: { ...(override?.labelAliases ?? {}) }
  };
  if (!config.allowlist.some((allowed) => allowed.toLowerCase() === repo.toLowerCase())) return { allowed: false, reason: "not_issue_enrichment_allowlisted", throttle, suggestions, repoPolicy };
  if (override?.enabled === false) return { allowed: false, reason: "issue_enrichment_repo_disabled", throttle, suggestions, repoPolicy };
  return { allowed: true, throttle, suggestions, repoPolicy };
}

function resolveIssueSuggestionAllowlist(globalAllowlist: string[], repoOverride: string[] | undefined): string[] {
  if (repoOverride !== undefined && repoOverride.length > 0) return [...repoOverride];
  return [...globalAllowlist];
}

function planRepoIssueScan(input: {
  repo: string;
  issues: GitHubRelatedIssueOrPull[];
  throttle: IssueEnrichmentThrottlePolicy;
  suggestions: IssueEnrichmentSuggestionPolicy;
  repoPolicy: IssueEnrichmentRepoPolicy;
  renderPolicy: IssueEnrichmentRenderPolicy;
  postIssueComment: boolean;
  checkedAt: string;
  shouldCountItem?: (item: IssueEnrichmentScanItem) => boolean;
}): IssueEnrichmentScanItem[] {
  const allowlists = issueSuggestionAllowlists(input.suggestions);
  const planned = input.issues.map((issue) => buildIssueEnrichmentDryRunOutput({
    repo: input.repo,
    issue,
    allowedLabels: allowlists.allowedLabels,
    allowedOwners: allowlists.allowedOwners,
    repoPolicy: input.repoPolicy,
    maxRelatedRefs: 8,
    ...input.renderPolicy
  }));
  const eligible = planned.filter((output) => !output.skipped);
  const countableEligible = input.shouldCountItem
    ? eligible.filter((output) => input.shouldCountItem!(
        issueScanItem(
          input.repo,
          output.issueNumber,
          output.state,
          input.postIssueComment ? "would_comment" : "would_enrich",
          "eligible",
          output.url
        )
      ))
    : eligible;
  const burstExceeded = countableEligible.length > input.throttle.maxIssuesPerBurst;
  let enriched = 0;
  let comments = 0;

  return planned.map((output) => {
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
    const eligibleAction = input.postIssueComment ? "would_comment" : "would_enrich";
    const eligibleItem = issueScanItem(input.repo, output.issueNumber, output.state, eligibleAction, "eligible", output.url);
    const countTowardCaps = input.shouldCountItem ? input.shouldCountItem(eligibleItem) : true;
    if (!countTowardCaps) return eligibleItem;
    if (burstExceeded) {
      return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "burst_threshold_exceeded", output.url, nextEligibleAt(input));
    }
    if (enriched >= input.throttle.maxIssuesPerCycle) {
      return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "repo_max_issues_per_cycle", output.url, nextEligibleAt(input));
    }
    enriched += 1;
    if (input.postIssueComment) {
      if (comments >= input.throttle.maxCommentsPerCycle) {
        return issueScanItem(input.repo, output.issueNumber, output.state, "deferred", "repo_max_comments_per_cycle", output.url, nextEligibleAt(input));
      }
      comments += 1;
      return eligibleItem;
    }
    return eligibleItem;
  });
}

function issueScanItem(
  repo: string,
  issueNumber: number,
  state: string,
  action: IssueEnrichmentScanAction,
  reason: IssueEnrichmentScanReason,
  url?: string,
  nextEligibleAtValue?: string
): IssueEnrichmentScanItem {
  return {
    repo,
    issueNumber,
    state,
    action,
    reason,
    ...(url ? { url } : {}),
    ...(nextEligibleAtValue ? { nextEligibleAt: nextEligibleAtValue } : {})
  };
}

function buildIssueScanSince(input: {
  checkedAt: string;
  includeExisting: boolean;
  lookbackMs: number;
  burstWindowMs: number;
}): string | undefined {
  if (input.includeExisting) return undefined;
  const checkedAtMs = Date.parse(input.checkedAt);
  const baseMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  return new Date(baseMs - Math.max(input.lookbackMs, input.burstWindowMs)).toISOString();
}

function buildIssueScanPageLimit(throttle: IssueEnrichmentThrottlePolicy): number {
  const threshold = Math.max(throttle.maxIssuesPerCycle, throttle.maxIssuesPerBurst) + 1;
  return Math.max(DEFAULT_REPO_SCAN_OPTIONS.pageLimit, Math.min(10, Math.ceil(threshold / DEFAULT_REPO_SCAN_OPTIONS.perPage)));
}

function buildIssueScanMinIssueResults(throttle: IssueEnrichmentThrottlePolicy): number {
  return Math.max(throttle.maxIssuesPerCycle, throttle.maxIssuesPerBurst) + 1;
}

function issueEnrichmentScanWasTruncated(input: {
  issues: IssueEnrichmentIssueList;
  minIssueResults: number;
  pageLimit: number;
  perPage: number;
}): boolean {
  switch (input.issues.scanCompletion) {
    case "page_limit_reached":
    case "stopped_after_min_issue_results":
      return true;
    case "complete":
      return false;
  }
  return input.issues.length >= input.minIssueResults || input.issues.length >= input.pageLimit * input.perPage;
}

function nextEligibleAt(input: { checkedAt: string; throttle: IssueEnrichmentThrottlePolicy }): string {
  const checkedAtMs = Date.parse(input.checkedAt);
  const baseMs = Number.isFinite(checkedAtMs) ? checkedAtMs : Date.now();
  return new Date(baseMs + input.throttle.cooldownMs).toISOString();
}

function globalNextEligibleAt(input: {
  checkedAt: string;
  config: IssueEnrichmentConfig;
  throttle: IssueEnrichmentThrottlePolicy;
}): string {
  return nextEligibleAt({
    checkedAt: input.checkedAt,
    throttle: {
      ...input.throttle,
      cooldownMs: Math.max(input.config.cooldownMs, input.throttle.cooldownMs)
    }
  });
}

function applyGlobalIssueEnrichmentCaps(input: {
  items: IssueEnrichmentScanItem[];
  repoScans: IssueEnrichmentRepoScan[];
  config: IssueEnrichmentConfig;
  checkedAt: string;
  shouldCountItem?: (item: IssueEnrichmentScanItem) => boolean;
}): void {
  let issuesConsidered = 0;
  let commentsConsidered = 0;
  for (let index = 0; index < input.items.length; index += 1) {
    const item = input.items[index]!;
    if (item.action !== "would_enrich" && item.action !== "would_comment") continue;
    if (input.shouldCountItem && !input.shouldCountItem(item)) continue;
    const policy = resolveIssueEnrichmentRepoPolicy(input.config, item.repo);
    if (issuesConsidered >= input.config.globalMaxIssuesPerCycle) {
      input.items[index] = issueScanItem(
        item.repo,
        item.issueNumber,
        item.state,
        "deferred",
        "global_max_issues_per_cycle",
        item.url,
        globalNextEligibleAt({ checkedAt: input.checkedAt, config: input.config, throttle: policy.throttle })
      );
      continue;
    }
    if (item.action === "would_comment") {
      if (commentsConsidered >= input.config.globalMaxCommentsPerCycle) {
        input.items[index] = issueScanItem(
          item.repo,
          item.issueNumber,
          item.state,
          "deferred",
          "global_max_comments_per_cycle",
          item.url,
          globalNextEligibleAt({ checkedAt: input.checkedAt, config: input.config, throttle: policy.throttle })
        );
        issuesConsidered += 1;
        continue;
      }
      commentsConsidered += 1;
    }
    issuesConsidered += 1;
  }

  for (const scan of input.repoScans) {
    if (!scan.allowed || !scan.ok) continue;
    const repoItems = input.items.filter((item) => item.repo === scan.repo);
    const countedRepoItems = input.shouldCountItem ? repoItems.filter(input.shouldCountItem) : repoItems;
    scan.eligible = countedRepoItems.filter(isEligibleIssueEnrichmentItem).length;
    scan.skipped = countedRepoItems.filter((item) => item.action === "skipped").length;
    scan.wouldEnrich = countedRepoItems.filter((item) => item.action === "would_enrich" || item.action === "would_comment").length;
    scan.wouldComment = countedRepoItems.filter((item) => item.action === "would_comment").length;
    scan.deferred = countedRepoItems.filter((item) => item.action === "deferred").length;
  }
}

function isEligibleIssueEnrichmentItem(item: IssueEnrichmentScanItem): boolean {
  return item.reason === "eligible" ||
    item.reason === "burst_threshold_exceeded" ||
    item.reason === "repo_max_issues_per_cycle" ||
    item.reason === "repo_max_comments_per_cycle" ||
    item.reason === "global_max_issues_per_cycle" ||
    item.reason === "global_max_comments_per_cycle";
}

function summarizeScan(repoScans: IssueEnrichmentRepoScan[]): IssueEnrichmentScanResult["summary"] {
  return {
    reposScanned: repoScans.filter((repo) => repo.allowed && repo.baselined !== true).length,
    reposSkipped: repoScans.filter((repo) => !repo.allowed).length,
    readFailures: repoScans.filter((repo) => !repo.ok).length,
    issuesSeen: sum(repoScans, "issuesSeen"),
    eligible: sum(repoScans, "eligible"),
    skipped: sum(repoScans, "skipped"),
    wouldEnrich: sum(repoScans, "wouldEnrich"),
    wouldComment: sum(repoScans, "wouldComment"),
    deferred: sum(repoScans, "deferred"),
    baselinedRepos: repoScans.filter((repo) => repo.baselined === true).length,
    truncatedRepos: repoScans.filter((repo) => repo.truncated === true).length,
    workerSkipped: 0
  };
}

function buildScanRecommendedActions(status: IssueEnrichmentStatus, summary: IssueEnrichmentScanResult["summary"]): string[] {
  const actions = [];
  if (status.state === "blocked") actions.push("resolve issue-enrichment blockers before live issue comments");
  if (summary.deferred > 0) {
    actions.push("inspect deferred issue-enrichment rows before throttle changes; summary.eligible includes cap- and burst-deferred issues, while wouldEnrich/wouldComment show current-cycle throughput");
  }
  if (summary.truncatedRepos > 0) actions.push("inspect truncated issue-enrichment scans before advancing repo watermarks");
  if (summary.readFailures > 0) actions.push("run doctor and inspect GitHub App Issues permissions");
  return actions;
}

function buildCycleRecommendedActions(
  scanActions: string[],
  summary: IssueEnrichmentCycleResult["summary"]
): string[] {
  const actions = [...scanActions];
  if (summary.failed > 0) actions.push("inspect failed issue-enrichment rows before enabling live issue comments");
  if (summary.posted > 0) actions.push("verify App-authored sticky issue comments before expanding the issue-enrichment allowlist");
  return [...new Set(actions)];
}

function emptyCycleSummary(): IssueEnrichmentCycleResult["summary"] {
  return {
    reposScanned: 0,
    reposSkipped: 0,
    readFailures: 0,
    issuesSeen: 0,
    eligible: 0,
    skipped: 0,
    wouldEnrich: 0,
    wouldComment: 0,
    deferred: 0,
    baselinedRepos: 0,
    truncatedRepos: 0,
    workerSkipped: 0,
    posted: 0,
    dryRunRecorded: 0,
    skippedRecorded: 0,
    deferredRecorded: 0,
    alreadyProcessed: 0,
    failed: 0
  };
}

function canonicalIssueUpdatedAt(issue: GitHubRelatedIssueOrPull | undefined, checkedAt: string): string {
  const candidate = issue?.updated_at ?? checkedAt;
  const parsed = Date.parse(candidate);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : checkedAt;
}

function shouldSkipIssueEnrichmentRecord(
  existing: IssueEnrichmentRecord,
  issueUpdatedAt: string,
  checkedAt: string,
  analysisInputHash?: string,
  action?: IssueEnrichmentScanAction
): boolean {
  if (existing.status === "failed") return false;
  if (existing.status === "deferred" && existing.nextEligibleAt) {
    const nextEligibleAt = Date.parse(existing.nextEligibleAt);
    const now = Date.parse(checkedAt);
    if (Number.isFinite(nextEligibleAt) && Number.isFinite(now) && nextEligibleAt <= now) return false;
  }
  if (existing.analysisInputHash && analysisInputHash && existing.status === "posted") {
    return existing.analysisInputHash === analysisInputHash.toLowerCase();
  }
  if (existing.status === "dry_run" && action === "would_comment") return false;
  if (existing.issueUpdatedAt !== issueUpdatedAt) return false;
  return true;
}

function shouldCompareIssueEnrichmentAnalysisInputHash(
  existing: IssueEnrichmentRecord | undefined
): boolean {
  return existing?.status === "posted" &&
    Boolean(existing.analysisInputHash);
}

function shouldBackfillIssueEnrichmentAnalysisInputHash(
  existing: IssueEnrichmentRecord | undefined,
  issueUpdatedAt: string,
  action: IssueEnrichmentScanAction
): boolean {
  return existing?.status === "posted" &&
    !existing.analysisInputHash &&
    existing.issueUpdatedAt === issueUpdatedAt &&
    isIssueEnrichmentCommentAction(action);
}

function issueKey(repo: string, issueNumber: number): string {
  return `${repo}#${issueNumber}`;
}

function isIssueEnrichmentCommentAction(action: IssueEnrichmentScanAction): boolean {
  return action === "would_comment" || action === "would_enrich";
}

function buildIssueEnrichmentForCycle(
  config: IssueEnrichmentConfig,
  repo: string,
  issue: GitHubRelatedIssueOrPull,
  renderPolicy: IssueEnrichmentRenderPolicy,
  lifecycle?: IssueEnrichmentLifecycleInput,
  reviewLensPacket?: ReviewLensPacket
): EnrichmentComment {
  const policy = resolveIssueEnrichmentRepoPolicy(config, repo);
  const allowlists = issueSuggestionAllowlists(policy.suggestions);
  return buildIssueEnrichmentComment({
    repo,
    issue,
    repoPolicy: policy.repoPolicy,
    allowedLabels: allowlists.allowedLabels,
    allowedOwners: allowlists.allowedOwners,
    ...renderPolicy,
    postIssueComment: true,
    ...(reviewLensPacket ? { reviewLensPacket } : {}),
    ...(lifecycle ? { lifecycle } : {})
  });
}

interface IssueEnrichmentRenderPolicy {
  maxSuggestions?: number;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}

function resolveIssueEnrichmentRenderPolicy(config: {
  enrichment?: { maxSuggestions?: number };
  confidenceCalibration?: { publicDisplay: PublicConfidenceDisplayPolicy };
}): IssueEnrichmentRenderPolicy {
  return {
    ...(config.enrichment?.maxSuggestions !== undefined
      ? { maxSuggestions: config.enrichment.maxSuggestions }
      : {}),
    ...(config.confidenceCalibration?.publicDisplay
      ? { publicConfidencePolicy: config.confidenceCalibration.publicDisplay }
      : {})
  };
}

function buildIssueEnrichmentReviewLensPacket(config?: ReviewLensConfig): ReviewLensPacket | undefined {
  if (!config?.enabled) return undefined;
  const result = buildReviewLensPacket({
    config,
    surface: "issue_enrichment"
  });
  if (!result.ok) throw new Error(`Review lens issue-enrichment packet failed closed: ${result.error}`);
  if (result.packet.lenses.length === 0) return undefined;
  return result.packet;
}

function sum<T extends keyof Pick<IssueEnrichmentRepoScan, "issuesSeen" | "eligible" | "skipped" | "wouldEnrich" | "wouldComment" | "deferred">>(
  repos: IssueEnrichmentRepoScan[],
  field: T
): number {
  return repos.reduce((total, repo) => total + repo[field], 0);
}
