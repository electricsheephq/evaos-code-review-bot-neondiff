import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { assertEvalOutputDirSafe } from "./eval-harness.js";
import { buildIssueEnrichmentComment } from "./enrichment.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import {
  buildLeanReviewShadow,
  buildReviewLensPacket,
  DEFAULT_REVIEW_LENS_CONFIG,
  type LeanReviewShadow,
  type ReviewLensConfig,
  type ReviewLensPacket,
  type ReviewLensSurface
} from "./review-lenses.js";
import { containsSecretLikeText, redactSecrets, stringifyRedactedJson } from "./secrets.js";
import type { PullFilePatch, PullRequestSummary } from "./types.js";
import { buildReviewPrompt } from "./zcode.js";

export type ReviewLensEvalMode = "deterministic" | "model-shadow";
export type ReviewLensEvalSuite = "review_lens_packet_safety";

export interface ReviewLensEvalScenario {
  evalName: string;
  runId: string;
  suite: ReviewLensEvalSuite;
  surface: ReviewLensSurface;
  negativeControl?: boolean;
  reviewLenses: ReviewLensConfig;
  issue?: ReviewLensEvalIssueInput;
  pull?: ReviewLensEvalPullInput;
  files?: PullFilePatch[];
  decision?: {
    status: "block" | "warn" | "accept_with_evidence" | "defer" | "human_review";
    reason: string;
  };
  expected?: {
    includedLenses?: string[];
    omittedReasons?: string[];
    maxPacketBytes?: number;
    secretFindings?: number;
    requestChangesEligible?: false;
    leanSuggestionsMin?: number;
    leanSuggestionsMax?: number;
    architectureSection?: boolean;
  };
}

export interface ReviewLensEvalIssueInput {
  repo: string;
  number: number;
  state: string;
  title: string;
  body?: string;
  html_url?: string;
}

export interface ReviewLensEvalPullInput {
  repo: string;
  number: number;
  title: string;
  draft: boolean;
  body?: string;
  headSha: string;
  baseSha: string;
  headRef: string;
  baseRef: string;
  html_url?: string;
}

export interface ReviewLensEvalOptions {
  scenarios: ReviewLensEvalScenario[];
  outputRoot: string;
  mode: ReviewLensEvalMode;
  dryRun: boolean;
  now?: Date;
}

export interface ReviewLensEvalSummary {
  ok: boolean;
  command: "review-lenses-eval";
  mode: ReviewLensEvalMode;
  dryRun: boolean;
  scenarioCount: number;
  passed: number;
  failed: number;
  outputRoot: string;
  generatedAt: string;
  proofBoundary: string;
  results: ReviewLensEvalRunSummary[];
}

export interface ReviewLensEvalRunSummary {
  ok: boolean;
  evalName: string;
  runId: string;
  suite: ReviewLensEvalSuite;
  surface: ReviewLensSurface;
  outputDir: string;
  scorecard: ReviewLensEvalScorecard;
}

export interface ReviewLensEvalScorecard {
  evalName: string;
  runId: string;
  suite: ReviewLensEvalSuite;
  surface: ReviewLensSurface;
  mode: ReviewLensEvalMode;
  generatedAt: string;
  counts: {
    includedLenses: number;
    omittedLenses: number;
    disallowedDirectiveOmissions: number;
    secretFindings: number;
    rawRedactedSources: number;
    byteEstimate: number;
    leanSuggestions: number;
    requestChangesEligibleSuggestions: number;
  };
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  publicConfidence: "uncalibrated";
  proofBoundary: string;
}

export function readReviewLensEvalScenario(path: string): ReviewLensEvalScenario {
  const parsed = JSON.parse(readFileSync(path, "utf8"));
  return normalizeScenario(parsed, path);
}

