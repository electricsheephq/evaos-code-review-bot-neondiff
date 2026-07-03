import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseFindings } from "./findings.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { Finding, Severity } from "./types.js";

export type EvalSuiteName =
  | "canary_shadow"
  | "historical_pr_replay"
  | "seeded_defect_recall"
  | "safety_redaction"
  | "duplicate_suppression";

export type EvalLabelSource = "coderabbit" | "human" | "ci_failure" | "merged_fix" | "seeded_defect";

export interface EvalScenarioInput {
  evalName?: string;
  runId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  suite: EvalSuiteName;
  mode?: "gating" | "exploratory";
  scenarioSource?: EvalScenarioSourceInput;
  rawOutput?: unknown;
  botFindings: unknown;
  inlinePreviews?: EvalInlinePreviewInput[];
  ciMetadata?: EvalCiMetadataInput[];
  mergedFixes?: EvalMergedFixInput[];
  labels: EvalLabelInput[];
  thresholds?: Partial<EvalThresholds>;
}

export interface EvalLabelInput {
  source: EvalLabelSource;
  severity: Severity;
  path: string;
  line: number;
  title: string;
  body: string;
  sourceId?: string;
  sourceUrl?: string;
  author?: string;
  checkName?: string;
  mergeSha?: string;
  diffSummary?: string;
  expected?: boolean;
}

export interface EvalScenarioSourceInput {
  path: string;
  sha256?: string;
}

export interface EvalInlinePreviewInput {
  path: string;
  line: number;
  side?: "RIGHT" | "LEFT";
  severity?: Severity;
  title: string;
  body: string;
  confidence?: number;
}

export interface EvalCiMetadataInput {
  provider: string;
  name: string;
  status: "success" | "failure" | "neutral" | "cancelled" | "skipped" | "timed_out" | "action_required" | "pending";
  conclusion?: string;
  url?: string;
  summary?: string;
}

export interface EvalMergedFixInput {
  repo: string;
  pullNumber: number;
  mergeSha: string;
  path?: string;
  summary: string;
}

export interface EvalThresholds {
  minPrecision: number;
  minRecall: number;
  minSeededRecall: number;
  maxSecretFindings: number;
  maxDuplicateFindings: number;
}

export interface EvalRunOptions {
  outputDir?: string;
  now?: Date;
}

export interface EvalRunResult {
  ok: boolean;
  outputDir: string;
  scorecard: EvalScorecard;
  artifacts: Record<string, string>;
}

export interface StickyVsColdRuntimeMetrics {
  providerAttempts?: number;
  latencyMs?: number;
  promptTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  providerCooldowns?: number;
  memoryPacketSha?: string;
  gitnexusPacketSha?: string;
  stickySessionId?: string;
  repoMemoryAgeSeconds?: number;
  staleContext?: boolean;
  notes?: string[];
}

export interface StickyVsColdThresholds {
  maxFalsePositiveDelta: number;
  maxFalseNegativeDelta: number;
  maxSecretFindingDelta: number;
  maxDuplicateFindingDelta: number;
  maxSchemaDropDelta: number;
  minRecallDelta: number;
  minSeededRecallDelta: number;
  requireProviderAttemptsNotHigher: boolean;
  minRuntimeSafeScenarios: number;
  minRuntimeSafeLabeledFindings: number;
  minRuntimeSafeP0P1Labels: number;
  minRuntimeSafeNegativeControls: number;
}

export interface StickyVsColdScenarioInput {
  evalName?: string;
  runId: string;
  scenarioSource?: EvalScenarioSourceInput;
  cold: EvalScenarioInput;
  sticky: EvalScenarioInput;
  coldRuntime?: StickyVsColdRuntimeMetrics;
  stickyRuntime?: StickyVsColdRuntimeMetrics;
  thresholds?: Partial<StickyVsColdThresholds>;
}

export type StickyVsColdDecision = "advisory" | "runtime_safe_candidate" | "not_enough_evidence";

export interface StickyVsColdEvalResult {
  ok: boolean;
  outputRoot: string;
  cold: EvalRunResult;
  sticky: EvalRunResult;
  summary: StickyVsColdSummary;
  artifacts: Record<string, string>;
}

export interface StickyVsColdSummary {
  evalName: string;
  artifactVersion: "0.1";
  runId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  suite: EvalSuiteName;
  decision: StickyVsColdDecision;
  ok: boolean;
  publicConfidence: "uncalibrated";
  generatedAt: string;
  scenarioSource?: unknown;
  packets: {
    cold: { outputDir: string; ok: boolean; scorecard: EvalScorecard };
    sticky: { outputDir: string; ok: boolean; scorecard: EvalScorecard };
  };
  deltas: {
    precision: number;
    recall: number;
    seededRecall: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    botFindings: number;
    secretFindings: number;
    duplicateFindings: number;
    droppedFromSchema: number;
    providerAttempts?: number;
    latencyMs?: number;
    promptTokens?: number;
    outputTokens?: number;
    totalTokens?: number;
    providerCooldowns?: number;
  };
  context: {
    coldRuntime?: unknown;
    stickyRuntime?: unknown;
  };
  evidenceCounts: {
    pairedScenarios: number;
    labeledFindings: number;
    p0p1Labels: number;
    negativeControlScenarios: number;
  };
  thresholds: StickyVsColdThresholds;
  gates: Array<{ name: string; ok: boolean; status: "pass" | "fail" | "skip"; detail: string }>;
  artifactInventory: Array<{ name: string; sha256: string }>;
  proofBoundary: string;
}

export interface EvalScorecard {
  evalName: string;
  runId: string;
  suite: EvalSuiteName;
  repo: string;
  pullNumber: number;
  headSha: string;
  counts: {
    botFindings: number;
    labels: number;
    truePositive: number;
    falsePositive: number;
    falseNegative: number;
    exactLineMatches: number;
    nearbyLineMatches: number;
    semanticMatches: number;
    droppedFromSchema: number;
    secretFindings: number;
    duplicateFindings: number;
    inlinePreviews: number;
    ciMetadata: number;
    mergedFixes: number;
    p0p1Labels: number;
  };
  metrics: {
    precision: number;
    recall: number;
    seededRecall: number;
    maxWilsonLowerBound: number;
  };
  thresholds: EvalThresholds;
  gates: Array<{ name: string; ok: boolean; detail: string }>;
}

export interface EvalCalibrationReport {
  claim: "uncalibrated" | "calibrated";
  bins: Array<{
    minConfidence: number;
    maxConfidence: number;
    findings: number;
    matched: number;
    empiricalPrecision: number;
    wilsonLowerBound: number;
    publicLabel: "uncalibrated" | "calibrated";
  }>;
  publicDisplayPolicy: EvalPublicDisplayPolicy;
  promotion: {
    eligible: boolean;
    reason: EvalPromotionReason;
  };
  note: string;
}

export interface EvalPublicDisplayPolicy {
  defaultLabel: "uncalibrated";
  minWilsonLowerBound: number;
  minLabeledFindings: number;
  minP0P1Labels: number;
  minNegativeControlScenarios: number;
}

export type EvalPromotionReason =
  | "eligible"
  | "insufficient_labeled_findings"
  | "insufficient_p0_p1_labels"
  | "insufficient_negative_controls"
  | "wilson_lower_bound_below_threshold"
  | "suite_failed"
  | "missing_required_suites";

export interface EvalSuitePromotionInput {
  ok: boolean;
  scenarioCount: number;
  missingSuites: EvalSuiteName[];
  scorecards: EvalScorecard[];
}

interface NormalizedEvalFinding extends Finding {
  id: string;
  source: "bot" | EvalLabelSource;
  evidence?: Record<string, string>;
}

interface EvalMatch {
  botFindingId: string;
  labelId: string;
  kind: "exact_line" | "nearby_line" | "semantic";
}

const DEFAULT_THRESHOLDS: EvalThresholds = {
  minPrecision: 0.8,
  minRecall: 0.6,
  minSeededRecall: 1,
  maxSecretFindings: 0,
  maxDuplicateFindings: 0
};

export const PUBLIC_CONFIDENCE_POLICY: EvalPublicDisplayPolicy = {
  defaultLabel: "uncalibrated",
  minWilsonLowerBound: 0.95,
  minLabeledFindings: 100,
  minP0P1Labels: 30,
  minNegativeControlScenarios: 10
};

export const REQUIRED_SUITES: EvalSuiteName[] = [
  "canary_shadow",
  "historical_pr_replay",
  "seeded_defect_recall",
  "safety_redaction",
  "duplicate_suppression"
];

