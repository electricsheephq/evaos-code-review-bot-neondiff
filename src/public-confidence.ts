export interface PublicConfidenceDisplayPolicy {
  mode: "uncalibrated" | "calibrated";
  evidenceUrl?: string;
  datasetId?: string;
  minLabeledFindings: number;
  labeledFindings?: number;
  minP0P1Labels: number;
  p0p1Labels?: number;
  minNegativeControlScenarios: number;
  negativeControlScenarios?: number;
  minWilsonLowerBound: number;
  wilsonLowerBound?: number;
}

export type PublicConfidenceMode = "uncalibrated" | "calibrated";

export type PublicConfidenceMissingThreshold =
  | "mode_not_calibrated"
  | "calibration_evidence_url_missing_or_unusable"
  | "dataset_id_missing"
  | "labeled_findings_below_100"
  | "p0_p1_labels_below_30"
  | "negative_controls_below_10"
  | "wilson_lower_bound_below_0.95";

export interface PublicConfidenceMetric {
  actual?: number;
  required: number;
  passed: boolean;
}

export interface PublicConfidencePolicyEvaluation {
  allowed: boolean;
  publicMode: PublicConfidenceMode;
  missingThresholds: PublicConfidenceMissingThreshold[];
  metrics: {
    labeledFindings: PublicConfidenceMetric;
    p0p1Labels: PublicConfidenceMetric;
    negativeControlScenarios: PublicConfidenceMetric;
    wilsonLowerBound: PublicConfidenceMetric;
  };
  proofBoundary: string;
}

export interface PublicConfidenceCalibrationReport extends PublicConfidencePolicyEvaluation {
  dataset: {
    id?: string;
    evidenceUrl?: string;
  };
  labels: {
    labeledFindings?: number;
    p0p1Labels?: number;
    negativeControlScenarios?: number;
  };
  requestChangesPolicy: string;
}