export function runReviewLensEval(input: ReviewLensEvalOptions): { summary: ReviewLensEvalSummary } {
  if (!input.dryRun) throw new Error("review-lenses-eval is dry-run only; live posting or config mutation is not implemented");
  if (input.scenarios.length === 0) throw new Error("review-lenses-eval requires at least one scenario");
  const outputRoot = prepareOutputRoot(input.outputRoot);
  const generatedAt = (input.now ?? new Date()).toISOString();

  const seenRunIds = new Set<string>();
  const results = input.scenarios.map((scenario) => {
    if (seenRunIds.has(scenario.runId)) throw new Error(`duplicate review-lenses-eval runId "${scenario.runId}"`);
    seenRunIds.add(scenario.runId);
    return runScenario({ scenario, outputRoot, mode: input.mode, generatedAt });
  });
  const summary: ReviewLensEvalSummary = {
    ok: results.every((result) => result.ok),
    command: "review-lenses-eval",
    mode: input.mode,
    dryRun: input.dryRun,
    scenarioCount: results.length,
    passed: results.filter((result) => result.ok).length,
    failed: results.filter((result) => !result.ok).length,
    outputRoot,
    generatedAt,
    proofBoundary:
      "Review lens eval proves dry-run/eval plumbing only. It does not prove production review-quality improvement, live activation readiness, or calibrated confidence.",
    results
  };
  writeJson(join(outputRoot, "suite-summary.json"), summary);
  writeText(join(outputRoot, "promotion-decision.md"), buildPromotionDecision(summary));
  return { summary };
}

function runScenario(input: {
  scenario: ReviewLensEvalScenario;
  outputRoot: string;
  mode: ReviewLensEvalMode;
  generatedAt: string;
}): ReviewLensEvalRunSummary {
  const outputDir = join(input.outputRoot, input.scenario.runId);
  const baselineDir = join(outputDir, "baseline");
  const lensDir = join(outputDir, "lens");
  mkdirSync(baselineDir, { recursive: true });
  mkdirSync(lensDir, { recursive: true });

  const baselineConfig = { ...DEFAULT_REVIEW_LENS_CONFIG, enabled: false, active: [] };
  const lensBuild = buildReviewLensPacket({
    config: input.scenario.reviewLenses,
    surface: input.scenario.surface,
    generatedAt: input.generatedAt
  });
  const baselineBuild = buildReviewLensPacket({
    config: baselineConfig,
    surface: input.scenario.surface,
    generatedAt: input.generatedAt
  });
  if (!baselineBuild.ok) throw new Error(`Baseline review lens packet failed: ${baselineBuild.error}`);
  const packet = lensBuild.ok ? lensBuild.packet : undefined;
  let leanShadow: LeanReviewShadow | undefined;
  let lensIssueBody: string | undefined;
  const sourceTexts: Array<{ id: string; text: string }> = [
    { id: "scenario", text: JSON.stringify(input.scenario) }
  ];

  if (baselineBuild.ok) {
    writeJson(join(baselineDir, `review-lens-${input.scenario.surface}-packet.json`), baselineBuild.packet);
    writeText(join(baselineDir, `review-lens-${input.scenario.surface}-packet.md`), baselineBuild.packet.markdown);
    sourceTexts.push({ id: "baseline-packet", text: baselineBuild.packet.markdown });
  }

  if (packet) {
    writeJson(join(lensDir, `review-lens-${input.scenario.surface}-packet.json`), packet);
    writeText(join(lensDir, `review-lens-${input.scenario.surface}-packet.md`), packet.markdown);
    sourceTexts.push({ id: "lens-packet", text: packet.markdown });
  }

  if (input.scenario.surface === "issue_enrichment") {
    const issue = scenarioIssue(input.scenario);
    const baselineComment = buildIssueEnrichmentComment({ repo: issue.repo, issue: issue.issue });
    const lensComment = buildIssueEnrichmentComment({
      repo: issue.repo,
      issue: issue.issue,
      ...(packet ? { reviewLensPacket: packet } : {})
    });
    writeText(join(baselineDir, "issue-enrichment.md"), baselineComment.body);
    writeText(join(lensDir, "issue-enrichment.md"), lensComment.body);
    lensIssueBody = lensComment.body;
    sourceTexts.push({ id: "baseline-issue-enrichment", text: baselineComment.body });
    sourceTexts.push({ id: "lens-issue-enrichment", text: lensComment.body });
  } else if (input.scenario.surface === "pr_shadow") {
    const pull = scenarioPull(input.scenario);
    const files = input.scenario.files ?? [];
    const baselinePrompt = buildReviewPrompt({ repo: pull.repo, pull: pull.pull, files });
    const lensPrompt = buildReviewPrompt({
      repo: pull.repo,
      pull: pull.pull,
      files,
      ...(packet ? { reviewLensPacket: packet } : {})
    });
    writeText(join(baselineDir, "review-prompt.md"), baselinePrompt);
    writeText(join(lensDir, "review-prompt.md"), lensPrompt);
    leanShadow = buildLeanReviewShadow({ files });
    writeJson(join(lensDir, "lean-review-shadow.json"), leanShadow);
    sourceTexts.push({ id: "baseline-review-prompt", text: baselinePrompt });
    sourceTexts.push({ id: "lens-review-prompt", text: lensPrompt });
    sourceTexts.push({ id: "lean-review-shadow", text: JSON.stringify(leanShadow) });
  } else {
    writeJson(join(baselineDir, "decision-evidence.json"), {
      status: "not_evaluated",
      reason: "Baseline has no decision lens packet."
    });
    writeJson(join(lensDir, "decision-evidence.json"), {
      ...(input.scenario.decision ?? {
        status: "human_review",
        reason: "No explicit decision fixture supplied."
      }),
      advisoryOnly: true
    });
  }

  if (input.mode === "model-shadow") {
    writeJson(join(outputDir, "model-shadow-summary.json"), {
      mode: "model-shadow",
      providerCalls: 0,
      githubPosts: 0,
      generatedAt: input.generatedAt,
      proofBoundary:
        "No provider call or GitHub posting was performed. This model-shadow packet compares prompt/evidence surfaces only."
    });
  }

  const redactionReport = buildEvalRedactionReport(sourceTexts);
  writeJson(join(outputDir, "redaction-report.json"), redactionReport);
  const scorecard = buildScorecard({
    scenario: input.scenario,
    mode: input.mode,
    generatedAt: input.generatedAt,
    packet,
    packetBuildOk: lensBuild.ok,
    packetBuildError: lensBuild.ok ? undefined : lensBuild.error,
    redactionReport,
    leanShadow,
    lensIssueBody
  });
  writeJson(join(outputDir, "lens-scorecard.json"), scorecard);
  writeJson(join(outputDir, "diff-summary.json"), buildDiffSummary(outputDir));
  writeJson(join(outputDir, "manifest.json"), {
    evalName: input.scenario.evalName,
    runId: input.scenario.runId,
    suite: input.scenario.suite,
    surface: input.scenario.surface,
    mode: input.mode,
    generatedAt: input.generatedAt,
    publicConfidence: "uncalibrated",
    activeLenses: input.scenario.reviewLenses.active,
    expected: input.scenario.expected ?? {},
    artifacts: inventoryArtifacts(outputDir),
    proofBoundary:
      "Review lens scenario evidence is dry-run only; it does not post comments, mutate GitHub, activate lenses, or widen repository allowlists."
  });

  return {
    ok: scorecard.gates.every((gate) => gate.ok),
    evalName: input.scenario.evalName,
    runId: input.scenario.runId,
    suite: input.scenario.suite,
    surface: input.scenario.surface,
    outputDir,
    scorecard
  };
}

