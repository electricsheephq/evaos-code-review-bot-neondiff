import { createHash } from "node:crypto";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { categoryLabel, isRequestChangesEligible } from "./regression-taxonomy.js";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import { assertPublicReviewOutputSafe } from "./repo-policy.js";
import type { ReviewModelSummary } from "./zcode.js";
import type {
  ChangedSurfaceValidationReport,
  DroppedFinding,
  OutsideDiffFinding,
  ProofRequirementReport,
  PullFilePatch,
  PullRequestSummary,
  RegressionCategory,
  ReviewComment,
  ReviewEvent,
  ReviewProviderMetadata,
  Severity,
  WalkthroughComment
} from "./types.js";

export const WALKTHROUGH_MARKER_PREFIX = "<!-- evaos-code-review-bot:walkthrough";
export const WALKTHROUGH_STATE_MARKER_PREFIX = "<!-- evaos-code-review-bot:walkthrough-state";
export const WALKTHROUGH_SCHEMA_VERSION = 1;

const SEVERITY_LABELS: Severity[] = ["P0", "P1", "P2", "P3"];
const MAX_CHANGED_FILE_ROWS = 25;
const REPO_SLUG_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const HEAD_SHA_PATTERN = /^[0-9a-f]{40}$/i;
const HTML_COMMENT_PATTERN = /<!--[\s\S]*?-->/g;

export type OutsideDiffCountMode = "count" | "count-line";

export function buildWalkthroughMarker(input: { repo: string; pullNumber: number }): string {
  validateWalkthroughRepoPull(input);
  return `${WALKTHROUGH_MARKER_PREFIX} repo=${input.repo} pr=${input.pullNumber} -->`;
}

