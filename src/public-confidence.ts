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
const CONFIDENCE_LABEL_PATTERN = new RegExp(String.raw`\b((?:confidence|certainty)\s*[:=]\s*)${CONFIDENCE_VALUE_PATTERN}`, "gi");
const CONFIDENCE_NOUN_VALUE_PATTERN = new RegExp(String.raw`\bconfidence(?:\s+score)?(?:\s+of)?\s*${CONFIDENCE_VALUE_PATTERN}`, "gi");
const VALUE_CONFIDENCE_PATTERN = new RegExp(String.raw`\b${CONFIDENCE_VALUE_PATTERN}\s*(?:confident|confidence)\b`, "gi");
const QUALIFIED_CONFIDENCE_DECIMAL_PATTERN = /\b(?:high|medium|low)\s+confidence\s*\(\s*(?:0?\.\d+|1(?:\.0+)?)\s*\)/gi;

export function buildPublicConfidencePolicy(input?: Partial<PublicConfidenceDisplayPolicy>): PublicConfidenceDisplayPolicy {
  const evidenceUrl = input?.evidenceUrl?.trim();
  const datasetId = input?.datasetId?.trim();
  return {
    mode: input?.mode ?? "uncalibrated",
    minLabeledFindings: input?.minLabeledFindings ?? DEFAULT_MIN_LABELED_FINDINGS,
    minP0P1Labels: input?.minP0P1Labels ?? DEFAULT_MIN_P0_P1_LABELS,
    minNegativeControlScenarios: input?.minNegativeControlScenarios ?? DEFAULT_MIN_NEGATIVE_CONTROL_SCENARIOS,
    minWilsonLowerBound: input?.minWilsonLowerBound ?? DEFAULT_MIN_WILSON_LOWER_BOUND,
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
  if (!policy.evidenceUrl?.trim() || !policy.datasetId?.trim()) return false;
  if (policy.labeledFindings === undefined || policy.labeledFindings < policy.minLabeledFindings) return false;
  if (policy.p0p1Labels === undefined || policy.p0p1Labels < policy.minP0P1Labels) return false;
  if (
    policy.negativeControlScenarios === undefined ||
    policy.negativeControlScenarios < policy.minNegativeControlScenarios
  ) {
    return false;
  }
  if (policy.wilsonLowerBound === undefined || policy.wilsonLowerBound < policy.minWilsonLowerBound) return false;
  return true;
}

export function sanitizePublicConfidenceText(value: string, policy?: PublicConfidenceDisplayPolicy): string {
  if (isPublicConfidenceDisplayAllowed(policy)) return value;
  return value
    .replace(QUALIFIED_CONFIDENCE_DECIMAL_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(CONFIDENCE_LABEL_PATTERN, `$1${PUBLIC_CONFIDENCE_REPLACEMENT}`)
    .replace(CONFIDENCE_NOUN_VALUE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT)
    .replace(VALUE_CONFIDENCE_PATTERN, PUBLIC_CONFIDENCE_REPLACEMENT);
}