function buildScorecard(input: {
  scenario: ReviewLensEvalScenario;
  mode: ReviewLensEvalMode;
  generatedAt: string;
  packet?: ReviewLensPacket;
  packetBuildOk: boolean;
  packetBuildError?: string;
  redactionReport: ReviewLensEvalRedactionReport;
  leanShadow?: LeanReviewShadow;
  lensIssueBody?: string;
}): ReviewLensEvalScorecard {
  const packet = input.packet;
  const includedLensIds = packet?.lenses.map((lens) => lens.id) ?? [];
  const omittedReasons = packet?.omittedLenses.map((lens) => lens.reason) ?? [];
  const leanSuggestions = input.leanShadow?.suggestions ?? [];
  const requestChangesEligibleSuggestions = leanSuggestions.filter((suggestion) => suggestion.requestChangesEligible).length;
  const gates = [
    {
      name: "packet_build_ok",
      ok: input.packetBuildOk,
      detail: input.packetBuildOk ? "packet rendered" : input.packetBuildError ?? "packet failed"
    },
    {
      name: "secret_redaction",
      ok: input.redactionReport.secretFindings === 0,
      detail: `${input.redactionReport.secretFindings} unredacted secret-like artifact(s) after rendering`
    },
    {
      name: "advisory_only",
      ok: requestChangesEligibleSuggestions === 0,
      detail: `${requestChangesEligibleSuggestions} REQUEST_CHANGES-eligible lens suggestion(s)`
    },
    {
      name: "packet_budget",
      ok: !packet || packet.byteEstimate <= (input.scenario.expected?.maxPacketBytes ?? input.scenario.reviewLenses.maxPacketBytes),
      detail: packet ? `${packet.byteEstimate} bytes` : "no packet"
    },
    {
      name: "disallowed_directives_omitted",
      ok: (packet?.omittedLenses.filter((lens) => lens.reason === "disallowed_directive").length ?? 0) <=
        (input.scenario.expected?.omittedReasons?.filter((reason) => reason === "disallowed_directive").length ?? 0),
      detail: `${packet?.omittedLenses.filter((lens) => lens.reason === "disallowed_directive").length ?? 0} disallowed directive omission(s)`
    },
    {
      name: "surface_filtering",
      ok: expectedIncludedLensesMatch(input.scenario.expected?.includedLenses, includedLensIds),
      detail: `included lenses: ${includedLensIds.join(", ") || "none"}`
    },
    {
      name: "lean_shadow_non_blocking",
      ok: leanSuggestions.every((suggestion) => !suggestion.blocking && !suggestion.requestChangesEligible),
      detail: `${leanSuggestions.length} lean shadow suggestion(s)`
    },
    {
      name: "safety_negative_control",
      ok: !input.scenario.negativeControl || leanSuggestions.length === 0,
      detail: input.scenario.negativeControl ? `${leanSuggestions.length} lean suggestion(s) in negative control` : "not a negative control"
    }
  ];
  const min = input.scenario.expected?.leanSuggestionsMin;
  if (min !== undefined) {
    gates.push({
      name: "lean_suggestion_min",
      ok: leanSuggestions.length >= min,
      detail: `${leanSuggestions.length} lean suggestion(s), expected at least ${min}`
    });
  }
  const max = input.scenario.expected?.leanSuggestionsMax;
  if (max !== undefined) {
    gates.push({
      name: "lean_suggestion_max",
      ok: leanSuggestions.length <= max,
      detail: `${leanSuggestions.length} lean suggestion(s), expected at most ${max}`
    });
  }
  const expectedArchitectureSection = input.scenario.expected?.architectureSection;
  if (expectedArchitectureSection !== undefined) {
    const hasArchitectureSection = input.lensIssueBody?.includes("### Architecture lens") ?? false;
    gates.push({
      name: "architecture_section_expectation",
      ok: hasArchitectureSection === expectedArchitectureSection,
      detail: `architecture section present=${hasArchitectureSection}, expected=${expectedArchitectureSection}`
    });
  }
  const expectedSecretFindings = input.scenario.expected?.secretFindings;
  if (expectedSecretFindings !== undefined) {
    gates.push({
      name: "expected_redaction_findings",
      ok: input.redactionReport.secretFindings <= expectedSecretFindings,
      detail: `${input.redactionReport.secretFindings} secret finding(s), expected at most ${expectedSecretFindings}`
    });
  }
  return {
    evalName: input.scenario.evalName,
    runId: input.scenario.runId,
    suite: input.scenario.suite,
    surface: input.scenario.surface,
    mode: input.mode,
    generatedAt: input.generatedAt,
    counts: {
      includedLenses: includedLensIds.length,
      omittedLenses: packet?.omittedLenses.length ?? 0,
      disallowedDirectiveOmissions: omittedReasons.filter((reason) => reason === "disallowed_directive").length,
      secretFindings: input.redactionReport.secretFindings,
      rawRedactedSources: input.redactionReport.redactedSources.length,
      byteEstimate: packet?.byteEstimate ?? 0,
      leanSuggestions: leanSuggestions.length,
      requestChangesEligibleSuggestions
    },
    gates,
    publicConfidence: "uncalibrated",
    proofBoundary:
      "Review lens scorecard is advisory dry-run evidence only. It cannot activate lenses, request changes, or make calibrated-confidence claims."
  };
}