export function buildWalkthroughComment(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  comments: ReviewComment[];
  outsideDiffFindings?: OutsideDiffFinding[];
  outsideDiffSection?: string[] | "review";
  outsideDiffCountMode?: OutsideDiffCountMode;
  dropped: DroppedFinding[];
  event: ReviewEvent;
  validation?: ChangedSurfaceValidationReport;
  proof?: ProofRequirementReport;
  modelSummary?: ReviewModelSummary;
  provider?: ReviewProviderMetadata;
  postIssueComment?: boolean;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}): WalkthroughComment {
  validateWalkthroughIdentity({ repo: input.repo, pullNumber: input.pull.number, headSha: input.pull.head.sha });
  const marker = buildWalkthroughMarker({ repo: input.repo, pullNumber: input.pull.number });
  // Keep gate/count signal on original comments; use publicComments only for public-text safety checks.
  const publicComments = input.comments.map((comment) => sanitizeReviewCommentPublicText(comment, input.publicConfidencePolicy));
  const outsideDiffFindings = input.outsideDiffFindings ?? [];
  const oneOutside = outsideDiffFindings.length === 1;
  const outsideDiffSubject = oneOutside
    ? "1 finding on a file GitHub shows no diff for"
    : `${outsideDiffFindings.length} findings on files GitHub shows no diff for`;
  const outsideDiffHeadline = input.outsideDiffCountMode === "count"
    ? `${outsideDiffSubject} ${oneOutside ? "was" : "were"} left out of this review's text to stay within the size limit.`
    : `${outsideDiffSubject} ${oneOutside ? "is" : "are"} ${input.outsideDiffSection === "review" ? "in the review" : "listed below"}.`;
  const findings = [...input.comments, ...outsideDiffFindings];
  const files = input.files.map((file) => summarizeFile(file, findings));
  const visibleFiles = files.slice(0, MAX_CHANGED_FILE_ROWS);
  const omittedFileCount = Math.max(0, files.length - visibleFiles.length);
  const effort = estimateReviewEffort(input.files, findings);
  const relatedRefs = extractRelatedRefs(`${input.pull.title}\n${input.pull.body ?? ""}`);
  const severityCounts = countSeverities(input.comments);
  const modelSummary = input.modelSummary ?? {
    changedBehavior: [],
    invariants: [],
    evidence: [],
    limitations: ["No structured provider summary was available."],
    noFindingRationale: "No structured provider summary was available."
  };
  const highSeverity = findings.filter((finding) => finding.severity === "P0" || finding.severity === "P1").length;
  const requestChangesEligible = findings.filter((finding) => isRequestChangesEligible(finding)).length;
  const visibleBody = [
    "## Walkthrough",
    "",
    `PR: ${input.repo}#${input.pull.number} - ${formatInlinePublicText(input.pull.title, input.publicConfidencePolicy)}`,
    `Head: \`${input.pull.head.sha}\` into \`${input.pull.base.ref}\`. Review event: \`${input.event}\`.`,
    `Estimated review effort: ${effort.score}/5 (~${effort.minutes} min)`,
    "",
    "### Changed Files",
    "",
    "| File | Status | Churn | Purpose | Risk |",
    "| --- | --- | --- | --- | --- |",
    ...visibleFiles.map((file) => `| \`${file.filename}\` | ${file.status} | ${file.churn} | ${file.purpose} | ${file.risk} |`),
    ...(omittedFileCount > 0 ? ["", `${omittedFileCount} additional changed files omitted from this walkthrough.`] : []),
    "",
    "### Review Signal",
    "",
    input.comments.length === 0
      ? "No validated inline findings."
      : `Validated inline findings: ${input.comments.length} (${formatSeverityCounts(severityCounts)}).`,
    ...(outsideDiffFindings.length === 0 || input.outsideDiffSection?.length === 0 || input.outsideDiffCountMode === "count-line"
      ? [] : [outsideDiffHeadline]),
    `Dropped findings before posting: ${input.dropped.length}. High-severity findings: ${highSeverity}.`,
    "",
    ...(input.outsideDiffSection === "review" ? [] : input.outsideDiffSection ?? formatOutsideDiffFindings(outsideDiffFindings, input.publicConfidencePolicy).lines),
    "### Maintainer Analysis",
    "",
    "Changed behavior:",
    ...formatModelSummaryList(modelSummary.changedBehavior, "No changed behavior was established.", input.publicConfidencePolicy),
    "",
    "Affected invariants:",
    ...formatModelSummaryList(modelSummary.invariants, "No affected invariant was established.", input.publicConfidencePolicy),
    "",
    "Evidence:",
    ...formatModelSummaryList(modelSummary.evidence, "No additional provider evidence was established.", input.publicConfidencePolicy),
    "",
    "Limitations:",
    ...formatModelSummaryList(modelSummary.limitations, "No limitations were supplied.", input.publicConfidencePolicy),
    "",
    ...(outsideDiffFindings.length === 0
      ? [`No-finding rationale: ${sanitizePublicConfidenceText(modelSummary.noFindingRationale, input.publicConfidencePolicy)}`, ""]
      : []),
    "### Risk Taxonomy",
    "",
    formatCategoryBreakdown(findings),
    "",
    "### Validation and Proof",
    "",
    ...formatValidationSection(input.validation, input.proof, input.publicConfidencePolicy),
    "",
    "### Related Context",
    "",
    `Related issues/PRs: ${relatedRefs.length > 0 ? relatedRefs.join(", ") : "none detected from PR metadata"}.`,
    "",
    "### Pre-merge checklist",
    "",
    checklistItem(input.comments.every((comment) => comment.side === "RIGHT"), "Inline comments target current RIGHT-side diff lines."),
    checklistItem(!commentsContainSecretLikeText(publicComments), "No secret-like content survived into posted inline comments."),
    checklistItem(
      input.event !== "REQUEST_CHANGES" || requestChangesEligible > 0,
      "REQUEST_CHANGES is only used when eligible P0/P1 findings survive validation."
    ),
    checklistItem(proofChecklistPassed(input.validation, input.proof), "Required behavior proof is present or not applicable.")
  ].join("\n");
  const redactedBody = redactSecrets(visibleBody);
  assertPublicReviewOutputSafe(redactedBody);
  const walkthroughHash = hashWalkthrough(redactedBody);
  const stateMarker = buildWalkthroughStateMarker({
    repo: input.repo,
    pullNumber: input.pull.number,
    headSha: input.pull.head.sha,
    verdict: input.event,
    walkthroughHash
  });

  return {
    marker,
    body: [marker, stateMarker, redactedBody].join("\n"),
    postIssueComment: input.postIssueComment ?? false
  };
}

