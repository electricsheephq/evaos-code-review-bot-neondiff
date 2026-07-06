#!/usr/bin/env node
/**
 * QA lab timing harness -- pass 1 (hermetic) (#341, tracker #340).
 *
 * Runs each seeded scenario (scripts/qa-lab/scenarios.ts) through the deterministic review
 * pipeline that already ships in this repo:
 *
 *   parseFindings (src/findings.ts)
 *     -> applyDeterministicReviewGate (src/review-gate.ts), which itself chains
 *        validateFindingLocations -> normalizeFindingsForReview -> decideReviewEvent
 *
 * against a FIXTURE config derived from config.example.json (never the live config). No GitHub
 * calls, no provider calls, no launchd, no repo mutation -- this measures pipeline wall-clock only.
 *
 * --config-variant selects a fixture config variant (scripts/qa-lab/config-variants.ts). Pass 1
 * only executes the "baseline" variant; any other variant name is accepted (so pass 2 can pass
 * `--config-variant github_related_context` etc. against the same CLI surface) but the harness
 * exits with a clear error rather than silently measuring the wrong thing, since those add-on
 * paths require live provider/GitHub calls that are out of scope here.
 *
 * Usage:
 *   tsx scripts/qa-lab/run-timing.ts \
 *     --config tests/fixtures/qa-lab/config.baseline.json \
 *     --config-variant baseline \
 *     --samples 25 \
 *     --output-dir /path/to/evidence/qa-harness
 */
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfigFromObject, type BotConfig } from "../../src/config.js";
import { parseFindings } from "../../src/findings.js";
import { redactSecrets } from "../../src/secrets.js";
import { applyDeterministicReviewGate } from "../../src/review-gate.js";
import { QA_LAB_SCENARIOS, type QaLabScenario } from "./scenarios.js";
import { findConfigVariant, HERMETIC_EXECUTABLE_VARIANTS, type QaLabConfigVariantId } from "./config-variants.js";
import { summarizePercentiles, type PercentileSummary } from "./stats.js";

interface ParsedArgs {
  config?: string;
  "config-variant"?: string;
  samples?: string;
  "output-dir"?: string;
}

interface ScenarioTimingResult {
  scenarioId: string;
  scenarioClass: string;
  description: string;
  configVariant: QaLabConfigVariantId;
  samples: number;
  stats: PercentileSummary;
  /** Deterministic-gate outcome from the LAST sample run, as a sanity spot-check evidence field. */
  lastRunOutcome: {
    event: string;
    acceptedComments: number;
    droppedFindings: number;
  };
}

interface TimingEvidence {
  evidenceVersion: "0.1";
  generatedAt: string;
  commitSha: string;
  nodeVersion: string;
  configVariant: QaLabConfigVariantId;
  configPath: string;
  samplesPerScenario: number;
  proofBoundary: string;
  scenarios: ScenarioTimingResult[];
}

function parseArgs(argv: string[]): ParsedArgs {
  const args: ParsedArgs = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token?.startsWith("--")) continue;
    const key = token.slice(2) as keyof ParsedArgs;
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`--${key} requires a value`);
    }
    args[key] = value;
    index += 1;
  }
  return args;
}

function writeRedactedJson(path: string, value: unknown): void {
  writeFileSync(path, `${redactSecrets(JSON.stringify(value, null, 2))}\n`);
}

function timeScenarioOnce(scenario: QaLabScenario, config: BotConfig): { elapsedMs: number; event: string; acceptedComments: number; droppedFindings: number } {
  const startedAt = process.hrtime.bigint();
  const parsed = parseFindings(scenario.botFindings);
  const gateResult = applyDeterministicReviewGate({
    findings: parsed.findings,
    files: scenario.files,
    droppedFromSchema: parsed.dropped,
    maxInlineComments: config.reviewGate?.maxInlineComments,
    publicConfidencePolicy: undefined
  });
  const elapsedNs = process.hrtime.bigint() - startedAt;
  return {
    elapsedMs: Number(elapsedNs) / 1_000_000,
    event: gateResult.event,
    acceptedComments: gateResult.comments.length,
    droppedFindings: gateResult.dropped.length
  };
}

function resolveCommitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function main(): void {
  const args = parseArgs(process.argv.slice(2));
  if (!args.config) throw new Error("--config is required (path to a fixture config JSON, never the live config)");
  const configVariantId = (args["config-variant"] ?? "baseline") as QaLabConfigVariantId;
  const samples = args.samples ? Number(args.samples) : 25;
  if (!Number.isInteger(samples) || samples < 1) throw new Error("--samples must be a positive integer");
  if (!args["output-dir"]) throw new Error("--output-dir is required");

  const variant = findConfigVariant(configVariantId);
  if (!variant) {
    throw new Error(
      `unknown --config-variant "${configVariantId}"; known variants: baseline, github_related_context, gitnexus_context, repo_memory, enrichment, self_consistency`
    );
  }
  if (!HERMETIC_EXECUTABLE_VARIANTS.includes(configVariantId)) {
    throw new Error(
      `--config-variant "${configVariantId}" requires live provider/GitHub calls (${variant.description}) and is out of ` +
        `scope for the hermetic pass-1 timing runner. Pass 1 only executes: ${HERMETIC_EXECUTABLE_VARIANTS.join(", ")}. ` +
        "This variant exists as a config fixture for pass 2 to wire real timing against."
    );
  }

  if (!existsSync(args.config)) throw new Error(`--config path does not exist: ${args.config}`);
  const rawConfig = JSON.parse(readFileSync(args.config, "utf8"));
  const baseConfig = loadConfigFromObject(rawConfig);
  const effectiveConfig = variant.applyVariant(baseConfig);

  const outputDir = args["output-dir"];
  mkdirSync(outputDir, { recursive: true });

  const scenarioResults: ScenarioTimingResult[] = QA_LAB_SCENARIOS.map((scenario) => {
    const timingsMs: number[] = [];
    let lastRun: { elapsedMs: number; event: string; acceptedComments: number; droppedFindings: number } | undefined;
    for (let sampleIndex = 0; sampleIndex < samples; sampleIndex += 1) {
      lastRun = timeScenarioOnce(scenario, effectiveConfig);
      timingsMs.push(lastRun.elapsedMs);
    }
    if (!lastRun) throw new Error(`scenario ${scenario.id} produced zero samples`);
    return {
      scenarioId: scenario.id,
      scenarioClass: scenario.scenarioClass,
      description: scenario.description,
      configVariant: configVariantId,
      samples,
      stats: summarizePercentiles(timingsMs),
      lastRunOutcome: {
        event: lastRun.event,
        acceptedComments: lastRun.acceptedComments,
        droppedFindings: lastRun.droppedFindings
      }
    };
  });

  const evidence: TimingEvidence = {
    evidenceVersion: "0.1",
    generatedAt: new Date().toISOString(),
    commitSha: resolveCommitSha(),
    nodeVersion: process.version,
    configVariant: configVariantId,
    configPath: args.config,
    samplesPerScenario: samples,
    proofBoundary:
      "hermetic deterministic-pipeline timing only (parseFindings -> applyDeterministicReviewGate); " +
      "no provider calls, no GitHub calls, no launchd, no live/active config read or write, no repo mutation",
    scenarios: scenarioResults
  };

  writeRedactedJson(join(outputDir, "timing-results.json"), evidence);
  writeFileSync(join(outputDir, "baseline-table.md"), buildBaselineTable(evidence));

  console.log(JSON.stringify({ ok: true, outputDir, scenarioCount: scenarioResults.length }, null, 2));
}

function buildBaselineTable(evidence: TimingEvidence): string {
  const rows = evidence.scenarios.map((scenario) => {
    const { p50Ms, p90Ms } = scenario.stats;
    return `| ${scenario.scenarioId} | ${scenario.scenarioClass} | ${scenario.samples} | ${p50Ms.toFixed(3)} | ${p90Ms.toFixed(3)} |`;
  });
  return [
    "# QA Lab Timing Baseline (hermetic, pass 1)",
    "",
    `Generated: ${evidence.generatedAt}`,
    `Commit: ${evidence.commitSha}`,
    `Node: ${evidence.nodeVersion}`,
    `Config variant: ${evidence.configVariant}`,
    `Samples per scenario: ${evidence.samplesPerScenario}`,
    "",
    "## Proof boundary",
    "",
    evidence.proofBoundary,
    "",
    "## Per-scenario p50/p90 (ms, deterministic-pipeline wall-clock)",
    "",
    "| Scenario | Class | Samples | p50 (ms) | p90 (ms) |",
    "| --- | --- | ---: | ---: | ---: |",
    ...rows,
    ""
  ].join("\n");
}

main();
