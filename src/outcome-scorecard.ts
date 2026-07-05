import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

export type OutcomeScoreSurface = "pr_review" | "issue_enrichment";
export type OutcomeMetricState = "measured" | "unmeasurable";

export interface OutcomeScorecardInput {
  evalName?: string;
  runId: string;
  surface: OutcomeScoreSurface;
  scenario: {
    id: string;
    title: string;
    repo?: string;
    url?: string;
    negativeControl?: boolean;
  };
  metrics: OutcomeMetricInput[];
  hardGates?: OutcomeHardGateInput[];
  thresholds?: Partial<OutcomeScoreThresholds>;
}

export interface OutcomeMetricInput {
  id: string;
  label: string;
  weight: number;
  rawScore?: number;
  state?: OutcomeMetricState;
  denominator: string;
  dataSource: string;
  scoringRule: string;
  unmeasurableReason?: string;
  evidenceUrls?: string[];
  notes?: string[];
}

export interface OutcomeHardGateInput {
  name: string;
  ok: boolean;
  detail: string;
}

export interface OutcomeScoreThresholds {
  minWeightedScore: number;
  minEvidenceScoreForScoresAboveThree: number;
}

export interface OutcomeScorecard {
  artifactVersion: "0.1";
  evalName: string;
  runId: string;
  surface: OutcomeScoreSurface;
  scenario: OutcomeScorecardInput["scenario"];
  ok: boolean;
  generatedAt: string;
  rawScoreUncapped: number;
  weightedScore: number;
  maxScore: number;
  publicClaim: "advisory_only";
  metrics: OutcomeMetric[];
  hardGates: OutcomeHardGateInput[];
  caps: Array<{ name: string; applied: boolean; detail: string }>;
  thresholds: OutcomeScoreThresholds;
  proofBoundary: string;
  redaction: {
    ok: boolean;
    redactedSources: Array<{ id: string; redactedPreview: string }>;
  };
  sha256: string;
}

export interface OutcomeMetric extends Required<Omit<OutcomeMetricInput, "rawScore" | "state" | "evidenceUrls" | "notes" | "unmeasurableReason">> {
  rawScore: number;
  state: OutcomeMetricState;
  weightedContribution: number;
  evidenceUrls: string[];
  notes: string[];
  unmeasurableReason: string;
}

const DEFAULT_THRESHOLDS: OutcomeScoreThresholds = {
  minWeightedScore: 4,
  minEvidenceScoreForScoresAboveThree: 1
};

export function readOutcomeScorecardInput(path: string): OutcomeScorecardInput {
  return parseOutcomeScorecardInput(JSON.parse(readFileSync(path, "utf8")));
}

export function parseOutcomeScorecardInput(value: unknown): OutcomeScorecardInput {
  if (!isRecord(value)) throw new Error("outcome scorecard input must be an object");
  const scenario = value.scenario;
  if (!isRecord(scenario)) throw new Error("outcome scorecard input requires scenario");
  const metrics = value.metrics;
  if (!Array.isArray(metrics) || metrics.length === 0) throw new Error("outcome scorecard input requires at least one metric");
  return {
    evalName: optionalString(value.evalName, "evalName"),
    runId: requiredString(value.runId, "runId"),
    surface: parseSurface(value.surface),
    scenario: {
      id: requiredString(scenario.id, "scenario.id"),
      title: requiredString(scenario.title, "scenario.title"),
      repo: optionalString(scenario.repo, "scenario.repo"),
      url: optionalString(scenario.url, "scenario.url"),
      negativeControl: scenario.negativeControl === undefined ? false : requiredBoolean(scenario.negativeControl, "scenario.negativeControl")
    },
    metrics: metrics.map(parseMetric),
    hardGates: optionalArray(value.hardGates, "hardGates").map(parseHardGate),
    thresholds: parseThresholds(value.thresholds)
  };
}

