import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import {
  assertEvalOutputDirSafe,
  buildEvalThresholds,
  countEvalFalsePositiveSeverities,
  guardEmptyOutputRoot,
  runOfflineEval,
  type EvalLabelInput,
  type EvalRunResult,
  type EvalScenarioInput,
  type EvalScorecard,
  type EvalSuiteName
} from "./eval-harness.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";
import type { Severity } from "./types.js";
import { codeUnitCompare, type RepoWikiPacket } from "./repo-wiki-packet.js";

export type RepoWikiEvalMode = "baseline" | "deterministic" | "openwiki";

const REPO_WIKI_EVAL_MODES = ["baseline", "deterministic", "openwiki"] as const;

export interface RepoWikiContextModeInput {
  botFindings: unknown;
  rawOutput?: unknown;
  packetSha?: string;
  freshness?: "fresh" | "stale" | "missing" | "unknown";
  degraded?: boolean;
}

export interface RepoWikiContextAbEvalInput {
  evalName?: string;
  runId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  suite: EvalSuiteName;
  labels: EvalLabelInput[];
  thresholds?: EvalScenarioInput["thresholds"];
  providerProof?: {
    mode?: "offline_fixture" | "zai_glm" | "unknown";
    paidFallbackUsed?: boolean;
    notes?: string;
  };
  modes: Record<RepoWikiEvalMode, RepoWikiContextModeInput>;
}

export interface RepoWikiContextAbEvalSummary {
  evalName: string;
  artifactVersion: "0.1";
  runId: string;
  repo: string;
  pullNumber: number;
  headSha: string;
  suite: EvalSuiteName;
  ok: boolean;
  generatedAt: string;
  proofBoundary: string;
  providerProof: {
    mode: "offline_fixture" | "zai_glm" | "unknown";
    paidFallbackUsed: boolean;
    notes?: string;
  };
  modes: Record<RepoWikiEvalMode, RepoWikiModeSummary>;
  comparisons: Record<Exclude<RepoWikiEvalMode, "baseline">, RepoWikiComparisonSummary>;
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  artifactInventory: Array<{ name: string; sha256: string }>;
}

export interface RepoWikiModeSummary {
  outputDir: string;
  ok: boolean;
  packetSha?: string;
  freshness?: string;
  degraded?: boolean;
  scorecard: EvalScorecard;
  falsePositiveSeverities: Record<Severity, number>;
  p0p1FalsePositives: number;
}

export interface RepoWikiComparisonSummary {
  precisionDelta: number;
  recallDelta: number;
  falsePositiveDelta: number;
  p0p1FalsePositiveDelta: number;
  secretFindingDelta: number;
}

export interface RepoWikiContextAbEvalResult {
  ok: boolean;
  outputRoot: string;
  summary: RepoWikiContextAbEvalSummary;
  artifacts: Record<string, string>;
}

export interface DocsDriftSeedClaim {
  id: string;
  expected: "stale" | "true";
  docPath: string;
  line: number;
  claim: string;
  sourcePath: string;
  currentText: string;
  suggestion: string;
}

export interface DocsDriftEvalInput {
  evalName?: string;
  runId: string;
  repo: string;
  headSha: string;
  worktreePath: string;
  packetPath: string;
  claims: DocsDriftSeedClaim[];
  thresholds?: {
    minStaleCaught?: number;
    maxMaterialFalsePositives?: number;
  };
}

export interface DocsDriftEvalSummary {
  evalName: string;
  artifactVersion: "0.1";
  runId: string;
  repo: string;
  headSha: string;
  ok: boolean;
  generatedAt: string;
  packet: {
    path: string;
    sha256?: string;
    freshness: string;
    degraded: boolean;
    includedSourceFiles: string[];
  };
  thresholds: {
    minStaleCaught: number;
    maxMaterialFalsePositives: number;
  };
  counts: {
    staleClaims: number;
    trueTraps: number;
    staleCaught: number;
    materialFalsePositives: number;
    suggestions: number;
  };
  claims: Array<{
    id: string;
    expected: "stale" | "true";
    detected: "suggested" | "not_suggested";
    ok: boolean;
    detail: string;
  }>;
  suggestions: DocsDriftSuggestion[];
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  artifactInventory: Array<{ name: string; sha256: string }>;
  proofBoundary: string;
}

