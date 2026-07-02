import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { redactSecrets } from "./secrets.js";
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
    `PR: ${input.repo}#${input.pull.number} - ${formatInlinePublicText(input.pull.title)}`,
    `Head: \`${input.pull.head.sha}\` into \`${input.pull.base.ref}\``,
    "",
    `Related issues/PRs: ${relatedRefs.length ? relatedRefs.join(", ") : "none detected from PR metadata"}.`,
    `Suggested labels: ${labels.length ? labels.join(", ") : "none"}.`,
    `Suggested reviewers: ${reviewers.length ? reviewers.join(", ") : "none"}.`,
    "",
    "### Validation suggestions",
    "",
    ...(validationSuggestions.length ? validationSuggestions.map((item) => `- ${formatPublicText(item)}`) : ["- No extra validation suggestions."]),
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

function validateIdentity(input: { repo: string; pullNumber: number; headSha: string }): void {
  validateRepoPull(input);
  if (!HEAD_SHA_PATTERN.test(input.headSha)) throw new Error(`Invalid enrichment head SHA: ${input.headSha}`);
}

function validateRepoPull(input: { repo: string; pullNumber: number }): void {
  if (!REPO_SLUG_PATTERN.test(input.repo)) throw new Error(`Invalid enrichment repo slug: ${input.repo}`);
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) throw new Error(`Invalid enrichment pull number: ${input.pullNumber}`);
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

function inferAcceptanceGaps(pull: PullRequestSummary): string[] {
  const body = pull.body ?? "";
  const gaps: string[] = [];
  if (!/\b(acceptance|checklist|test plan|validation|proof)\b/i.test(body)) {
    gaps.push("Acceptance criteria or validation evidence not detected in PR body.");
  }
  return gaps;
}

function formatInlinePublicText(value: string | undefined): string {
  return formatPublicText(value).replace(/\s+/g, " ").replace(/^#{1,6}\s+/, "").slice(0, 200);
}

function formatPublicText(value: string | undefined): string {
  return redactSecrets((value ?? "").replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")).trim();
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => formatPublicText(value)).filter(Boolean))];
}

function hashBody(value: string): string {
  return createHash("sha256").update(redactSecrets(value), "utf8").digest("hex");
}