export function formatOutsideDiffFindings(
  findings: OutsideDiffFinding[],
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy,
  detail: "full" | "titles" | "paths" | "count" = "full",
  budget = 20_000
): { lines: string[]; listedCount: number } {
  if (!findings.length) return { lines: [], listedCount: 0 };
  const omitted = (count: number) => `${count} more findings are in the review evidence.`;
  const countLine = detail === "count"
    ? `Findings outside the diff view: ${findings.length} ${findings.length === 1 ? "finding" : "findings"}, highest ${highestSeverity(findings)}.`
    : omitted(findings.length);
  const lines = ["### Findings outside the diff view", ""];
  let size = lines.join("\n").length;
  if (detail === "count" || size + countLine.length + 2 > budget) {
    return { lines: countLine.length < budget ? [countLine, ""] : [], listedCount: 0 };
  }
  const publicText = (text: string) => redactSecrets(sanitizePublicConfidenceText(text, publicConfidencePolicy))
    .replace(HTML_COMMENT_PATTERN, "[hidden comment removed]").replaceAll("<!--", "&lt;!--");
  let listedCount = 0;
  for (const finding of findings) {
    const path = redactSecrets(finding.path).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    const coordinate = `<code>${path}:${finding.line}</code>`;
    const remaining = findings.length - listedCount - 1;
    const room = budget - size - (remaining ? omitted(remaining).length + 2 : 0) - 2;
    const body = detail === "full" ? publicText(finding.body) : "";
    const noteStart = finding.severityDemotedFrom ? body.lastIndexOf("\n\n_Severity lowered from ") : -1;
    const note = noteStart < 0 ? "" : body.slice(noteStart);
    const description = truncateReviewText(note ? body.slice(0, noteStart) : body, 1_500 - note.length);
    let entry = detail === "full" ? `${coordinate}\n\n${description}${note}` : coordinate;
    if (entry.length > room && detail === "full") detail = "titles";
    if (detail === "titles") entry = `${coordinate} ${publicText(finding.title).replace(/\s+/g, " ").trim()}`;
    if (entry.length > room) break;
    lines.push(entry, "");
    size += entry.length + 2;
    listedCount += 1;
  }
  if (listedCount < findings.length) lines.push(omitted(findings.length - listedCount), "");
  return { lines, listedCount };
}

