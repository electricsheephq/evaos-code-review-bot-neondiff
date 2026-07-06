import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { buildPublicConfidencePolicy } from "./public-confidence.js";
import { redactSecrets } from "./secrets.js";

export interface AggregateCalibrationInput {
  labeledFindings: number;
  p0p1Labels: number;
  negativeControlScenarios: number;
  bestWilsonLowerBound: number;
}

export interface CalibrationPromotionGate {
  eligible: boolean;
  failingGate?: string;
  numbers: {
    labeledFindings: number;
    p0p1Labels: number;
    negativeControlScenarios: number;
    wilsonLowerBound: number;
  };
}

/**
 * Evaluate aggregate calibration evidence against the public-confidence HARD floors (#286 PR C). This
 * is the SAME floor source (buildPublicConfidencePolicy) the live gate uses. Returns the failing gate
 * by name when below threshold. It NEVER decides display mode — that stays a human edit.
 */
export function evaluateCalibrationPromotion(aggregate: AggregateCalibrationInput): CalibrationPromotionGate {
  const floors = buildPublicConfidencePolicy();
  const numbers = {
    labeledFindings: aggregate.labeledFindings,
    p0p1Labels: aggregate.p0p1Labels,
    negativeControlScenarios: aggregate.negativeControlScenarios,
    wilsonLowerBound: aggregate.bestWilsonLowerBound
  };
  if (numbers.labeledFindings < floors.minLabeledFindings) return { eligible: false, failingGate: "min_labeled_findings", numbers };
  if (numbers.p0p1Labels < floors.minP0P1Labels) return { eligible: false, failingGate: "min_p0_p1_labels", numbers };
  if (numbers.negativeControlScenarios < floors.minNegativeControlScenarios) {
    return { eligible: false, failingGate: "min_negative_control_scenarios", numbers };
  }
  if (numbers.wilsonLowerBound < floors.minWilsonLowerBound) return { eligible: false, failingGate: "min_wilson_lower_bound", numbers };
  return { eligible: true, numbers };
}

export interface CalibrationPromotionResult {
  ok: boolean;
  eligible: boolean;
  failingGate?: string;
  mode: "patch" | "apply";
  outputPath?: string;
  numbers: CalibrationPromotionGate["numbers"];
  note: string;
}

const MODE_NOTE =
  "This writes the calibration evidence NUMBERS only. Flipping confidenceCalibration.publicDisplay.mode to \"calibrated\" remains a MANUAL human edit — this tool never sets mode.";

/**
 * Promote aggregate calibration evidence (#286 PR C). REQUIRES an explicit confirm. Below-threshold
 * evidence is refused with the failing gate named — nothing is written. On eligible evidence:
 *  - default (apply=false): write a config PATCH FILE (redacted) the operator applies by hand;
 *  - apply=true: additionally REQUIRES iUnderstandLiveConfig (double flag) and writes the same patch
 *    shape to the apply path, but STILL never sets publicDisplay.mode — the calibrated flip stays
 *    a deliberate human edit, stated loudly in the output.
 */
export function runCalibrationPromotion(input: {
  aggregatePath: string;
  outputDir: string;
  confirm: boolean;
  apply?: boolean;
  iUnderstandLiveConfig?: boolean;
  now?: Date;
}): CalibrationPromotionResult {
  if (!input.confirm) throw new Error("calibration-promote requires --confirm to acknowledge it writes calibration evidence");
  const apply = input.apply === true;
  if (apply && input.iUnderstandLiveConfig !== true) {
    throw new Error("calibration-promote --apply additionally requires --i-understand-live-config (double confirmation)");
  }

  const aggregate = readAggregate(input.aggregatePath);
  const gate = evaluateCalibrationPromotion(aggregate);
  if (!gate.eligible) {
    throw new Error(`calibration-promote refuses below-threshold evidence: failing gate ${gate.failingGate}`);
  }

  // The patch NEVER carries mode: setting it "calibrated" is a manual human edit.
  const patch = {
    confidenceCalibration: {
      publicDisplay: {
        labeledFindings: gate.numbers.labeledFindings,
        p0p1Labels: gate.numbers.p0p1Labels,
        negativeControlScenarios: gate.numbers.negativeControlScenarios,
        wilsonLowerBound: gate.numbers.wilsonLowerBound
      }
    },
    _note: MODE_NOTE
  };

  mkdirSync(input.outputDir, { recursive: true });
  const fileName = apply ? "calibration-config-apply-patch.json" : "calibration-config-patch.json";
  const outputPath = join(input.outputDir, fileName);
  writeRedactedJson(outputPath, patch);

  return {
    ok: true,
    eligible: true,
    mode: apply ? "apply" : "patch",
    outputPath,
    numbers: gate.numbers,
    note: MODE_NOTE
  };
}

function readAggregate(path: string): AggregateCalibrationInput {
  const value = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  return {
    labeledFindings: requireNumber(value.labeledFindings, "labeledFindings"),
    p0p1Labels: requireNumber(value.p0p1Labels, "p0p1Labels"),
    negativeControlScenarios: requireNumber(value.negativeControlScenarios, "negativeControlScenarios"),
    bestWilsonLowerBound: requireNumber(value.bestWilsonLowerBound, "bestWilsonLowerBound")
  };
}

function requireNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`aggregate-calibration.${label} must be a number`);
  return value;
}

function writeRedactedJson(path: string, value: unknown): void {
  writeFileSync(path, `${redactSecrets(JSON.stringify(value, null, 2))}\n`);
}