const DEFAULT_STICKY_VS_COLD_THRESHOLDS: StickyVsColdThresholds = {
  maxFalsePositiveDelta: 0,
  maxFalseNegativeDelta: 0,
  maxSecretFindingDelta: 0,
  maxDuplicateFindingDelta: 0,
  maxSchemaDropDelta: 0,
  minRecallDelta: 0,
  minSeededRecallDelta: 0,
  requireProviderAttemptsNotHigher: true,
  minRuntimeSafeScenarios: 30,
  minRuntimeSafeLabeledFindings: PUBLIC_CONFIDENCE_POLICY.minLabeledFindings,
  minRuntimeSafeP0P1Labels: PUBLIC_CONFIDENCE_POLICY.minP0P1Labels,
  minRuntimeSafeNegativeControls: PUBLIC_CONFIDENCE_POLICY.minNegativeControlScenarios
};

export function runOfflineEval(input: EvalScenarioInput, options: EvalRunOptions = {}): EvalRunResult {
  validateEvalInput(input);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  validateThresholds(thresholds);
  validateThresholdPolicy(input.mode ?? "gating", input.thresholds ?? {});

  const evalName = input.evalName ?? "evaos-zcode-review-bot-comparison-v0.1";
  const outputDir = options.outputDir ?? defaultEvalOutputDir(input, options.now ?? new Date());
  guardOutputDir(outputDir);
  mkdirSync(outputDir, { recursive: true });

  const parsedBot = parseFindings(input.botFindings);
  const botFindings = parsedBot.findings.map((finding, index) => normalizeFinding(finding, "bot", `bot-${index + 1}`));
  const labels = input.labels
    .filter((label) => label.expected !== false)
    .map((label, index) => normalizeFinding(label, label.source, `label-${index + 1}`));
  const inlinePreviews = buildInlinePreviews(input.inlinePreviews, botFindings);
  const ciMetadata = normalizeCiMetadata(input.ciMetadata ?? []);
  const mergedFixes = normalizeMergedFixes(input.mergedFixes ?? []);
  const matches = matchFindings(botFindings, labels);
  const duplicateReport = findDuplicateFindings(botFindings);
  const redactionReport = buildRedactionReport(input, parsedBot.findings, input.labels, parsedBot.dropped.length);
  const scorecard = buildScorecard({
    input,
    evalName,
    botFindings,
    labels,
    matches,
    duplicateCount: duplicateReport.duplicates.length,
    secretCount: redactionReport.secretLikeItems.length,
    droppedFromSchema: parsedBot.dropped.length,
    inlinePreviewCount: inlinePreviews.length,
    ciMetadataCount: ciMetadata.length,
    mergedFixCount: mergedFixes.length,
    thresholds
  });

  const artifacts: Record<string, string> = {
    "manifest.json": join(outputDir, "manifest.json"),
    "raw-output.json": join(outputDir, "raw-output.json"),
    "normalized-findings.json": join(outputDir, "normalized-findings.json"),
    "inline-previews.json": join(outputDir, "inline-previews.json"),
    "ci-metadata.json": join(outputDir, "ci-metadata.json"),
    "merged-fixes.json": join(outputDir, "merged-fixes.json"),
    "redaction-report.json": join(outputDir, "redaction-report.json"),
    "duplicate-report.json": join(outputDir, "duplicate-report.json"),
    "comparison.csv": join(outputDir, "comparison.csv"),
    "labels.json": join(outputDir, "labels.json"),
    "calibration-report.json": join(outputDir, "calibration-report.json"),
    "scorecard.json": join(outputDir, "scorecard.json")
  };

  writeJson(artifacts["raw-output.json"]!, redactUnknown(input.rawOutput ?? input.botFindings));
  writeJson(artifacts["normalized-findings.json"]!, {
    botFindings,
    droppedFromSchema: parsedBot.dropped.map(redactUnknown)
  });
  writeJson(artifacts["inline-previews.json"]!, inlinePreviews);
  writeJson(artifacts["ci-metadata.json"]!, ciMetadata);
  writeJson(artifacts["merged-fixes.json"]!, mergedFixes);
  writeJson(artifacts["redaction-report.json"]!, redactionReport);
  writeJson(artifacts["duplicate-report.json"]!, duplicateReport);
  writeFileSync(artifacts["comparison.csv"]!, buildComparisonCsv(botFindings, labels, matches));
  writeJson(artifacts["labels.json"]!, labels);
  writeJson(artifacts["calibration-report.json"]!, buildCalibrationReport(botFindings, labels, matches));
  writeJson(artifacts["scorecard.json"]!, scorecard);
  writeJson(artifacts["manifest.json"]!, {
    evalName,
    artifactVersion: "0.2",
    runId: input.runId,
    suite: input.suite,
    mode: input.mode ?? "gating",
    requiredSuites: REQUIRED_SUITES,
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    scenarioSource: input.scenarioSource ? redactUnknown(input.scenarioSource) : undefined,
    negativeControl: labels.length === 0,
    thresholds,
    artifactInventory: Object.entries(artifacts)
      .filter(([name]) => name !== "manifest.json")
      .map(([name, path]) => ({ name, sha256: sha256File(path) })),
    metadataCounts: {
      inlinePreviews: inlinePreviews.length,
      ciMetadata: ciMetadata.length,
      mergedFixes: mergedFixes.length
    },
    generatedAt: (options.now ?? new Date()).toISOString(),
    proofBoundary: "offline comparison packet only; no GitHub posting or repo mutation"
  });

  return {
    ok: scorecard.gates.every((gate) => gate.ok),
    outputDir,
    scorecard,
    artifacts
  };
}

export function runStickyVsColdEval(
  input: StickyVsColdScenarioInput,
  options: { outputRoot?: string; now?: Date } = {}
): StickyVsColdEvalResult {
  validateStickyVsColdInput(input);
  const now = options.now ?? new Date();
  const evalName = input.evalName ?? "evaos-zcode-review-bot-sticky-vs-cold-v0.1";
  const thresholds = { ...DEFAULT_STICKY_VS_COLD_THRESHOLDS, ...(input.thresholds ?? {}) };
  validateStickyVsColdThresholds(thresholds);
  const outputRoot = options.outputRoot ?? defaultStickyVsColdOutputRoot(input, now);
  guardOutputDir(outputRoot);
  mkdirSync(outputRoot, { recursive: true });

  const cold = runOfflineEval(input.cold, {
    outputDir: join(outputRoot, "cold"),
    now
  });
  const sticky = runOfflineEval(input.sticky, {
    outputDir: join(outputRoot, "sticky"),
    now
  });

  const summaryPath = join(outputRoot, "sticky-vs-cold-summary.json");
  const reportPath = join(outputRoot, "sticky-vs-cold-report.md");
  const summary = buildStickyVsColdSummary({
    input,
    evalName,
    cold,
    sticky,
    thresholds,
    now
  });
  writeFileSync(reportPath, buildStickyVsColdReport(summary));
  const artifactInventory = [
    { name: "sticky-vs-cold-report.md", sha256: sha256File(reportPath) },
    { name: "cold/scorecard.json", sha256: sha256File(cold.artifacts["scorecard.json"]!) },
    { name: "sticky/scorecard.json", sha256: sha256File(sticky.artifacts["scorecard.json"]!) },
    { name: "cold/manifest.json", sha256: sha256File(cold.artifacts["manifest.json"]!) },
    { name: "sticky/manifest.json", sha256: sha256File(sticky.artifacts["manifest.json"]!) }
  ];
  const finalSummary = { ...summary, artifactInventory };
  writeJson(summaryPath, finalSummary);

  return {
    ok: finalSummary.ok,
    outputRoot,
    cold,
    sticky,
    summary: finalSummary,
    artifacts: {
      "sticky-vs-cold-summary.json": summaryPath,
      "sticky-vs-cold-report.md": reportPath
    }
  };
}