export function truncateReviewText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const suffix = "\n\n… (truncated)";
  if (limit < suffix.length) return "";
  const entities: Record<string, string> = { "<": "&lt;", ">": "&gt;", "`": "&#96;", "~": "&#126;" };
  const ending = (fence: string) => fence ? `\n${fence}${suffix}` : suffix;
  let kept = "";
  let fence = "";
  const prefix = text.slice(0, limit).replace(/[\uD800-\uDBFF]$/, "");
  for (const [index, line] of prefix.split(/\r?\n/).entries()) {
    let nextFence = fence;
    const delimiter = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (delimiter) {
      const [, run, rest] = delimiter;
      if (!fence && (run.startsWith("~") || !rest.includes("`"))) nextFence = run;
      if (fence && run.startsWith(fence) && !rest.trim()) nextFence = "";
    }
    // Escape inline delimiters in clipped prose, but keep complete fence lines and their contents.
    const newline = index ? "\n" : "";
    const escaped = line.replace(fence || nextFence ? /[<>]/g : /[<>`~]/g, (char) => entities[char]);
    if (kept.length + newline.length + escaped.length + ending(nextFence).length <= limit) {
      kept += newline + escaped;
      fence = nextFence;
      continue;
    }
    let room = limit - kept.length - newline.length - ending(fence).length;
    if (room > 0) kept += newline;
    for (const char of line) {
      const safe = entities[char] ?? char;
      if (safe.length > room) break;
      kept += safe;
      room -= safe.length;
    }
    break;
  }
  return kept.trimEnd() + ending(fence);
}

function formatModelSummaryList(
  values: string[],
  fallback: string,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy
): string[] {
  if (values.length === 0) return [`- ${fallback}`];
  return values.map((value) => `- ${sanitizePublicConfidenceText(value, publicConfidencePolicy)}`);
}

function buildWalkthroughStateMarker(input: {
  repo: string;
  pullNumber: number;
  headSha: string;
  verdict: ReviewEvent;
  walkthroughHash: string;
}): string {
  validateWalkthroughIdentity(input);
  if (!/^[0-9a-f]{64}$/i.test(input.walkthroughHash)) {
    throw new Error(`Invalid walkthrough hash: ${input.walkthroughHash}`);
  }
  return `${WALKTHROUGH_STATE_MARKER_PREFIX} version=${WALKTHROUGH_SCHEMA_VERSION} repo=${input.repo} pr=${input.pullNumber} sha=${input.headSha} verdict=${input.verdict} hash=${input.walkthroughHash} -->`;
}

function validateWalkthroughIdentity(input: { repo: string; pullNumber: number; headSha: string }): void {
  validateWalkthroughRepoPull(input);
  if (!HEAD_SHA_PATTERN.test(input.headSha)) throw new Error(`Invalid walkthrough head SHA: ${input.headSha}`);
}

function validateWalkthroughRepoPull(input: { repo: string; pullNumber: number }): void {
  if (!REPO_SLUG_PATTERN.test(input.repo)) throw new Error(`Invalid walkthrough repo slug: ${input.repo}`);
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) {
    throw new Error(`Invalid walkthrough pull number: ${input.pullNumber}`);
  }
}

function hashWalkthrough(body: string): string {
  return createHash("sha256").update(body, "utf8").digest("hex");
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

function summarizeFile(file: PullFilePatch, comments: Pick<ReviewComment, "path" | "severity">[]): {
  filename: string;
  status: string;
  churn: string;
  purpose: string;
  risk: string;
} {
  const fileComments = comments.filter((comment) => comment.path === file.filename);
  const maxSeverity = highestSeverity(fileComments);
  const changes = file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0);
  return {
    filename: file.filename,
    status: file.status ?? "modified",
    churn: `+${file.additions ?? 0}/-${file.deletions ?? 0}`,
    purpose: inferPurpose(file.filename),
    risk: inferRisk(file.filename, changes, maxSeverity)
  };
}

function sanitizeReviewCommentPublicText(comment: ReviewComment, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): ReviewComment {
  return {
    ...comment,
    title: sanitizePublicConfidenceText(comment.title, publicConfidencePolicy),
    body: sanitizePublicConfidenceText(comment.body, publicConfidencePolicy)
  };
}

function inferPurpose(filename: string): string {
  const lower = filename.toLowerCase();
  if (lower.includes("/test") || lower.includes(".test.") || lower.includes(".spec.")) return "Test coverage";
  if (lower.startsWith("docs/") || lower.endsWith(".md")) return "Documentation";
  if (lower.startsWith("assets/") || lower.endsWith(".cs")) return "Unity/gameplay state";
  if (lower.includes("package.json") || lower.includes("package-lock") || lower.includes("config")) return "Configuration";
  if (lower.startsWith("src/")) return "Runtime code";
  return "Changed file";
}

function inferRisk(filename: string, changes: number, maxSeverity?: Severity): string {
  if (maxSeverity === "P0" || maxSeverity === "P1") return `Elevated: validated ${maxSeverity} finding`;
  if (maxSeverity === "P2" || maxSeverity === "P3") return `Moderate: validated ${maxSeverity} finding`;
  const lower = filename.toLowerCase();
  if (changes >= 200) return "Elevated: large change";
  if (lower.startsWith("assets/") || lower.startsWith("src/") || lower.endsWith(".cs")) return "Moderate: runtime path";
  return "Low";
}

function estimateReviewEffort(files: PullFilePatch[], comments: Pick<ReviewComment, "severity">[]): { score: number; minutes: number } {
  const totalChanges = files.reduce((sum, file) => sum + (file.changes ?? (file.additions ?? 0) + (file.deletions ?? 0)), 0);
  const highSeverity = comments.filter((comment) => comment.severity === "P0" || comment.severity === "P1").length;
  const rawScore = 1 + Math.floor(files.length / 4) + Math.floor(totalChanges / 250) + Math.min(highSeverity, 2);
  const score = Math.min(5, Math.max(1, rawScore));
  return { score, minutes: score * 10 + Math.min(20, files.length * 2) };
}

function extractRelatedRefs(text: string): string[] {
  const refs = new Set<string>();
  for (const match of text.matchAll(/#(\d+)/g)) refs.add(`#${match[1]}`);
  return [...refs].slice(0, 8);
}

function countSeverities(comments: ReviewComment[]): Record<Severity, number> {
  return Object.fromEntries(SEVERITY_LABELS.map((severity) => [
    severity,
    comments.filter((comment) => comment.severity === severity).length
  ])) as Record<Severity, number>;
}

function formatSeverityCounts(counts: Record<Severity, number>): string {
  return SEVERITY_LABELS.map((severity) => `${severity}: ${counts[severity]}`).join(", ");
}

function formatCategoryBreakdown(comments: Pick<ReviewComment, "category">[]): string {
  if (comments.length === 0) return "No finding categories.";
  const counts: Partial<Record<RegressionCategory, number>> = {};
  for (const comment of comments) counts[comment.category] = (counts[comment.category] ?? 0) + 1;
  return Object.entries(counts)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, count]) => `- ${categoryLabel(category as RegressionCategory)}: ${count}`)
    .join("\n");
}