export interface DocsDriftSuggestion {
  claimId: string;
  docPath: string;
  line: number;
  currentClaim: string;
  suggestedText: string;
  sourceCitation: {
    path: string;
    text: string;
  };
  packetSectionIds: string[];
}

export interface DocsDriftEvalResult {
  ok: boolean;
  outputRoot: string;
  summary: DocsDriftEvalSummary;
  artifacts: Record<string, string>;
}

export function runRepoWikiContextAbEval(
  input: RepoWikiContextAbEvalInput,
  options: { outputRoot: string; now?: Date }
): RepoWikiContextAbEvalResult {
  const now = options.now ?? new Date();
  const evalName = input.evalName ?? "neondiff-openwiki-context-ab-v0.1";
  const modeInputs = validateRepoWikiContextAbModes(input.modes);
  validateRepoWikiContextAbThresholds(input.thresholds);
  const outputRoot = assertEvalOutputDirSafe(options.outputRoot);
  guardEmptyOutputRoot(outputRoot, "repo-wiki context A/B eval");
  mkdirSync(outputRoot, { recursive: true });
  const modes = Object.fromEntries(
    REPO_WIKI_EVAL_MODES.map((mode) => {
      const modeInput = modeInputs[mode];
      const result = runOfflineEval({
        evalName,
        runId: `${input.runId}-${mode}`,
        repo: input.repo,
        pullNumber: input.pullNumber,
        headSha: input.headSha,
        suite: input.suite,
        labels: input.labels,
        thresholds: input.thresholds,
        botFindings: modeInput.botFindings,
        rawOutput: modeInput.rawOutput
      }, {
        outputDir: join(outputRoot, mode),
        now
      });
      return [mode, summarizeMode({ modeInput, result })];
    })
  ) as Record<RepoWikiEvalMode, RepoWikiModeSummary>;

  const comparisons = {
    deterministic: compareMode(modes.baseline, modes.deterministic),
    openwiki: compareMode(modes.baseline, modes.openwiki)
  };
  const providerProof = {
    mode: input.providerProof?.mode ?? "offline_fixture",
    paidFallbackUsed: input.providerProof?.paidFallbackUsed ?? false,
    ...(input.providerProof?.notes ? { notes: redactSecrets(input.providerProof.notes) } : {})
  };
  const gates = buildAbGates({ modes, comparisons, providerProof });
  const summaryPath = join(outputRoot, "repo-wiki-context-ab-summary.json");
  const reportPath = join(outputRoot, "repo-wiki-context-ab-report.md");
  const summaryWithoutInventory: Omit<RepoWikiContextAbEvalSummary, "artifactInventory"> = {
    evalName,
    artifactVersion: "0.1",
    runId: input.runId,
    repo: input.repo,
    pullNumber: input.pullNumber,
    headSha: input.headSha,
    suite: input.suite,
    ok: gates.every((gate) => gate.ok),
    generatedAt: now.toISOString(),
    proofBoundary: "offline A/B eval packet only; no model call, GitHub posting, daemon enablement, cron, or production config change",
    providerProof,
    modes,
    comparisons,
    gates
  };
  assertNoSecretLikeText(summaryWithoutInventory, "repo-wiki context A/B summary");
  const reportText = buildAbReport(summaryWithoutInventory);
  assertNoSecretLikeText(reportText, "repo-wiki context A/B report");
  writeJson(reportPath, reportText);
  const artifactInventory = buildArtifactInventory(outputRoot, [
    "baseline/scorecard.json",
    "deterministic/scorecard.json",
    "openwiki/scorecard.json",
    "repo-wiki-context-ab-report.md"
  ]);
  const summary = { ...summaryWithoutInventory, artifactInventory };
  assertNoSecretLikeText(summary, "repo-wiki context A/B summary with artifact inventory");
  writeJson(summaryPath, summary);
  return {
    ok: summary.ok,
    outputRoot,
    summary,
    artifacts: {
      "repo-wiki-context-ab-summary.json": summaryPath,
      "repo-wiki-context-ab-report.md": reportPath
    }
  };
}

function validateRepoWikiContextAbModes(value: unknown): Record<RepoWikiEvalMode, RepoWikiContextModeInput> {
  if (!isRecord(value)) {
    throw new Error("repoWikiContextAb.modes must be an object");
  }
  for (const mode of REPO_WIKI_EVAL_MODES) {
    if (!isRecord(value[mode])) {
      throw new Error(`repoWikiContextAb.modes.${mode} is required`);
    }
  }
  return value as Record<RepoWikiEvalMode, RepoWikiContextModeInput>;
}