export const PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS = 100;
export const PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS = 30;
export const PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS = 10;
export const PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND = 0.95;
const PUBLIC_CONFIDENCE_REPLACEMENT = "[confidence not calibrated]";
const MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH = 128_000;
const PUBLIC_CONFIDENCE_BOUNDARY_SCAN_LENGTH = 4_096;
const DANGLING_CONFIDENCE_FRAGMENT_MAX_TRAILING_CHARS = 64;
const DANGLING_CONFIDENCE_VALUE_CONTEXT_CHARS = 256;
const PUBLIC_CONFIDENCE_TRUNCATION_NOTICE = "\n\n[truncated before public confidence sanitization]";
const HORIZONTAL_WHITESPACE_PATTERN = String.raw`[^\S\r\n]`;
const CONFIDENCE_VALUE_PATTERN = String.raw`(?:\d+(?:\.\d+)?${HORIZONTAL_WHITESPACE_PATTERN}*(?:%|percent\b)|(?:0?\.\d+|1\.0+)(?=\b|[-_]))`;
const CONFIDENCE_NOUN_PATTERN = String.raw`(?:confidence|certainty|reliability|sure(?:ness)?)`;
const CONFIDENCE_SEPARATOR_PATTERN = String.raw`(?:${HORIZONTAL_WHITESPACE_PATTERN}+|[-_]+)`;
const MARKDOWN_WRAPPER_PATTERN = "(?:[*_~`]+)?";
const MARKDOWN_VALUE_START_PATTERN = "(?:\\b|(?<=[*_~`]))";
const CONFIDENCE_LABEL_PATTERN = new RegExp(
  String.raw`\b((${CONFIDENCE_NOUN_PATTERN})${HORIZONTAL_WHITESPACE_PATTERN}*[:=]${HORIZONTAL_WHITESPACE_PATTERN}*)${CONFIDENCE_VALUE_PATTERN}(?=${HORIZONTAL_WHITESPACE_PATTERN}*(?:[.,;:!?)]|$|\r?\n))`,
  "gi"
);
const CONFIDENCE_LABEL_CONTINUATION_PATTERN = new RegExp(
  String.raw`\b(${CONFIDENCE_NOUN_PATTERN})${HORIZONTAL_WHITESPACE_PATTERN}*[:=]${HORIZONTAL_WHITESPACE_PATTERN}*${CONFIDENCE_VALUE_PATTERN}${HORIZONTAL_WHITESPACE_PATTERN}+(is|was|are|were|that)\b`,
  "gi"
);
const MARKDOWN_CONFIDENCE_LABEL_PATTERN = new RegExp(
  String.raw`\b${MARKDOWN_WRAPPER_PATTERN}(${CONFIDENCE_NOUN_PATTERN})${MARKDOWN_WRAPPER_PATTERN}${HORIZONTAL_WHITESPACE_PATTERN}*[:=]${HORIZONTAL_WHITESPACE_PATTERN}*${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?=${HORIZONTAL_WHITESPACE_PATTERN}*(?:[.,;:!?)]|$|\r?\n))`,
  "gi"
);
const MARKDOWN_CONFIDENCE_LABEL_CONTINUATION_PATTERN = new RegExp(
  String.raw`\b${MARKDOWN_WRAPPER_PATTERN}(${CONFIDENCE_NOUN_PATTERN})${MARKDOWN_WRAPPER_PATTERN}${HORIZONTAL_WHITESPACE_PATTERN}*[:=]${HORIZONTAL_WHITESPACE_PATTERN}*${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}${HORIZONTAL_WHITESPACE_PATTERN}+(is|was|are|were|that)\b`,
  "gi"
);
const CONFIDENCE_NOUN_VALUE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_NOUN_PATTERN}(?:${CONFIDENCE_SEPARATOR_PATTERN}score(?:${HORIZONTAL_WHITESPACE_PATTERN}*(?::|=)${HORIZONTAL_WHITESPACE_PATTERN}*|${HORIZONTAL_WHITESPACE_PATTERN}+of${HORIZONTAL_WHITESPACE_PATTERN}+|${HORIZONTAL_WHITESPACE_PATTERN}+(?:is|was|at)${HORIZONTAL_WHITESPACE_PATTERN}+|${CONFIDENCE_SEPARATOR_PATTERN})|${HORIZONTAL_WHITESPACE_PATTERN}+of${HORIZONTAL_WHITESPACE_PATTERN}+|${HORIZONTAL_WHITESPACE_PATTERN}+(?:is|was|at|in)${HORIZONTAL_WHITESPACE_PATTERN}+|${CONFIDENCE_SEPARATOR_PATTERN}|(?=\d))${CONFIDENCE_VALUE_PATTERN}`,
  "gi"
);
const VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_VALUE_PATTERN}(?:${HORIZONTAL_WHITESPACE_PATTERN}*|[-_]+)(?:confident|confidence(?:${HORIZONTAL_WHITESPACE_PATTERN}+in\b)?|reliable|reliability|sure)\b`,
  "gi"
);
const VALUE_IN_CONFIDENCE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_VALUE_PATTERN}${HORIZONTAL_WHITESPACE_PATTERN}+in${HORIZONTAL_WHITESPACE_PATTERN}+${CONFIDENCE_NOUN_PATTERN}\b`,
  "gi"
);
const CONCATENATED_VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`${MARKDOWN_VALUE_START_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?:0?\.\d+|1\.0+)${MARKDOWN_WRAPPER_PATTERN}(?:confident|confidence(?:\s+in\b)?|reliable|reliability|sure)${MARKDOWN_WRAPPER_PATTERN}\b`,
  "gi"
);
const MARKDOWN_VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`${MARKDOWN_VALUE_START_PATTERN}${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?:${HORIZONTAL_WHITESPACE_PATTERN}*|[-_]+)${MARKDOWN_WRAPPER_PATTERN}(?:confident|confidence(?:${HORIZONTAL_WHITESPACE_PATTERN}+in\b)?|reliable|reliability|sure)${MARKDOWN_WRAPPER_PATTERN}\b`,
  "gi"
);
const QUALIFIED_CONFIDENCE_DECIMAL_PATTERN = new RegExp(
  String.raw`\b(?:high|medium|low)${HORIZONTAL_WHITESPACE_PATTERN}+confidence${HORIZONTAL_WHITESPACE_PATTERN}*\(${HORIZONTAL_WHITESPACE_PATTERN}*(?:0?\.\d+|1(?:\.0+)?)${HORIZONTAL_WHITESPACE_PATTERN}*\)`,
  "gi"
);
const RESIDUAL_CONFIDENCE_VALUE_PATTERN = new RegExp(CONFIDENCE_VALUE_PATTERN, "gi");
const CONFIDENCE_SANITIZER_CONTEXT_PREFILTER = /confidence|certainty|reliability|sure|confident|reliable/i;
const CONFIDENCE_SANITIZER_VALUE_PREFILTER = /\d/;
const RESIDUAL_CONFIDENCE_CONTEXT_PATTERN = /confidence|certainty|reliability/i;
// Keep this carve-out deliberately narrow: until calibrated evidence is present,
// review-confidence redaction wins over ambiguous statistical phrasing.
const PRESERVED_TECHNICAL_CONFIDENCE_CONTEXT_PATTERN = /\bconfidence\s+(?:interval|threshold|calibration)\b|\b(?:precision|recall|accuracy|coverage|pass rate|success rate|uptime)\b/i;
const RESIDUAL_CONFIDENCE_CONTEXT_WINDOW = 80;

export function buildPublicConfidencePolicy(input?: Partial<PublicConfidenceDisplayPolicy>): PublicConfidenceDisplayPolicy {
  const evidenceUrl = input?.evidenceUrl?.trim();
  const datasetId = input?.datasetId?.trim();
  return {
    mode: input?.mode ?? "uncalibrated",
    minLabeledFindings: hardFloorPositiveInteger(input?.minLabeledFindings, PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS),
    minP0P1Labels: hardFloorPositiveInteger(input?.minP0P1Labels, PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS),
    minNegativeControlScenarios: hardFloorPositiveInteger(
      input?.minNegativeControlScenarios,
      PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS
    ),
    minWilsonLowerBound: hardFloorProbability(input?.minWilsonLowerBound, PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(input?.labeledFindings !== undefined ? { labeledFindings: input.labeledFindings } : {}),
    ...(input?.p0p1Labels !== undefined ? { p0p1Labels: input.p0p1Labels } : {}),
    ...(input?.negativeControlScenarios !== undefined ? { negativeControlScenarios: input.negativeControlScenarios } : {}),
    ...(input?.wilsonLowerBound !== undefined ? { wilsonLowerBound: input.wilsonLowerBound } : {})
  };
}

export function isPublicConfidenceDisplayAllowed(policy?: PublicConfidenceDisplayPolicy): boolean {
  return evaluatePublicConfidencePolicy(policy).allowed;
}

export function evaluatePublicConfidencePolicy(policy?: PublicConfidenceDisplayPolicy): PublicConfidencePolicyEvaluation {
  const malformedMinimums = findMalformedPolicyMinimums(policy);
  const effectivePolicy = buildPublicConfidencePolicy(policy);
  const requiredLabeledFindings = hardFloorPositiveInteger(effectivePolicy.minLabeledFindings, PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS);
  const requiredP0P1Labels = hardFloorPositiveInteger(effectivePolicy.minP0P1Labels, PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS);
  const requiredNegativeControls = hardFloorPositiveInteger(effectivePolicy.minNegativeControlScenarios, PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS);
  const requiredWilsonLowerBound = hardFloorProbability(effectivePolicy.minWilsonLowerBound, PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND);
  const metrics = {
    labeledFindings: thresholdMetric(effectivePolicy.labeledFindings, requiredLabeledFindings, isNonNegativeInteger, malformedMinimums.labeledFindings),
    p0p1Labels: thresholdMetric(effectivePolicy.p0p1Labels, requiredP0P1Labels, isNonNegativeInteger, malformedMinimums.p0p1Labels),
    negativeControlScenarios: thresholdMetric(
      effectivePolicy.negativeControlScenarios,
      requiredNegativeControls,
      isNonNegativeInteger,
      malformedMinimums.negativeControlScenarios
    ),
    wilsonLowerBound: thresholdMetric(effectivePolicy.wilsonLowerBound, requiredWilsonLowerBound, isProbability, malformedMinimums.wilsonLowerBound)
  };
  const missingThresholds: PublicConfidenceMissingThreshold[] = [];

  if (effectivePolicy.mode !== "calibrated") missingThresholds.push("mode_not_calibrated");
  if (!isUsablePublicConfidenceEvidenceUrl(effectivePolicy.evidenceUrl)) {
    missingThresholds.push("calibration_evidence_url_missing_or_unusable");
  }
  if (!effectivePolicy.datasetId?.trim()) missingThresholds.push("dataset_id_missing");
  if (!metrics.labeledFindings.passed) missingThresholds.push("labeled_findings_below_100");
  if (!metrics.p0p1Labels.passed) missingThresholds.push("p0_p1_labels_below_30");
  if (!metrics.negativeControlScenarios.passed) missingThresholds.push("negative_controls_below_10");
  if (!metrics.wilsonLowerBound.passed) missingThresholds.push("wilson_lower_bound_below_0.95");

  const allowed = missingThresholds.length === 0;
  return {
    allowed,
    publicMode: allowed ? "calibrated" : "uncalibrated",
    missingThresholds,
    metrics,
    proofBoundary: allowed
      ? "Public comments may display confidence percentages only while this report stays linked to the evaluated dataset and passing metrics."
      : "Public comments must not display confidence percentages until all calibration thresholds pass."
  };
}

export function buildPublicConfidenceCalibrationReport(policy?: PublicConfidenceDisplayPolicy): PublicConfidenceCalibrationReport {
  const effectivePolicy = buildPublicConfidencePolicy(policy);
  const evaluation = evaluatePublicConfidencePolicy(policy);
  return {
    ...evaluation,
    dataset: {
      ...(effectivePolicy.datasetId ? { id: effectivePolicy.datasetId } : {}),
      ...(effectivePolicy.evidenceUrl ? { evidenceUrl: effectivePolicy.evidenceUrl } : {})
    },
    labels: {
      ...(effectivePolicy.labeledFindings !== undefined ? { labeledFindings: effectivePolicy.labeledFindings } : {}),
      ...(effectivePolicy.p0p1Labels !== undefined ? { p0p1Labels: effectivePolicy.p0p1Labels } : {}),
      ...(effectivePolicy.negativeControlScenarios !== undefined
        ? { negativeControlScenarios: effectivePolicy.negativeControlScenarios }
        : {})
    },
    requestChangesPolicy: "REQUEST_CHANGES confidence claims require calibrated P0/P1 bins that pass the public display policy."
  };
}

function thresholdMetric(
  actual: number | undefined,
  required: number,
  isValidActual: (value: unknown) => value is number,
  forceFail = false
): PublicConfidenceMetric {
  if (!isValidActual(actual)) {
    return { required, passed: false };
  }
  return { actual, required, passed: !forceFail && actual >= required };
}

function hardFloorPositiveInteger(value: unknown, floor: number): number {
  return isPositiveInteger(value) ? Math.max(value, floor) : floor;
}

function hardFloorProbability(value: unknown, floor: number): number {
  return isProbability(value) ? Math.max(value, floor) : floor;
}

function findMalformedPolicyMinimums(policy: PublicConfidenceDisplayPolicy | undefined): {
  labeledFindings: boolean;
  p0p1Labels: boolean;
  negativeControlScenarios: boolean;
  wilsonLowerBound: boolean;
} {
  return {
    labeledFindings: policy?.minLabeledFindings !== undefined && !isPositiveInteger(policy.minLabeledFindings),
    p0p1Labels: policy?.minP0P1Labels !== undefined && !isPositiveInteger(policy.minP0P1Labels),
    negativeControlScenarios:
      policy?.minNegativeControlScenarios !== undefined && !isPositiveInteger(policy.minNegativeControlScenarios),
    wilsonLowerBound: policy?.minWilsonLowerBound !== undefined && !isProbability(policy.minWilsonLowerBound)
  };
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isProbability(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

export function isUsablePublicConfidenceEvidenceUrl(value: string | undefined): boolean {
  if (!value?.trim()) return false;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" && url.hostname.length > 0;
  } catch {
    return false;
  }
}

export function sanitizePublicConfidenceText(value: string, policy?: PublicConfidenceDisplayPolicy): string {
  const boundedValue = boundPublicConfidenceText(value);
  if (isPublicConfidenceDisplayAllowed(policy)) return boundedValue;
  if (!CONFIDENCE_SANITIZER_CONTEXT_PREFILTER.test(boundedValue) || !CONFIDENCE_SANITIZER_VALUE_PREFILTER.test(boundedValue)) {
    return boundedValue;
  }
  const sanitized = boundedValue
    .replace(QUALIFIED_CONFIDENCE_DECIMAL_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(CONFIDENCE_LABEL_CONTINUATION_PATTERN, (_match, noun: string, continuation: string) => formatConfidenceLabelContinuation(noun, continuation))
    .replace(MARKDOWN_CONFIDENCE_LABEL_CONTINUATION_PATTERN, (_match, noun: string, continuation: string) => formatConfidenceLabelContinuation(noun, continuation))
    .replace(MARKDOWN_CONFIDENCE_LABEL_PATTERN, (_match, noun: string) => `${noun}: ${PUBLIC_CONFIDENCE_REPLACEMENT}`)
    .replace(VALUE_IN_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(CONCATENATED_VALUE_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(MARKDOWN_VALUE_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(CONFIDENCE_LABEL_PATTERN, (_match, prefix: string) => `${prefix}${PUBLIC_CONFIDENCE_REPLACEMENT}`)
    .replace(CONFIDENCE_NOUN_VALUE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(VALUE_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT);
  return redactResidualPublicConfidenceValues(sanitized);
}

function redactResidualPublicConfidenceValues(value: string): string {
  let output = "";
  let cursor = 0;
  for (const match of value.matchAll(RESIDUAL_CONFIDENCE_VALUE_PATTERN)) {
    const token = match[0];
    const offset = match.index;
    if (offset === undefined) continue;
    const lineStart = value.lastIndexOf("\n", offset - 1) + 1;
    const nextLineBreak = value.indexOf("\n", offset + token.length);
    const lineEnd = nextLineBreak === -1 ? value.length : nextLineBreak;
    const context = value.slice(
      Math.max(lineStart, offset - RESIDUAL_CONFIDENCE_CONTEXT_WINDOW),
      Math.min(lineEnd, offset + token.length + RESIDUAL_CONFIDENCE_CONTEXT_WINDOW)
    );
    const replacement =
      !isVersionLikeDecimalFragment(value, offset, token) &&
      RESIDUAL_CONFIDENCE_CONTEXT_PATTERN.test(context) &&
      !PRESERVED_TECHNICAL_CONFIDENCE_CONTEXT_PATTERN.test(context)
        ? PUBLIC_CONFIDENCE_REPLACEMENT
        : token;
    output += value.slice(cursor, offset) + replacement;
    cursor = offset + token.length;
  }
  return `${output}${value.slice(cursor)}`;
}

function isVersionLikeDecimalFragment(value: string, offset: number, token: string): boolean {
  if (!token.includes(".")) return false;
  const previous = value[offset - 1];
  const previousPrevious = value[offset - 2];
  const next = value[offset + token.length];
  const nextNext = value[offset + token.length + 1];
  return (
    (token.startsWith(".") && /\d/.test(previous ?? "")) ||
    (previous === "." && /\d/.test(previousPrevious ?? "")) ||
    (next === "." && /\d/.test(nextNext ?? ""))
  );
}

function boundPublicConfidenceText(value: string): string {
  if (value.length <= MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH) return value;
  const truncated = value.slice(0, MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH);
  const boundaryWindowStart = Math.max(0, truncated.length - PUBLIC_CONFIDENCE_BOUNDARY_SCAN_LENGTH);
  const boundaryWindow = truncated.slice(boundaryWindowStart);
  const danglingConfidenceTokenStart = findDanglingConfidenceTokenStart(boundaryWindow);
  if (danglingConfidenceTokenStart !== -1) {
    return `${truncated.slice(0, boundaryWindowStart + danglingConfidenceTokenStart).trimEnd()}${PUBLIC_CONFIDENCE_TRUNCATION_NOTICE}`;
  }
  const lastTokenBoundaryInWindow = Math.max(
    boundaryWindow.lastIndexOf(" "),
    boundaryWindow.lastIndexOf("\n"),
    boundaryWindow.lastIndexOf("\r"),
    boundaryWindow.lastIndexOf("\t")
  );
  const safeTruncated =
    lastTokenBoundaryInWindow === -1 ? truncated : truncated.slice(0, boundaryWindowStart + lastTokenBoundaryInWindow).trimEnd();
  return `${safeTruncated}${PUBLIC_CONFIDENCE_TRUNCATION_NOTICE}`;
}

function findDanglingConfidenceTokenStart(value: string): number {
  const confidenceFragment = /confidence|certainty|reliability|sure(?:ness)?|\d+(?:\.\d+)?\s*(?:%|percent\b)|(?:0?\.\d+|1\.0+)/gi;
  let lastConfidenceWordIndex = -1;
  let lastMatchIndex = -1;
  for (const match of value.matchAll(confidenceFragment)) {
    const token = match[0];
    const isConfidenceWord = /^(?:confidence|certainty|reliability|sure)/i.test(token);
    if (isConfidenceWord) lastConfidenceWordIndex = match.index;
    const matchEnd = match.index + match[0].length;
    const trailingChars = value.length - matchEnd;
    if (isConfidenceWord && trailingChars <= DANGLING_CONFIDENCE_VALUE_CONTEXT_CHARS) {
      lastMatchIndex = match.index;
    } else if (trailingChars <= DANGLING_CONFIDENCE_FRAGMENT_MAX_TRAILING_CHARS) {
      const shouldIncludeConfidenceWord =
        !isConfidenceWord &&
        lastConfidenceWordIndex !== -1 &&
        match.index - lastConfidenceWordIndex <= DANGLING_CONFIDENCE_VALUE_CONTEXT_CHARS;
      lastMatchIndex = shouldIncludeConfidenceWord ? lastConfidenceWordIndex : match.index;
    }
  }
  return lastMatchIndex;
}

function formatConfidenceLabelContinuation(_noun: string, continuation: string): string {
  if (continuation.toLowerCase() === "that") return `${PUBLIC_CONFIDENCE_REPLACEMENT};`;
  return `${PUBLIC_CONFIDENCE_REPLACEMENT}; it ${continuation}`;
}
