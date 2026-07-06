import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import { categoryLabel, isRegressionCategory, isRequestChangesEligible, normalizeFindingCategory, type CategoryPrecisionFloors, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
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
      dropped.push({ ...sanitizeDroppedFindingPublicText(redactFinding(finding), options.publicConfidencePolicy), reason: "secret_detected" });
      continue;
    }
    accepted.push(finding);
  }

  accepted.sort((a, b) => {
    const severity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (severity !== 0) return severity;
    // Within a severity tier, higher-confidence findings rank first so the cap keeps them.
    const confidence = b.confidence - a.confidence;
    if (confidence !== 0) return confidence;
    const path = a.path.localeCompare(b.path);
    if (path !== 0) return path;
    return a.line - b.line || a.title.localeCompare(b.title);
  });

  // Same-run near-duplicate suppression (#281): collapse clusters where one model response flags
  // the same root cause twice (adjacent lines / reworded title). Runs on the confidence-ranked
  // order so the KEPT cluster member is the highest-ranked (post-#287, highest-confidence) one, and
  // runs BEFORE the cap so a suppressed duplicate frees a slot for a distinct finding.
  const deduped = suppressSameRunNearDuplicates(accepted);
  for (const finding of deduped.dropped) {
    dropped.push({ ...sanitizeDroppedFindingPublicText(finding, options.publicConfidencePolicy), reason: "same_run_near_duplicate" });
  }

  const kept = deduped.kept.slice(0, maxInlineComments);
  for (const finding of deduped.kept.slice(maxInlineComments)) {
    dropped.push({ ...sanitizeDroppedFindingPublicText(finding, options.publicConfidencePolicy), reason: "comment_cap_exceeded" });
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
        // Internal gating/evidence metadata; never rendered into the public body/title.
        confidence: finding.confidence,
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

export const SAME_RUN_DEDUP_MAX_LINE_DELTA = 3;
export const SAME_RUN_DEDUP_MIN_PREFIX_LENGTH = 12;

/**
 * Suppress same-run near-duplicate findings (#281): within one review response, collapse a cluster
 * of findings that flag the same root cause. Two findings are near-duplicates when they share the
 * same path AND the same normalized category (normalizeFindingCategory) AND their line numbers are
 * within {@link SAME_RUN_DEDUP_MAX_LINE_DELTA} AND their normalized titles are exact-or-prefix
 * similar. Conservative by design (no fuzzy edit-distance): a missed duplicate is cheaper than a
 * suppressed distinct finding. The input order is authoritative — the FIRST member of a cluster is
 * kept and later members are dropped, so callers should pass findings pre-sorted by rank.
 */
export function suppressSameRunNearDuplicates(findings: Finding[]): { kept: Finding[]; dropped: Finding[] } {
  const kept: Array<{ finding: Finding; category: string; normalizedTitle: string }> = [];
  const dropped: Finding[] = [];

  for (const finding of findings) {
    const category = normalizeFindingCategory(finding);
    const normalizedTitle = normalizeTitleForDedup(finding.title);
    const isDuplicate = kept.some(
      (entry) =>
        entry.finding.path === finding.path &&
        entry.category === category &&
        Math.abs(entry.finding.line - finding.line) <= SAME_RUN_DEDUP_MAX_LINE_DELTA &&
        titlesAreNearDuplicate(entry.normalizedTitle, normalizedTitle)
    );
    if (isDuplicate) {
      dropped.push(finding);
      continue;
    }
    kept.push({ finding, category, normalizedTitle });
  }

  return { kept: kept.map((entry) => entry.finding), dropped };
}

export function normalizeTitleForDedup(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function titlesAreNearDuplicate(a: string, b: string): boolean {
  if (a === b) return a.length > 0;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  // Prefix match must span a meaningful anchor so short generic titles don't collapse distinct
  // findings; require the shared prefix (the shorter title) to be at least the min length.
  return shorter.length >= SAME_RUN_DEDUP_MIN_PREFIX_LENGTH && longer.startsWith(shorter);
}

function redactFinding<T extends Finding>(finding: T): T {
  return {
    ...finding,
    title: redactSecrets(finding.title),
    body: redactSecrets(finding.body),
    ...(finding.why_this_matters ? { why_this_matters: redactSecrets(finding.why_this_matters) } : {})
  };
}

function sanitizeDroppedFindingPublicText<T extends Partial<Finding>>(finding: T, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): T {
  return {
    ...finding,
    ...(typeof finding.title === "string" ? { title: sanitizePublicConfidenceText(finding.title, publicConfidencePolicy) } : {}),
    ...(typeof finding.body === "string" ? { body: sanitizePublicConfidenceText(finding.body, publicConfidencePolicy) } : {}),
    ...(typeof finding.why_this_matters === "string"
      ? { why_this_matters: sanitizePublicConfidenceText(finding.why_this_matters, publicConfidencePolicy) }
      : {})
  };
}

/**
 * Full public-safe sanitization for a dropped finding (#283): redact secret-like text AND strip
 * uncalibrated confidence numbers from title/body/why_this_matters. This is the same treatment the
 * secret-drop path applies inline and that worker.ts re-applies as a second pass; both redactSecrets
 * and sanitizePublicConfidenceText are idempotent, so callers may re-run it without changing output.
 * Exported so the review-gate module boundary can enforce redaction on drops it produces BEFORE any
 * caller sees them, rather than relying on the caller to sanitize.
 */
export function sanitizeDroppedFinding<T extends Partial<Finding>>(finding: T, publicConfidencePolicy?: PublicConfidenceDisplayPolicy): T {
  return {
    ...finding,
    ...(typeof finding.title === "string"
      ? { title: sanitizePublicConfidenceText(redactSecrets(finding.title), publicConfidencePolicy) }
      : {}),
    ...(typeof finding.body === "string"
      ? { body: sanitizePublicConfidenceText(redactSecrets(finding.body), publicConfidencePolicy) }
      : {}),
    ...(typeof finding.why_this_matters === "string"
      ? { why_this_matters: sanitizePublicConfidenceText(redactSecrets(finding.why_this_matters), publicConfidencePolicy) }
      : {})
  };
}

export function decideReviewEvent(
  findings: Pick<ReviewComment, "severity" | "category" | "confidence">[],
  confidenceFloors?: RequestChangesConfidenceFloors,
  categoryPrecisionFloors?: CategoryPrecisionFloors
): ReviewEvent {
  return findings.some((finding) => isRequestChangesEligible(finding, confidenceFloors, categoryPrecisionFloors))
    ? "REQUEST_CHANGES"
    : "COMMENT";
}

export function formatReviewComment(
  finding: Finding,
  publicConfidencePolicy?: PublicConfidenceDisplayPolicy,
  options: { textAlreadySanitized?: boolean } = {}
): string {
  // textAlreadySanitized means title, body, and why_this_matters have all crossed the same public-text boundary.
  const severity = SEVERITIES.has(finding.severity as Severity) ? finding.severity : "P3";
  const title = options.textAlreadySanitized ? finding.title : sanitizePublicConfidenceText(finding.title, publicConfidencePolicy);
  const body = options.textAlreadySanitized ? finding.body : sanitizePublicConfidenceText(finding.body, publicConfidencePolicy);
  const category = finding.category ? `\n\nCategory: ${categoryLabel(finding.category)}` : "";
  const why = finding.why_this_matters
    ? `\n\nWhy this matters: ${options.textAlreadySanitized ? finding.why_this_matters : sanitizePublicConfidenceText(finding.why_this_matters, publicConfidencePolicy)}`
    : "";
  return `**${severity}: ${title}**\n\n${body}${category}${why}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