function validateRepoWikiContextAbThresholds(thresholds: EvalScenarioInput["thresholds"]): void {
  buildEvalThresholds(thresholds, "gating");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function runDocsDriftEval(
  input: DocsDriftEvalInput,
  options: { outputRoot: string; now?: Date }
): DocsDriftEvalResult {
  const now = options.now ?? new Date();
  const evalName = input.evalName ?? "neondiff-openwiki-docs-drift-v0.1";
  const thresholds = validateDocsDriftThresholds(input.thresholds);
  const outputRoot = assertEvalOutputDirSafe(options.outputRoot);
  guardEmptyOutputRoot(outputRoot, "OpenWiki docs-drift eval");
  const packet = readRepoWikiPacket(input);
  const suggestions: DocsDriftSuggestion[] = [];
  const claims = input.claims.map((claim) => {
    const result = evaluateDocsDriftClaim({ claim, input, packet });
    if (result.suggestion) suggestions.push(result.suggestion);
    return result.claimSummary;
  });
  const staleClaims = input.claims.filter((claim) => claim.expected === "stale").length;
  const trueTraps = input.claims.filter((claim) => claim.expected === "true").length;
  const staleCaught = claims.filter((claim) => claim.expected === "stale" && claim.detected === "suggested").length;
  const materialFalsePositives = claims.filter((claim) => claim.expected === "true" && claim.detected === "suggested").length;
  const gates = [
    {
      name: "packet_readable",
      ok: packet.ok,
      detail: packet.ok ? "curated repo-wiki packet parsed" : packet.error ?? "packet parse failed"
    },
    {
      name: "stale_claim_recall",
      ok: staleCaught >= thresholds.minStaleCaught,
      detail: `${staleCaught} >= ${thresholds.minStaleCaught}`
    },
    {
      name: "false_positive_limit",
      ok: materialFalsePositives <= thresholds.maxMaterialFalsePositives,
      detail: `${materialFalsePositives} <= ${thresholds.maxMaterialFalsePositives}`
    },
    {
      name: "suggestions_have_citations",
      ok: suggestions.every((suggestion) => suggestion.sourceCitation.path.length > 0 && suggestion.packetSectionIds.length > 0),
      detail: `${suggestions.length} suggestion(s) checked`
    }
  ];
  const suggestionsPath = join(outputRoot, "suggested-doc-edits.md");
  const summaryPath = join(outputRoot, "docs-drift-summary.json");
  const reportPath = join(outputRoot, "docs-drift-report.md");
  const summaryWithoutInventory: Omit<DocsDriftEvalSummary, "artifactInventory"> = {
    evalName,
    artifactVersion: "0.1",
    runId: input.runId,
    repo: input.repo,
    headSha: input.headSha,
    ok: gates.every((gate) => gate.ok),
    generatedAt: now.toISOString(),
    packet: {
      path: input.packetPath,
      ...(packet.packetSha ? { sha256: packet.packetSha } : {}),
      freshness: packet.repoWiki?.source.status ?? "unknown",
      degraded: packet.repoWiki?.degraded ?? true,
      includedSourceFiles: packet.includedSourceFiles
    },
    thresholds,
    counts: {
      staleClaims,
      trueTraps,
      staleCaught,
      materialFalsePositives,
      suggestions: suggestions.length
    },
    claims,
    suggestions,
    gates,
    proofBoundary: "suggest-only docs-drift eval artifact; no docs, source, config, workflow, daemon, or GitHub comments are modified"
  };
  assertNoSecretLikeText(summaryWithoutInventory, "docs-drift summary");
  const suggestionsText = formatDocsDriftSuggestions(suggestions);
  const reportText = buildDocsDriftReport(summaryWithoutInventory);
  assertNoSecretLikeText(suggestionsText, "docs-drift suggestions");
  assertNoSecretLikeText(reportText, "docs-drift report");
  mkdirSync(outputRoot, { recursive: true });
  writeFileSync(suggestionsPath, suggestionsText, "utf8");
  writeJson(reportPath, reportText);
  const artifactInventory = buildArtifactInventory(outputRoot, [
    "suggested-doc-edits.md",
    "docs-drift-report.md"
  ]);
  const summary = { ...summaryWithoutInventory, artifactInventory };
  assertNoSecretLikeText(summary, "docs-drift summary with artifact inventory");
  writeJson(summaryPath, summary);
  return {
    ok: summary.ok,
    outputRoot,
    summary,
    artifacts: {
      "docs-drift-summary.json": summaryPath,
      "docs-drift-report.md": reportPath,
      "suggested-doc-edits.md": suggestionsPath
    }
  };
}

function validateDocsDriftThresholds(thresholds: DocsDriftEvalInput["thresholds"]): DocsDriftEvalSummary["thresholds"] {
  const merged = {
    minStaleCaught: thresholds?.minStaleCaught ?? 4,
    maxMaterialFalsePositives: thresholds?.maxMaterialFalsePositives ?? 0
  };
  if (!Number.isInteger(merged.minStaleCaught) || merged.minStaleCaught < 1) {
    throw new Error("minStaleCaught must be a positive integer");
  }
  if (!Number.isInteger(merged.maxMaterialFalsePositives) || merged.maxMaterialFalsePositives < 0) {
    throw new Error("maxMaterialFalsePositives must be a non-negative integer");
  }
  return merged;
}

function summarizeMode(input: {
  modeInput: RepoWikiContextModeInput;
  result: EvalRunResult;
}): RepoWikiModeSummary {
  const falsePositiveSeverities = countFalsePositiveSeverities(input.result.scorecard);
  return {
    outputDir: input.result.outputDir,
    ok: input.result.ok,
    ...(input.modeInput.packetSha ? { packetSha: input.modeInput.packetSha } : {}),
    ...(input.modeInput.freshness ? { freshness: input.modeInput.freshness } : {}),
    ...(typeof input.modeInput.degraded === "boolean" ? { degraded: input.modeInput.degraded } : {}),
    scorecard: input.result.scorecard,
    falsePositiveSeverities,
    p0p1FalsePositives: falsePositiveSeverities.P0 + falsePositiveSeverities.P1
  };
}

function compareMode(baseline: RepoWikiModeSummary, candidate: RepoWikiModeSummary): RepoWikiComparisonSummary {
  return {
    precisionDelta: roundMetric(candidate.scorecard.metrics.precision - baseline.scorecard.metrics.precision),
    recallDelta: roundMetric(candidate.scorecard.metrics.recall - baseline.scorecard.metrics.recall),
    falsePositiveDelta: candidate.scorecard.counts.falsePositive - baseline.scorecard.counts.falsePositive,
    p0p1FalsePositiveDelta: candidate.p0p1FalsePositives - baseline.p0p1FalsePositives,
    secretFindingDelta: candidate.scorecard.counts.secretFindings - baseline.scorecard.counts.secretFindings
  };
}

function buildAbGates(input: {
  modes: Record<RepoWikiEvalMode, RepoWikiModeSummary>;
  comparisons: Record<Exclude<RepoWikiEvalMode, "baseline">, RepoWikiComparisonSummary>;
  providerProof: RepoWikiContextAbEvalSummary["providerProof"];
}): RepoWikiContextAbEvalSummary["gates"] {
  return [
    ...(["baseline", "deterministic", "openwiki"] as const).map((mode) => ({
      name: `${mode}_scorecard_ok`,
      ok: input.modes[mode].ok,
      detail: input.modes[mode].ok ? "offline scorecard passed" : "offline scorecard failed"
    })),
    ...(["deterministic", "openwiki"] as const).flatMap((mode) => [
      {
        name: `${mode}_precision_neutral_or_better`,
        ok: input.comparisons[mode].precisionDelta >= 0,
        detail: `${input.comparisons[mode].precisionDelta} >= 0`
      },
      {
        name: `${mode}_recall_neutral_or_better`,
        ok: input.comparisons[mode].recallDelta >= 0,
        detail: `${input.comparisons[mode].recallDelta} >= 0`
      },
      {
        name: `${mode}_no_p0_p1_false_positive_regression`,
        ok: input.comparisons[mode].p0p1FalsePositiveDelta <= 0,
        detail: `${input.comparisons[mode].p0p1FalsePositiveDelta} <= 0`
      },
      {
        name: `${mode}_no_secret_regression`,
        ok: input.comparisons[mode].secretFindingDelta <= 0,
        detail: `${input.comparisons[mode].secretFindingDelta} <= 0`
      }
    ]),
    {
      name: "no_paid_provider_fallback",
      ok: input.providerProof.paidFallbackUsed === false,
      detail: input.providerProof.paidFallbackUsed
        ? "provider proof reports paid fallback"
        : input.providerProof.mode === "offline_fixture"
          ? "offline fixture made no provider call and reports no paid fallback"
        : `${input.providerProof.mode} reports no paid fallback`
    }
  ];
}

function countFalsePositiveSeverities(scorecard: EvalScorecard): Record<Severity, number> {
  return countEvalFalsePositiveSeverities(scorecard);
}

function readRepoWikiPacket(input: DocsDriftEvalInput): {
  ok: boolean;
  error?: string;
  repoWiki?: RepoWikiPacket;
  packetSha?: string;
  includedSourceFiles: string[];
  sectionIdsBySourcePath: Map<string, string[]>;
} {
  const packetPath = resolveExistingFileInside(input.worktreePath, input.packetPath, "packetPath");
  if (!packetPath.ok) {
    return { ok: false, error: packetPath.error, includedSourceFiles: [], sectionIdsBySourcePath: new Map() };
  }
  const raw = readFileSync(packetPath.path, "utf8");
  if (containsSecretLikeText(raw)) {
    return { ok: false, error: "packet contains secret-like text", includedSourceFiles: [], sectionIdsBySourcePath: new Map() };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!isRepoWikiPacket(parsed)) {
      return {
        ok: false,
        error: "packet JSON did not match repo-wiki packet shape",
        includedSourceFiles: [],
        sectionIdsBySourcePath: new Map()
      };
    }
    const repoWiki = parsed;
    const sectionIdsBySourcePath = new Map<string, string[]>();
    for (const section of repoWiki.includedSections ?? []) {
      for (const sourceFile of section.sourceFiles ?? []) {
        const existing = sectionIdsBySourcePath.get(sourceFile) ?? [];
        existing.push(section.id);
        sectionIdsBySourcePath.set(sourceFile, existing);
      }
    }
    const includedSourceFiles = [...sectionIdsBySourcePath.keys()].sort(codeUnitCompare);
    return {
      ok: true,
      repoWiki,
      packetSha: sha256(raw),
      includedSourceFiles,
      sectionIdsBySourcePath
    };
  } catch (error) {
    return {
      ok: false,
      error: `packet JSON did not parse: ${error instanceof Error ? error.message : String(error)}`,
      includedSourceFiles: [],
      sectionIdsBySourcePath: new Map()
    };
  }
}

