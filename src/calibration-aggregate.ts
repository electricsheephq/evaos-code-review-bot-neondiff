import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { computeConfidenceBinStats, PUBLIC_CONFIDENCE_POLICY, type ConfidenceBinStat } from "./eval-harness.js";
import { redactSecrets } from "./secrets.js";
import type { FindingOutcomeLabelRecord } from "./state.js";

export interface CategoryPrecision {
  category: string;
  labeled: number;
  matched: number;
  precision: number;
}

export interface CalibrationAggregateThresholds {
  minLabeledFindings: number;
  minP0P1Labels: number;
  minNegativeControlScenarios: number;
  minWilsonLowerBound: number;
}

export interface CalibrationAggregate {
  labeledFindings: number;
  p0p1Labels: number;
  negativeControlScenarios: number;
  bins: ConfidenceBinStat[];
  bestWilsonLowerBound: number;
  categoryPrecision: CategoryPrecision[];
  thresholds: CalibrationAggregateThresholds;
  eligible: boolean;
  reason: string;
}

/**
 * Batch calibration aggregation (#286 PR B). Reads finding_outcome_labels and produces the SAME
 * Wilson bins the eval-harness computes by mapping labels into computeConfidenceBinStats's inputs —
 * the math is REUSED, never forked. A true_positive label is a matched (validated) finding; a
 * false_positive is a present-but-unmatched finding; an unvalidated label earns NOTHING and is
 * excluded entirely. The public-confidence floors are EVALUATED and reported but NEVER applied here —
 * this function computes evidence; flipping public display remains a human config edit downstream.
 *
 * negativeControlScenarios is 0 by construction: the label store has no explicit-control concept yet,
 * and none_observed/unvalidated labels are NOT negative controls (that conflation is exactly the bug
 * #296 fixed on the eval path). A principled explicit-control source must be added before this can be
 * non-zero.
 */
export function aggregateCalibrationLabels(labels: FindingOutcomeLabelRecord[]): CalibrationAggregate {
  const validated = labels.filter((label) => label.verdict !== "unvalidated");
  const findings = validated.map((label) => ({ id: label.fingerprint, confidence: label.confidence }));
  const matches = validated
    .filter((label) => label.verdict === "true_positive")
    .map((label) => ({ botFindingId: label.fingerprint }));

  const bins = computeConfidenceBinStats(findings, matches);
  const bestWilsonLowerBound = bins.reduce((max, bin) => Math.max(max, bin.rawWilsonLowerBound), 0);
  const labeledFindings = validated.length;
  const p0p1Labels = validated.filter((label) => label.severity === "P0" || label.severity === "P1").length;
  const negativeControlScenarios = 0;

  const categoryPrecision = computeCategoryPrecision(validated);
  const thresholds: CalibrationAggregateThresholds = {
    minLabeledFindings: PUBLIC_CONFIDENCE_POLICY.minLabeledFindings,
    minP0P1Labels: PUBLIC_CONFIDENCE_POLICY.minP0P1Labels,
    minNegativeControlScenarios: PUBLIC_CONFIDENCE_POLICY.minNegativeControlScenarios,
    minWilsonLowerBound: PUBLIC_CONFIDENCE_POLICY.minWilsonLowerBound
  };
  const { eligible, reason } = evaluateThresholds({
    labeledFindings,
    p0p1Labels,
    negativeControlScenarios,
    bestWilsonLowerBound,
    thresholds
  });

  return {
    labeledFindings,
    p0p1Labels,
    negativeControlScenarios,
    bins,
    bestWilsonLowerBound,
    categoryPrecision,
    thresholds,
    eligible,
    reason
  };
}

function computeCategoryPrecision(validated: FindingOutcomeLabelRecord[]): CategoryPrecision[] {
  const byCategory = new Map<string, { labeled: number; matched: number }>();
  for (const label of validated) {
    const entry = byCategory.get(label.category) ?? { labeled: 0, matched: 0 };
    entry.labeled += 1;
    if (label.verdict === "true_positive") entry.matched += 1;
    byCategory.set(label.category, entry);
  }
  return [...byCategory.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([category, entry]) => ({
      category,
      labeled: entry.labeled,
      matched: entry.matched,
      precision: entry.labeled === 0 ? 0 : entry.matched / entry.labeled
    }));
}

// Evaluated, never applied: reports whether the aggregate would clear the public-confidence floors.
function evaluateThresholds(input: {
  labeledFindings: number;
  p0p1Labels: number;
  negativeControlScenarios: number;
  bestWilsonLowerBound: number;
  thresholds: CalibrationAggregateThresholds;
}): { eligible: boolean; reason: string } {
  if (input.labeledFindings < input.thresholds.minLabeledFindings) return { eligible: false, reason: "insufficient_labeled_findings" };
  if (input.p0p1Labels < input.thresholds.minP0P1Labels) return { eligible: false, reason: "insufficient_p0_p1_labels" };
  if (input.negativeControlScenarios < input.thresholds.minNegativeControlScenarios) return { eligible: false, reason: "insufficient_negative_controls" };
  if (input.bestWilsonLowerBound < input.thresholds.minWilsonLowerBound) return { eligible: false, reason: "wilson_lower_bound_below_threshold" };
  return { eligible: true, reason: "eligible" };
}

export interface CalibrationAggregatePacketResult {
  ok: boolean;
  outputDir: string;
  aggregate: CalibrationAggregate;
}

/**
 * Write the aggregate calibration evidence packet + machine-readable aggregate-calibration.json via
 * the redacted writer. The packet's proof boundary is explicit: it ENABLES calibration claims; it
 * never switches public display by itself.
 */
export function writeCalibrationAggregatePacket(input: {
  labels: FindingOutcomeLabelRecord[];
  outputDir: string;
  now?: Date;
}): CalibrationAggregatePacketResult {
  const aggregate = aggregateCalibrationLabels(input.labels);
  const packet = {
    ok: true,
    generatedAt: (input.now ?? new Date()).toISOString(),
    aggregate,
    proofBoundary:
      "Aggregate offline calibration evidence only. It reports whether the public-confidence floors are met; it does NOT switch public calibrated-confidence display or mutate any config."
  };
  mkdirSync(input.outputDir, { recursive: true });
  writeRedactedJson(join(input.outputDir, "aggregate-calibration.json"), aggregate);
  writeRedactedJson(join(input.outputDir, "calibration-aggregate-packet.json"), packet);
  return { ok: true, outputDir: input.outputDir, aggregate };
}

function writeRedactedJson(path: string, value: unknown): void {
  writeFileSync(path, `${redactSecrets(JSON.stringify(value, null, 2))}\n`);
}
