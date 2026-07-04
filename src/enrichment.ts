import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { redactSecrets } from "./secrets.js";
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
  const redactedVisibleBody = redactSecrets(visibleBody);
  const stateMarker = buildStateMarker({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    bodyHash: hashBody(redactedVisibleBody)
  });

  return {
    marker,
    body: [marker, stateMarker, redactedVisibleBody].join("\n"),
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
  const stateMarker = buildIssueStateMarker({
    repo: input.repo,
    issueNumber: input.issue.number,
    state,
    bodyHash: hashBody(redactedVisibleBody)
  });

  return {
    marker,
    body: [marker, stateMarker, redactedVisibleBody].join("\n"),
    postIssueComment: input.postIssueComment ?? false
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
    if (input.evidenceDir) writeFileSync(join(input.evidenceDir, "enrichment-comment-error.txt"), `${message}\n`);
    return { posted: false, reason: "upsert_failed", error: message };
  }
}

function buildStateMarker(input: { repo: string; pullNumber: number; headSha: string; bodyHash: string }): string {
  validateIdentity(input);
  if (!/^[0-9a-f]{64}$/i.test(input.bodyHash)) throw new Error(`Invalid enrichment body hash: ${input.bodyHash}`);
  return `${ENRICHMENT_STATE_MARKER_PREFIX} version=${ENRICHMENT_SCHEMA_VERSION} repo=${input.repo} pr=${input.pullNumber} sha=${input.headSha} hash=${input.bodyHash} -->`;
}

function buildIssueStateMarker(input: { repo: string; issueNumber: number; state: string; bodyHash: string }): string {
  validateRepoIssue(input);
  if (!/^[0-9a-f]{64}$/i.test(input.bodyHash)) throw new Error(`Invalid enrichment body hash: ${input.bodyHash}`);
  const state = normalizeIssueState({ state: input.state, number: input.issueNumber });
  return `${ENRICHMENT_STATE_MARKER_PREFIX} version=${ENRICHMENT_SCHEMA_VERSION} repo=${input.repo} issue=${input.issueNumber} state=${state} hash=${input.bodyHash} -->`;
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