function buildStickyVsColdSummary(input: {
  input: StickyVsColdScenarioInput;
  evalName: string;
  cold: EvalRunResult;
  sticky: EvalRunResult;
  thresholds: StickyVsColdThresholds;
  now: Date;
}): StickyVsColdSummary {
  const deltas = buildStickyVsColdDeltas({
    cold: input.cold.scorecard,
    sticky: input.sticky.scorecard,
    coldRuntime: input.input.coldRuntime,
    stickyRuntime: input.input.stickyRuntime
  });
  const evidenceCounts = {
    pairedScenarios: 1,
    labeledFindings: input.sticky.scorecard.counts.labels,
    p0p1Labels: input.sticky.scorecard.counts.p0p1Labels,
    negativeControlScenarios: input.sticky.scorecard.counts.labels === 0 ? 1 : 0
  };
  const gates = buildStickyVsColdGates({
    cold: input.cold,
    sticky: input.sticky,
    deltas,
    thresholds: input.thresholds,
    coldRuntime: input.input.coldRuntime,
    stickyRuntime: input.input.stickyRuntime
  });
  const ok = gates.every((gate) => gate.ok);
  const providerAttemptsComparable =
    typeof input.input.coldRuntime?.providerAttempts === "number" &&
    typeof input.input.stickyRuntime?.providerAttempts === "number";
  const stickyContextFreshForPromotion = input.input.stickyRuntime?.staleContext === false;
  const runtimeSafeEvidence =
    ok &&
    providerAttemptsComparable &&
    stickyContextFreshForPromotion &&
    evidenceCounts.pairedScenarios >= input.thresholds.minRuntimeSafeScenarios &&
    evidenceCounts.labeledFindings >= input.thresholds.minRuntimeSafeLabeledFindings &&
    evidenceCounts.p0p1Labels >= input.thresholds.minRuntimeSafeP0P1Labels &&
    evidenceCounts.negativeControlScenarios >= input.thresholds.minRuntimeSafeNegativeControls;
  const decision: StickyVsColdDecision = ok
    ? runtimeSafeEvidence
      ? "runtime_safe_candidate"
      : "advisory"
    : "not_enough_evidence";

  return {
    evalName: input.evalName,
    artifactVersion: "0.1",
    runId: input.input.runId,
    repo: input.sticky.scorecard.repo,
    pullNumber: input.sticky.scorecard.pullNumber,
    headSha: input.sticky.scorecard.headSha,
    suite: input.sticky.scorecard.suite,
    decision,
    ok,
    publicConfidence: "uncalibrated",
    generatedAt: input.now.toISOString(),
    ...(input.input.scenarioSource ? { scenarioSource: redactUnknown(input.input.scenarioSource) } : {}),
    packets: {
      cold: {
        outputDir: input.cold.outputDir,
        ok: input.cold.ok,
        scorecard: input.cold.scorecard
      },
      sticky: {
        outputDir: input.sticky.outputDir,
        ok: input.sticky.ok,
        scorecard: input.sticky.scorecard
      }
    },
    deltas,
    context: {
      ...(input.input.coldRuntime ? { coldRuntime: redactUnknown(input.input.coldRuntime) } : {}),
      ...(input.input.stickyRuntime ? { stickyRuntime: redactUnknown(input.input.stickyRuntime) } : {})
    },
    evidenceCounts,
    thresholds: input.thresholds,
    gates,
    artifactInventory: [],
    proofBoundary: "offline paired sticky-vs-cold eval packet only; no GitHub posting, launchd mutation, repo mutation, or calibrated public confidence claim"
  };
}

function buildStickyVsColdDeltas(input: {
  cold: EvalScorecard;
  sticky: EvalScorecard;
  coldRuntime?: StickyVsColdRuntimeMetrics;
  stickyRuntime?: StickyVsColdRuntimeMetrics;
}): StickyVsColdSummary["deltas"] {
  return {
    precision: roundMetric(input.sticky.metrics.precision - input.cold.metrics.precision),
    recall: roundMetric(input.sticky.metrics.recall - input.cold.metrics.recall),
    seededRecall: roundMetric(input.sticky.metrics.seededRecall - input.cold.metrics.seededRecall),
    truePositive: input.sticky.counts.truePositive - input.cold.counts.truePositive,
    falsePositive: input.sticky.counts.falsePositive - input.cold.counts.falsePositive,
    falseNegative: input.sticky.counts.falseNegative - input.cold.counts.falseNegative,
    botFindings: input.sticky.counts.botFindings - input.cold.counts.botFindings,
    secretFindings: input.sticky.counts.secretFindings - input.cold.counts.secretFindings,
    duplicateFindings: input.sticky.counts.duplicateFindings - input.cold.counts.duplicateFindings,
    droppedFromSchema: input.sticky.counts.droppedFromSchema - input.cold.counts.droppedFromSchema,
    ...optionalNumberDelta("providerAttempts", input.coldRuntime?.providerAttempts, input.stickyRuntime?.providerAttempts),
    ...optionalNumberDelta("latencyMs", input.coldRuntime?.latencyMs, input.stickyRuntime?.latencyMs),
    ...optionalNumberDelta("promptTokens", input.coldRuntime?.promptTokens, input.stickyRuntime?.promptTokens),
    ...optionalNumberDelta("outputTokens", input.coldRuntime?.outputTokens, input.stickyRuntime?.outputTokens),
    ...optionalNumberDelta("totalTokens", input.coldRuntime?.totalTokens, input.stickyRuntime?.totalTokens),
    ...optionalNumberDelta("providerCooldowns", input.coldRuntime?.providerCooldowns, input.stickyRuntime?.providerCooldowns)
  };
}

function buildStickyVsColdGates(input: {
  cold: EvalRunResult;
  sticky: EvalRunResult;
  deltas: StickyVsColdSummary["deltas"];
  thresholds: StickyVsColdThresholds;
  coldRuntime?: StickyVsColdRuntimeMetrics;
  stickyRuntime?: StickyVsColdRuntimeMetrics;
}): StickyVsColdSummary["gates"] {
  const providerAttemptsComparable =
    typeof input.coldRuntime?.providerAttempts === "number" &&
    typeof input.stickyRuntime?.providerAttempts === "number";
  return [
    {
      name: "sticky_packet_ok",
      ok: input.sticky.ok,
      status: input.sticky.ok ? "pass" : "fail",
      detail: input.sticky.ok ? "sticky packet gates passed" : "sticky packet gates failed"
    },
    {
      name: "no_secret_regression",
      ok: input.deltas.secretFindings <= input.thresholds.maxSecretFindingDelta,
      status: input.deltas.secretFindings <= input.thresholds.maxSecretFindingDelta ? "pass" : "fail",
      detail: `${input.deltas.secretFindings} <= ${input.thresholds.maxSecretFindingDelta}`
    },
    {
      name: "no_duplicate_regression",
      ok: input.deltas.duplicateFindings <= input.thresholds.maxDuplicateFindingDelta,
      status: input.deltas.duplicateFindings <= input.thresholds.maxDuplicateFindingDelta ? "pass" : "fail",
      detail: `${input.deltas.duplicateFindings} <= ${input.thresholds.maxDuplicateFindingDelta}`
    },
    {
      name: "no_schema_drop_regression",
      ok: input.deltas.droppedFromSchema <= input.thresholds.maxSchemaDropDelta,
      status: input.deltas.droppedFromSchema <= input.thresholds.maxSchemaDropDelta ? "pass" : "fail",
      detail: `${input.deltas.droppedFromSchema} <= ${input.thresholds.maxSchemaDropDelta}`
    },
    {
      name: "no_false_positive_regression",
      ok: input.deltas.falsePositive <= input.thresholds.maxFalsePositiveDelta,
      status: input.deltas.falsePositive <= input.thresholds.maxFalsePositiveDelta ? "pass" : "fail",
      detail: `${input.deltas.falsePositive} <= ${input.thresholds.maxFalsePositiveDelta}`
    },
    {
      name: "no_false_negative_regression",
      ok: input.deltas.falseNegative <= input.thresholds.maxFalseNegativeDelta,
      status: input.deltas.falseNegative <= input.thresholds.maxFalseNegativeDelta ? "pass" : "fail",
      detail: `${input.deltas.falseNegative} <= ${input.thresholds.maxFalseNegativeDelta}`
    },
    {
      name: "recall_not_lower",
      ok: input.deltas.recall >= input.thresholds.minRecallDelta,
      status: input.deltas.recall >= input.thresholds.minRecallDelta ? "pass" : "fail",
      detail: `${input.deltas.recall} >= ${input.thresholds.minRecallDelta}`
    },
    {
      name: "seeded_recall_not_lower",
      ok: input.deltas.seededRecall >= input.thresholds.minSeededRecallDelta,
      status: input.deltas.seededRecall >= input.thresholds.minSeededRecallDelta ? "pass" : "fail",
      detail: `${input.deltas.seededRecall} >= ${input.thresholds.minSeededRecallDelta}`
    },
    {
      name: "provider_attempts_not_higher",
      ok: !input.thresholds.requireProviderAttemptsNotHigher ||
        !providerAttemptsComparable ||
        (input.stickyRuntime?.providerAttempts ?? 0) <= (input.coldRuntime?.providerAttempts ?? 0),
      status: providerAttemptsComparable
        ? (input.stickyRuntime?.providerAttempts ?? 0) <= (input.coldRuntime?.providerAttempts ?? 0)
          ? "pass"
          : "fail"
        : "skip",
      detail: providerAttemptsComparable
        ? `${input.stickyRuntime!.providerAttempts} <= ${input.coldRuntime!.providerAttempts}`
        : "SKIPPED: provider attempt counts not supplied; runtime_safe_candidate remains disabled"
    },
    {
      name: "sticky_context_fresh",
      ok: input.stickyRuntime?.staleContext !== true,
      status: input.stickyRuntime?.staleContext === true
        ? "fail"
        : input.stickyRuntime?.staleContext === false
          ? "pass"
          : "skip",
      detail: input.stickyRuntime?.staleContext === true
        ? "sticky runtime marked context stale"
        : input.stickyRuntime?.staleContext === false
          ? "sticky runtime marked context fresh"
          : "SKIPPED: sticky context freshness not supplied; runtime_safe_candidate remains disabled"
    },
    {
      name: "cold_packet_ok",
      ok: input.cold.ok,
      status: input.cold.ok ? "pass" : "fail",
      detail: input.cold.ok ? "cold packet gates passed" : "cold packet gates failed; paired comparison cannot be advisory"
    }
  ];
}