export function buildOutcomeScorecard(input: OutcomeScorecardInput, options: { now?: Date } = {}): OutcomeScorecard {
  const generatedAt = options.now?.toISOString() ?? new Date().toISOString();
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  const redaction = buildRedactionReport(input);
  const maxWeight = input.metrics.reduce((sum, metric) => sum + metric.weight, 0);
  const metrics = input.metrics.map((metric) => normalizeMetric(metric, maxWeight));
  const measuredWeight = metrics.filter((metric) => metric.state === "measured").reduce((sum, metric) => sum + metric.weight, 0);
  const rawScoreUncapped = average(metrics.map((metric) => metric.rawScore));
  const weightedScore = maxWeight === 0
    ? 0
    : metrics.reduce((sum, metric) => sum + metric.weightedContribution, 0);
  const caps = buildCaps({ input, metrics, measuredWeight, maxWeight, redaction, thresholds });
  const scoreCappingFailure = caps.some((cap) => cap.applied && ["evidence_required_for_high_scores", "hard_gate_cap"].includes(cap.name));
  const capMaxScore = caps.some((cap) => cap.applied && cap.name === "safety_cap") ? 1 : scoreCappingFailure ? 3 : 5;
  const maxScore = Math.min(5, capMaxScore);
  const cappedWeightedScore = Math.min(weightedScore, maxScore);
  const hardGates = input.hardGates ?? [];
  const ok = redaction.ok &&
    hardGates.every((gate) => gate.ok) &&
    cappedWeightedScore >= thresholds.minWeightedScore &&
    !caps.some((cap) => cap.applied && cap.name === "safety_cap");
  const base = {
    artifactVersion: "0.1" as const,
    evalName: input.evalName ?? "evaos-outcome-scorecard-v0.1",
    runId: sanitizeId(input.runId),
    surface: input.surface,
    scenario: normalizeScenario(input.scenario),
    ok,
    generatedAt,
    rawScoreUncapped,
    weightedScore: cappedWeightedScore,
    maxScore,
    publicClaim: "advisory_only" as const,
    metrics,
    hardGates: hardGates.map((gate) => ({
      name: sanitizeId(gate.name),
      ok: gate.ok,
      detail: redactSecrets(gate.detail)
    })),
    caps,
    thresholds,
    proofBoundary: "Outcome scorecard fixtures are advisory and executable only for sampled scenarios. They do not prove CodeRabbit parity, calibrated 95% accuracy, release readiness, or production rollout safety.",
    redaction
  };
  return {
    ...base,
    sha256: sha256Json({ ...base, generatedAt: undefined })
  };
}

