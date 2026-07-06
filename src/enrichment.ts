import { createHash } from "node:crypto";
import { join } from "node:path";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { redactSecrets } from "./secrets.js";
import {
  buildIssueHash,
  renderMarkerLifecycleFields,
  type IssueLifecycleState,
  type MarkerLifecycleFields
} from "./marker-lifecycle.js";
import { writeSecureFileSync } from "./temp-files.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import type {
  EnrichmentComment as PlanEnrichmentComment,
  EnrichmentCommentPostResult as PlanEnrichmentCommentPostResult,
  PullFilePatch,
  PullRequestSummary
} from "./types.js";

export const ENRICHMENT_MARKER_PREFIX = "<!-- evaos-code-review-bot:enrichment";
export const ENRICHMENT_STATE_MARKER_PREFIX = "<!-- evaos-code-review-bot:enrichment-state";
export const ENRICHMENT_SCHEMA_VERSION = 1;

const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

export interface EnrichmentConfig {
  enabled: boolean;
  postIssueComment: boolean;
  packetVersion: string;
  maxRelatedRefs: number;
  maxSuggestions: number;
}

export type EnrichmentComment = PlanEnrichmentComment;
export type EnrichmentCommentPostResult = PlanEnrichmentCommentPostResult;
type IssueEnrichmentSkipReason = "stale_issue_closed" | "issue_is_pull_request";
type IssuePlannerSourceKind =
  | "vision_repo_policy_memory_gitnexus"
  | "same_repo_issues_prs"
  | "allowlisted_cross_repo_github"
  | "external_oss_examples"
  | "library_api_docs"
  | "current_market_examples"
  | "internal_mcp_docs";

interface IssuePlannerPacket {
  relatedContext: string[];
  sourceTaxonomy: Array<{ kind: IssuePlannerSourceKind; enabled: boolean; reason: string }>;
  problemShape: string;
  productFit: string;
  buildBorrowBuyScan: string[];
  candidateSources: string[];
  implementationWedge: string;
  acceptanceCriteria: string[];
  proofPlan: string[];
  knownTraps: string[];
  nonGoals: string[];
}

export type IssueEnrichmentDryRunOutput =
  | {
      ok: true;
      skipped: true;
      reason: IssueEnrichmentSkipReason;
      repo: string;
      issueNumber: number;
      state: string;
      url?: string;
    }
  | {
      ok: true;
      skipped: false;
      repo: string;
      issueNumber: number;
      state: string;
      marker: string;
      url?: string;
      body: string;
    };