interface ReviewLensEvalRedactionReport {
  ok: boolean;
  checkedSources: number;
  redactedSources: Array<{ id: string; redactedPreview: string }>;
  secretFindings: number;
}

function buildEvalRedactionReport(sources: Array<{ id: string; text: string }>): ReviewLensEvalRedactionReport {
  const redactedSources = sources
    .filter((source) => containsSecretLikeText(source.text))
    .map((source) => ({
      id: source.id,
      redactedPreview: truncate(redactSecrets(source.text).replace(/\s+/g, " ").trim(), 160)
    }));
  const renderedText = sources.map((source) => redactSecrets(source.text)).join("\n");
  const secretFindings = containsSecretLikeText(renderedText) ? 1 : 0;
  return {
    ok: secretFindings === 0,
    checkedSources: sources.length,
    redactedSources,
    secretFindings
  };
}

function buildDiffSummary(outputDir: string): {
  baselineArtifacts: string[];
  lensArtifacts: string[];
  comparisons: Array<{ artifact: string; baselineSha256: string; lensSha256: string; changed: boolean }>;
  baselineOnly: string[];
  lensOnly: string[];
  changed: boolean;
  proofBoundary: string;
} {
  const baselineArtifacts = listRelativeFiles(join(outputDir, "baseline"));
  const lensArtifacts = listRelativeFiles(join(outputDir, "lens"));
  const baselineSet = new Set(baselineArtifacts);
  const lensSet = new Set(lensArtifacts);
  const common = baselineArtifacts.filter((artifact) => lensSet.has(artifact));
  const comparisons = common.map((artifact) => {
    const baselineSha256 = sha256(readFileSync(join(outputDir, "baseline", artifact), "utf8"));
    const lensSha256 = sha256(readFileSync(join(outputDir, "lens", artifact), "utf8"));
    return {
      artifact,
      baselineSha256,
      lensSha256,
      changed: baselineSha256 !== lensSha256
    };
  });
  const baselineOnly = baselineArtifacts.filter((artifact) => !lensSet.has(artifact));
  const lensOnly = lensArtifacts.filter((artifact) => !baselineSet.has(artifact));
  return {
    baselineArtifacts,
    lensArtifacts,
    comparisons,
    baselineOnly,
    lensOnly,
    changed: comparisons.some((comparison) => comparison.changed) || baselineOnly.length > 0 || lensOnly.length > 0,
    proofBoundary: "Diff summary compares baseline and lens artifact content hashes; semantic quality comparison requires labeled outcome review."
  };
}