function buildStickyVsColdReport(summary: StickyVsColdSummary): string {
  return [
    "# Sticky vs Cold Eval Report",
    "",
    `Decision: ${summary.decision}`,
    `Public confidence: ${summary.publicConfidence}`,
    `Scenario: ${summary.repo}#${summary.pullNumber} @ ${summary.headSha}`,
    `Suite: ${summary.suite}`,
    "",
    "## Packets",
    "",
    `- Cold: ${summary.packets.cold.ok ? "ok" : "failed"} (${summary.packets.cold.outputDir})`,
    `- Sticky: ${summary.packets.sticky.ok ? "ok" : "failed"} (${summary.packets.sticky.outputDir})`,
    "",
    "## Scorecard Deltas",
    "",
    "| Metric | Sticky - cold |",
    "| --- | ---: |",
    `| Precision | ${summary.deltas.precision} |`,
    `| Recall | ${summary.deltas.recall} |`,
    `| Seeded recall | ${summary.deltas.seededRecall} |`,
    `| True positives | ${summary.deltas.truePositive} |`,
    `| False positives | ${summary.deltas.falsePositive} |`,
    `| False negatives | ${summary.deltas.falseNegative} |`,
    `| Bot findings | ${summary.deltas.botFindings} |`,
    `| Secret findings | ${summary.deltas.secretFindings} |`,
    `| Duplicate findings | ${summary.deltas.duplicateFindings} |`,
    `| Schema drops | ${summary.deltas.droppedFromSchema} |`,
    ...optionalDeltaRows(summary.deltas),
    "",
    "## Gates",
    "",
    ...summary.gates.map((gate) => `- ${gate.status.toUpperCase()} ${gate.name}: ${gate.detail}`),
    "",
    "## Evidence Counts",
    "",
    `- Paired scenarios: ${summary.evidenceCounts.pairedScenarios} / ${summary.thresholds.minRuntimeSafeScenarios}`,
    `- Labeled findings: ${summary.evidenceCounts.labeledFindings} / ${summary.thresholds.minRuntimeSafeLabeledFindings}`,
    `- P0/P1 labels: ${summary.evidenceCounts.p0p1Labels} / ${summary.thresholds.minRuntimeSafeP0P1Labels}`,
    `- Negative-control scenarios: ${summary.evidenceCounts.negativeControlScenarios} / ${summary.thresholds.minRuntimeSafeNegativeControls}`,
    "",
    "## Proof Boundary",
    "",
    summary.proofBoundary,
    ""
  ].join("\n");
}

function optionalDeltaRows(deltas: StickyVsColdSummary["deltas"]): string[] {
  const rows: string[] = [];
  for (const key of ["providerAttempts", "latencyMs", "promptTokens", "outputTokens", "totalTokens", "providerCooldowns"] as const) {
    if (typeof deltas[key] === "number") rows.push(`| ${key} | ${deltas[key]} |`);
  }
  return rows;
}

function optionalNumberDelta<K extends keyof StickyVsColdSummary["deltas"]>(
  key: K,
  cold: number | undefined,
  sticky: number | undefined
): Partial<Pick<StickyVsColdSummary["deltas"], K>> {
  if (typeof cold !== "number" || typeof sticky !== "number") return {};
  return { [key]: sticky - cold } as Partial<Pick<StickyVsColdSummary["deltas"], K>>;
}

function buildScorecard(input: {
  input: EvalScenarioInput;
  evalName: string;
  botFindings: NormalizedEvalFinding[];
  labels: NormalizedEvalFinding[];
  matches: EvalMatch[];
  duplicateCount: number;
  secretCount: number;
  droppedFromSchema: number;
  inlinePreviewCount: number;
  ciMetadataCount: number;
  mergedFixCount: number;
  thresholds: EvalThresholds;
}): EvalScorecard {
  const matchedBotIds = new Set(input.matches.map((match) => match.botFindingId));
  const matchedLabelIds = new Set(input.matches.map((match) => match.labelId));
  const truePositive = matchedBotIds.size;
  const falsePositive = input.botFindings.length - truePositive;
  const falseNegative = input.labels.length - matchedLabelIds.size;
  const seededLabels = input.labels.filter((label) => label.source === "seeded_defect");
  const matchedSeeded = seededLabels.filter((label) => matchedLabelIds.has(label.id)).length;
  const precision = input.botFindings.length === 0 ? (input.labels.length === 0 ? 1 : 0) : truePositive / input.botFindings.length;
  const recall = input.labels.length === 0 ? 1 : truePositive / input.labels.length;
  const seededRecall = seededLabels.length === 0 ? 1 : matchedSeeded / seededLabels.length;
  const p0p1Labels = input.labels.filter((label) => label.severity === "P0" || label.severity === "P1").length;
  const maxWilsonLowerBound = maxRawWilsonLowerBound(input.botFindings, input.matches);
  const exactLineMatches = input.matches.filter((match) => match.kind === "exact_line").length;
  const nearbyLineMatches = input.matches.filter((match) => match.kind === "nearby_line").length;
  const semanticMatches = input.matches.filter((match) => match.kind === "semantic").length;
  const suiteGate = evaluateSuiteRequirements({
    suite: input.input.suite,
    labels: input.labels,
    thresholds: input.thresholds,
    ciMetadataCount: input.ciMetadataCount,
    mergedFixCount: input.mergedFixCount
  });

  return {
    evalName: input.evalName,
    runId: input.input.runId,
    suite: input.input.suite,
    repo: input.input.repo,
    pullNumber: input.input.pullNumber,
    headSha: input.input.headSha,
    counts: {
      botFindings: input.botFindings.length,
      labels: input.labels.length,
      truePositive,
      falsePositive,
      falseNegative,
      exactLineMatches,
      nearbyLineMatches,
      semanticMatches,
      droppedFromSchema: input.droppedFromSchema,
      secretFindings: input.secretCount,
      duplicateFindings: input.duplicateCount,
      inlinePreviews: input.inlinePreviewCount,
      ciMetadata: input.ciMetadataCount,
      mergedFixes: input.mergedFixCount,
      p0p1Labels
    },
    metrics: {
      precision: roundMetric(precision),
      recall: roundMetric(recall),
      seededRecall: roundMetric(seededRecall),
      maxWilsonLowerBound
    },
    thresholds: input.thresholds,
    gates: [
      {
        name: "precision",
        ok: precision >= input.thresholds.minPrecision,
        detail: `${roundMetric(precision)} >= ${input.thresholds.minPrecision}`
      },
      {
        name: "recall",
        ok: recall >= input.thresholds.minRecall,
        detail: `${roundMetric(recall)} >= ${input.thresholds.minRecall}`
      },
      {
        name: "seeded_recall",
        ok: seededRecall >= input.thresholds.minSeededRecall,
        detail: `${roundMetric(seededRecall)} >= ${input.thresholds.minSeededRecall}`
      },
      {
        name: "secret_redaction",
        ok: input.secretCount <= input.thresholds.maxSecretFindings,
        detail: `${input.secretCount} <= ${input.thresholds.maxSecretFindings}`
      },
      {
        name: "schema_valid",
        ok: input.droppedFromSchema === 0,
        detail: `${input.droppedFromSchema} dropped finding(s)`
      },
      {
        name: "duplicate_suppression",
        ok: input.duplicateCount <= input.thresholds.maxDuplicateFindings,
        detail: `${input.duplicateCount} <= ${input.thresholds.maxDuplicateFindings}`
      },
      {
        name: "suite_requirements",
        ok: suiteGate.ok,
        detail: suiteGate.detail
      }
    ]
  };
}

