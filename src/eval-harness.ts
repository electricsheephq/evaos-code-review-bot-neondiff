import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  rawOutput?: unknown;
  botFindings: unknown;
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
  expected?: boolean;
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
  };
  metrics: {
    precision: number;
    recall: number;
    seededRecall: number;
  };
  thresholds: EvalThresholds;
  gates: Array<{ name: string; ok: boolean; detail: string }>;
}

interface NormalizedEvalFinding extends Finding {
  id: string;
  source: "bot" | EvalLabelSource;
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

const REQUIRED_SUITES: EvalSuiteName[] = [
  "canary_shadow",
  "historical_pr_replay",
  "seeded_defect_recall",
  "safety_redaction",
  "duplicate_suppression"
];

export function runOfflineEval(input: EvalScenarioInput, options: EvalRunOptions = {}): EvalRunResult {
  validateEvalInput(input);
  const thresholds = { ...DEFAULT_THRESHOLDS, ...(input.thresholds ?? {}) };
  validateThresholds(thresholds);

  const evalName = input.evalName ?? "evaos-zcode-review-bot-comparison-v0.1";
  const outputDir = options.outputDir ?? defaultEvalOutputDir(input, options.now ?? new Date());
  mkdirSync(outputDir, { recursive: true });

  const parsedBot = parseFindings(input.botFindings);
  const botFindings = parsedBot.findings.map((finding, index) => normalizeFinding(finding, "bot", `bot-${index + 1}`));
  const labels = input.labels
    .filter((label) => label.expected !== false)
    .map((label, index) => normalizeFinding(label, label.source, `label-${index + 1}`));
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
    thresholds
  });

  const artifacts: Record<string, string> = {
    "manifest.json": join(outputDir, "manifest.json"),
    "raw-output.json": join(outputDir, "raw-output.json"),
    "normalized-findings.json": join(outputDir, "normalized-findings.json"),
    "redaction-report.json": join(outputDir, "redaction-report.json"),
    "duplicate-report.json": join(outputDir, "duplicate-report.json"),
    "comparison.csv": join(outputDir, "comparison.csv"),
    "labels.json": join(outputDir, "labels.json"),
    "calibration-report.json": join(outputDir, "calibration-report.json"),
    "scorecard.json": join(outputDir, "scorecard.json")
  };

  writeJson(artifacts["manifest.json"]!, {
    evalName,
    runId: input.runId,
    suite: input.suite,
    requiredSuites: REQUIRED_SUITES,
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    generatedAt: (options.now ?? new Date()).toISOString(),
    proofBoundary: "offline comparison packet only; no GitHub posting or repo mutation"
  });
  writeJson(artifacts["raw-output.json"]!, redactUnknown(input.rawOutput ?? input.botFindings));
  writeJson(artifacts["normalized-findings.json"]!, {
    botFindings,
    droppedFromSchema: parsedBot.dropped.map(redactUnknown)
  });
  writeJson(artifacts["redaction-report.json"]!, redactionReport);
  writeJson(artifacts["duplicate-report.json"]!, duplicateReport);
  writeFileSync(artifacts["comparison.csv"]!, buildComparisonCsv(botFindings, labels, matches));
  writeJson(artifacts["labels.json"]!, labels);
  writeJson(artifacts["calibration-report.json"]!, buildCalibrationReport(botFindings, matches));
  writeJson(artifacts["scorecard.json"]!, scorecard);

  return {
    ok: scorecard.gates.every((gate) => gate.ok),
    outputDir,
    scorecard,
    artifacts
  };
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
  const exactLineMatches = input.matches.filter((match) => match.kind === "exact_line").length;
  const nearbyLineMatches = input.matches.filter((match) => match.kind === "nearby_line").length;
  const semanticMatches = input.matches.filter((match) => match.kind === "semantic").length;

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
      duplicateFindings: input.duplicateCount
    },
    metrics: {
      precision: roundMetric(precision),
      recall: roundMetric(recall),
      seededRecall: roundMetric(seededRecall)
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
      }
    ]
  };
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

function buildCalibrationReport(botFindings: NormalizedEvalFinding[], matches: EvalMatch[]): {
  claim: "uncalibrated";
  bins: Array<{ minConfidence: number; maxConfidence: number; findings: number; matched: number; empiricalPrecision: number }>;
  note: string;
} {
  const matchedBotIds = new Set(matches.map((match) => match.botFindingId));
  const bins = [
    { minConfidence: 0, maxConfidence: 0.5 },
    { minConfidence: 0.5, maxConfidence: 0.8 },
    { minConfidence: 0.8, maxConfidence: 1.01 }
  ].map((bin) => {
    const findings = botFindings.filter((finding) => finding.confidence >= bin.minConfidence && finding.confidence < bin.maxConfidence);
    const matched = findings.filter((finding) => matchedBotIds.has(finding.id)).length;
    return {
      minConfidence: bin.minConfidence,
      maxConfidence: bin.maxConfidence === 1.01 ? 1 : bin.maxConfidence,
      findings: findings.length,
      matched,
      empiricalPrecision: roundMetric(findings.length === 0 ? 0 : matched / findings.length)
    };
  });
  return {
    claim: "uncalibrated",
    bins,
    note: "Model confidence is treated as an input feature only until enough labeled findings exist for calibrated public claims."
  };
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
  return {
    id,
    source,
    severity: finding.severity,
    path: finding.path,
    line: finding.line,
    title: redactSecrets(finding.title.trim()),
    body: redactSecrets(finding.body.trim()),
    confidence: "confidence" in finding && typeof finding.confidence === "number" ? finding.confidence : 1,
    ...(whyThisMatters ? { why_this_matters: redactSecrets(whyThisMatters.trim()) } : {})
  };
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

function redactUnknown(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactSecrets(key), redactUnknown(item)]));
  }
  return value;
}

function csvCell(value: string): string {
  if (!/[",\n]/.test(value)) return value;
  return `"${value.replaceAll("\"", "\"\"")}"`;
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function validateEvalInput(input: EvalScenarioInput): void {
  validateNonEmpty(input.runId, "runId");
  validateNonEmpty(input.repo, "repo");
  validateNonEmpty(input.headSha, "headSha");
  if (!Number.isInteger(input.pullNumber) || input.pullNumber <= 0) throw new Error("pullNumber must be a positive integer");
  if (!REQUIRED_SUITES.includes(input.suite)) throw new Error(`suite must be one of ${REQUIRED_SUITES.join(", ")}`);
  if (!("botFindings" in input)) throw new Error("botFindings is required");
  if (!isFindingEnvelope(input.botFindings)) throw new Error("botFindings must be an array or an object with a findings array");
  if (!Array.isArray(input.labels)) throw new Error("labels must be an array");
  for (const [index, label] of input.labels.entries()) validateLabel(label, `labels[${index}]`);
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

function validateNonEmpty(value: string, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
}
