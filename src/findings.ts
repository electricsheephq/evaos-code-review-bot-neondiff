import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { categoryLabel, isRegressionCategory, isRequestChangesEligible, normalizeFindingCategory } from "./regression-taxonomy.js";
import { sanitizePublicConfidenceText, type PublicConfidenceDisplayPolicy } from "./public-confidence.js";
import type { DroppedFinding, Finding, ReviewComment, ReviewEvent, Severity } from "./types.js";

const SEVERITY_RANK: Record<Severity, number> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3
};

const SEVERITIES = new Set<Severity>(["P0", "P1", "P2", "P3"]);

export function parseFindings(value: unknown): { findings: Finding[]; dropped: DroppedFinding[] } {
  const rawFindings = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.findings)
      ? value.findings
      : [];
  const findings: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const raw of rawFindings) {
    if (!isRecord(raw)) {
      dropped.push({ reason: "invalid_schema" });
      continue;
    }

    const severity = raw.severity;
    const path = raw.path;
    const line = raw.line;
    const title = raw.title;
    const body = raw.body;
    const confidence = raw.confidence;
    const category = raw.category;

    if (
      !SEVERITIES.has(severity as Severity) ||
      typeof path !== "string" ||
      typeof line !== "number" ||
      !Number.isInteger(line) ||
      line <= 0 ||
      typeof title !== "string" ||
      title.trim().length === 0 ||
      typeof body !== "string" ||
      body.trim().length === 0 ||
      typeof confidence !== "number" ||
      confidence < 0 ||
      confidence > 1
    ) {
      dropped.push({ reason: "invalid_schema" });
      continue;
    }

    findings.push({
      severity: severity as Severity,
      path,
      line,
      title: title.trim(),
      body: body.trim(),
      confidence,
      ...(isRegressionCategory(category) ? { category } : {}),
      ...(typeof raw.why_this_matters === "string" && raw.why_this_matters.trim()
        ? { why_this_matters: raw.why_this_matters.trim() }
        : {})
    });
  }

  return { findings, dropped };
}

export function normalizeFindingsForReview(
  findings: Finding[],
  options: { maxInlineComments?: number; publicConfidencePolicy?: PublicConfidenceDisplayPolicy } = {}
): { comments: ReviewComment[]; dropped: DroppedFinding[] } {
  const maxInlineComments = options.maxInlineComments ?? 25;
  const accepted: Finding[] = [];
  const dropped: DroppedFinding[] = [];

  for (const finding of findings) {
    if (containsSecretLikeText(`${finding.title}\n${finding.body}\n${finding.why_this_matters ?? ""}`)) {
      dropped.push({ ...redactFinding(finding), reason: "secret_detected" });
      continue;
    }
    accepted.push(finding);
  }

  accepted.sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    const path = a.path.localeCompare(b.path);
    if (path !== 0) return path;
    return a.line - b.line || a.title.localeCompare(b.title);
  });

  const kept = accepted.slice(0, maxInlineComments);
  for (const finding of accepted.slice(maxInlineComments)) {
    dropped.push({ ...finding, reason: "comment_cap_exceeded" });
  }

  return {
    comments: kept.map((finding) => {
      const category = normalizeFindingCategory(finding);
      const publicTitle = sanitizePublicConfidenceText(finding.title, options.publicConfidencePolicy);
      const publicBody = sanitizePublicConfidenceText(finding.body, options.publicConfidencePolicy);
      const publicWhy = finding.why_this_matters
        ? sanitizePublicConfidenceText(finding.why_this_matters, options.publicConfidencePolicy)
        : undefined;
      return {
        path: finding.path,
        line: finding.line,
        side: "RIGHT",
        severity: finding.severity,
        category,
        title: publicTitle,
        body: formatReviewComment(
          { ...finding, category, title: publicTitle, body: publicBody, ...(publicWhy ? { why_this_matters: publicWhy } : {}) },
          options.publicConfidencePolicy,
          { textAlreadySanitized: true }
        )
      };
    }),
    dropped
  };
}

function redactFinding<T extends Finding>(finding: T): T {
  return {
    ...finding,
    title: redactSecrets(finding.title),
    body: redactSecrets(finding.body),
    ...(finding.why_this_matters ? { why_this_matters: redactSecrets(finding.why_this_matters) } : {})
  };
}

export function decideReviewEvent(findings: Pick<ReviewComment, "severity" | "category">[]): ReviewEvent {
  return findings.some((finding) => isRequestChangesEligible(finding)) ? "REQUEST_CHANGES" : "COMMENT";
}

export function formatReviewComment(
  finding: Finding,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy,
  options: { textAlreadySanitized?: boolean } = {}
): string {
  const title = options.textAlreadySanitized ? finding.title : sanitizePublicConfidenceText(finding.title, publicConfidencePolicy);
  const body = options.textAlreadySanitized ? finding.body : sanitizePublicConfidenceText(finding.body, publicConfidencePolicy);
  const category = finding.category ? `\n\nCategory: ${categoryLabel(finding.category)}` : "";
  const why = finding.why_this_matters
    ? `\n\nWhy this matters: ${options.textAlreadySanitized ? finding.why_this_matters : sanitizePublicConfidenceText(finding.why_this_matters, publicConfidencePolicy)}`
    : "";
  return `**${finding.severity}: ${title}**\n\n${body}${category}${why}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
