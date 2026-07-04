import { createHash } from "node:crypto";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { categoryLabel, isRequestChangesEligible } from "./regression-taxonomy.js";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import type { ReviewSettingsPreview } from "./repo-policy.js";
import type {
  ChangedSurfaceValidationReport,
  DroppedFinding,
  ProofRequirementReport,
  PullFilePatch,
  PullRequestSummary,
  RegressionCategory,
  ReviewComment,
  ReviewEvent,
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

export function buildWalkthroughMarker(input: { repo: string; pullNumber: number }): string {
  validateWalkthroughRepoPull(input);
  return `${WALKTHROUGH_MARKER_PREFIX} repo=${input.repo} pr=${input.pullNumber} -->`;
}

export function buildWalkthroughComment(input: {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  comments: ReviewComment[];
  dropped: DroppedFinding[];
  event: ReviewEvent;
  validation?: ChangedSurfaceValidationReport;
  proof?: ProofRequirementReport;
  settingsPreview?: ReviewSettingsPreview;
  postIssueComment?: boolean;
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy;
}): WalkthroughComment {
  validateWalkthroughIdentity({ repo: input.repo, pullNumber: input.pull.number, headSha: input.pull.head.sha });
  const marker = buildWalkthroughMarker({ repo: input.repo, pullNumber: input.pull.number });
  const files = input.files.map((file) => summarizeFile(file, input.comments));
  const visibleFiles = files.slice(0, MAX_CHANGED_FILE_ROWS);
  const omittedFileCount = Math.max(0, files.length - visibleFiles.length);
  const effort = estimateReviewEffort(input.files, input.comments);
  const relatedRefs = extractRelatedRefs(`${input.pull.title}\n${input.pull.body ?? ""}`);
  const suggestedLabels = suggestLabels(input.files, input.comments);
  const suggestedReviewers = input.pull.requested_reviewers?.map((reviewer) => reviewer.login).filter(Boolean) ?? [];
  const severityCounts = countSeverities(input.comments);
  const highSeverity = severityCounts.P0 + severityCounts.P1;
  const requestChangesEligible = input.comments.filter(isRequestChangesEligible).length;
  const settingsPreviewSection = formatSettingsPreviewSection(input.settingsPreview, input.publicConfidencePolicy);

  const visibleBody = [
    "## Walkthrough",
    "",
    `PR: ${input.repo}#${input.pull.number} - ${formatInlinePublicText(input.pull.title, input.publicConfidencePolicy)}`,
    `Head: \`${input.pull.head.sha}\` into \`${input.pull.base.ref}\`. Review event: \`${input.event}\`.`,
    "",
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
    `Dropped findings before posting: ${input.dropped.length}. High-severity findings: ${highSeverity}.`,
    "",
    "### Risk Taxonomy",
    "",
    formatCategoryBreakdown(input.comments),
    "",
    "### Validation and Proof",
    "",
    ...formatValidationSection(input.validation, input.proof, input.publicConfidencePolicy),
    "",
    "### Related Context",
    "",
    `Related issues/PRs: ${relatedRefs.length > 0 ? relatedRefs.join(", ") : "none detected from PR metadata"}.`,
    `Suggested labels: ${suggestedLabels.length > 0 ? suggestedLabels.join(", ") : "none"}.`,
    `Suggested reviewers: ${suggestedReviewers.length > 0 ? suggestedReviewers.join(", ") : "none from current metadata"}.`,
    ...(settingsPreviewSection.length > 0 ? ["", ...settingsPreviewSection, ""] : [""]),
    "### Pre-merge checklist",
    "",
    checklistItem(input.comments.every((comment) => comment.side === "RIGHT"), "Inline comments target current RIGHT-side diff lines."),
    checklistItem(!commentsContainSecretLikeText(input.comments), "No secret-like content survived into posted inline comments."),
    checklistItem(
      input.event !== "REQUEST_CHANGES" || requestChangesEligible > 0,
      "REQUEST_CHANGES is only used when eligible P0/P1 findings survive validation."
    ),
    checklistItem(proofChecklistPassed(input.validation, input.proof), "Required behavior proof is present or not applicable."),
    checklistItem(true, "Labels and reviewers are suggestions only; the bot did not auto-apply them.")
  ].join("\n");
  const redactedBody = redactSecrets(visibleBody);
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

function formatSettingsPreviewSection(
  settings: ReviewSettingsPreview | undefined,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy
): string[] {
  if (!settings) return [];
  const enabledSections = settings.sections
    .filter((section) => section.enabled)
    .map((section) => `${formatInlinePublicText(section.label, publicConfidencePolicy)} (${section.mode})`);
  return [
    "### Review Settings Preview",
    "",
    `- Profile: ${settings.profile}`,
    `- Enabled sections: ${enabledSections.length > 0 ? enabledSections.join("; ") : "none"}`,
    ...formatSettingsPathInstructions(settings, publicConfidencePolicy),
    `- Label suggestions: ${settings.suggestions.labels.length > 0 ? settings.suggestions.labels.map((label) => formatInlinePublicText(label, publicConfidencePolicy)).join(", ") : "none"}`,
    `- Reviewer suggestions: ${settings.suggestions.reviewers.length > 0 ? settings.suggestions.reviewers.map((reviewer) => formatInlinePublicText(reviewer, publicConfidencePolicy)).join(", ") : "none"}`,
    `- Suggestion behavior: ${settings.suggestions.autoApply ? "auto-apply enabled" : "suggestions only; labels and reviewers are not auto-applied."}`,
    `- Roadmap-only settings: ${settings.roadmapOnly.length > 0 ? settings.roadmapOnly.map((setting) => formatInlinePublicText(setting, publicConfidencePolicy)).join("; ") : "none"}`
  ];
}

function formatSettingsPathInstructions(
  settings: ReviewSettingsPreview,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy
): string[] {
  if (settings.pathInstructions.length === 0) return ["- Path instructions: none"];
  return settings.pathInstructions.map((entry) =>
    `- Path instructions: \`${formatInlineCodePublicText(entry.pattern, publicConfidencePolicy)}\` - ${entry.instructions.map((instruction) => formatInlinePublicText(instruction, publicConfidencePolicy)).join("; ")}`
  );
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
  return sanitizePublicConfidenceText(
    redactSecrets((value ?? "").replace(HTML_COMMENT_PATTERN, "[hidden comment removed]")),
    publicConfidencePolicy
  )
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^#{1,6}\s+/, "")
    .slice(0, 200);
}

function formatInlineCodePublicText(value: string | undefined, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): string {
  return formatInlinePublicText(value, publicConfidencePolicy).replace(/`/g, "\\`");
}

function summarizeFile(file: PullFilePatch, comments: ReviewComment[]): {
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

function estimateReviewEffort(files: PullFilePatch[], comments: ReviewComment[]): { score: number; minutes: number } {
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

function suggestLabels(files: PullFilePatch[], comments: ReviewComment[]): string[] {
  const labels = new Set<string>();
  if (comments.some((comment) => comment.severity === "P0" || comment.severity === "P1")) labels.add("bug");
  if (files.some((file) => file.filename.toLowerCase().startsWith("assets/") || file.filename.endsWith(".cs"))) labels.add("unity");
  if (files.some((file) => file.filename.toLowerCase().startsWith("docs/") || file.filename.endsWith(".md"))) labels.add("docs");
  if (files.some((file) => file.filename.toLowerCase().includes("/test") || file.filename.includes(".test."))) labels.add("tests");
  return [...labels].slice(0, 6);
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

function formatCategoryBreakdown(comments: ReviewComment[]): string {
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
  if (validation.profileHints.validationHints.length > 0) {
    lines.push(`Profile validation hints: ${sanitizePublicConfidenceText(validation.profileHints.validationHints.join("; "), publicConfidencePolicy)}`);
  }
  if (validation.profileHints.proofExpectations.length > 0) {
    lines.push(`Profile proof expectations: ${sanitizePublicConfidenceText(validation.profileHints.proofExpectations.join("; "), publicConfidencePolicy)}`);
  }
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

function highestSeverity(comments: ReviewComment[]): Severity | undefined {
  return SEVERITY_LABELS.find((severity) => comments.some((comment) => comment.severity === severity));
}

function commentsContainSecretLikeText(comments: ReviewComment[]): boolean {
  return comments.some((comment) => containsSecretLikeText(`${comment.title}\n${comment.body}`));
}

function checklistItem(ok: boolean, text: string): string {
  return `- [${ok ? "x" : " "}] ${text}`;
}