function formatValidationSection(
  validation: ChangedSurfaceValidationReport | undefined,
  proof: ProofRequirementReport | undefined,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy
): string[] {
  if (!validation) return ["Validation selector did not run."];
  const lines = [sanitizePublicConfidenceText(validation.summary, publicConfidencePolicy)];
  for (const recommendation of validation.recommendations) {
    lines.push(
      `- ${recommendation.status}: ${sanitizePublicConfidenceText(recommendation.title, publicConfidencePolicy)} - ${sanitizePublicConfidenceText(recommendation.reason, publicConfidencePolicy)}` +
        (recommendation.proofTypes.length > 0 ? ` Proof: ${sanitizePublicConfidenceText(recommendation.proofTypes.join("; "), publicConfidencePolicy)}.` : "")
    );
  }
  if (proof) lines.push(`Proof status: ${proof.status} - ${sanitizePublicConfidenceText(proof.summary, publicConfidencePolicy)}`);
  return lines;
}

function proofChecklistPassed(
  validation: ChangedSurfaceValidationReport | undefined,
  proof: ProofRequirementReport | undefined
): boolean {
  if (!validation) return true;
  if (!proof) return false;
  return proof.status === "sufficient" || proof.status === "not_applicable";
}

function highestSeverity(comments: Pick<ReviewComment, "severity">[]): Severity | undefined {
  return SEVERITY_LABELS.find((severity) => comments.some((comment) => comment.severity === severity));
}

function commentsContainSecretLikeText(comments: ReviewComment[]): boolean {
  return comments.some((comment) => containsSecretLikeText(`${comment.title}\n${comment.body}`));
}

function checklistItem(ok: boolean, text: string): string {
  return `- [${ok ? "x" : " "}] ${text}`;
}
