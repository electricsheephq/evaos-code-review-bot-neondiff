import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { CalibrationAggregate } from "./calibration-aggregate.js";
import {
  buildPublicConfidencePolicy,
  evaluatePublicConfidencePolicy,
  type PublicConfidenceDisplayPolicy,
  type PublicConfidencePolicyEvaluation
} from "./public-confidence.js";

export interface ShieldsEndpointBadge {
  schemaVersion: 1;
  label: "NeonDiff precision";
  message: string;
  color: "green" | "lightgrey";
}

export interface PrecisionBadgeResult {
  ok: boolean;
  badge: ShieldsEndpointBadge;
  outputPath?: string;
  publicMode: PublicConfidencePolicyEvaluation["publicMode"];
  allowed: boolean;
  missingThresholds: PublicConfidencePolicyEvaluation["missingThresholds"];
  labeledFindings: number;
  wilsonLowerBound: number;
  proofBoundary: string;
}

export function buildPrecisionBadgeEndpoint(input: {
  aggregate: CalibrationAggregate;
  publicDisplay?: PublicConfidenceDisplayPolicy;
}): ShieldsEndpointBadge {
  const evaluation = evaluatePrecisionBadgePolicy(input);
  return badgeForEvaluation(input.aggregate, evaluation);
}

function badgeForEvaluation(
  aggregate: CalibrationAggregate,
  evaluation: PublicConfidencePolicyEvaluation
): ShieldsEndpointBadge {
  const n = aggregate.labeledFindings;
  if (!evaluation.allowed) {
    return {
      schemaVersion: 1,
      label: "NeonDiff precision",
      message: `calibrating (n=${n})`,
      color: "lightgrey"
    };
  }

  return {
    schemaVersion: 1,
    label: "NeonDiff precision",
    message: `${formatConservativePercent(aggregate.bestWilsonLowerBound)}% (n=${n})`,
    color: "green"
  };
}

export function writePrecisionBadgeEndpoint(input: {
  aggregate: CalibrationAggregate;
  publicDisplay?: PublicConfidenceDisplayPolicy;
  outputPath: string;
}): PrecisionBadgeResult {
  const evaluation = evaluatePrecisionBadgePolicy(input);
  const badge = badgeForEvaluation(input.aggregate, evaluation);
  mkdirSync(dirname(input.outputPath), { recursive: true });
  writeFileSync(input.outputPath, `${JSON.stringify(badge, null, 2)}\n`);
  return {
    ok: true,
    badge,
    outputPath: input.outputPath,
    publicMode: evaluation.publicMode,
    allowed: evaluation.allowed,
    missingThresholds: evaluation.missingThresholds,
    labeledFindings: input.aggregate.labeledFindings,
    wilsonLowerBound: input.aggregate.bestWilsonLowerBound,
    proofBoundary: "Shields endpoint badge only. Percentages render only when the existing public-confidence gate passes and publicDisplay.mode is human-flipped to calibrated."
  };
}

function evaluatePrecisionBadgePolicy(input: {
  aggregate: CalibrationAggregate;
  publicDisplay?: PublicConfidenceDisplayPolicy;
}): PublicConfidencePolicyEvaluation {
  return evaluatePublicConfidencePolicy(buildPublicConfidencePolicy({
    ...input.publicDisplay,
    labeledFindings: input.aggregate.labeledFindings,
    p0p1Labels: input.aggregate.p0p1Labels,
    negativeControlScenarios: input.aggregate.negativeControlScenarios,
    wilsonLowerBound: input.aggregate.bestWilsonLowerBound
  }));
}

function formatConservativePercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.floor(value * 100)));
}