function prepareOutputRoot(outputRoot: string): string {
  const safeOutputRoot = assertEvalOutputDirSafe(outputRoot);
  if (existsSync(safeOutputRoot)) {
    const stat = lstatSync(safeOutputRoot);
    if (stat.isSymbolicLink()) throw new Error("outputRoot must not be a symbolic link");
    if (!stat.isDirectory()) throw new Error("outputRoot must be a directory when it already exists");
    if (readdirSync(safeOutputRoot).length > 0) {
      throw new Error("outputRoot must be empty before running review-lenses-eval; choose a fresh output root to avoid stale artifacts");
    }
  }
  mkdirSync(safeOutputRoot, { recursive: true });
  return safeOutputRoot;
}

function normalizeScenario(value: unknown, path: string): ReviewLensEvalScenario {
  if (!isRecord(value)) throw new Error(`${path} must contain a JSON object`);
  const scenario = value as Record<string, unknown>;
  const runId = requireSafeSegment(scenario.runId, `${path}.runId`);
  const evalName = requireString(scenario.evalName, `${path}.evalName`);
  if (scenario.suite !== "review_lens_packet_safety") throw new Error(`${path}.suite must be review_lens_packet_safety`);
  const surface = requireSurface(scenario.surface, `${path}.surface`);
  const reviewLenses = normalizeReviewLensConfig(scenario.reviewLenses, `${path}.reviewLenses`);
  return {
    evalName,
    runId,
    suite: "review_lens_packet_safety",
    surface,
    ...(scenario.negativeControl === true ? { negativeControl: true } : {}),
    reviewLenses,
    ...(scenario.issue ? { issue: normalizeIssue(scenario.issue, `${path}.issue`) } : {}),
    ...(scenario.pull ? { pull: normalizePull(scenario.pull, `${path}.pull`) } : {}),
    ...(scenario.files ? { files: normalizeFiles(scenario.files, `${path}.files`) } : {}),
    ...(scenario.decision ? { decision: normalizeDecision(scenario.decision, `${path}.decision`) } : {}),
    ...(scenario.expected ? { expected: normalizeExpected(scenario.expected, `${path}.expected`) } : {})
  };
}