function isRepoWikiPacket(value: unknown): value is RepoWikiPacket {
  if (!isRecord(value)) return false;
  if (typeof value.packetVersion !== "string") return false;
  if (!isRecord(value.repo) || typeof value.repo.fullName !== "string") return false;
  if (!isRecord(value.source) || !isRepoWikiSourceStatus(value.source.status)) return false;
  if (typeof value.generatedAt !== "string") return false;
  if (typeof value.advisory !== "string") return false;
  if (typeof value.degraded !== "boolean") return false;
  if (!isRecord(value.byteBudget) || typeof value.byteBudget.maxBytes !== "number" || typeof value.byteBudget.usedBytes !== "number") {
    return false;
  }
  if (!isRecord(value.tokenBudget) || typeof value.tokenBudget.maxTokens !== "number" || typeof value.tokenBudget.usedTokens !== "number") {
    return false;
  }
  if (!isRecord(value.redaction) || typeof value.redaction.status !== "string" || typeof value.redaction.replacementCount !== "number") {
    return false;
  }
  if (!Array.isArray(value.includedSections) || !value.includedSections.every(isRepoWikiIncludedSection)) return false;
  if (!Array.isArray(value.excludedSections)) return false;
  if (!Array.isArray(value.includedFiles)) return false;
  return typeof value.packetSha === "string";
}

