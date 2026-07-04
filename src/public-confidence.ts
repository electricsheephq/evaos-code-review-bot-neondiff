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

export const PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS = 100;
export const PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS = 30;
export const PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS = 10;
export const PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND = 0.95;
const PUBLIC_CONFIDENCE_REPLACEMENT = "confidence not calibrated";
const MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH = 128_000;
const PUBLIC_CONFIDENCE_TRUNCATION_NOTICE = "\n\n[truncated before public confidence sanitization]";
const CONFIDENCE_VALUE_PATTERN = String.raw`(?:\d+(?:\.\d+)?\s*(?:%|percent\b)|(?:0?\.\d+|1\.0+)(?=\b|[-_]))`;
const CONFIDENCE_NOUN_PATTERN = String.raw`(?:confidence|certainty|reliability|sure(?:ness)?)`;
const CONFIDENCE_SEPARATOR_PATTERN = String.raw`(?:\s+|[-_]+)`;
const MARKDOWN_WRAPPER_PATTERN = "(?:[*_~`]+)?";
const MARKDOWN_VALUE_START_PATTERN = "(?:\\b|(?<=[*_~`]))";
const CONFIDENCE_LABEL_PATTERN = new RegExp(String.raw`\b((${CONFIDENCE_NOUN_PATTERN})\s*[:=]\s*)${CONFIDENCE_VALUE_PATTERN}(?=\s*(?:[.,;:!?)]|$))`, "gi");
const CONFIDENCE_LABEL_CONTINUATION_PATTERN = new RegExp(
  String.raw`\b(${CONFIDENCE_NOUN_PATTERN})\s*[:=]\s*${CONFIDENCE_VALUE_PATTERN}\s+(is|was|are|were|that)\b`,
  "gi"
);
const MARKDOWN_CONFIDENCE_LABEL_PATTERN = new RegExp(
  String.raw`\b${MARKDOWN_WRAPPER_PATTERN}(${CONFIDENCE_NOUN_PATTERN})${MARKDOWN_WRAPPER_PATTERN}\s*[:=]\s*${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?=\s*(?:[.,;:!?)]|$))`,
  "gi"
);
const MARKDOWN_CONFIDENCE_LABEL_CONTINUATION_PATTERN = new RegExp(
  String.raw`\b${MARKDOWN_WRAPPER_PATTERN}(${CONFIDENCE_NOUN_PATTERN})${MARKDOWN_WRAPPER_PATTERN}\s*[:=]\s*${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}\s+(is|was|are|were|that)\b`,
  "gi"
);
const CONFIDENCE_NOUN_VALUE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_NOUN_PATTERN}(?:${CONFIDENCE_SEPARATOR_PATTERN}score(?:\s*(?::|=)\s*|\s+of\s+|\s+(?:is|was|at)\s+|${CONFIDENCE_SEPARATOR_PATTERN})|\s+of\s+|\s+(?:is|was|at|in)\s+|${CONFIDENCE_SEPARATOR_PATTERN}|(?=\d))${CONFIDENCE_VALUE_PATTERN}`,
  "gi"
);
const VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_VALUE_PATTERN}(?:\s*|[-_]+)(?:confident|confidence(?:\s+in\b)?|reliable|reliability|sure)\b`,
  "gi"
);
const VALUE_IN_CONFIDENCE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_VALUE_PATTERN}\s+in\s+${CONFIDENCE_NOUN_PATTERN}\b`,
  "gi"
);
const CONCATENATED_VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`${MARKDOWN_VALUE_START_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?:0?\.\d+|1\.0+)${MARKDOWN_WRAPPER_PATTERN}(?:confident|confidence(?:\s+in\b)?|reliable|reliability|sure)${MARKDOWN_WRAPPER_PATTERN}\b`,
  "gi"
);
const MARKDOWN_VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`${MARKDOWN_VALUE_START_PATTERN}${MARKDOWN_WRAPPER_PATTERN}${CONFIDENCE_VALUE_PATTERN}${MARKDOWN_WRAPPER_PATTERN}(?:\s*|[-_]+)${MARKDOWN_WRAPPER_PATTERN}(?:confident|confidence(?:\s+in\b)?|reliable|reliability|sure)${MARKDOWN_WRAPPER_PATTERN}\b`,
  "gi"
);
const QUALIFIED_CONFIDENCE_DECIMAL_PATTERN = /\b(?:high|medium|low)\s+confidence\s*\(\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)/gi;

export function buildPublicConfidencePolicy(input?: Partial<PublicConfidenceDisplayPolicy>): PublicConfidenceDisplayPolicy {
  const evidenceUrl = input?.evidenceUrl?.trim();
  const datasetId = input?.datasetId?.trim();
  return {
    mode: input?.mode ?? "uncalibrated",
    minLabeledFindings: Math.max(input?.minLabeledFindings ?? PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS, PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS),
    minP0P1Labels: Math.max(input?.minP0P1Labels ?? PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS, PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS),
    minNegativeControlScenarios: Math.max(
      input?.minNegativeControlScenarios ?? PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS,
      PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS
    ),
    minWilsonLowerBound: Math.max(input?.minWilsonLowerBound ?? PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND, PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND),
    ...(evidenceUrl ? { evidenceUrl } : {}),
    ...(datasetId ? { datasetId } : {}),
    ...(input?.labeledFindings !== undefined ? { labeledFindings: input.labeledFindings } : {}),
    ...(input?.p0p1Labels !== undefined ? { p0p1Labels: input.p0p1Labels } : {}),
    ...(input?.negativeControlScenarios !== undefined ? { negativeControlScenarios: input.negativeControlScenarios } : {}),
    ...(input?.wilsonLowerBound !== undefined ? { wilsonLowerBound: input.wilsonLowerBound } : {})
  };
}

export function isPublicConfidenceDisplayAllowed(policy?: PublicConfidenceDisplayPolicy): boolean {
  if (!policy || policy.mode !== "calibrated") return false;
  if (!isUsablePublicConfidenceEvidenceUrl(policy.evidenceUrl) || !policy.datasetId?.trim()) return false;
  if (policy.labeledFindings === undefined || policy.labeledFindings < Math.max(policy.minLabeledFindings, PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS)) {
    return false;
  }
  if (policy.p0p1Labels === undefined || policy.p0p1Labels < Math.max(policy.minP0P1Labels, PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS)) return false;
  if (
    policy.negativeControlScenarios === undefined ||
    policy.negativeControlScenarios < Math.max(policy.minNegativeControlScenarios, PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS)
  ) {
    return false;
  }
  if (policy.wilsonLowerBound === undefined || policy.wilsonLowerBound < Math.max(policy.minWilsonLowerBound, PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND)) {
    return false;
  }
  return true;
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
  if (isPublicConfidenceDisplayAllowed(policy)) return value;
  const boundedValue = boundPublicConfidenceText(value);
  return boundedValue
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
}

function boundPublicConfidenceText(value: string): string {
  if (value.length <= MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH) return value;
  const truncated = value.slice(0, MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH);
  const boundaryWindowStart = Math.max(0, truncated.length - 128);
  const boundaryWindow = truncated.slice(boundaryWindowStart);
  const danglingConfidenceTokenStart = findDanglingConfidenceTokenStart(boundaryWindow);
  if (danglingConfidenceTokenStart !== -1) {
    return `${truncated.slice(0, boundaryWindowStart + danglingConfidenceTokenStart).trimEnd()}${PUBLIC_CONFIDENCE_TRUNCATION_NOTICE}`;
  }
  const lastTokenBoundary = Math.max(
    truncated.lastIndexOf(" "),
    truncated.lastIndexOf("\n"),
    truncated.lastIndexOf("\r"),
    truncated.lastIndexOf("\t")
  );
  const safeTruncated = lastTokenBoundary >= MAX_PUBLIC_CONFIDENCE_TEXT_LENGTH - 128
    ? truncated.slice(0, lastTokenBoundary).trimEnd()
    : truncated;
  return `${safeTruncated}${PUBLIC_CONFIDENCE_TRUNCATION_NOTICE}`;
}

function findDanglingConfidenceTokenStart(value: string): number {
  const confidenceFragment = /confidence|certainty|reliability|sure(?:ness)?|\d+(?:\.\d+)?\s*(?:%|percent\b)|(?:0?\.\d+|1\.0+)/gi;
  let lastMatchIndex = -1;
  for (const match of value.matchAll(confidenceFragment)) {
    lastMatchIndex = match.index;
  }
  return lastMatchIndex;
}

function formatConfidenceLabelContinuation(_noun: string, continuation: string): string {
  if (continuation.toLowerCase() === "that") return "confidence is not calibrated;";
  return `confidence is not calibrated; it ${continuation}`;
}
