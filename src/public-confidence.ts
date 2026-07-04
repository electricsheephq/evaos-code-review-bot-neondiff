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

const DEFAULT_MIN_LABELED_FINDINGS = 100;
const DEFAULT_MIN_P0_P1_LABELS = 30;
const DEFAULT_MIN_NEGATIVE_CONTROL_SCENARIOS = 10;
const DEFAULT_MIN_WILSON_LOWER_BOUND = 0.95;
const PUBLIC_CONFIDENCE_REPLACEMENT = "confidence not calibrated";
const CONFIDENCE_VALUE_PATTERN = String.raw`(?:\d+(?:\.\d+)?\s*(?:%|percent\b)|(?:0?\.\d+|1(?:\.0+)?)\b)`;
const CONFIDENCE_NOUN_PATTERN = String.raw`(?:confidence|certainty|reliability|accuracy|likelihood|sure(?:ness)?)`;
const CONFIDENCE_LABEL_PATTERN = new RegExp(String.raw`\b((${CONFIDENCE_NOUN_PATTERN})\s*[:=]\s*)${CONFIDENCE_VALUE_PATTERN}`, "gi");
const CONFIDENCE_NOUN_VALUE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_NOUN_PATTERN}(?:\s+score(?:\s*(?::|=)\s*|\s+of\s+|\s+(?:is|was|at)\s+|\s+)|\s+of\s+|\s+(?:is|was|at|in)\s+|\s+)${CONFIDENCE_VALUE_PATTERN}`,
  "gi"
);
const VALUE_CONFIDENCE_PATTERN = new RegExp(
  String.raw`\b${CONFIDENCE_VALUE_PATTERN}\s*(?:confident|confidence(?:\s+in\b)?|reliable|reliability|accurate|accuracy|likely|likelihood|sure)\b`,
  "gi"
);
const QUALIFIED_CONFIDENCE_DECIMAL_PATTERN = /\b(?:high|medium|low)\s+confidence\s*\(\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)/gi;

export function buildPublicConfidencePolicy(input?: Partial<PublicConfidenceDisplayPolicy>): PublicConfidenceDisplayPolicy {
  const evidenceUrl = input?.evidenceUrl?.trim();
  const datasetId = input?.datasetId?.trim();
  return {
    mode: input?.mode ?? "uncalibrated",
    minLabeledFindings: Math.max(input?.minLabeledFindings ?? DEFAULT_MIN_LABELED_FINDINGS, DEFAULT_MIN_LABELED_FINDINGS),
    minP0P1Labels: Math.max(input?.minP0P1Labels ?? DEFAULT_MIN_P0_P1_LABELS, DEFAULT_MIN_P0_P1_LABELS),
    minNegativeControlScenarios: Math.max(
      input?.minNegativeControlScenarios ?? DEFAULT_MIN_NEGATIVE_CONTROL_SCENARIOS,
      DEFAULT_MIN_NEGATIVE_CONTROL_SCENARIOS
    ),
    minWilsonLowerBound: Math.max(input?.minWilsonLowerBound ?? DEFAULT_MIN_WILSON_LOWER_BOUND, DEFAULT_MIN_WILSON_LOWER_BOUND),
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
  if (policy.labeledFindings === undefined || policy.labeledFindings < Math.max(policy.minLabeledFindings, DEFAULT_MIN_LABELED_FINDINGS)) {
    return false;
  }
  if (policy.p0p1Labels === undefined || policy.p0p1Labels < Math.max(policy.minP0P1Labels, DEFAULT_MIN_P0_P1_LABELS)) return false;
  if (
    policy.negativeControlScenarios === undefined ||
    policy.negativeControlScenarios < Math.max(policy.minNegativeControlScenarios, DEFAULT_MIN_NEGATIVE_CONTROL_SCENARIOS)
  ) {
    return false;
  }
  if (policy.wilsonLowerBound === undefined || policy.wilsonLowerBound < Math.max(policy.minWilsonLowerBound, DEFAULT_MIN_WILSON_LOWER_BOUND)) {
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
  return value
    .replace(QUALIFIED_CONFIDENCE_DECIMAL_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(CONFIDENCE_LABEL_PATTERN, `$1${PUBLIC_CONFIDENCE_REPLACEMENT}`)
    .replace(CONFIDENCE_NOUN_VALUE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(VALUE_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT);
}