function evaluateSuiteRequirements(input: {
  suite: EvalSuiteName;
  labels: NormalizedEvalFinding[];
  thresholds: EvalThresholds;
  ciMetadataCount: number;
  mergedFixCount: number;
}): { ok: boolean; detail: string } {
  if (input.suite === "seeded_defect_recall") {
    const seeded = input.labels.filter((label) => label.source === "seeded_defect").length;
    return {
      ok: seeded > 0,
      detail: `${seeded} seeded_defect label(s)`
    };
  }
  if (input.suite === "historical_pr_replay") {
    const comparisonLabels = input.labels.filter((label) => label.source !== "seeded_defect").length;
    const evidenceItems = input.ciMetadataCount + input.mergedFixCount;
    return {
      ok: comparisonLabels > 0 && evidenceItems > 0,
      detail: `${comparisonLabels} comparison label(s), ${input.ciMetadataCount} CI evidence item(s), ${input.mergedFixCount} merged-fix evidence item(s)`
    };
  }
  if (input.suite === "safety_redaction") {
    return {
      ok: input.thresholds.maxSecretFindings === 0,
      detail: `maxSecretFindings=${input.thresholds.maxSecretFindings}`
    };
  }
  if (input.suite === "duplicate_suppression") {
    return {
      ok: input.thresholds.maxDuplicateFindings === 0,
      detail: `maxDuplicateFindings=${input.thresholds.maxDuplicateFindings}`
    };
  }
  return { ok: true, detail: "canary shadow suite has no extra fixture requirement" };
}

function matchFindings(botFindings: NormalizedEvalFinding[], labels: NormalizedEvalFinding[]): EvalMatch[] {
  const candidates = labels.flatMap((label) => botFindings
    .filter((finding) => finding.path === label.path)
    .map((finding) => ({ finding, label, kind: classifyMatch(finding, label) }))
    .filter((candidate): candidate is {
      finding: NormalizedEvalFinding;
      label: NormalizedEvalFinding;
      kind: EvalMatch["kind"];
    } => Boolean(candidate.kind)));

  candidates.sort((a, b) =>
    matchRank(a.kind) - matchRank(b.kind) ||
    Math.abs(a.finding.line - a.label.line) - Math.abs(b.finding.line - b.label.line) ||
    b.finding.confidence - a.finding.confidence ||
    a.label.id.localeCompare(b.label.id)
  );

  const usedBotIds = new Set<string>();
  const usedLabelIds = new Set<string>();
  const matches: EvalMatch[] = [];

  for (const candidate of candidates) {
    if (usedBotIds.has(candidate.finding.id) || usedLabelIds.has(candidate.label.id)) continue;
    usedBotIds.add(candidate.finding.id);
    usedLabelIds.add(candidate.label.id);
    matches.push({
      botFindingId: candidate.finding.id,
      labelId: candidate.label.id,
      kind: candidate.kind
    });
  }

  return matches.filter((match) => usedLabelIds.has(match.labelId));
}

function classifyMatch(botFinding: NormalizedEvalFinding, label: NormalizedEvalFinding): EvalMatch["kind"] | undefined {
  if (botFinding.severity !== label.severity) return undefined;
  const overlap = tokenOverlap(botFinding, label);
  if (botFinding.line === label.line && overlap >= 0.25) return "exact_line";
  if (Math.abs(botFinding.line - label.line) <= 3 && overlap >= 0.35) return "nearby_line";
  if (overlap >= 0.55) return "semantic";
  return undefined;
}

function tokenOverlap(a: Pick<Finding, "title" | "body">, b: Pick<Finding, "title" | "body">): number {
  const aTokens = tokenize(`${a.title} ${a.body}`);
  const bTokens = tokenize(`${b.title} ${b.body}`);
  if (aTokens.size === 0 || bTokens.size === 0) return 0;
  const intersection = [...aTokens].filter((token) => bTokens.has(token)).length;
  return intersection / Math.min(aTokens.size, bTokens.size);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((token) => token.length >= 4)
  );
}

function matchRank(kind: EvalMatch["kind"]): number {
  if (kind === "exact_line") return 0;
  if (kind === "nearby_line") return 1;
  return 2;
}

function findDuplicateFindings(findings: NormalizedEvalFinding[]): {
  duplicates: Array<{ duplicateId: string; originalId: string; key: string }>;
} {
  const seen = new Map<string, string>();
  const duplicates: Array<{ duplicateId: string; originalId: string; key: string }> = [];
  for (const finding of findings) {
    const key = `${finding.path}:${finding.line}:${finding.severity}`;
    const originalId = seen.get(key);
    if (originalId) duplicates.push({ duplicateId: finding.id, originalId, key });
    else seen.set(key, finding.id);
  }
  const duplicateIds = new Set(duplicates.map((duplicate) => duplicate.duplicateId));
  for (let index = 0; index < findings.length; index += 1) {
    const finding = findings[index]!;
    if (duplicateIds.has(finding.id)) continue;
    for (const prior of findings.slice(0, index)) {
      if (finding.path !== prior.path || finding.severity !== prior.severity) continue;
      if (finding.line === prior.line) continue;
      if (Math.abs(finding.line - prior.line) > 3) continue;
      if (tokenOverlap(finding, prior) < 0.55) continue;
      duplicateIds.add(finding.id);
      duplicates.push({
        duplicateId: finding.id,
        originalId: prior.id,
        key: `${finding.path}:${prior.line}-${finding.line}:${finding.severity}:nearby_semantic`
      });
      break;
    }
  }
  return { duplicates };
}

function buildRedactionReport(
  input: EvalScenarioInput,
  botFindings: Finding[],
  labels: EvalLabelInput[],
  droppedFromSchema: number
): {
  droppedFromSchema: number;
  secretLikeItems: Array<{ id: string; source: string; field: string }>;
} {
  const botItems = botFindings.map((finding, index) => ({ ...finding, id: `bot-${index + 1}`, source: "bot" }));
  const labelItems = labels.map((label, index) => ({ ...label, id: `label-${index + 1}` }));
  const secretLikeItems = [...botItems, ...labelItems].flatMap((finding) => {
    const items: Array<{ id: string; source: string; field: string }> = [];
    for (const field of ["title", "body"] as const) {
      if (containsSecretLikeText(finding[field])) items.push({ id: finding.id, source: finding.source, field });
    }
    if ("why_this_matters" in finding) {
      const value = finding.why_this_matters;
      if (value && containsSecretLikeText(value)) {
        items.push({ id: finding.id, source: finding.source, field: "why_this_matters" });
      }
    }
    return items;
  });
  const rawPayload = input.rawOutput ?? input.botFindings;
  if (containsSecretLikeText(JSON.stringify(rawPayload))) {
    secretLikeItems.push({
      id: "raw-output",
      source: "raw",
      field: input.rawOutput !== undefined ? "rawOutput" : "botFindings"
    });
  }
  for (const [source, value] of [
    ["labelEvidence", labels.map(extractLabelEvidenceForScan)],
    ["inlinePreviews", input.inlinePreviews ?? []],
    ["ciMetadata", input.ciMetadata ?? []],
    ["mergedFixes", input.mergedFixes ?? []]
  ] as const) {
    if (containsSecretLikeText(JSON.stringify(value))) {
      secretLikeItems.push({
        id: source,
        source: "metadata",
        field: source
      });
    }
  }
  return { droppedFromSchema, secretLikeItems };
}