function isRepoWikiIncludedSection(value: unknown): value is RepoWikiPacket["includedSections"][number] {
  return isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.title === "string" &&
    typeof value.body === "string" &&
    typeof value.order === "number" &&
    Array.isArray(value.sourceFiles) &&
    value.sourceFiles.every((sourceFile) => typeof sourceFile === "string") &&
    typeof value.byteLength === "number" &&
    typeof value.tokenEstimate === "number" &&
    typeof value.truncated === "boolean" &&
    typeof value.redacted === "boolean";
}

function isRepoWikiSourceStatus(value: unknown): value is RepoWikiPacket["source"]["status"] {
  return value === "fresh" || value === "stale" || value === "missing";
}

function evaluateDocsDriftClaim(input: {
  claim: DocsDriftSeedClaim;
  input: DocsDriftEvalInput;
  packet: ReturnType<typeof readRepoWikiPacket>;
}): {
  claimSummary: DocsDriftEvalSummary["claims"][number];
  suggestion?: DocsDriftSuggestion;
} {
  const docFile = readWorktreeFile(input.input.worktreePath, input.claim.docPath, "docPath");
  const sourceFile = readWorktreeFile(input.input.worktreePath, input.claim.sourcePath, "sourcePath");
  const docText = docFile.ok ? docFile.text : "";
  const sourceText = sourceFile.ok ? sourceFile.text : "";
  const docLine = readLine(docText, input.claim.line);
  const docLineContainsClaim = docLine?.includes(input.claim.claim) ?? false;
  const docContainsClaimElsewhere = docText.includes(input.claim.claim);
  const sourceContainsCurrentText = sourceText.includes(input.claim.currentText);
  const packetSectionIds = input.packet.sectionIdsBySourcePath.get(input.claim.sourcePath) ?? [];
  const sourceBacked = input.packet.ok && packetSectionIds.length > 0 && sourceContainsCurrentText;
  // v0.1 fixtures intentionally use exact, case-sensitive substring matching so seeded claims stay auditable.
  const shouldSuggest = docLineContainsClaim &&
    sourceBacked &&
    input.claim.claim.trim() !== input.claim.currentText.trim();
  const ok = input.claim.expected === "stale" ? shouldSuggest : !shouldSuggest;
  let detail: string;
  if (!docFile.ok) {
    detail = `doc file unreadable: ${docFile.error}`;
  } else if (!sourceFile.ok) {
    detail = `source file unreadable: ${sourceFile.error}`;
  } else if (!docLineContainsClaim) {
    detail = docContainsClaimElsewhere
      ? `doc claim text found, but not at reported line ${input.claim.line}`
      : "doc claim text not found";
  } else if (!sourceContainsCurrentText) {
    detail = "source evidence text not found";
  } else if (packetSectionIds.length === 0) {
    detail = "source path not present in curated packet";
  } else if (shouldSuggest) {
    detail = input.claim.expected === "true"
      ? "true trap would be rewritten; counted as material false positive"
      : "stale claim suggested with source citation";
  } else {
    detail = "claim left unchanged";
  }
  return {
    claimSummary: {
      id: input.claim.id,
      expected: input.claim.expected,
      detected: shouldSuggest ? "suggested" : "not_suggested",
      ok,
      detail
    },
    ...(shouldSuggest
      ? {
          suggestion: {
            claimId: input.claim.id,
            docPath: redactSecrets(input.claim.docPath),
            line: input.claim.line,
            currentClaim: redactSecrets(input.claim.claim),
            suggestedText: redactSecrets(input.claim.suggestion),
            sourceCitation: {
              path: redactSecrets(input.claim.sourcePath),
              text: redactSecrets(input.claim.currentText)
            },
            packetSectionIds: packetSectionIds.map(redactSecrets)
          }
        }
      : {})
  };
}

