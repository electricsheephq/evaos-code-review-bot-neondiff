#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { collectCoverageAudit, CoverageStateReader } from "./coverage-audit.js";
import { runDaemonCycle } from "./daemon.js";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { REQUIRED_SUITES, runOfflineEval } from "./eval-harness.js";
import { GitHubApi } from "./github.js";
import {
  buildOperatorQueue,
  buildOperatorStatus,
  collectOperatorLeases,
  collectOperatorProviderCooldowns,
  collectOperatorRepoProviderCooldowns,
  collectOperatorReviewQueue,
  explainPullStatus,
  summarizeAgentInventory
} from "./operator-cli.js";
import { collectReleaseStatus } from "./release-status.js";
import { buildRepoPolicySnapshot, listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { ReviewStateStore, type ReviewQueueJobState } from "./state.js";
import { isSuccessfulRetryStatus, retryFailedHead, retryProviderCooldowns, runOnce } from "./worker.js";
import { resolveZCodeProviderEnv } from "./zcode-env.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(JSON.stringify(buildHelp(), null, 2));
    return;
  }

  if (command === "doctor") {
    const config = loadConfig(args.config);
    const zcode = resolveZCodeProviderEnv({
      appConfigPath: config.zcode.appConfigPath,
      model: config.zcode.model,
      providerId: config.zcode.providerId
    });
    const github = new GitHubApi(config.github);
    const readChecks = [];
    const monitoredRepos = listReposToScan(config);
    for (const repo of monitoredRepos) {
      const repoPolicy = resolveRepoProfile(config, repo);
      const policy = buildRepoPolicySnapshot(config, repo);
      if (!repoPolicy.allowed) {
        readChecks.push({ repo, ok: true, policy, skippedByPolicy: repoPolicy.reason });
        continue;
      }
      try {
        await github.listOpenPulls(repo);
        readChecks.push({ repo, ok: true, policy });
      } catch (error) {
        readChecks.push({
          repo,
          ok: false,
          policy,
          error: error instanceof Error ? error.message : String(error)
        });
      }
    }
    console.log(JSON.stringify({
      ok: readChecks.every((check) => check.ok),
      pilotRepos: config.pilotRepos,
      monitoredRepos,
      canaryPulls: config.canaryPulls ?? [],
      repoProfilesEnabled: Boolean(config.repoProfiles),
      activation: config.activation,
      reviewConcurrency: config.reviewConcurrency,
      reviewerSessions: config.reviewerSessions,
      commandsEnabled: config.commands.enabled,
      statePath: config.statePath,
      workRoot: config.workRoot,
      zcode: zcode.redacted,
      github: {
        canPostAsApp: github.canPostAsApp(),
        readMode: github.canPostAsApp() ? "app_installation" : "fallback_token",
        hasFallbackReadToken: Boolean(config.github.token),
        readChecks
      }
    }, null, 2));
    if (readChecks.some((check) => !check.ok)) process.exitCode = 1;
    return;
  }

  if (command === "release-status") {
    const status = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"]
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (command === "coverage-audit") {
    const config = loadConfig(args.config);
    const github = new GitHubApi(config.github);
    const state = CoverageStateReader.open(args["state-path"] ?? config.statePath);
    try {
      const audit = await collectCoverageAudit({
        config,
        github,
        state,
        repo: args.repo,
        pullNumber: args.pr ? Number(args.pr) : undefined,
        verifyCurrentHeads: args["verify-current-heads"] !== "false"
      });
      console.log(JSON.stringify(audit, null, 2));
      if (!audit.ok) process.exitCode = 1;
    } finally {
      state.close();
    }
    return;
  }

  if (command === "status") {
    const config = loadConfig(args.config);
    const release = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"]
    });
    const coverage = await collectCoverageReport(args, config);
    const agents = summarizeAgentInventory({
      launchd: release.launchd,
      heartbeat: release.heartbeat,
      leases: collectOperatorLeases(args["state-path"] ?? config.statePath)
    });
    const providerCooldowns = collectOperatorProviderCooldowns(args["state-path"] ?? config.statePath, {
      repo: args.repo,
      expiredOnly: false,
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
    });
    const durableQueue = collectOperatorReviewQueue(args["state-path"] ?? config.statePath, {
      repo: args.repo,
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
    });
    const status = buildOperatorStatus({
      release,
      coverage,
      agents,
      providerCooldowns,
      durableQueue
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (command === "agents") {
    const config = loadConfig(args.config);
    const release = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"]
    });
    const inventory = summarizeAgentInventory({
      launchd: release.launchd,
      heartbeat: release.heartbeat,
      leases: collectOperatorLeases(args["state-path"] ?? config.statePath)
    });
    console.log(JSON.stringify(inventory, null, 2));
    if (!inventory.ok) process.exitCode = 1;
    return;
  }

  if (command === "queue") {
    const config = loadConfig(args.config);
    const report = await collectCoverageReport(args, config);
    const queue = buildOperatorQueue(report);
    const durableQueue = collectOperatorReviewQueue(args["state-path"] ?? config.statePath, {
      repo: args.repo,
      state: parseReviewQueueJobState(args.state),
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
    });
    const output = { ...queue, ok: queue.ok, coverage: queue, durableQueue };
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
    return;
  }

  if (command === "coverage") {
    const config = loadConfig(args.config);
    const report = await collectCoverageReport(args, config);
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "cooldowns") {
    const config = loadConfig(args.config);
    const now = new Date();
    const statePath = args["state-path"] ?? config.statePath;
    const providerRows = collectOperatorProviderCooldowns(statePath, {
      repo: args.repo,
      expiredOnly: args["expired-only"] === "true",
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined,
      now
    });
    const repoCooldowns = collectOperatorRepoProviderCooldowns(statePath, {
      repo: args.repo,
      activeOnly: args["active-only"] === "true",
      now
    });
    const report = {
      ok: providerRows.every((row) => !row.expired),
      checkedAt: now.toISOString(),
      filters: {
        ...(args.repo ? { repo: args.repo } : {}),
        expiredOnly: args["expired-only"] === "true",
        activeOnly: args["active-only"] === "true"
      },
      summary: {
        providerRows: providerRows.length,
        expiredProviderRows: providerRows.filter((row) => row.expired).length,
        activeProviderRows: providerRows.filter((row) => !row.expired).length,
        repoCooldowns: repoCooldowns.length
      },
      providerRows,
      repoCooldowns,
      recommendedActions: providerRows.some((row) => row.expired)
        ? [
            `npx tsx src/cli.ts retry-provider-cooldowns --config ${args.config ?? "(default config)"} --expired-only true --dry-run false${args.repo ? ` --repo ${args.repo}` : ""}`
          ]
        : []
    };
    console.log(JSON.stringify(report, null, 2));
    if (!report.ok) process.exitCode = 1;
    return;
  }

  if (command === "why") {
    if (!args.repo) throw new Error("--repo is required for why");
    if (!args.pr) throw new Error("--pr is required for why");
    const config = loadConfig(args.config);
    const report = await collectCoverageReport(args, config, true);
    const repoWideReport = await collectCoverageReport({ ...args, pr: undefined }, config, true);
    const repoWideExplanation = explainPullStatus(repoWideReport, args.repo, Number(args.pr));
    const explanation = repoWideExplanation.state === "unknown"
      ? explainPullStatus(report, args.repo, Number(args.pr))
      : repoWideExplanation;
    console.log(JSON.stringify({
      ok: !["read_failure", "unknown"].includes(explanation.state),
      checkedAt: report.checkedAt,
      explanation,
      scopedCoverage: {
        summary: report.summary,
        staleHeads: report.staleHeads,
        readFailures: report.readFailures
      },
      repoCoverage: {
        summary: repoWideReport.summary,
        staleHeads: repoWideReport.staleHeads,
        readFailures: repoWideReport.readFailures
      }
    }, null, 2));
    if (["read_failure", "unknown"].includes(explanation.state)) process.exitCode = 1;
    return;
  }

  if (command === "eval-offline") {
    if (!args.input) throw new Error("--input is required for eval-offline");
    const input = JSON.parse(readFileSync(args.input, "utf8"));
    const result = runOfflineEval(input, {
      outputDir: args["output-dir"]
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "eval-suite") {
    if (!args["input-dir"]) throw new Error("--input-dir is required for eval-suite");
    if (!args["output-root"]) throw new Error("--output-root is required for eval-suite");
    const scenarioFiles = listJsonFiles(args["input-dir"]);
    const seenRunIds = new Map<string, string>();
    const results = scenarioFiles.map((scenarioPath) => {
      try {
        const input = JSON.parse(readFileSync(scenarioPath, "utf8"));
        const runId = validateScenarioRunId(input, scenarioPath);
        const duplicatePath = seenRunIds.get(runId);
        if (duplicatePath) throw new Error(`duplicate runId "${runId}" already used by ${duplicatePath}`);
        seenRunIds.set(runId, scenarioPath);
        input.scenarioSource = input.scenarioSource ?? { path: scenarioPath };
        return {
          scenarioPath,
          ...runOfflineEval(input, {
            outputDir: join(args["output-root"]!, runId)
          })
        };
      } catch (error) {
        return {
          scenarioPath,
          ok: false,
          error: error instanceof Error ? error.message : String(error)
        };
      }
    });
    const suites = [...new Set(results.flatMap((result) => "scorecard" in result ? [result.scorecard.suite] : []))].sort();
    const missingSuites = REQUIRED_SUITES.filter((suite) => !suites.includes(suite));
    const summary = {
      ok: results.every((result) => result.ok) && missingSuites.length === 0,
      scenarioCount: results.length,
      suites,
      missingSuites,
      results
    };
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
    return;
  }

  if (command === "run-once") {
    await runOnce({
      configPath: args.config,
      dryRun: args["dry-run"] !== "false",
      repo: args.repo,
      pullNumber: args.pr ? Number(args.pr) : undefined,
      useZCode: args.zcode !== "false"
    });
    return;
  }

  if (command === "retry-failed") {
    if (!args.repo) throw new Error("--repo is required for retry-failed");
    if (!args.pr) throw new Error("--pr is required for retry-failed");
    if (!args["head-sha"]) throw new Error("--head-sha is required for retry-failed");
    if (args["dry-run"] !== "true" && args["dry-run"] !== "false") {
      throw new Error("retry-failed requires explicit --dry-run true or --dry-run false");
    }
    const result = await retryFailedHead({
      configPath: args.config,
      repo: args.repo,
      pullNumber: Number(args.pr),
      headSha: args["head-sha"],
      dryRun: args["dry-run"] === "true",
      useZCode: args.zcode !== "false"
    });
    console.log(JSON.stringify(result, null, 2));
    if (!isSuccessfulRetryStatus(result.status)) process.exitCode = 1;
    return;
  }

  if (command === "provider-cooldowns") {
    const config = loadConfig(args.config);
    const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
    try {
      const expiredOnly = args["expired-only"] === "true";
      const limit = args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined;
      const rows = state.listProviderCooldownReviews({
        repo: args.repo,
        expiredOnly,
        limit
      });
      console.log(JSON.stringify({
        ok: true,
        checkedAt: new Date().toISOString(),
        expiredOnly,
        ...(args.repo ? { repo: args.repo } : {}),
        count: rows.length,
        expiredCount: rows.filter((row) => row.expired).length,
        rows
      }, null, 2));
    } finally {
      state.close();
    }
    return;
  }

  if (command === "retry-provider-cooldowns") {
    if (args["dry-run"] !== "true" && args["dry-run"] !== "false") {
      throw new Error("retry-provider-cooldowns requires explicit --dry-run true or --dry-run false");
    }
    const result = await retryProviderCooldowns({
      configPath: args.config,
      repo: args.repo,
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined,
      expiredOnly: args["expired-only"] !== "false",
      dryRun: args["dry-run"] === "true",
      useZCode: args.zcode !== "false"
    });
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "retire-failed") {
    if (!args.repo) throw new Error("--repo is required for retire-failed");
    if (!args.pr) throw new Error("--pr is required for retire-failed");
    if (!args["head-sha"]) throw new Error("--head-sha is required for retire-failed");
    if (!args.reason) throw new Error("--reason is required for retire-failed");
    const config = loadConfig(args.config);
    const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
    try {
      const retired = state.retireFailedReview({
        repo: args.repo,
        pullNumber: Number(args.pr),
        headSha: args["head-sha"],
        reason: args.reason
      });
      console.log(JSON.stringify({ ok: true, retired }, null, 2));
    } finally {
      state.close();
    }
    return;
  }

  if (command === "daemon") {
    const config = loadConfig(args.config);
    const monitoredRepos = listReposToScan(config);
    let cycle = 0;
    for (;;) {
      cycle += 1;
      const dryRun = args["dry-run"] !== "false";
      await runDaemonCycle({
        cycle,
        dryRun,
        pilotRepos: config.pilotRepos,
        monitoredRepos,
        canaryPulls: config.canaryPulls ?? [],
        commandsEnabled: config.commands.enabled,
        reviewSchedulerEnabled: config.reviewScheduler?.enabled === true,
        configPath: args.config
      });
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }

  throw new Error(`Unknown command: ${command ?? "(missing)"}`);
}

async function collectCoverageReport(args: ParsedArgs, config = loadConfig(args.config), forceScoped = false) {
  const github = new GitHubApi(config.github);
  const state = CoverageStateReader.open(args["state-path"] ?? config.statePath);
  try {
    return await collectCoverageAudit({
      config,
      github,
      state,
      repo: args.repo,
      pullNumber: args.pr ? Number(args.pr) : undefined,
      verifyCurrentHeads: forceScoped ? true : args["verify-current-heads"] !== "false"
    });
  } finally {
    state.close();
  }
}

function buildHelp() {
  return {
    ok: true,
    commands: {
      operator: [
        "status",
        "agents",
        "queue",
        "coverage",
        "cooldowns",
        "why"
      ],
      existing: [
        "doctor",
        "release-status",
        "coverage-audit",
        "provider-cooldowns",
        "retry-provider-cooldowns",
        "retry-failed",
        "retire-failed",
        "run-once",
        "daemon",
        "eval-offline",
        "eval-suite"
      ]
    },
    examples: [
      "npx tsx src/cli.ts status --config /path/to/live.json --launchd-label com.electricsheephq.evaos-code-review-bot",
      "npx tsx src/cli.ts agents --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json --state provider_deferred",
      "npx tsx src/cli.ts why --config /path/to/live.json --repo owner/repo --pr 123",
      "npx tsx src/cli.ts cooldowns --config /path/to/live.json --expired-only true"
    ]
  };
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      parsed[key] = next;
      index += 1;
    } else {
      parsed[key] = "true";
    }
  }
  return parsed;
}

function parsePositiveInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new Error(`${label} must be a positive integer`);
  return parsed;
}

const REVIEW_QUEUE_JOB_STATES: ReviewQueueJobState[] = [
  "queued",
  "leased",
  "running",
  "provider_deferred",
  "stale_retired",
  "closed_retired",
  "command_recorded",
  "posted",
  "failed"
];

function parseReviewQueueJobState(value?: string): ReviewQueueJobState | undefined {
  if (!value) return undefined;
  if (REVIEW_QUEUE_JOB_STATES.includes(value as ReviewQueueJobState)) {
    return value as ReviewQueueJobState;
  }
  throw new Error(`--state must be one of: ${REVIEW_QUEUE_JOB_STATES.join(", ")}`);
}

function listJsonFiles(inputDir: string): string[] {
  return readdirSync(inputDir)
    .map((entry) => join(inputDir, entry))
    .filter((path) => statSync(path).isFile() && path.endsWith(".json"))
    .sort();
}

function validateScenarioRunId(input: unknown, scenarioPath: string): string {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`${scenarioPath}: scenario must be a JSON object`);
  }
  const runId = (input as { runId?: unknown }).runId;
  if (typeof runId !== "string" || runId.trim().length === 0) {
    throw new Error(`${scenarioPath}: runId must be a non-empty string`);
  }
  const trimmed = runId.trim();
  if (!/^[A-Za-z0-9._-]+$/.test(trimmed) || trimmed === "." || trimmed === "..") {
    throw new Error(`${scenarioPath}: runId must be a safe path segment`);
  }
  return trimmed;
}

interface ParsedArgs {
  _: string[];
  config?: string;
  repo?: string;
  pr?: string;
  reason?: string;
  "expected-head"?: string;
  "launchd-label"?: string;
  "state-path"?: string;
  "dry-run"?: string;
  "expired-only"?: string;
  "head-sha"?: string;
  input?: string;
  "input-dir"?: string;
  "output-dir"?: string;
  "output-root"?: string;
  limit?: string;
  state?: string;
  zcode?: string;
  "active-only"?: string;
  "verify-current-heads"?: string;
  [key: string]: string | string[] | undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