export interface EnrichmentCommentGithub {
  canPostAsApp(): boolean;
  upsertIssueComment(input: {
    repo: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<{ action: "created" | "updated"; html_url?: string; id: number }>;
}

export function buildEnrichmentMarker(input: { repo: string; pullNumber: number }): string {
  validateRepoPull(input);
  return `${ENRICHMENT_MARKER_PREFIX} repo=${input.repo} pr=${input.pullNumber} -->`;
}

export function buildIssueEnrichmentMarker(input: { repo: string; issueNumber: number }): string {
  validateRepoIssue(input);
  return `${ENRICHMENT_MARKER_PREFIX} repo=${input.repo} issue=${input.issueNumber} -->`;
}

export function buildEnrichmentComment(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
  validationSuggestions?: string[];
  maxRelatedRefs?: number;
  maxSuggestions?: number;
  postIssueComment?: boolean;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}): EnrichmentComment {
  validateIdentity({ repo: input.repo, pullNumber: input.pull.number, headSha: input.pull.head.sha });
  const marker = buildEnrichmentMarker({ repo: input.repo, pullNumber: input.pull.number });
  const relatedRefs = extractRelatedRefs(`${input.pull.title}\n${input.pull.body ?? ""}`).slice(0, input.maxRelatedRefs ?? 8);
  const labels = unique([
    ...(input.suggestedLabels ?? []),
    ...suggestLabelsFromFiles(input.files),
    ...(input.pull.labels?.map((label) => label.name) ?? [])
  ]).slice(0, input.maxSuggestions ?? 8);
  const reviewers = unique([
    ...(input.suggestedReviewers ?? []),
    ...(input.pull.requested_reviewers?.map((reviewer) => reviewer.login) ?? [])
  ]).slice(0, input.maxSuggestions ?? 8);
  const validationSuggestions = unique(input.validationSuggestions ?? []).slice(0, input.maxSuggestions ?? 8);
  const gaps = inferAcceptanceGaps(input.pull);
  const visibleBody = [
    "## evaOS enrichment",
    "",
    `PR: ${input.repo}#${input.pull.number} - ${formatInlinePublicText(input.pull.title, input.publicConfidencePolicy)}`,
    `Head: \`${input.pull.head.sha}\` into \`${input.pull.base.ref}\``,
    "",
    `Related issues/PRs: ${relatedRefs.length ? relatedRefs.join(", ") : "none detected from PR metadata"}.`,
    `Suggested labels: ${labels.length ? labels.join(", ") : "none"}.`,
    `Suggested reviewers: ${reviewers.length ? reviewers.join(", ") : "none"}.`,
    "",
    "### Validation suggestions",
    "",
    ...(validationSuggestions.length ? validationSuggestions.map((item) => `- ${formatPublicText(item, input.publicConfidencePolicy)}`) : ["- No extra validation suggestions."]),
    "",
    "### Triage gaps",
    "",
    ...(gaps.length ? gaps.map((item) => `- ${item}`) : ["- No obvious acceptance-criteria gap detected from PR metadata."]),
    "",
    "No labels or reviewers were applied by this bot."
  ].join("\n");
  // Keep a final redaction pass over the assembled sticky markdown so future
  // planner fields cannot bypass the field-level formatting helpers.
  const redactedVisibleBody = redactSecrets(visibleBody);
  const bodyHash = hashBody(redactedVisibleBody);
  const stateMarker = buildStateMarker({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    bodyHash
  });

  return {
    marker,
    body: [marker, stateMarker, redactedVisibleBody].join("\n"),
    bodyHash,
    postIssueComment: input.postIssueComment ?? false
  };
}

export function buildIssueEnrichmentComment(input: {
  repo: string;
  issue: GitHubRelatedIssueOrPull;
  suggestedLabels?: string[];
  suggestedOwners?: string[];
  allowedLabels?: string[];
  allowedOwners?: string[];
  validationSuggestions?: string[];
  maxRelatedRefs?: number;
  maxSuggestions?: number;
  postIssueComment?: boolean;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
  /** Optional lifecycle/handoff metadata (#263). Rides the diagnostic issue state marker only. */
  lifecycle?: IssueEnrichmentLifecycleInput;
}): EnrichmentComment {
  validateRepoIssue({ repo: input.repo, issueNumber: input.issue.number });
  const eligibility = getIssueEnrichmentEligibility(input.issue);
  if (eligibility.skip) throw new Error(`Cannot build issue enrichment for ${input.repo}#${input.issue.number}: ${eligibility.skip.reason}`);
  const state = eligibility.state;
  const marker = buildIssueEnrichmentMarker({ repo: input.repo, issueNumber: input.issue.number });
  const relatedRefs = extractRelatedRefs(`${input.issue.title ?? ""}\n${input.issue.body ?? ""}`).slice(0, input.maxRelatedRefs ?? 8);
  const existingLabels = uniqueCaseInsensitive(normalizeIssueLabels(input.issue.labels));
  const existingLabelKeys = new Set(existingLabels.map(normalizedSuggestionKey));
  const allowedLabelKeys = input.allowedLabels === undefined || input.allowedLabels.length === 0
    ? undefined
    : new Set(uniqueCaseInsensitive(input.allowedLabels).map(normalizedSuggestionKey));
  const allowedOwnerKeys = input.allowedOwners === undefined || input.allowedOwners.length === 0
    ? undefined
    : new Set(uniqueCaseInsensitive(input.allowedOwners).map(normalizedSuggestionKey));
  const suggestedLabels = uniqueCaseInsensitive([
    ...(input.suggestedLabels ?? []),
    ...suggestLabelsFromIssue(input.issue)
  ]).filter((label) => {
    const key = normalizedSuggestionKey(label);
    return !existingLabelKeys.has(key) && (allowedLabelKeys === undefined || allowedLabelKeys.has(key));
  }).slice(0, input.maxSuggestions ?? 8);
  const owners = uniqueCaseInsensitive(input.suggestedOwners ?? []).filter((owner) => {
    return allowedOwnerKeys === undefined || allowedOwnerKeys.has(normalizedSuggestionKey(owner));
  }).slice(0, input.maxSuggestions ?? 8);
  const validationSuggestions = unique(input.validationSuggestions ?? []).slice(0, input.maxSuggestions ?? 8);
  const gaps = inferIssueAcceptanceGaps(input.issue);
  const planner = buildIssuePlannerPacket({
    issue: input.issue,
    relatedRefs,
    publicConfidencePolicy: input.publicConfidencePolicy
  });
  const visibleBody = [
    "## evaOS issue enrichment",
    "",
    `Issue: ${input.repo}#${input.issue.number} - ${formatInlinePublicText(input.issue.title ?? "(untitled)", input.publicConfidencePolicy)}`,
    `State: \`${state}\`${input.issue.milestone?.title ? `; milestone: \`${formatInlinePublicText(input.issue.milestone.title, input.publicConfidencePolicy)}\`` : ""}`,
    "",
    `Related issues/PRs: ${relatedRefs.length ? relatedRefs.join(", ") : "none detected from issue metadata"}.`,
    `Existing labels: ${existingLabels.length ? existingLabels.join(", ") : "none"}.`,
    `Suggested labels: ${suggestedLabels.length ? suggestedLabels.join(", ") : "none"}.`,
    `Suggested owners: ${owners.length ? owners.join(", ") : "none"}.`,
    "",
    "### Related context",
    "",
    ...planner.relatedContext,
    "",
    "### Agent-start packet",
    "",
    `Problem shape: ${planner.problemShape}`,
    `Product fit: ${planner.productFit}`,
    `Implementation wedge: ${planner.implementationWedge}`,
    "",
    "Build / borrow / buy scan:",
    ...planner.buildBorrowBuyScan,
    "",
    "Candidate sources:",
    ...planner.candidateSources,
    "",
    "Acceptance criteria:",
    ...planner.acceptanceCriteria,
    "",
    "Proof plan:",
    ...planner.proofPlan,
    "",
    "Known traps:",
    ...planner.knownTraps,
    "",
    "Non-goals:",
    ...planner.nonGoals,
    "",
    "Context-source taxonomy:",
    ...planner.sourceTaxonomy.map((source) => `- [${source.enabled ? "enabled" : "deferred"}] ${source.kind}: ${source.reason}`),
    "",
    "### Validation suggestions",
    "",
    ...(validationSuggestions.length ? validationSuggestions.map((item) => `- ${formatPublicText(item, input.publicConfidencePolicy)}`) : ["- Confirm owner, acceptance criteria, and validation evidence before implementation."]),
    "",
    "### Triage gaps",
    "",
    ...(gaps.length ? gaps.map((item) => `- ${item}`) : ["- No obvious issue triage gap detected from issue metadata."]),
    "",
    "No labels, owners, reviewers, or roadmap fields were changed by this bot."
  ].join("\n");
  const redactedVisibleBody = redactSecrets(visibleBody);
  const bodyHash = hashBody(redactedVisibleBody);
  const stateMarker = buildIssueStateMarker({
    repo: input.repo,
    issueNumber: input.issue.number,
    state,
    bodyHash,
    // Opt-in only: absent lifecycle input ⇒ no new tokens ⇒ byte-identical marker text.
    ...(input.lifecycle?.state ? { lifecycleState: input.lifecycle.state } : {}),
    ...(input.lifecycle ? { lifecycle: buildIssueLifecycleFields(input.repo, input.issue.number, input.lifecycle) } : {})
  });

  return {
    marker,
    body: [marker, stateMarker, redactedVisibleBody].join("\n"),
    bodyHash,
    postIssueComment: input.postIssueComment ?? false
  };
}

/**
 * Optional #263 lifecycle/handoff inputs for an issue enrichment marker. `state` is the mapped
 * issue-side lifecycle state (a renaming of the existing enrichment decision); the rest are
 * optional passthroughs. All ride the diagnostic issue state marker only.
 */
export interface IssueEnrichmentLifecycleInput {
  state?: IssueLifecycleState;
  runId?: string;
  handoffTarget?: string;
}

function buildIssueLifecycleFields(
  repo: string,
  issueNumber: number,
  lifecycle: IssueEnrichmentLifecycleInput | undefined
): MarkerLifecycleFields {
  // Role is fixed for the enricher surface; issueHash correlates repo+issue. outcome=enriched only
  // when the mapped lifecycle state is `enriched` (a terminal enrich decision). runId/handoffTarget
  // are optional passthroughs.
  return {
    role: "enricher",
    issueHash: buildIssueHash({ repo, issueNumber }),
    ...(lifecycle?.state === "enriched" ? { outcome: "enriched" as const } : {}),
    ...(lifecycle?.runId ? { runId: lifecycle.runId } : {}),
    ...(lifecycle?.handoffTarget ? { handoffTarget: lifecycle.handoffTarget } : {})
  };
}

export function buildIssueEnrichmentDryRunOutput(input: {
  repo: string;
  issue: GitHubRelatedIssueOrPull;
  suggestedLabels?: string[];
  suggestedOwners?: string[];
  allowedLabels?: string[];
  allowedOwners?: string[];
  validationSuggestions?: string[];
  maxRelatedRefs?: number;
  maxSuggestions?: number;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}): IssueEnrichmentDryRunOutput {
  validateRepoIssue({ repo: input.repo, issueNumber: input.issue.number });
  const eligibility = getIssueEnrichmentEligibility(input.issue);
  const state = eligibility.state;
  const skip = eligibility.skip;
  if (skip) {
    return {
      ok: true,
      skipped: true,
      reason: skip.reason,
      repo: input.repo,
      issueNumber: input.issue.number,
      state,
      ...(input.issue.html_url ? { url: redactSecrets(input.issue.html_url) } : {})
    };
  }
  const enrichment = buildIssueEnrichmentComment({
    repo: input.repo,
    issue: input.issue,
    suggestedLabels: input.suggestedLabels,
    suggestedOwners: input.suggestedOwners,
    allowedLabels: input.allowedLabels,
    allowedOwners: input.allowedOwners,
    validationSuggestions: input.validationSuggestions,
    maxRelatedRefs: input.maxRelatedRefs,
    maxSuggestions: input.maxSuggestions,
    publicConfidencePolicy: input.publicConfidencePolicy,
    postIssueComment: false
  });
  return {
    ok: true,
    skipped: false,
    repo: input.repo,
    issueNumber: input.issue.number,
    state,
    marker: enrichment.marker,
    ...(input.issue.html_url ? { url: redactSecrets(input.issue.html_url) } : {}),
    body: enrichment.body
  };
}

export async function postEnrichmentComment(input: {
  enabled: boolean;
  dryRun: boolean;
  github: EnrichmentCommentGithub;
  repo: string;
  pullNumber: number;
  enrichment?: EnrichmentComment;
  evidenceDir?: string;
}): Promise<EnrichmentCommentPostResult> {
  if (!input.enabled || !input.enrichment?.postIssueComment) return { posted: false, reason: "disabled" };
  if (input.dryRun) return { posted: false, reason: "dry_run" };
  if (!input.github.canPostAsApp()) return { posted: false, reason: "missing_app_credentials" };
  try {
    const result = await input.github.upsertIssueComment({
      repo: input.repo,
      issueNumber: input.pullNumber,
      marker: input.enrichment.marker,
      body: input.enrichment.body
    });
    return { posted: true, ...result };
  } catch (error) {
    const message = redactSecrets(error instanceof Error ? error.message : String(error));
    if (input.evidenceDir) writeSecureFileSync(join(input.evidenceDir, "enrichment-comment-error.txt"), `${message}\n`);
    return { posted: false, reason: "upsert_failed", error: message };
  }
}

function buildStateMarker(input: { repo: string; pullNumber: number; headSha: string; bodyHash: string }): string {
  validateIdentity(input);
  if (!/^[0-9a-f]{64}$/i.test(input.bodyHash)) throw new Error(`Invalid enrichment body hash: ${input.bodyHash}`);
  return `${ENRICHMENT_STATE_MARKER_PREFIX} version=${ENRICHMENT_SCHEMA_VERSION} repo=${input.repo} pr=${input.pullNumber} sha=${input.headSha} hash=${input.bodyHash} -->`;
}

function buildIssueStateMarker(input: {
  repo: string;
  issueNumber: number;
  state: string;
  bodyHash: string;
  lifecycle?: MarkerLifecycleFields;
  lifecycleState?: IssueLifecycleState;
}): string {
  validateRepoIssue(input);
  if (!/^[0-9a-f]{64}$/i.test(input.bodyHash)) throw new Error(`Invalid enrichment body hash: ${input.bodyHash}`);
  const state = normalizeIssueState({ state: input.state, number: input.issueNumber });
  // `lifecycle=` is the #263 issue-side lifecycle state; distinct from the `state=` identity token
  // (open|closed|unknown) so both round-trip. Absent ⇒ token omitted ⇒ byte-identical marker.
  const lifecycleState = input.lifecycleState ? ` lifecycle=${input.lifecycleState}` : "";
  const lifecycle = renderMarkerLifecycleFields(input.lifecycle);
  return `${ENRICHMENT_STATE_MARKER_PREFIX} version=${ENRICHMENT_SCHEMA_VERSION} repo=${input.repo} issue=${input.issueNumber} state=${state}${lifecycleState} hash=${input.bodyHash}${lifecycle} -->`;
}

function validateIdentity(input: { repo: string; pullNumber: number; headSha: string }): void {
  validateRepoPull(input);
  if (!HEAD_SHA_PATTERN.test(input.headSha)) throw new Error(`Invalid enrichment head SHA: ${input.headSha}`);
}

function validateRepoPull(input: { repo: string; pullNumber: number }): void {
  if (!REPO_SLUG_PATTERN.test(input.repo)) throw new Error(`Invalid enrichment repo slug: ${input.repo}`);
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) throw new Error(`Invalid enrichment pull number: ${input.pullNumber}`);
}

function validateRepoIssue(input: { repo: string; issueNumber: number }): void {
  if (!REPO_SLUG_PATTERN.test(input.repo)) throw new Error(`Invalid enrichment repo slug: ${input.repo}`);
  if (!Number.isInteger(input.issueNumber) || input.issueNumber <= 0) throw new Error(`Invalid enrichment issue number: ${input.issueNumber}`);
}

function extractRelatedRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/(?<![A-Za-z0-9_/.-])#([1-9]\d*)\b/g)) refs.add(`#${match[1]}`);
  return [...refs];
}

function suggestLabelsFromFiles(files: PullFilePatch[]): string[] {
  const labels = new Set<string>();
  if (files.some((file) => file.filename.startsWith("docs/") || file.filename.endsWith(".md"))) labels.add("docs");
  if (files.some((file) => file.filename.includes("test") || file.filename.includes(".spec."))) labels.add("tests");
  if (files.some((file) => file.filename.startsWith("src/"))) labels.add("backend");
  if (files.some((file) => file.filename.startsWith("Assets/") || file.filename.endsWith(".cs"))) labels.add("unity");
  return [...labels];
}

function suggestLabelsFromIssue(issue: GitHubRelatedIssueOrPull): string[] {
  const text = `${issue.title ?? ""}\n${issue.body ?? ""}`.toLowerCase();
  const labels = new Set<string>();
  if (/\bbug|regression|broken|error|failure\b/.test(text)) labels.add("bug");
  if (/\bsecurity|auth|token|secret|permission\b/.test(text)) labels.add("security");
  if (/\bdocs?|readme|runbook\b/.test(text)) labels.add("docs");
  if (/\btest|coverage|fixture|eval\b/.test(text)) labels.add("tests");
  if (/\bsupport|customer|incident|escalation\b/.test(text)) labels.add("support");
  return [...labels];
}

function normalizeIssueLabels(labels: GitHubRelatedIssueOrPull["labels"]): string[] {
  return (labels ?? []).map((label) => typeof label === "string" ? label : label.name ?? "").filter(Boolean);
}

function getIssueEnrichmentEligibility(issue: GitHubRelatedIssueOrPull): {
  state: string;
  skip?: { reason: IssueEnrichmentSkipReason };
} {
  const state = normalizeIssueState(issue);
  if (issue.pull_request) return { state, skip: { reason: "issue_is_pull_request" } };
  if (state === "closed") return { state, skip: { reason: "stale_issue_closed" } };
  return { state };
}

function normalizeIssueState(issue: Pick<GitHubRelatedIssueOrPull, "state" | "number">): string {
  const normalized = formatInlinePublicText(issue.state ?? "unknown").toLowerCase() || "unknown";
  if (normalized === "open" || normalized === "closed") return normalized;
  return "unknown";
}

function inferAcceptanceGaps(pull: PullRequestSummary): string[] {
  const body = pull.body ?? "";
  const gaps: string[] = [];
  if (!/\b(acceptance|checklist|test plan|validation|proof)\b/i.test(body)) {
    gaps.push("Acceptance criteria or validation evidence not detected in PR body.");
  }
  return gaps;
}

function inferIssueAcceptanceGaps(issue: GitHubRelatedIssueOrPull): string[] {
  const body = issue.body ?? "";
  const gaps: string[] = [];
  if (!/\b(acceptance|checklist|test plan|validation|proof|done when)\b/i.test(body)) {
    gaps.push("Acceptance criteria or validation evidence not detected in issue body.");
  }
  if (!/\b(owner|assignee|reviewer|responsible)\b/i.test(body)) {
    gaps.push("Owner or reviewer signal not detected in issue body.");
  }
  return gaps;
}

function buildIssuePlannerPacket(input: {
  issue: GitHubRelatedIssueOrPull;
  relatedRefs: string[];
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}): IssuePlannerPacket {
  const text = `${input.issue.title ?? ""}\n${input.issue.body ?? ""}`;
  const classes = classifyIssueForPlanner(text);
  const shouldResearch = classes.some((issueClass) => ["product", "ux", "library_choice", "build_vs_buy", "market_positioning"].includes(issueClass));
  const relatedContext = input.relatedRefs.length
    ? input.relatedRefs.map((ref) => `- ${ref} - mentioned in issue metadata; inspect for dependency, duplicate, or prior-decision risk.`)
    : ["- No same-repo issue/PR references detected in issue metadata."];
  const sourceTaxonomy: IssuePlannerPacket["sourceTaxonomy"] = [
    {
      kind: "vision_repo_policy_memory_gitnexus",
      enabled: true,
      reason: "Use repo vision, policy, memory, and GitNexus first before external research."
    },
    {
      kind: "same_repo_issues_prs",
      enabled: true,
      reason: input.relatedRefs.length ? "Issue metadata contains same-repo references." : "No explicit same-repo references detected; still safe as bounded local context."
    },
    {
      kind: "allowlisted_cross_repo_github",
      enabled: shouldResearch,
      reason: shouldResearch ? "Triggered by issue class; keep to configured allowlist and source caps." : "Deferred until product, UX, market-positioning, or library-choice signal appears."
    },
    {
      kind: "external_oss_examples",
      enabled: shouldResearch,
      reason: shouldResearch ? "Use for build/borrow/buy precedent with citations and observed dates." : "Deferred for low-research-value issue class."
    },
    {
      kind: "library_api_docs",
      enabled: shouldResearch || classes.includes("library_choice"),
      reason: shouldResearch || classes.includes("library_choice") ? "Use when implementation may depend on a module, SDK, API, or framework choice." : "Deferred unless a library/API decision is present."
    },
    {
      kind: "current_market_examples",
      enabled: classes.includes("market_positioning") || classes.includes("product") || classes.includes("ux"),
      reason: classes.includes("market_positioning") || classes.includes("product") || classes.includes("ux")
        ? "Use for product/UX/market positioning issues with freshness dates."
        : "Deferred for implementation-only issues."
    },
    {
      kind: "internal_mcp_docs",
      enabled: true,
      reason: "Use internal docs/MCP context when available; missing context is degraded, not blocking."
    }
  ];
  return {
    relatedContext,
    sourceTaxonomy,
    problemShape: summarizeIssueShape(input.issue, input.publicConfidencePolicy),
    productFit: buildProductFit(classes),
    buildBorrowBuyScan: buildBuildBorrowBuyScan({ shouldResearch, classes }),
    candidateSources: buildCandidateSources({ shouldResearch, classes }),
    implementationWedge: buildImplementationWedge(classes),
    acceptanceCriteria: buildPlannerAcceptanceCriteria(input.issue),
    proofPlan: buildPlannerProofPlan(classes),
    knownTraps: buildPlannerKnownTraps(classes, shouldResearch),
    nonGoals: [
      "- Do not auto-apply labels, owners, reviewers, roadmap fields, or milestones.",
      "- Do not bulk-enrich old backlog issues from this planner output.",
      "- Do not claim external market or OSS research was performed unless cited sources are present."
    ]
  };
}

function classifyIssueForPlanner(text: string): string[] {
  const normalized = text.toLowerCase();
  const classes = new Set<string>();
  if (/\b(ux|ui|onboarding|experience|design|interaction|flow)\b/.test(normalized)) classes.add("ux");
  if (/\b(product|pricing|market|positioning|customer|roadmap|vision)\b/.test(normalized)) classes.add("product");
  if (/\b(architecture|runtime|provider|queue|scheduler|database|migration|api|integration)\b/.test(normalized)) classes.add("architecture");
  if (/\b(library|sdk|module|package|framework|dependency|build vs buy|borrow|buy)\b/.test(normalized)) classes.add("library_choice");
  if (/\b(open source|oss|competitor|alternative to|current market|last 30 days)\b/.test(normalized)) classes.add("market_positioning");
  if (/\b(integration|webhook|oauth|api|connector)\b/.test(normalized)) classes.add("integration");
  if (/\b(milestone|roadmap|sprint|release|launch)\b/.test(normalized)) classes.add("roadmap");
  if (classes.size === 0) classes.add("implementation");
  if (classes.has("library_choice") || classes.has("market_positioning")) classes.add("build_vs_buy");
  return [...classes].sort();
}

function summarizeIssueShape(issue: GitHubRelatedIssueOrPull, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  const title = formatInlinePublicText(issue.title ?? "(untitled)", publicConfidencePolicy);
  const body = formatPublicText(issue.body ?? "", publicConfidencePolicy).replace(/\s+/g, " ").trim();
  const excerpt = body ? trimExcerptAtWhitespaceBoundary(body, 220) : "No issue body supplied.";
  return `${title} - ${excerpt}`;
}

function trimExcerptAtWhitespaceBoundary(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  const clipped = value.slice(0, maxChars);
  const lastWhitespace = clipped.lastIndexOf(" ");
  return (lastWhitespace > 0 ? clipped.slice(0, lastWhitespace) : clipped).trimEnd();
}

function buildProductFit(classes: string[]): string {
  if (classes.includes("ux")) return "Product/UX-sensitive issue; review against repo vision and user flow quality, not only technical P0/P1 risk.";
  if (classes.includes("product") || classes.includes("market_positioning")) return "Product/market issue; check vision fit, customer value, and whether external precedent can reduce time-to-market.";
  if (classes.includes("architecture") || classes.includes("integration")) return "Architecture/integration issue; check repo policy, prior decisions, and operational constraints before implementation.";
  return "Implementation issue; keep product fit lightweight unless VISION.md/repo policy raises a constraint.";
}

function buildBuildBorrowBuyScan(input: { shouldResearch: boolean; classes: string[] }): string[] {
  const items = [
    "- Build: identify the smallest implementation wedge that proves the issue without broad rollout.",
    "- Borrow: inspect same-repo prior art, repo memory, GitNexus context, and allowlisted cross-repo examples first.",
    input.shouldResearch
      ? "- Buy/use: run capped external OSS/library/API/current-market research with citations, observed dates, and why each source matters."
      : "- Buy/use: deferred; no product, architecture, UX, library-choice, integration, roadmap, or market-positioning trigger detected."
  ];
  if (input.classes.includes("library_choice")) items.push("- Library choice: compare maintenance, API fit, license, bundle/runtime cost, and integration proof.");
  return items;
}

function buildCandidateSources(input: { shouldResearch: boolean; classes: string[] }): string[] {
  const items = [
    "- VISION.md / repo policy / repo-memory.md / GitNexus packet.",
    "- Same-repo issues and PRs referenced by issue metadata."
  ];
  if (input.shouldResearch) {
    items.push("- Allowlisted cross-repo GitHub examples with direct issue/PR/repo URLs.");
    items.push("- External OSS repositories or library/API docs with freshness dates.");
  }
  if (input.classes.includes("product") || input.classes.includes("ux") || input.classes.includes("market_positioning")) {
    items.push("- Current market/product examples, capped and cited, only when they change implementation direction.");
  }
  return items;
}

function buildImplementationWedge(classes: string[]): string {
  if (classes.includes("ux")) return "Ship the smallest user-visible path or prototype that can be smoke-tested against the intended experience.";
  if (classes.includes("architecture") || classes.includes("integration")) return "Start with a bounded adapter/contract or dry-run packet before changing live runtime behavior.";
  if (classes.includes("library_choice")) return "Prototype the candidate module behind a config flag or fixture before committing to the dependency.";
  return "Start with a focused fixture or dry-run path that proves the issue shape before widening behavior.";
}

function buildPlannerAcceptanceCriteria(issue: GitHubRelatedIssueOrPull): string[] {
  const body = issue.body ?? "";
  const criteria = [
    /\b(acceptance|done when|checklist)\b/i.test(body)
      ? "- Preserve and execute the issue's stated acceptance criteria."
      : "- Add explicit acceptance criteria before implementation is considered done.",
    "- Include source citations for any external OSS/library/current-market claims.",
    "- Keep issue-enrichment comments sticky and idempotent.",
    "- Keep labels, owners, reviewers, and roadmap fields suggestion-only."
  ];
  return criteria;
}

function buildPlannerProofPlan(classes: string[]): string[] {
  const plan = [
    "- Focused unit/fixture test for the changed planner behavior.",
    "- Dry-run issue-enrichment evidence packet before live comment posting.",
    "- Redaction check for issue body, citations, and generated markdown."
  ];
  if (classes.includes("ux")) plan.push("- UX/product smoke or screenshot proof when implementation changes user flow.");
  if (classes.includes("architecture") || classes.includes("integration")) plan.push("- Contract or degraded-mode proof before runtime promotion.");
  if (classes.includes("library_choice")) plan.push("- Dependency/license/API-fit note before adding or relying on a package.");
  return plan;
}

function buildPlannerKnownTraps(classes: string[], shouldResearch: boolean): string[] {
  const traps = [
    "- Do not treat related links as proof by themselves; each source needs a reason why it matters.",
    "- Do not scan old issue backlogs or exceed repo-level enrichment throttles."
  ];
  if (shouldResearch) traps.push("- External research must stay capped, cited, fresh-dated, and redacted.");
  if (classes.includes("ux") || classes.includes("product")) traps.push("- Technical severity alone can miss product/UX regressions; include product-manager review framing.");
  return traps;
}

function formatInlinePublicText(value: string | undefined, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  const normalizedText = redactSecrets((value ?? "").replace(HTML_COMMENT_PATTERN, "[hidden comment removed]"))
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "");
  return sanitizePublicConfidenceText(normalizedText, publicConfidencePolicy)
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .slice(0, 200);
}

function formatPublicText(value: string | undefined, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  return sanitizePublicConfidenceText(
    redactSecrets((value ?? "").replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")),
    publicConfidencePolicy
  ).trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => formatPublicText(value)).filter(Boolean))];
}

function uniqueCaseInsensitive(values: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    const formatted = formatPublicText(value);
    if (!formatted) continue;
    const key = normalizedSuggestionKey(formatted);
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(formatted);
  }
  return result;
}

function normalizedSuggestionKey(value: string): string {
  return formatPublicText(value).toLowerCase();
}

function hashBody(value: string): string {
  return createHash("sha256").update(redactSecrets(value), "utf8").digest("hex");
}