function readLine(text: string, lineNumber: number): string | undefined {
  if (!Number.isSafeInteger(lineNumber) || lineNumber < 1) return undefined;
  return text.split(/\r?\n/)[lineNumber - 1];
}

function readWorktreeFile(
  worktreePath: string,
  relativePath: string,
  label: string
): { ok: true; text: string } | { ok: false; error: string } {
  const filePath = resolveExistingFileInside(worktreePath, relativePath, label);
  if (!filePath.ok) return { ok: false, error: redactSecrets(filePath.error) };
  try {
    return { ok: true, text: readFileSync(filePath.path, "utf8") };
  } catch (error) {
    return {
      ok: false,
      error: redactSecrets(`could not read ${relativePath}: ${error instanceof Error ? error.message : String(error)}`)
    };
  }
}

function formatDocsDriftSuggestions(suggestions: DocsDriftSuggestion[]): string {
  return [
    "# Suggested Doc Edits",
    "",
    "These are suggest-only eval findings. No source or documentation files were edited.",
    "",
    ...suggestions.flatMap((suggestion) => [
      `## ${suggestion.claimId}`,
      "",
      `- Doc: ${suggestion.docPath}:${suggestion.line}`,
      `- Source: ${suggestion.sourceCitation.path}`,
      `- Packet sections: ${suggestion.packetSectionIds.join(", ")}`,
      "",
      "Current claim:",
      "",
      `> ${suggestion.currentClaim}`,
      "",
      "Suggested replacement:",
      "",
      `> ${suggestion.suggestedText}`,
      ""
    ])
  ].join("\n");
}