function buildComparisonCsv(
  botFindings: NormalizedEvalFinding[],
  labels: NormalizedEvalFinding[],
  matches: EvalMatch[]
): string {
  const labelsById = new Map(labels.map((label) => [label.id, label]));
  const botsById = new Map(botFindings.map((finding) => [finding.id, finding]));
  const matchedBotIds = new Set(matches.map((match) => match.botFindingId));
  const matchedLabelIds = new Set(matches.map((match) => match.labelId));
  const rows = [
    ["kind", "match_type", "bot_id", "label_id", "path", "bot_line", "label_line", "severity", "title"].join(",")
  ];

  for (const match of matches) {
    const bot = botsById.get(match.botFindingId);
    const label = labelsById.get(match.labelId);
    if (!bot || !label) continue;
    rows.push([
      "true_positive",
      match.kind,
      bot.id,
      label.id,
      bot.path,
      String(bot.line),
      String(label.line),
      bot.severity,
      bot.title
    ].map(csvCell).join(","));
  }
  for (const bot of botFindings.filter((finding) => !matchedBotIds.has(finding.id))) {
    rows.push(["false_positive", "", bot.id, "", bot.path, String(bot.line), "", bot.severity, bot.title].map(csvCell).join(","));
  }
  for (const label of labels.filter((finding) => !matchedLabelIds.has(finding.id))) {
    rows.push(["false_negative", "", "", label.id, label.path, "", String(label.line), label.severity, label.title].map(csvCell).join(","));
  }
  return `${rows.join("\n")}\n`;
}

function buildCalibrationReport(
  botFindings: NormalizedEvalFinding[],
  labels: NormalizedEvalFinding[],
  matches: EvalMatch[]
): EvalCalibrationReport {
  const bins = confidenceBins(botFindings, matches);
  const promotionReason = choosePromotionReason({
    labeledFindings: labels.length,
    p0p1Labels: labels.filter((label) => label.severity === "P0" || label.severity === "P1").length,
    negativeControlScenarios: labels.length === 0 ? 1 : 0,
    bestWilsonLowerBound: maxRawWilsonLowerBound(botFindings, matches)
  });
  return {
    claim: "uncalibrated",
    bins,
    publicDisplayPolicy: PUBLIC_CONFIDENCE_POLICY,
    promotion: {
      eligible: promotionReason === "eligible",
      reason: promotionReason
    },
    note: "Model confidence is treated as an input feature only until enough labeled findings exist for measured reliability bins. Public comments must show uncalibrated unless the promotion policy passes."
  };
}

function confidenceBins(botFindings: NormalizedEvalFinding[], matches: EvalMatch[]): EvalCalibrationReport["bins"] {
  const matchedBotIds = new Set(matches.map((match) => match.botFindingId));
  return [
    { minConfidence: 0, maxConfidence: 0.5 },
    { minConfidence: 0.5, maxConfidence: 0.8 },
    { minConfidence: 0.8, maxConfidence: 1.01 }
  ].map((bin) => {
    const findings = botFindings.filter((finding) => finding.confidence >= bin.minConfidence && finding.confidence < bin.maxConfidence);
    const matched = findings.filter((finding) => matchedBotIds.has(finding.id)).length;
    const wilsonLowerBound = wilsonLowerBound95(matched, findings.length);
    return {
      minConfidence: bin.minConfidence,
      maxConfidence: bin.maxConfidence === 1.01 ? 1 : bin.maxConfidence,
      findings: findings.length,
      matched,
      empiricalPrecision: roundMetric(findings.length === 0 ? 0 : matched / findings.length),
      wilsonLowerBound: roundMetric(wilsonLowerBound),
      publicLabel: "uncalibrated" as const
    };
  });
}

function maxRawWilsonLowerBound(botFindings: NormalizedEvalFinding[], matches: EvalMatch[]): number {
  const matchedBotIds = new Set(matches.map((match) => match.botFindingId));
  return Math.max(0, ...[
    { minConfidence: 0, maxConfidence: 0.5 },
    { minConfidence: 0.5, maxConfidence: 0.8 },
    { minConfidence: 0.8, maxConfidence: 1.01 }
  ].map((bin) => {
    const findings = botFindings.filter((finding) => finding.confidence >= bin.minConfidence && finding.confidence < bin.maxConfidence);
    const matched = findings.filter((finding) => matchedBotIds.has(finding.id)).length;
    return wilsonLowerBound95(matched, findings.length);
  }));
}

export function buildEvalPromotionDecisionMarkdown(input: EvalSuitePromotionInput): string {
  const labeledFindings = input.scorecards.reduce((sum, scorecard) => sum + scorecard.counts.labels, 0);
  const p0p1Labels = input.scorecards.reduce((sum, scorecard) => sum + scorecard.counts.p0p1Labels, 0);
  const negativeControlScenarios = input.scorecards.filter((scorecard) => scorecard.counts.labels === 0).length;
  const maxWilsonLowerBound = input.scorecards.reduce((max, scorecard) => Math.max(max, scorecard.metrics.maxWilsonLowerBound), 0);
  const reason = !input.ok
    ? input.missingSuites.length > 0
      ? "missing_required_suites"
      : "suite_failed"
    : choosePromotionReason({
      labeledFindings,
      p0p1Labels,
      negativeControlScenarios,
      bestWilsonLowerBound: maxWilsonLowerBound
    });
  const eligible = reason === "eligible";
  const decision = eligible ? "advisory promotion eligible" : "not enough evidence";

  return [
    "# Eval Promotion Decision",
    "",
    `Decision: ${decision}`,
    `Calibrated public confidence: ${eligible ? "eligible for explicit review" : "disabled"}`,
    "",
    "## Evidence Counts",
    "",
    `- Scenario count: ${input.scenarioCount}`,
    `- Required suites missing: ${input.missingSuites.length ? input.missingSuites.join(", ") : "none"}`,
    `- Labeled findings: ${labeledFindings} / ${PUBLIC_CONFIDENCE_POLICY.minLabeledFindings}`,
    `- P0/P1 labels: ${p0p1Labels} / ${PUBLIC_CONFIDENCE_POLICY.minP0P1Labels}`,
    `- Negative-control scenarios: ${negativeControlScenarios} / ${PUBLIC_CONFIDENCE_POLICY.minNegativeControlScenarios}`,
    `- Best Wilson lower bound: ${roundMetric(maxWilsonLowerBound)} / ${PUBLIC_CONFIDENCE_POLICY.minWilsonLowerBound}`,
    "",
    "## Reason",
    "",
    `- ${reason}`,
    "",
    "## Proof Boundary",
    "",
    "This packet is an offline eval artifact. It does not enable public calibrated percentages, change live review posting, or prove broad CodeRabbit parity.",
    ""
  ].join("\n");
}

function choosePromotionReason(input: {
  labeledFindings: number;
  p0p1Labels: number;
  negativeControlScenarios: number;
  bestWilsonLowerBound: number;
}): EvalPromotionReason {
  if (input.labeledFindings < PUBLIC_CONFIDENCE_POLICY.minLabeledFindings) return "insufficient_labeled_findings";
  if (input.p0p1Labels < PUBLIC_CONFIDENCE_POLICY.minP0P1Labels) return "insufficient_p0_p1_labels";
  if (input.negativeControlScenarios < PUBLIC_CONFIDENCE_POLICY.minNegativeControlScenarios) return "insufficient_negative_controls";
  if (input.bestWilsonLowerBound < PUBLIC_CONFIDENCE_POLICY.minWilsonLowerBound) return "wilson_lower_bound_below_threshold";
  return "eligible";
}

function wilsonLowerBound95(successes: number, total: number): number {
  if (total <= 0) return 0;
  const z = 1.96;
  const p = successes / total;
  const denominator = 1 + z ** 2 / total;
  const centre = p + z ** 2 / (2 * total);
  const margin = z * Math.sqrt((p * (1 - p) + z ** 2 / (4 * total)) / total);
  return Math.max(0, (centre - margin) / denominator);
}

function buildInlinePreviews(
  inputPreviews: EvalInlinePreviewInput[] | undefined,
  botFindings: NormalizedEvalFinding[]
): EvalInlinePreviewInput[] {
  const previews = inputPreviews ?? botFindings.map((finding) => ({
    path: finding.path,
    line: finding.line,
    side: "RIGHT" as const,
    severity: finding.severity,
    title: finding.title,
    body: finding.body,
    confidence: finding.confidence
  }));
  return previews.map((preview) => ({
    path: preview.path,
    line: preview.line,
    side: preview.side ?? "RIGHT",
    severity: preview.severity,
    title: redactSecrets(preview.title.trim()),
    body: redactSecrets(preview.body.trim()),
    ...(typeof preview.confidence === "number" ? { confidence: preview.confidence } : {})
  }));
}

function normalizeCiMetadata(items: EvalCiMetadataInput[]): EvalCiMetadataInput[] {
  return items.map((item) => ({
    provider: redactSecrets(item.provider.trim()),
    name: redactSecrets(item.name.trim()),
    status: item.status,
    ...(item.conclusion ? { conclusion: redactSecrets(item.conclusion.trim()) } : {}),
    ...(item.url ? { url: redactSecrets(item.url.trim()) } : {}),
    ...(item.summary ? { summary: redactSecrets(item.summary.trim()) } : {})
  }));
}