function normalizeReviewLensConfig(value: unknown, label: string): ReviewLensConfig {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    enabled: value.enabled === undefined ? true : requireBoolean(value.enabled, `${label}.enabled`),
    packetVersion: value.packetVersion === undefined ? DEFAULT_REVIEW_LENS_CONFIG.packetVersion : requireString(value.packetVersion, `${label}.packetVersion`),
    active: Array.isArray(value.active) ? value.active as ReviewLensConfig["active"] : [],
    maxLensBytes: value.maxLensBytes === undefined ? DEFAULT_REVIEW_LENS_CONFIG.maxLensBytes : requirePositiveInteger(value.maxLensBytes, `${label}.maxLensBytes`),
    maxPacketBytes: value.maxPacketBytes === undefined ? DEFAULT_REVIEW_LENS_CONFIG.maxPacketBytes : requirePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`)
  };
}

function normalizeIssue(value: unknown, label: string): ReviewLensEvalIssueInput {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    repo: requireRepo(value.repo, `${label}.repo`),
    number: requirePositiveInteger(value.number, `${label}.number`),
    state: requireString(value.state, `${label}.state`),
    title: requireString(value.title, `${label}.title`),
    ...(value.body === undefined ? {} : { body: requireString(value.body, `${label}.body`) }),
    ...(value.html_url === undefined ? {} : { html_url: requireString(value.html_url, `${label}.html_url`) })
  };
}

function normalizePull(value: unknown, label: string): ReviewLensEvalPullInput {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    repo: requireRepo(value.repo, `${label}.repo`),
    number: requirePositiveInteger(value.number, `${label}.number`),
    title: requireString(value.title, `${label}.title`),
    draft: requireBoolean(value.draft, `${label}.draft`),
    ...(value.body === undefined ? {} : { body: requireString(value.body, `${label}.body`) }),
    headSha: requireSha(value.headSha, `${label}.headSha`),
    baseSha: requireSha(value.baseSha, `${label}.baseSha`),
    headRef: requireString(value.headRef, `${label}.headRef`),
    baseRef: requireString(value.baseRef, `${label}.baseRef`),
    ...(value.html_url === undefined ? {} : { html_url: requireString(value.html_url, `${label}.html_url`) })
  };
}

function normalizeFiles(value: unknown, label: string): PullFilePatch[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`${label}.${index} must be an object`);
    return {
      filename: requireString(entry.filename, `${label}.${index}.filename`),
      ...(entry.patch === undefined || entry.patch === null ? {} : { patch: requireString(entry.patch, `${label}.${index}.patch`) })
    };
  });
}

function normalizeDecision(value: unknown, label: string): ReviewLensEvalScenario["decision"] {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const status = value.status;
  if (status !== "block" && status !== "warn" && status !== "accept_with_evidence" && status !== "defer" && status !== "human_review") {
    throw new Error(`${label}.status must be block, warn, accept_with_evidence, defer, or human_review`);
  }
  return { status, reason: requireString(value.reason, `${label}.reason`) };
}

function normalizeExpected(value: unknown, label: string): NonNullable<ReviewLensEvalScenario["expected"]> {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  return {
    ...(value.includedLenses === undefined ? {} : { includedLenses: requireStringArray(value.includedLenses, `${label}.includedLenses`) }),
    ...(value.omittedReasons === undefined ? {} : { omittedReasons: requireStringArray(value.omittedReasons, `${label}.omittedReasons`) }),
    ...(value.maxPacketBytes === undefined ? {} : { maxPacketBytes: requirePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`) }),
    ...(value.secretFindings === undefined ? {} : { secretFindings: requireNonNegativeInteger(value.secretFindings, `${label}.secretFindings`) }),
    ...(value.requestChangesEligible === undefined ? {} : { requestChangesEligible: false }),
    ...(value.leanSuggestionsMin === undefined ? {} : { leanSuggestionsMin: requireNonNegativeInteger(value.leanSuggestionsMin, `${label}.leanSuggestionsMin`) }),
    ...(value.leanSuggestionsMax === undefined ? {} : { leanSuggestionsMax: requireNonNegativeInteger(value.leanSuggestionsMax, `${label}.leanSuggestionsMax`) }),
    ...(value.architectureSection === undefined ? {} : { architectureSection: requireBoolean(value.architectureSection, `${label}.architectureSection`) })
  };
}