export function writeOutcomeScorecardPacket(input: {
  scorecardInput: OutcomeScorecardInput;
  outputDir: string;
  now?: Date;
}): OutcomeScorecard {
  const scorecard = buildOutcomeScorecard(input.scorecardInput, { now: input.now });
  if (existsSync(input.outputDir)) throw new Error("outputDir must not already exist for outcome-scorecard");
  mkdirSync(input.outputDir, { recursive: true });
  writeFileSync(join(input.outputDir, "scorecard.json"), `${JSON.stringify(scorecard, null, 2)}\n`);
  writeFileSync(join(input.outputDir, "scorecard.md"), `${renderOutcomeScorecardMarkdown(scorecard)}\n`);
  writeFileSync(join(input.outputDir, "redaction-report.json"), `${JSON.stringify(scorecard.redaction, null, 2)}\n`);
  const artifacts = {
    "scorecard.json": sha256File(join(input.outputDir, "scorecard.json")),
    "scorecard.md": sha256File(join(input.outputDir, "scorecard.md")),
    "redaction-report.json": sha256File(join(input.outputDir, "redaction-report.json"))
  };
  const manifest = {
    artifactVersion: scorecard.artifactVersion,
    evalName: scorecard.evalName,
    runId: scorecard.runId,
    ok: scorecard.ok,
    surface: scorecard.surface,
    rawScoreUncapped: scorecard.rawScoreUncapped,
    weightedScore: scorecard.weightedScore,
    maxScore: scorecard.maxScore,
    publicClaim: scorecard.publicClaim,
    proofBoundary: scorecard.proofBoundary,
    scorecardSha256: scorecard.sha256,
    artifacts,
    packetSha256: sha256Json({
      artifactVersion: scorecard.artifactVersion,
      runId: scorecard.runId,
      scorecardSha256: scorecard.sha256,
      artifacts
    })
  };
  writeFileSync(join(input.outputDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return scorecard;
}

export function renderOutcomeScorecardMarkdown(scorecard: OutcomeScorecard): string {
  return [
    `# Outcome Scorecard: ${scorecard.scenario.id}`,
    "",
    `- Surface: \`${scorecard.surface}\``,
    `- Weighted score: ${scorecard.weightedScore.toFixed(2)} / ${scorecard.maxScore}`,
    `- Uncapped raw score: ${scorecard.rawScoreUncapped.toFixed(2)} / 5`,
    `- Public claim: \`${scorecard.publicClaim}\``,
    "",
    "## Metrics",
    "",
    ...scorecard.metrics.map((metric) => `- [${metric.state}] ${metric.id}: ${metric.rawScore}/5, weight ${metric.weight}, contribution ${metric.weightedContribution.toFixed(2)}${metric.evidenceUrls.length > 0 ? `, evidence ${metric.evidenceUrls.join(", ")}` : ""}${metric.unmeasurableReason ? `, reason ${metric.unmeasurableReason}` : ""}`),
    "",
    "## Hard Gates",
    "",
    ...(scorecard.hardGates.length === 0 ? ["None."] : scorecard.hardGates.map((gate) => `- [${gate.ok ? "pass" : "fail"}] ${gate.name}: ${gate.detail}`)),
    "",
    "## Caps",
    "",
    ...scorecard.caps.map((cap) => `- [${cap.applied ? "applied" : "clear"}] ${cap.name}: ${cap.detail}`),
    "",
    "## Proof Boundary",
    "",
    scorecard.proofBoundary
  ].join("\n");
}

function parseMetric(value: unknown): OutcomeMetricInput {
  if (!isRecord(value)) throw new Error("metrics entries must be objects");
  return {
    id: requiredString(value.id, "metrics.id"),
    label: requiredString(value.label, "metrics.label"),
    weight: requiredPositiveNumber(value.weight, "metrics.weight"),
    rawScore: optionalScore(value.rawScore, "metrics.rawScore"),
    state: value.state === undefined ? undefined : parseMetricState(value.state),
    denominator: requiredString(value.denominator, "metrics.denominator"),
    dataSource: requiredString(value.dataSource, "metrics.dataSource"),
    scoringRule: requiredString(value.scoringRule, "metrics.scoringRule"),
    unmeasurableReason: optionalString(value.unmeasurableReason, "metrics.unmeasurableReason"),
    evidenceUrls: optionalStringArray(value.evidenceUrls, "metrics.evidenceUrls"),
    notes: optionalStringArray(value.notes, "metrics.notes")
  };
}

function normalizeMetric(input: OutcomeMetricInput, maxWeight: number): OutcomeMetric {
  const state = input.state ?? (input.rawScore === undefined ? "unmeasurable" : "measured");
  const rawScore = state === "unmeasurable" ? 0 : clampScore(input.rawScore ?? 0);
  return {
    id: sanitizeId(input.id),
    label: redactSecrets(input.label),
    weight: input.weight,
    rawScore,
    state,
    denominator: redactSecrets(input.denominator),
    dataSource: redactSecrets(input.dataSource),
    scoringRule: redactSecrets(input.scoringRule),
    unmeasurableReason: state === "unmeasurable" ? redactSecrets(input.unmeasurableReason || "metric was not measurable") : "",
    evidenceUrls: (input.evidenceUrls ?? []).map(redactSecrets),
    notes: (input.notes ?? []).map(redactSecrets),
    weightedContribution: maxWeight === 0 ? 0 : rawScore * (input.weight / maxWeight)
  };
}

function buildCaps(input: {
  input: OutcomeScorecardInput;
  metrics: OutcomeMetric[];
  measuredWeight: number;
  maxWeight: number;
  redaction: OutcomeScorecard["redaction"];
  thresholds: OutcomeScoreThresholds;
}): OutcomeScorecard["caps"] {
  const requiredEvidenceLinks = Math.ceil(input.thresholds.minEvidenceScoreForScoresAboveThree);
  const highScoresWithoutEvidence = input.metrics.filter((metric) => (metric.rawScore ?? 0) > 3 && metric.evidenceUrls.length < requiredEvidenceLinks);
  const hardGateFailure = (input.input.hardGates ?? []).some((gate) => !gate.ok);
  const safetyFailure = !input.redaction.ok ||
    (input.input.hardGates ?? []).some((gate) => ["stale_head_post", "unredacted_secret", "invalid_inline_coordinate"].includes(gate.name) && !gate.ok);
  return [
    {
      name: "evidence_required_for_high_scores",
      applied: highScoresWithoutEvidence.length > 0,
      detail: highScoresWithoutEvidence.length > 0
        ? `Scores above 3 require direct evidence links: ${highScoresWithoutEvidence.map((metric) => metric.id).join(", ")}`
        : `All scores above 3 have at least ${requiredEvidenceLinks} evidence link(s).`
    },
    {
      name: "unmeasurable_no_positive_credit",
      applied: input.measuredWeight < input.maxWeight,
      detail: `${input.measuredWeight}/${input.maxWeight} metric weight was measurable; unmeasurable metrics contribute zero.`
    },
    {
      name: "hard_gate_cap",
      applied: hardGateFailure,
      detail: hardGateFailure ? "One or more hard gates failed." : "No hard gates failed."
    },
    {
      name: "safety_cap",
      applied: safetyFailure,
      detail: safetyFailure ? "Safety failure caps score at 1." : "No score-capping safety failure detected."
    }
  ];
}

function normalizeScenario(scenario: OutcomeScorecardInput["scenario"]): OutcomeScorecard["scenario"] {
  return {
    id: sanitizeId(scenario.id),
    title: redactSecrets(scenario.title),
    ...(scenario.repo ? { repo: redactSecrets(scenario.repo) } : {}),
    ...(scenario.url ? { url: redactSecrets(scenario.url) } : {}),
    negativeControl: scenario.negativeControl ?? false
  };
}

function buildRedactionReport(input: OutcomeScorecardInput): OutcomeScorecard["redaction"] {
  const redactedSources = collectStringSources(input)
    .filter((source) => containsSecretLikeText(source.text))
    .map((source) => ({
      id: source.id,
      redactedPreview: redactSecrets(source.text).slice(0, 240)
    }));
  return {
    ok: redactedSources.length === 0,
    redactedSources
  };
}

function parseHardGate(value: unknown): OutcomeHardGateInput {
  if (!isRecord(value)) throw new Error("hardGates entries must be objects");
  return {
    name: requiredString(value.name, "hardGates.name"),
    ok: requiredBoolean(value.ok, "hardGates.ok"),
    detail: requiredString(value.detail, "hardGates.detail")
  };
}

function parseThresholds(value: unknown): Partial<OutcomeScoreThresholds> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new Error("thresholds must be an object");
  return {
    ...(value.minWeightedScore !== undefined ? { minWeightedScore: requiredScore(value.minWeightedScore, "thresholds.minWeightedScore") } : {}),
    ...(value.minEvidenceScoreForScoresAboveThree !== undefined ? {
      minEvidenceScoreForScoresAboveThree: requiredPositiveNumber(value.minEvidenceScoreForScoresAboveThree, "thresholds.minEvidenceScoreForScoresAboveThree")
    } : {})
  };
}

function collectStringSources(input: unknown, prefix = "input"): Array<{ id: string; text: string }> {
  if (typeof input === "string") return [{ id: prefix, text: input }];
  if (Array.isArray(input)) return input.flatMap((item, index) => collectStringSources(item, `${prefix}[${index}]`));
  if (isRecord(input)) return Object.entries(input).flatMap(([key, value]) => collectStringSources(value, `${prefix}.${key}`));
  return [];
}

function parseSurface(value: unknown): OutcomeScoreSurface {
  if (value === "pr_review" || value === "issue_enrichment") return value;
  throw new Error("surface must be pr_review or issue_enrichment");
}

function parseMetricState(value: unknown): OutcomeMetricState {
  if (value === "measured" || value === "unmeasurable") return value;
  throw new Error("metrics.state must be measured or unmeasurable");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value.trim();
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  return value.trim();
}

function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${label} must be an array of strings`);
  return value.map((entry) => entry.trim()).filter(Boolean);
}

function optionalArray(value: unknown, label: string): unknown[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requiredPositiveNumber(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function requiredScore(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 5) throw new Error(`${label} must be between 0 and 5`);
  return value;
}

function optionalScore(value: unknown, label: string): number | undefined {
  if (value === undefined) return undefined;
  return requiredScore(value, label);
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(5, value));
}

function average(values: number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function sanitizeId(value: string): string {
  return redactSecrets(value).trim().replace(/[^A-Za-z0-9_.:-]/g, "-");
}

function sha256Json(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}