function normalizeMergedFixes(items: EvalMergedFixInput[]): EvalMergedFixInput[] {
  return items.map((item) => ({
    repo: redactSecrets(item.repo.trim()),
    pullNumber: item.pullNumber,
    mergeSha: redactSecrets(item.mergeSha.trim()),
    ...(item.path ? { path: redactSecrets(item.path.trim()) } : {}),
    summary: redactSecrets(item.summary.trim())
  }));
}

function normalizeFinding(
  finding: Finding | EvalLabelInput,
  source: "bot" | EvalLabelSource,
  id: string
): NormalizedEvalFinding {
  const whyThisMatters =
    "why_this_matters" in finding && typeof finding.why_this_matters === "string"
      ? finding.why_this_matters
      : undefined;
  const evidence = buildLabelEvidence(finding);
  return {
    id,
    source,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    title: redactSecrets(finding.title.trim()),
    body: redactSecrets(finding.body.trim()),
    confidence: "confidence" in finding && typeof finding.confidence === "number" ? finding.confidence : 1,
    ...(whyThisMatters ? { why_this_matters: redactSecrets(whyThisMatters.trim()) } : {}),
    ...(evidence ? { evidence } : {})
  };
}

function buildLabelEvidence(finding: Finding | EvalLabelInput): Record<string, string> | undefined {
  const evidence: Record<string, string> = {};
  const candidate = finding as unknown as Record<string, unknown>;
  for (const field of ["sourceId", "sourceUrl", "author", "checkName", "mergeSha", "diffSummary"] as const) {
    if (typeof candidate[field] === "string" && candidate[field].trim().length > 0) {
      evidence[field] = redactSecrets(candidate[field].trim());
    }
  }
  return Object.keys(evidence).length > 0 ? evidence : undefined;
}

function defaultEvalOutputDir(input: Pick<EvalScenarioInput, "runId">, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return join("/Volumes/LEXAR/Codex/evals/zcode-glm-pr-review", date, sanitizePathSegment(input.runId));
}

function sanitizePathSegment(value: string): string {
  const sanitized = value.trim().replaceAll(/[^A-Za-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "");
  if (!sanitized) throw new Error("runId must contain at least one safe path character");
  return sanitized.slice(0, 120);
}

function writeJson(path: string, value: unknown): void {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function assertEvalOutputDirSafe(outputDir: string): string {
  const resolvedOutput = resolve(outputDir);
  const gitRoot = findGitRoot(process.cwd());
  if (!gitRoot) return resolvedOutput;
  const realOutput = resolveRealPathForPotentialOutput(resolvedOutput);
  const realGitRoot = realpathSync(gitRoot);
  const relation = relative(realGitRoot, realOutput);
  if (relation === "" || (!relation.startsWith("..") && !isAbsolute(relation))) {
    throw new Error("outputDir must not be inside the current git checkout; write eval packets under /Volumes/LEXAR/Codex/evals or a temp directory");
  }
  return resolvedOutput;
}

function guardOutputDir(outputDir: string): void {
  assertEvalOutputDirSafe(outputDir);
}

function resolveRealPathForPotentialOutput(path: string): string {
  const resolved = resolve(path);
  if (existsSync(resolved)) return realpathSync(resolved);
  const segments: string[] = [];
  let cursor = resolved;
  while (!existsSync(cursor)) {
    const parent = dirname(cursor);
    if (parent === cursor) return resolved;
    segments.unshift(cursor.slice(parent.length + 1));
    cursor = parent;
  }
  return resolve(realpathSync(cursor), ...segments);
}

function findGitRoot(start: string): string | undefined {
  let cursor = resolve(start);
  for (;;) {
    const gitPath = join(cursor, ".git");
    if (existsSync(gitPath)) {
      const stat = statSync(gitPath);
      if (stat.isDirectory() || stat.isFile()) return cursor;
    }
    const parent = dirname(cursor);
    if (parent === cursor) return undefined;
    cursor = parent;
  }
}

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key), redactUnknown(item)]));
  }
  return value;
}

function extractLabelEvidenceForScan(label: EvalLabelInput): Record<string, unknown> {
  return Object.fromEntries(
    (["sourceId", "sourceUrl", "author", "checkName", "mergeSha", "diffSummary"] as const)
      .filter((field) => label[field] !== undefined)
      .map((field) => [field, label[field]])
  );
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function defaultStickyVsColdOutputRoot(input: Pick<StickyVsColdScenarioInput, "runId">, now: Date): string {
  const date = now.toISOString().slice(0, 10);
  return join("/Volumes/LEXAR/Codex/evals/zcode-glm-pr-review", date, sanitizePathSegment(input.runId));
}

function validateStickyVsColdInput(input: StickyVsColdScenarioInput): void {
  validateNonEmpty(input.runId, "runId");
  if (!input.cold || typeof input.cold !== "object") throw new Error("cold scenario is required");
  if (!input.sticky || typeof input.sticky !== "object") throw new Error("sticky scenario is required");
  validateEvalInput(input.cold);
  validateEvalInput(input.sticky);
  if (input.scenarioSource !== undefined) validateScenarioSource(input.scenarioSource);
  if (input.coldRuntime !== undefined) validateStickyRuntimeMetrics(input.coldRuntime, "coldRuntime");
  if (input.stickyRuntime !== undefined) validateStickyRuntimeMetrics(input.stickyRuntime, "stickyRuntime");
  if (input.thresholds !== undefined) validateStickyVsColdThresholds({ ...DEFAULT_STICKY_VS_COLD_THRESHOLDS, ...input.thresholds });

  for (const field of ["repo", "pullNumber", "headSha", "suite"] as const) {
    if (input.cold[field] !== input.sticky[field]) {
      throw new Error(`cold.${field} must match sticky.${field}`);
    }
  }
  validateEquivalentExpectedLabels(input.cold.labels, input.sticky.labels);
}

function validateStickyRuntimeMetrics(metrics: StickyVsColdRuntimeMetrics, labelPath: string): void {
  for (const field of [
    "providerAttempts",
    "latencyMs",
    "promptTokens",
    "outputTokens",
    "totalTokens",
    "providerCooldowns",
    "repoMemoryAgeSeconds"
  ] as const) {
    if (metrics[field] !== undefined && (!Number.isFinite(metrics[field]) || metrics[field] < 0)) {
      throw new Error(`${labelPath}.${field} must be a non-negative number`);
    }
  }
  for (const field of ["memoryPacketSha", "gitnexusPacketSha"] as const) {
    if (metrics[field] !== undefined && !/^[a-f0-9]{64}$/i.test(metrics[field])) {
      throw new Error(`${labelPath}.${field} must be a sha256 hex digest`);
    }
  }
  if (metrics.stickySessionId !== undefined && typeof metrics.stickySessionId !== "string") {
    throw new Error(`${labelPath}.stickySessionId must be a string`);
  }
  if (metrics.staleContext !== undefined && typeof metrics.staleContext !== "boolean") {
    throw new Error(`${labelPath}.staleContext must be a boolean`);
  }
  if (metrics.notes !== undefined && (!Array.isArray(metrics.notes) || metrics.notes.some((note) => typeof note !== "string"))) {
    throw new Error(`${labelPath}.notes must be an array of strings`);
  }
}

function validateStickyVsColdThresholds(thresholds: StickyVsColdThresholds): void {
  for (const key of ["maxFalsePositiveDelta", "maxFalseNegativeDelta", "maxSecretFindingDelta", "maxDuplicateFindingDelta", "maxSchemaDropDelta"] as const) {
    if (!Number.isInteger(thresholds[key]) || thresholds[key] < 0) throw new Error(`${key} must be a non-negative integer`);
    if (thresholds[key] > DEFAULT_STICKY_VS_COLD_THRESHOLDS[key]) {
      throw new Error(`${key} cannot be loosened below the default sticky-vs-cold safety policy`);
    }
  }
  for (const key of ["minRecallDelta", "minSeededRecallDelta"] as const) {
    if (typeof thresholds[key] !== "number" || thresholds[key] < -1 || thresholds[key] > 1) {
      throw new Error(`${key} must be between -1 and 1`);
    }
    if (thresholds[key] < DEFAULT_STICKY_VS_COLD_THRESHOLDS[key]) {
      throw new Error(`${key} cannot be loosened below the default sticky-vs-cold quality policy`);
    }
  }
  if (typeof thresholds.requireProviderAttemptsNotHigher !== "boolean") {
    throw new Error("requireProviderAttemptsNotHigher must be a boolean");
  }
  if (thresholds.requireProviderAttemptsNotHigher !== DEFAULT_STICKY_VS_COLD_THRESHOLDS.requireProviderAttemptsNotHigher) {
    throw new Error("requireProviderAttemptsNotHigher cannot be disabled for sticky-vs-cold promotion");
  }
  for (const key of [
    "minRuntimeSafeScenarios",
    "minRuntimeSafeLabeledFindings",
    "minRuntimeSafeP0P1Labels",
    "minRuntimeSafeNegativeControls"
  ] as const) {
    if (!Number.isInteger(thresholds[key]) || thresholds[key] < 0) throw new Error(`${key} must be a non-negative integer`);
    if (thresholds[key] < DEFAULT_STICKY_VS_COLD_THRESHOLDS[key]) {
      throw new Error(`${key} cannot be loosened below the default sticky-vs-cold promotion policy`);
    }
  }
}

function validateEquivalentExpectedLabels(coldLabels: EvalLabelInput[], stickyLabels: EvalLabelInput[]): void {
  const cold = expectedLabelKeys(coldLabels);
  const sticky = expectedLabelKeys(stickyLabels);
  if (cold.length !== sticky.length) {
    throw new Error(`cold and sticky expected labels must match (${cold.length} != ${sticky.length})`);
  }
  for (let index = 0; index < cold.length; index += 1) {
    if (cold[index] !== sticky[index]) {
      throw new Error("cold and sticky expected labels must match");
    }
  }
}

function expectedLabelKeys(labels: EvalLabelInput[]): string[] {
  return labels
    .filter((label) => label.expected !== false)
    .map((label) => [
      label.source,
      label.severity,
      label.path,
      label.line,
      label.title.trim(),
      label.body.trim(),
      label.sourceId ?? "",
      label.sourceUrl ?? "",
      label.author ?? "",
      label.checkName ?? "",
      label.mergeSha ?? "",
      label.diffSummary ?? ""
    ].join("\u001f"))
    .sort();
}

function validateEvalInput(input: EvalScenarioInput): void {
  validateNonEmpty(input.runId, "runId");
  validateNonEmpty(input.repo, "repo");
  validateNonEmpty(input.headSha, "headSha");
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) throw new Error("pullNumber must be a positive integer");
  if (!REQUIRED_SUITES.includes(input.suite)) throw new Error(`suite must be one of ${REQUIRED_SUITES.join(", ")}`);
  if (!("botFindings" in input)) throw new Error("botFindings is required");
  if (!isFindingEnvelope(input.botFindings)) throw new Error("botFindings must be an array or an object with a findings array");
  if (input.mode !== undefined && !["gating", "exploratory"].includes(input.mode)) throw new Error("mode must be gating or exploratory");
  if (input.scenarioSource !== undefined) validateScenarioSource(input.scenarioSource);
  if (!Array.isArray(input.labels)) throw new Error("labels must be an array");
  if (input.inlinePreviews !== undefined && !Array.isArray(input.inlinePreviews)) throw new Error("inlinePreviews must be an array");
  if (input.ciMetadata !== undefined && !Array.isArray(input.ciMetadata)) throw new Error("ciMetadata must be an array");
  if (input.mergedFixes !== undefined && !Array.isArray(input.mergedFixes)) throw new Error("mergedFixes must be an array");
  for (const [index, label] of input.labels.entries()) validateLabel(label, `labels[${index}]`);
  for (const [index, preview] of (input.inlinePreviews ?? []).entries()) validateInlinePreview(preview, `inlinePreviews[${index}]`);
  for (const [index, item] of (input.ciMetadata ?? []).entries()) validateCiMetadata(item, `ciMetadata[${index}]`);
  for (const [index, item] of (input.mergedFixes ?? []).entries()) validateMergedFix(item, `mergedFixes[${index}]`);
}