function scenarioIssue(scenario: ReviewLensEvalScenario): { repo: string; issue: GitHubRelatedIssueOrPull } {
  if (!scenario.issue) throw new Error(`scenario ${scenario.runId} requires issue for issue_enrichment surface`);
  return {
    repo: scenario.issue.repo,
    issue: {
      number: scenario.issue.number,
      title: scenario.issue.title,
      state: scenario.issue.state,
      body: scenario.issue.body ?? "",
      html_url: scenario.issue.html_url,
      labels: []
    }
  };
}

function scenarioPull(scenario: ReviewLensEvalScenario): { repo: string; pull: PullRequestSummary } {
  if (!scenario.pull) throw new Error(`scenario ${scenario.runId} requires pull for pr_shadow surface`);
  return {
    repo: scenario.pull.repo,
    pull: {
      number: scenario.pull.number,
      title: scenario.pull.title,
      draft: scenario.pull.draft,
      body: scenario.pull.body ?? "",
      html_url: scenario.pull.html_url ?? `https://github.test/${scenario.pull.repo}/pull/${scenario.pull.number}`,
      head: {
        sha: scenario.pull.headSha,
        ref: scenario.pull.headRef,
        repo: { full_name: scenario.pull.repo }
      },
      base: {
        sha: scenario.pull.baseSha,
        ref: scenario.pull.baseRef,
        repo: { full_name: scenario.pull.repo }
      },
      requested_reviewers: [],
      labels: []
    }
  };
}

function expectedIncludedLensesMatch(expected: string[] | undefined, actual: string[]): boolean {
  if (!expected) return true;
  return JSON.stringify([...expected].sort()) === JSON.stringify([...actual].sort());
}

function buildPromotionDecision(summary: ReviewLensEvalSummary): string {
  return [
    "# Review Lenses Eval Promotion Decision",
    "",
    `Decision: ${summary.ok ? "advisory dry-run evidence passed" : "not ready"}`,
    "Live activation: disabled",
    "Calibrated public confidence: disabled",
    "",
    summary.proofBoundary,
    "",
    "## Scenario Results",
    "",
    ...summary.results.map((result) => `- ${result.ok ? "PASS" : "FAIL"} ${result.runId} (${result.surface})`)
  ].join("\n");
}

function inventoryArtifacts(root: string): Array<{ path: string; sha256: string }> {
  return listRelativeFiles(root).map((artifactPath) => {
    const fullPath = join(root, artifactPath);
    return {
      path: artifactPath,
      sha256: sha256(readFileSync(fullPath, "utf8"))
    };
  });
}

function listRelativeFiles(root: string): string[] {
  if (!existsSync(root)) return [];
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(dir).sort()) {
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      if (stat.isDirectory()) {
        visit(fullPath);
      } else if (stat.isFile()) {
        files.push(relative(root, fullPath));
      }
    }
  };
  visit(root);
  return files.sort();
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${stringifyRedactedJson(value)}\n`);
}

function writeText(path: string, value: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, redactSecrets(value));
}

function requireSurface(value: unknown, label: string): ReviewLensSurface {
  if (value === "issue_enrichment" || value === "pr_shadow" || value === "walkthrough") return value;
  throw new Error(`${label} must be issue_enrichment, pr_shadow, or walkthrough`);
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  return value;
}

function requireStringArray(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) throw new Error(`${label} must be an array of strings`);
  return value;
}

function requireRepo(value: unknown, label: string): string {
  const repo = requireString(value, label);
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error(`${label} must be owner/name`);
  return repo;
}

function requireSha(value: unknown, label: string): string {
  const sha = requireString(value, label);
  if (!/^[0-9a-f]{40}$/i.test(sha)) throw new Error(`${label} must be a 40-character SHA`);
  return sha;
}

function requireSafeSegment(value: unknown, label: string): string {
  const segment = requireString(value, label);
  if (!/^[A-Za-z0-9._-]+$/.test(segment)) throw new Error(`${label} must be a safe path segment`);
  return segment;
}

function requireBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  const parsed = requireNonNegativeInteger(value, label);
  if (parsed < 1) throw new Error(`${label} must be positive`);
  return parsed;
}

function requireNonNegativeInteger(value: unknown, label: string): number {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
  return Number(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function truncate(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `${value.slice(0, Math.max(0, maxChars - 3))}...`;
}
