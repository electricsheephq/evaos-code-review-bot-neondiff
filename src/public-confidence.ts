export interface PublicConfidenceDisplayPolicy {
  mode: "uncalibrated" | "calibrated";
  evidenceUrl?: string;
  datasetId?: string;
  minLabeledFindings: number;
  labeledFindings?: number;
  minWilsonLowerBound: number;
  wilsonLowerBound?: number;
}

const DEFAULT_MIN_LABELED_FINDINGS = 100;
const DEFAULT_MIN_WILSON_LOWER_BOUND = 0.95;
const CONFIDENCE_PERCENT_PATTERN = /\b(confidence\s*[:=]\s*)\d+(?:\.\d+)?\s*%/gi;
const CONFIDENCE_DECIMAL_PATTERN = /\b(confidence\s*[:=]\s*)(?:0?\.\d+|1(?:\.0+)?)\b/gi;
const PERCENT_CONFIDENT_PATTERN = /\b\d+(?:\.\d+)?\s*%\s*(confident|confidence)\b/gi;
const DECIMAL_CONFIDENT_PATTERN = /\b(?:0?\.\d+|1(?:\.0+)?)\s*(confident|confidence)\b/gi;
const CONFIDENCE_NOUN_PERCENT_PATTERN = /\b(confidence)\s+\d+(?:\.\d+)?\s*%/gi;
const CONFIDENCE_QUERY_PERCENT_PATTERN = /\b(confidence=)\d+(?:\.\d+)?\s*%/gi;

export function buildPublicConfidencePolicy(input?: Partial<PublicConfidenceDisplayPolicy>): PublicConfidenceDisplayPolicy {
  return {
    mode: input?.mode ?? "uncalibrated",
    minLabeledFindings: input?.minLabeledFindings ?? DEFAULT_MIN_LABELED_FINDINGS,
    minWilsonLowerBound: input?.minWilsonLowerBound ?? DEFAULT_MIN_WILSON_LOWER_BOUND,
    ...(input?.evidenceUrl ? { evidenceUrl: input.evidenceUrl } : {}),
    ...(input?.datasetId ? { datasetId: input.datasetId } : {}),
    ...(input?.labeledFindings !== undefined ? { labeledFindings: input.labeledFindings } : {}),
    ...(input?.wilsonLowerBound !== undefined ? { wilsonLowerBound: input.wilsonLowerBound } : {})
  };
}

export function isPublicConfidenceDisplayAllowed(policy?: PublicConfidenceDisplayPolicy): boolean {
  if (!policy || policy.mode !== "calibrated") return false;
  if (!policy.evidenceUrl || !policy.datasetId) return false;
  if (policy.labeledFindings === undefined || policy.labeledFindings < policy.minLabeledFindings) return false;
  if (policy.wilsonLowerBound === undefined || policy.wilsonLowerBound < policy.minWilsonLowerBound) return false;
  return true;
}

export function sanitizePublicConfidenceText(value: string, policy?: PublicConfidenceDisplayPolicy): string {
  if (isPublicConfidenceDisplayAllowed(policy)) return value;
  return value
    .replace(CONFIDENCE_PERCENT_PATTERN, "$1uncalibrated")
    .replace(CONFIDENCE_DECIMAL_PATTERN, "$1uncalibrated")
    .replace(PERCENT_CONFIDENT_PATTERN, "uncalibrated $1")
    .replace(DECIMAL_CONFIDENT_PATTERN, "uncalibrated $1")
    .replace(CONFIDENCE_NOUN_PERCENT_PATTERN, "$1 uncalibrated")
    .replace(CONFIDENCE_QUERY_PERCENT_PATTERN, "$1uncalibrated");
}