function isFindingEnvelope(value: unknown): boolean {
  return Array.isArray(value) || (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Array.isArray((value as { findings?: unknown }).findings)
  );
}

function validateLabel(label: EvalLabelInput, labelPath: string): void {
  if (!["coderabbit", "human", "ci_failure", "merged_fix", "seeded_defect"].includes(label.source)) {
    throw new Error(`${labelPath}.source is invalid`);
  }
  if (!["P0", "P1", "P2", "P3"].includes(label.severity)) throw new Error(`${labelPath}.severity is invalid`);
  validateNonEmpty(label.path, `${labelPath}.path`);
  validateNonEmpty(label.title, `${labelPath}.title`);
  validateNonEmpty(label.body, `${labelPath}.body`);
  if (!Number.isInteger(label.line) || label.line <= 0) throw new Error(`${labelPath}.line must be a positive integer`);
  for (const field of ["sourceId", "sourceUrl", "author", "checkName", "mergeSha", "diffSummary"] as const) {
    if (label[field] !== undefined && typeof label[field] !== "string") throw new Error(`${labelPath}.${field} must be a string`);
  }
}

function validateScenarioSource(source: EvalScenarioSourceInput): void {
  validateNonEmpty(source.path, "scenarioSource.path");
  if (source.sha256 !== undefined && !/^[a-f0-9]{64}$/i.test(source.sha256)) throw new Error("scenarioSource.sha256 must be a sha256 hex digest");
}

function validateInlinePreview(preview: EvalInlinePreviewInput, labelPath: string): void {
  validateNonEmpty(preview.path, `${labelPath}.path`);
  validateNonEmpty(preview.title, `${labelPath}.title`);
  validateNonEmpty(preview.body, `${labelPath}.body`);
  if (!Number.isInteger(preview.line) || preview.line <= 0) throw new Error(`${labelPath}.line must be a positive integer`);
  if (preview.side !== undefined && !["RIGHT", "LEFT"].includes(preview.side)) throw new Error(`${labelPath}.side is invalid`);
  if (preview.severity !== undefined && !["P0", "P1", "P2", "P3"].includes(preview.severity)) {
    throw new Error(`${labelPath}.severity is invalid`);
  }
  if (preview.confidence !== undefined && (typeof preview.confidence !== "number" || preview.confidence < 0 || preview.confidence > 1)) {
    throw new Error(`${labelPath}.confidence must be between 0 and 1`);
  }
}

function validateCiMetadata(item: EvalCiMetadataInput, labelPath: string): void {
  validateNonEmpty(item.provider, `${labelPath}.provider`);
  validateNonEmpty(item.name, `${labelPath}.name`);
  if (!["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "pending"].includes(item.status)) {
    throw new Error(`${labelPath}.status is invalid`);
  }
  for (const field of ["conclusion", "url", "summary"] as const) {
    if (item[field] !== undefined && typeof item[field] !== "string") throw new Error(`${labelPath}.${field} must be a string`);
  }
}

function validateMergedFix(item: EvalMergedFixInput, labelPath: string): void {
  validateNonEmpty(item.repo, `${labelPath}.repo`);
  validateNonEmpty(item.mergeSha, `${labelPath}.mergeSha`);
  validateNonEmpty(item.summary, `${labelPath}.summary`);
  if (!Number.isInteger(item.pullNumber) || item.pullNumber <= 0) throw new Error(`${labelPath}.pullNumber must be a positive integer`);
  if (item.path !== undefined && typeof item.path !== "string") throw new Error(`${labelPath}.path must be a string`);
}

function validateThresholds(thresholds: EvalThresholds): void {
  for (const key of ["minPrecision", "minRecall", "minSeededRecall"] as const) {
    if (typeof thresholds[key] !== "number" || thresholds[key] < 0 || thresholds[key] > 1) {
      throw new Error(`${key} must be between 0 and 1`);
    }
  }
  for (const key of ["maxSecretFindings", "maxDuplicateFindings"] as const) {
    if (!Number.isInteger(thresholds[key]) || thresholds[key] < 0) throw new Error(`${key} must be a non-negative integer`);
  }
}

function validateThresholdPolicy(mode: "gating" | "exploratory", thresholds: Partial<EvalThresholds>): void {
  if (mode === "exploratory") return;
  for (const key of ["minPrecision", "minRecall", "minSeededRecall"] as const) {
    if (thresholds[key] !== undefined && thresholds[key] < DEFAULT_THRESHOLDS[key]) {
      throw new Error(`${key} below the default requires mode="exploratory"`);
    }
  }
  for (const key of ["maxSecretFindings", "maxDuplicateFindings"] as const) {
    if (thresholds[key] !== undefined && thresholds[key] > DEFAULT_THRESHOLDS[key]) {
      throw new Error(`${key} above the default requires mode="exploratory"`);
    }
  }
}

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}