function buildAbReport(summary: Omit<RepoWikiContextAbEvalSummary, "artifactInventory">): string {
  return [
    "# Repo-Wiki Context A/B Eval",
    "",
    `Result: ${summary.ok ? "pass" : "fail"}`,
    `Scenario: ${summary.repo}#${summary.pullNumber} @ ${summary.headSha}`,
    "",
    "| Mode | OK | Precision | Recall | False positives | P0/P1 false positives |",
    "| --- | --- | ---: | ---: | ---: | ---: |",
    ...(["baseline", "deterministic", "openwiki"] as const).map((mode) => {
      const scorecard = summary.modes[mode].scorecard;
      return `| ${mode} | ${summary.modes[mode].ok ? "yes" : "no"} | ${scorecard.metrics.precision} | ${scorecard.metrics.recall} | ${scorecard.counts.falsePositive} | ${summary.modes[mode].p0p1FalsePositives} |`;
    }),
    "",
    "## Gates",
    "",
    ...summary.gates.map((gate) => `- ${gate.ok ? "PASS" : "FAIL"} ${gate.name}: ${gate.detail}`),
    "",
    "## Proof Boundary",
    "",
    summary.proofBoundary,
    ""
  ].join("\n");
}

function buildDocsDriftReport(summary: Omit<DocsDriftEvalSummary, "artifactInventory">): string {
  return [
    "# OpenWiki Docs-Drift Suggestion Eval",
    "",
    `Result: ${summary.ok ? "pass" : "fail"}`,
    `Repo: ${summary.repo} @ ${summary.headSha}`,
    `Stale caught: ${summary.counts.staleCaught}/${summary.counts.staleClaims}`,
    `Material false positives: ${summary.counts.materialFalsePositives}/${summary.counts.trueTraps}`,
    "",
    "## Gates",
    "",
    ...summary.gates.map((gate) => `- ${gate.ok ? "PASS" : "FAIL"} ${gate.name}: ${gate.detail}`),
    "",
    "## Proof Boundary",
    "",
    summary.proofBoundary,
    ""
  ].join("\n");
}

function buildArtifactInventory(root: string, names: string[]): Array<{ name: string; sha256: string }> {
  return names
    .map((name) => ({ name, path: join(root, name) }))
    .filter((artifact) => existsSync(artifact.path))
    .map((artifact) => ({ name: artifact.name, sha256: sha256File(artifact.path) }));
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${typeof value === "string" ? value : JSON.stringify(value, null, 2)}\n`, "utf8");
}

function assertNoSecretLikeText(value: unknown, label: string): void {
  const text = typeof value === "string" ? value : JSON.stringify(value) ?? "";
  if (containsSecretLikeText(text)) throw new Error(`${label} contains secret-like text`);
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function roundMetric(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function resolveExistingFileInside(
  rootPath: string,
  candidatePath: string,
  label: string
): { ok: true; path: string } | { ok: false; error: string } {
  const resolvedRoot = resolve(rootPath);
  const resolvedCandidate = resolve(resolvedRoot, candidatePath);
  const lexicalRelation = relative(resolvedRoot, resolvedCandidate);
  if (lexicalRelation === "" || lexicalRelation.startsWith("..") || isAbsolute(lexicalRelation)) {
    return { ok: false, error: `${label} must resolve inside worktreePath` };
  }
  if (!existsSync(resolvedCandidate)) {
    return { ok: false, error: `${label} does not exist` };
  }
  try {
    const realRoot = realpathSync(resolvedRoot);
    const realCandidate = realpathSync(resolvedCandidate);
    const realRelation = relative(realRoot, realCandidate);
    if (realRelation === "" || realRelation.startsWith("..") || isAbsolute(realRelation)) {
      return { ok: false, error: `${label} must resolve inside worktreePath` };
    }
    if (!statSync(realCandidate).isFile()) {
      return { ok: false, error: `${label} must point to a file` };
    }
    return { ok: true, path: realCandidate };
  } catch (error) {
    return { ok: false, error: `${label} could not be resolved safely: ${error instanceof Error ? error.message : String(error)}` };
  }
}
