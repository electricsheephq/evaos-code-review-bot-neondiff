#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, validateLicenseConfigOverride, type BotConfig } from "./config.js";
import { collectCoverageAudit, CoverageStateReader } from "./coverage-audit.js";
import { collectProviderThrottleReport } from "./provider-throttle-report.js";
import { runDaemonCycle } from "./daemon.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, parse as parsePath, resolve, sep } from "node:path";
import {
  assertEvalOutputDirSafe,
  buildEvalPromotionDecisionMarkdown,
  REQUIRED_SUITES,
  runOfflineEval,
  runStickyVsColdEval
} from "./eval-harness.js";
import { inspectConfigForDesktop, patchConfigForDesktop } from "./config-cli.js";
import { buildEnrichmentComment, buildIssueEnrichmentDryRunOutput } from "./enrichment.js";
import {
  buildFinishingTouchDraft,
  FINISHING_TOUCH_ACTIONS,
  parseFinishingTouchCommand,
  validateFinishingTouchRequest,
  type FinishingTouchAction
} from "./finishing-touches.js";
import { GitHubApi } from "./github.js";
import { buildGitNexusContextPacket } from "./gitnexus-context.js";
import { buildGitHubRelatedContextPacket } from "./github-related-context.js";
import { buildIssueEnrichmentStatus, collectIssueEnrichmentScan, resolveIssueEnrichmentRepoPolicy } from "./issue-enrichment.js";
import { activateLicense, deactivateLicense, getLicenseStatus, type LicenseConfig } from "./license.js";
import { buildReviewBudgetStatus } from "./review-budget.js";
import {
  buildOperatorDashboard,
  buildRuntimeInventory,
  buildOperatorQueue,
  buildOperatorStatus,
  collectBotProcessInventory,
  collectOperatorIssueEnrichmentRuntime,
  collectOperatorLeases,
  collectOperatorProviderCooldowns,
  collectOperatorRepoProviderCooldowns,
  collectOperatorReviewReadiness,
  collectOperatorReviewQueue,
  explainPullStatus,
  formatOperatorDashboardHuman,
  formatRuntimeInventoryHuman,
  summarizeAgentInventory,
  type OperatorDurableQueueSnapshot,
  type OperatorQueueSnapshot
} from "./operator-cli.js";
import { buildPricingOutput } from "./pricing.js";
import { buildProviderRegistrySummary, doctorProviderRegistry, isProviderId } from "./providers.js";
import { collectReleaseStatus, type ReleaseStatus } from "./release-status.js";
import { buildReviewHeadGate } from "./review-head-gate.js";
import { buildRepoMemoryPacket, readRepoMemoryMarkdown } from "./repo-memory.js";
import { buildRepoPolicySnapshot, listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { runOnceCliCommand } from "./run-once-cli.js";
import { redactSecrets, stringifyRedactedJson } from "./secrets.js";
import { buildSkillPackContextPacket } from "./skill-packs.js";
import {
  buildRetiredFailedHeadError,
  listRepoMemoryNotesReadOnly,
  normalizeRetirementReason,
  ReviewStateStore,
  type ReviewQueueJobRecord,
  type ReviewQueueJobState
} from "./state.js";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "./validation-selector.js";
import { isSuccessfulRetryStatus, retryFailedHead, retryProviderCooldowns } from "./worker.js";
import { resolveZCodeProviderEnv } from "./zcode-env.js";
import { parsePositiveInteger } from "./cli-args.js";

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const PLUTIL_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(JSON.stringify(buildHelp(), null, 2));
    return;
  }

  if (isHelpRequested(args)) {
    console.log(JSON.stringify(buildHelp(command), null, 2));
    return;
  }

  if (command === "init") {
    const result = runInitCommand(args);
    console.log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "config") {
    const configAction = args._[1];
    if (configAction === "inspect") {
      const result = inspectConfigForDesktop(args.config ? parseSingleArg(args.config, "--config") : undefined);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    if (configAction === "patch") {
      if (!args.config) throw new Error("config patch requires --config");
      if (!args.input) throw new Error("config patch requires --input");
      const result = patchConfigForDesktop({
        configPath: parseSingleArg(args.config, "--config"),
        inputPath: parseSingleArg(args.input, "--input"),
        dryRun: args["dry-run"] !== "false",
        confirm: args.confirm === "true"
      });
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("config subcommand must be one of: inspect, patch");
  }

  if (command === "pricing") {
    console.log(stringifyRedactedJson(buildPricingOutput()));
    return;
  }

  if (command === "providers") {
    const action = args._[1];
    const config = loadConfig(args.config);
    if (action === "list") {
      console.log(stringifyProviderOutput({
        ok: true,
        command: "providers list",
        proofBoundary: "Provider registry visibility only; live review execution remains ZCode-backed until adapter rollout evidence passes.",
        ...buildProviderRegistrySummary({
          registry: config.providers!,
          currentZCode: {
            providerId: config.zcode.providerId,
            model: config.zcode.model
          }
        })
      }));
      return;
    }
    if (action === "doctor") {
      const providerId = args.provider ? parseSingleArg(args.provider, "--provider") : undefined;
      if (providerId && !isProviderId(providerId)) {
        console.log(stringifyProviderOutput({
          ok: false,
          command: "providers doctor",
          error: "--provider must be a stable provider identifier"
        }));
        process.exitCode = 1;
        return;
      }
      const result = await doctorProviderRegistry({
        registry: config.providers!,
        ...(providerId ? { providerId } : {}),
        smoke: args.smoke === undefined ? false : parseBooleanArg(args.smoke, "--smoke")
      });
      console.log(stringifyProviderOutput({
        ...result,
        proofBoundary: "Provider readiness check only; alternate providers are not selected for live review execution by this command."
      }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("providers subcommand must be one of: list, doctor");
  }

  if (command === "license") {
    const action = args._[1];
    const config = loadConfig(args.config);
    const licenseConfig = licenseConfigFromArgs(config.license!, args);
    if (action === "activate") {
      const licenseKey = resolveLicenseKeyArg(args);
      const result = await activateLicense({
        config: licenseConfig,
        licenseKey,
        ...(args.repo ? { repo: parseSingleArg(args.repo, "--repo") } : {})
      });
      console.log(stringifyRedactedJson({ command: "license activate", ...result }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "status") {
      const result = await getLicenseStatus({
        config: licenseConfig,
        refresh: args.refresh === undefined ? false : parseBooleanArg(args.refresh, "--refresh"),
        ...(args.repo ? { repo: parseSingleArg(args.repo, "--repo") } : {})
      });
      console.log(stringifyRedactedJson({ command: "license status", ...result }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (action === "deactivate") {
      const result = await deactivateLicense({
        config: licenseConfig,
        notifyApi: args["notify-api"] === undefined ? false : parseBooleanArg(args["notify-api"], "--notify-api")
      });
      console.log(stringifyRedactedJson({ command: "license deactivate", ...result }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("license subcommand must be one of: activate, status, deactivate");
  }

  if (command === "doctor") {
    const config = loadConfig(args.config);
    if (args._[1] === "github") {
      const result = await buildDoctorGithubReport(config);
      console.log(stringifyRedactedJson(result));
      if (!result.ok) process.exitCode = 1;
      return;
    }
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
    const issueEnrichment = buildIssueEnrichmentStatus({
      config,
      canPostAsApp: github.canPostAsApp()
    });
    const ok = readChecks.every((check) => check.ok) && issueEnrichment.ok;
    console.log(JSON.stringify({
      ok,
      pilotRepos: config.pilotRepos,
      monitoredRepos,
      canaryPulls: config.canaryPulls ?? [],
      repoProfilesEnabled: Boolean(config.repoProfiles),
      activation: config.activation,
      reviewConcurrency: config.reviewConcurrency,
      reviewerSessions: config.reviewerSessions,
      repoMemory: config.repoMemory,
      issueEnrichment,
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
    if (!ok) process.exitCode = 1;
    return;
  }

  if (command === "release-status") {
    const budgetDetailLimit = args["budget-detail-limit"]
      ? parsePositiveInteger(args["budget-detail-limit"], "--budget-detail-limit")
      : undefined;
    const budgetJobLimit = args["budget-job-limit"]
      ? parsePositiveInteger(args["budget-job-limit"], "--budget-job-limit")
      : undefined;
    const status = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      publicReleaseManifestPath: args["public-release-manifest"],
      expectedPublicVersion: args["expected-public-version"],
      verifyPublicRollbackRefs: args["verify-public-rollback-refs"] === undefined
        ? false
        : parseBooleanArg(args["verify-public-rollback-refs"], "--verify-public-rollback-refs"),
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"],
      budgetDetails: args["budget-details"] === "true",
      ...(budgetDetailLimit !== undefined ? { budgetDetailLimit } : {}),
      ...(budgetJobLimit !== undefined ? { budgetJobLimit } : {})
    });
    console.log(stringifyRedactedJson({
      ...status,
      healthState: status.ok ? "runtime_ok" : "runtime_blocked",
      runtimeOk: status.ok,
      failedGates: failedGates(status.gates)
    }));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (command === "review-head-gate") {
    if (!args.repo) throw new Error("--repo is required for review-head-gate");
    if (!args.pr) throw new Error("--pr is required for review-head-gate");
    const headSha = args["head-sha"] ?? args["current-head"];
    if (!headSha) throw new Error("--head-sha is required for review-head-gate");
    const config = loadConfig(args.config);
    const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
    try {
      const result = buildReviewHeadGate({
        state,
        repo: args.repo,
        pullNumber: parsePositiveInteger(args.pr, "--pr"),
        headSha: parseSingleArg(headSha, "--head-sha")
      });
      console.log(stringifyRedactedJson(result));
      if (!result.ok) process.exitCode = 1;
    } finally {
      state.close();
    }
    return;
  }

  if (command === "budget-status") {
    const budgetDetailLimit = args.limit ? parsePositiveInteger(args.limit, "--limit") : 50;
    const budgetJobLimit = args["job-limit"] ? parsePositiveInteger(args["job-limit"], "--job-limit") : 1_000;
    const status = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"],
      budgetDetails: true,
      budgetDetailLimit,
      budgetJobLimit
    });
    const readyToRetry = status.budget?.providerDeferred.readyToRetry ?? 0;
    const failed = status.database.failedReviewQueueJobCount ?? 0;
    const ok = status.budget?.enabled === true &&
      status.budget.details.inputJobsTruncated !== true &&
      readyToRetry === 0 &&
      failed === 0;
    const gates = [
      {
        name: "budget_available",
        ok: status.budget?.enabled === true,
        detail: status.budget?.enabled === true ? "enabled" : "not available"
      },
      {
        name: "budget_input_not_truncated",
        ok: status.budget?.details.inputJobsTruncated !== true,
        detail: status.budget?.details.inputJobsTruncated === true ? "input jobs truncated" : "input jobs complete"
      },
      {
        name: "budget_no_ready_provider_deferred_jobs",
        ok: readyToRetry === 0,
        detail: `${readyToRetry} ready-to-retry provider-deferred job(s)`
      },
      {
        name: "budget_no_failed_queue_jobs",
        ok: failed === 0,
        detail: `${failed} failed durable queue job(s)`
      }
    ];
    console.log(JSON.stringify({
      ok,
      healthState: ok ? "runtime_ok" : "runtime_blocked",
      runtimeOk: ok,
      checkedAt: status.checkedAt,
      summary: {
        readyToRetryProviderDeferredJobs: readyToRetry,
        failedQueueJobs: failed,
        wouldLeaseCount: status.budget?.wouldLeaseCount ?? 0,
        delayedCount: status.budget?.delayedCount ?? 0
      },
      failedGates: failedGates(gates),
      recommendedActions: ok ? [] : [
        ...(readyToRetry > 0 ? ["wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry"] : []),
        ...(failed > 0 ? ["inspect operator queue failed jobs before promotion"] : [])
      ],
      gates,
      budget: status.budget
    }, null, 2));
    if (!ok) process.exitCode = 1;
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
	      const gates = coverageAuditGates(audit);
	      const coverageOk = gates.every((gate) => gate.ok);
	      console.log(JSON.stringify({
	        ...audit,
	        ok: coverageOk,
	        healthScope: "coverage",
	        healthState: coverageOk ? "coverage_ok" : "coverage_blocked",
	        coverageOk,
	        runtimeOk: null,
	        failedGates: failedGates(gates),
	        recommendedActions: coverageAuditRecommendedActions(audit),
	        gates
	      }, null, 2));
	      if (!coverageOk) process.exitCode = 1;
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
    const issueEnrichmentRuntime = collectOperatorIssueEnrichmentRuntime(args["state-path"] ?? config.statePath, {
      repo: args.repo,
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
    });
    const github = new GitHubApi(config.github);
    const status = buildOperatorStatus({
      release,
      coverage,
      agents,
      providerCooldowns,
      durableQueue,
      issueEnrichment: buildIssueEnrichmentStatus({
        config,
        canPostAsApp: github.canPostAsApp(),
        checkedAt: release.checkedAt
      }),
      issueEnrichmentRuntime
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
    return;
  }

  if (command === "runtime-inventory") {
    const config = loadConfig(args.config);
    const release = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: args.config,
      expectedHead: args["expected-head"],
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"]
    });
    const coverage = await collectCoverageReport(args, config);
    const statePath = args["state-path"] ?? config.statePath;
    const now = new Date();
    const agents = summarizeAgentInventory({
      launchd: release.launchd,
      heartbeat: release.heartbeat,
      leases: collectOperatorLeases(statePath),
      now
    });
    const providerCooldowns = collectOperatorProviderCooldowns(statePath, {
      repo: args.repo,
      expiredOnly: false,
      now
    });
    const repoProviderCooldowns = collectOperatorRepoProviderCooldowns(statePath, {
      repo: args.repo,
      activeOnly: args["active-only"] === "true",
      now
    });
    const durableQueue = collectOperatorReviewQueue(statePath, {
      repo: args.repo,
      now
    });
    const issueEnrichmentRuntime = collectOperatorIssueEnrichmentRuntime(statePath, {
      repo: args.repo,
      now
    });
    const github = new GitHubApi(config.github);
    const processes = collectBotProcessInventory({
      repoPath: process.cwd(),
      launchdLabel: release.launchd.label,
      launchdPid: release.launchd.pid,
      now
    });
    const inventory = buildRuntimeInventory({
      release,
      coverage,
      agents,
      processes,
      providerCooldowns,
      repoProviderCooldowns,
      durableQueue,
      issueEnrichment: buildIssueEnrichmentStatus({
        config,
        canPostAsApp: github.canPostAsApp(),
        checkedAt: now.toISOString()
      }),
      issueEnrichmentRuntime,
      checkedAt: now.toISOString()
    });
    console.log(args.human === "true" ? formatRuntimeInventoryHuman(inventory) : JSON.stringify(inventory, null, 2));
    if (!inventory.ok) process.exitCode = 1;
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
	    const statePath = args["state-path"] ?? config.statePath;
	    const queueState = parseReviewQueueJobState(args.state);
	    const durableQueue = collectOperatorReviewQueue(statePath, {
	      repo: args.repo,
	      state: queueState,
	      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
	    });
	    const budgetQueue = collectOperatorReviewQueue(statePath, {
	      repo: args.repo,
	      state: queueState
	    });
	    const budgetOutput = collectQueueBudget(config, collectBudgetJobsForSelection(statePath, budgetQueue.jobs));
    const gates = queueHealthGates(queue, durableQueue, budgetOutput.budget);
    const ok = gates.every((gate) => gate.ok);
    const output = {
      ...queue,
      ok,
      healthState: ok ? "runtime_ok" : "runtime_blocked",
      coverageOk: queue.ok,
      runtimeOk: ok,
      failedGates: failedGates(gates),
      recommendedActions: queueRecommendedActions(gates),
      actionableRows: queueActionableRows(durableQueue, budgetOutput.budget),
      gates,
      coverage: queue,
      durableQueue,
      ...budgetOutput
    };
    console.log(JSON.stringify(output, null, 2));
    if (!output.ok) process.exitCode = 1;
    return;
  }

  if (command === "dashboard") {
    const config = loadConfig(args.config);
    const report = await collectCoverageReport(args, config);
    const statePath = args["state-path"] ?? config.statePath;
    const dashboard = buildOperatorDashboard({
      coverage: report,
      durableQueue: collectOperatorReviewQueue(statePath, {
        repo: args.repo,
        limit: args["job-limit"] ? parsePositiveInteger(args["job-limit"], "--job-limit") : undefined
      }),
      readiness: collectOperatorReviewReadiness(statePath, {
        repo: args.repo,
        limit: args["job-limit"] ? parsePositiveInteger(args["job-limit"], "--job-limit") : undefined
      }),
      evidenceDir: config.evidenceDir,
      filters: {
        ...(args.repo ? { repo: args.repo } : {}),
        ...(args.status ?? args.state ? { status: args.status ?? args.state } : {}),
        ...(args.priority ? { priority: parseNonNegativeInteger(args.priority, "--priority") } : {}),
        ...(args["stale-head-reason"] ? { staleHeadReason: args["stale-head-reason"] } : {}),
        ...(args["include-history"] === "true" ? { includeHistory: true } : {}),
        ...(args.limit ? { limit: parsePositiveInteger(args.limit, "--limit") } : {})
      }
    });
    console.log(args.human === "true" ? formatOperatorDashboardHuman(dashboard) : JSON.stringify(dashboard, null, 2));
    if (!dashboard.ok) process.exitCode = 1;
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

  if (command === "build-memory-packet") {
    if (!args.repo) throw new Error("--repo is required for build-memory-packet");
    const config = loadConfig(args.config);
    const generatedAt = args["generated-at"] ?? new Date().toISOString();
    const generatedAtDate = parseCanonicalIsoTimestamp(generatedAt, "--generated-at");
    const memoryConfig = config.repoMemory!;
    const statePath = args["state-path"] ?? config.statePath;
    if (args["state-path"] && realPathPreservingMissing(args["state-path"]) !== realPathPreservingMissing(config.statePath)) {
      throw new Error("--state-path for build-memory-packet must match the configured statePath");
    }
    const includeExpired = args["include-stale"] === "true" || memoryConfig.includeStaleNotes;
    const noteLimit = args["note-limit"] ? parsePositiveInteger(args["note-limit"], "--note-limit") : memoryConfig.maxStateNotes;
    const promptNotes = listRepoMemoryNotesReadOnly(statePath, {
      repo: args.repo,
      includeExpired,
      now: generatedAtDate,
      limit: noteLimit,
      excludeKind: "false_positive"
    });
    const falsePositiveNotes = listRepoMemoryNotesReadOnly(statePath, {
      repo: args.repo,
      includeExpired,
      now: generatedAtDate,
      limit: noteLimit,
      kind: "false_positive"
    });
    const result = buildRepoMemoryPacket({
      repo: args.repo,
      humanMarkdown: readRepoMemoryMarkdown(args["memory-root"] ?? memoryConfig.memoryRoot, args.repo),
      stateNotes: [...promptNotes, ...falsePositiveNotes],
      findingFingerprints: parseCsv(args.fingerprint),
      generatedAt,
      packetVersion: memoryConfig.packetVersion,
      maxPacketBytes: args["max-bytes"] ? parsePositiveInteger(args["max-bytes"], "--max-bytes") : memoryConfig.maxPacketBytes,
      includeStaleNotes: includeExpired
    });
    if (result.ok && args["record-build"] === "true") {
      const state = new ReviewStateStore(statePath);
      try {
        state.recordRepoMemoryPacketBuild({
          packetSha: result.packet.sha256,
          repo: result.packet.repo,
          packetVersion: result.packet.packetVersion,
          generatedAt: result.packet.generatedAt,
          byteEstimate: result.packet.byteEstimate,
          tokenEstimate: result.packet.tokenEstimate,
          includedNoteIds: result.packet.sources.filter((source) => source.type === "sqlite_note").map((source) => source.id),
          redactionStatus: result.redactionReport.ok ? "passed" : "failed",
          memoryRoot: args["memory-root"] ?? memoryConfig.memoryRoot
        });
      } finally {
        state.close();
      }
    }
    if (result.ok && args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      writeFileSync(join(safeOutputDir, "repo-memory-packet.json"), `${JSON.stringify(result, null, 2)}\n`);
      writeFileSync(join(safeOutputDir, "repo-memory-packet.md"), result.packet.markdown);
    }
    const format = args.format ?? "json";
    const jsonOutput = redactSecrets(JSON.stringify(result, null, 2));
    if (format === "markdown") {
      console.log(result.ok ? result.packet.markdown : jsonOutput);
    } else if (format === "both" && result.ok) {
      console.log(`${jsonOutput}\n\n${result.packet.markdown}`);
    } else {
      console.log(jsonOutput);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "build-gitnexus-context-packet") {
    if (!args.repo) throw new Error("--repo is required for build-gitnexus-context-packet");
    if (!args.pr) throw new Error("--pr is required for build-gitnexus-context-packet");
    const repo = parseSingleArg(args.repo, "--repo");
    const pullNumber = parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr");
    const config = loadConfig(args.config);
    const generatedAt = args["generated-at"] ?? new Date().toISOString();
    parseCanonicalIsoTimestamp(generatedAt, "--generated-at");
    const gitnexusConfig = config.gitnexusContext!;
    const github = new GitHubApi(config.github);
    const pull = await github.getPull(repo, pullNumber);
    const files = await github.listPullFiles(repo, pullNumber);
    const result = buildGitNexusContextPacket({
      repo,
      pull,
      files,
      config: {
        ...gitnexusConfig,
        enabled: true,
        ...(args["max-bytes"] ? { maxPacketBytes: parsePositiveInteger(parseSingleArg(args["max-bytes"], "--max-bytes"), "--max-bytes") } : {}),
        ...(args["max-related-items"]
          ? { maxRelatedItems: parsePositiveInteger(parseSingleArg(args["max-related-items"], "--max-related-items"), "--max-related-items") }
          : {}),
        ...(args["query-limit"] ? { queryLimit: parsePositiveInteger(parseSingleArg(args["query-limit"], "--query-limit"), "--query-limit") } : {})
      },
      generatedAt
    });
    if (args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      const jsonName = result.ok ? "gitnexus-context-packet.json" : "gitnexus-context-packet-error.json";
      writeFileSync(join(safeOutputDir, jsonName), `${redactSecrets(JSON.stringify(result, null, 2))}\n`);
      if (result.ok) writeFileSync(join(safeOutputDir, "gitnexus-context-packet.md"), result.packet.markdown);
    }
    const format = args.format ?? "json";
    if (format === "markdown") {
      console.log(result.ok ? result.packet.markdown : JSON.stringify(result, null, 2));
    } else if (format === "both" && result.ok) {
      console.log(`${JSON.stringify(result, null, 2)}\n\n${result.packet.markdown}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "build-github-related-context-packet") {
    if (!args.repo) throw new Error("--repo is required for build-github-related-context-packet");
    if (!args.pr) throw new Error("--pr is required for build-github-related-context-packet");
    const repo = parseSingleArg(args.repo, "--repo");
    const pullNumber = parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr");
    const config = loadConfig(args.config);
    const generatedAt = args["generated-at"] ?? new Date().toISOString();
    parseCanonicalIsoTimestamp(generatedAt, "--generated-at");
    const relatedConfig = config.githubRelatedContext!;
    const github = new GitHubApi({
      ...config.github,
      requestTimeoutMs: relatedConfig.requestTimeoutMs
    });
    const pull = await github.getPull(repo, pullNumber);
    const result = await buildGitHubRelatedContextPacket({
      repo,
      pull,
      config: {
        ...relatedConfig,
        enabled: true,
        ...(args["max-bytes"] ? { maxPacketBytes: parsePositiveInteger(parseSingleArg(args["max-bytes"], "--max-bytes"), "--max-bytes") } : {}),
        ...(args["max-related-items"]
          ? { maxRelatedItems: parsePositiveInteger(parseSingleArg(args["max-related-items"], "--max-related-items"), "--max-related-items") }
          : {}),
        ...(args["max-body-bytes"] ? { maxBodyBytes: parseNonNegativeInteger(parseSingleArg(args["max-body-bytes"], "--max-body-bytes"), "--max-body-bytes") } : {}),
        ...(args["include-cross-repo-refs"] ? { includeCrossRepoRefs: parseBooleanArg(args["include-cross-repo-refs"], "--include-cross-repo-refs") } : {})
      },
      reader: github,
      generatedAt
    });
    if (args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      const jsonName = result.ok ? "github-related-context-packet.json" : "github-related-context-packet-error.json";
      writeFileSync(join(safeOutputDir, jsonName), `${redactSecrets(JSON.stringify(result, null, 2))}\n`);
      if (result.ok) writeFileSync(join(safeOutputDir, "github-related-context-packet.md"), result.packet.markdown);
    }
    const format = args.format ?? "json";
    if (format === "markdown") {
      console.log(result.ok ? result.packet.markdown : JSON.stringify(result, null, 2));
    } else if (format === "both" && result.ok) {
      console.log(`${JSON.stringify(result, null, 2)}\n\n${result.packet.markdown}`);
    } else {
      console.log(JSON.stringify(result, null, 2));
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "build-skill-pack") {
    const config = loadConfig(args.config);
    const generatedAt = args["generated-at"] ?? new Date().toISOString();
    parseCanonicalIsoTimestamp(generatedAt, "--generated-at");
    const result = buildSkillPackContextPacket({
      config: {
        ...config.skillPacks!,
        enabled: true
      },
      generatedAt
    });
    if (args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      const jsonName = result.ok ? "skill-pack-context-packet.json" : "skill-pack-context-packet-error.json";
      writeFileSync(join(safeOutputDir, jsonName), `${redactSecrets(JSON.stringify(result, null, 2))}\n`);
      if (result.ok) writeFileSync(join(safeOutputDir, "skill-pack-context-packet.md"), result.packet.markdown);
    }
    const jsonOutput = redactSecrets(JSON.stringify(result, null, 2));
    console.log(jsonOutput);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "build-enrichment-comment") {
    if (!args.repo) throw new Error("--repo is required for build-enrichment-comment");
    if (Boolean(args.pr) === Boolean(args.issue)) throw new Error("exactly one of --pr or --issue is required for build-enrichment-comment");
    const repo = parseSingleArg(args.repo, "--repo");
    const config = loadConfig(args.config);
    const github = new GitHubApi(config.github);
    const repoPolicy = resolveRepoProfile(config, repo);
    const enrichmentConfig = config.enrichment!;
    if (args.issue) {
      const issueNumber = parsePositiveInteger(parseSingleArg(args.issue, "--issue"), "--issue");
      const issue = await github.getIssueOrPull(repo, issueNumber, { tolerateUnreadable: true });
      if (!issue) throw new Error(`Issue ${repo}#${issueNumber} was not found or is not readable`);
      const issuePolicy = resolveIssueEnrichmentRepoPolicy(config.issueEnrichment!, repo);
      const output = buildIssueEnrichmentDryRunOutput({
        repo,
        issue,
        allowedLabels: issuePolicy.suggestions.allowedLabels,
        allowedOwners: issuePolicy.suggestions.allowedReviewers,
        validationSuggestions: ["Confirm owner, acceptance criteria, and validation evidence before implementation."],
        maxRelatedRefs: enrichmentConfig.maxRelatedRefs,
        maxSuggestions: enrichmentConfig.maxSuggestions
      });
      if (args["output-dir"]) {
        const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
        mkdirSync(safeOutputDir, { recursive: true });
        writeFileSync(join(safeOutputDir, "enrichment-comment.json"), `${redactSecrets(JSON.stringify(output, null, 2))}\n`);
        if (!output.skipped) writeFileSync(join(safeOutputDir, "enrichment.md"), output.body);
      }
      console.log(redactSecrets(JSON.stringify(output, null, 2)));
      return;
    }
    if (!repoPolicy.allowed) throw new Error(`Repo ${repo} is skipped by policy: ${repoPolicy.reason}`);
    const prArg = parseSingleArg(args.pr ?? [], "--pr");
    const pullNumber = parsePositiveInteger(prArg, "--pr");
    const pull = await github.getPull(repo, pullNumber);
    const files = await github.listPullFiles(repo, pullNumber);
    const validation = buildChangedSurfaceValidationReport({
      repo,
      pull,
      files,
      profile: repoPolicy.profile
    });
    const proof = evaluateProofRequirements({ pull, validation });
    const enrichment = buildEnrichmentComment({
      repo,
      pull,
      files,
      suggestedLabels: repoPolicy.profile.suggestedLabels,
      suggestedReviewers: repoPolicy.profile.suggestedReviewers,
      validationSuggestions: [
        ...validation.recommendations.map((recommendation) => `${recommendation.title}: ${recommendation.reason}`),
        `Proof status: ${proof.status} - ${proof.summary}`
      ],
      maxRelatedRefs: enrichmentConfig.maxRelatedRefs,
      maxSuggestions: enrichmentConfig.maxSuggestions,
      postIssueComment: false
    });
    const output = {
      ok: true,
      repo,
      pullNumber,
      headSha: pull.head.sha,
      marker: enrichment.marker,
      body: enrichment.body
    };
    if (args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      writeFileSync(join(safeOutputDir, "enrichment-comment.json"), `${redactSecrets(JSON.stringify(output, null, 2))}\n`);
      writeFileSync(join(safeOutputDir, "enrichment.md"), enrichment.body);
    }
    console.log(redactSecrets(JSON.stringify(output, null, 2)));
    return;
  }

  if (command === "issue-enrichment-scan") {
    const config = loadConfig(args.config);
    const dryRun = args["dry-run"] !== "false";
    if (!dryRun) throw new Error("issue-enrichment-scan currently supports dry-run only; live issue comments require a separate promotion gate");
    const github = new GitHubApi(config.github);
    const scan = await collectIssueEnrichmentScan({
      config,
      reader: github,
      dryRun,
      canPostAsApp: github.canPostAsApp(),
      ...(args.repo ? { repo: parseSingleArg(args.repo, "--repo") } : {}),
      includeExisting: args["include-existing"] === "true",
      ...(args.since ? { since: parseCanonicalIsoTimestamp(parseSingleArg(args.since, "--since"), "--since").toISOString() } : {})
    });
    if (args["output-dir"]) {
      const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
      mkdirSync(safeOutputDir, { recursive: true });
      writeFileSync(join(safeOutputDir, "issue-enrichment-scan.json"), `${redactSecrets(JSON.stringify(scan, null, 2))}\n`);
    }
    console.log(redactSecrets(JSON.stringify(scan, null, 2)));
    if (!scan.ok) process.exitCode = 1;
    return;
  }

  if (command === "clear-issue-enrichment-leases") {
    const config = loadConfig(args.config);
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const confirm = args.confirm === undefined ? false : parseBooleanArg(args.confirm, "--confirm");
    const expiredOnly = args["expired-only"] === undefined ? false : parseBooleanArg(args["expired-only"], "--expired-only");
    const forceActive = args["force-active"] === undefined ? false : parseBooleanArg(args["force-active"], "--force-active");
    if (!dryRun && !confirm) {
      throw new Error("clear-issue-enrichment-leases requires --confirm true when --dry-run false");
    }
    if (!dryRun && !expiredOnly && !forceActive) {
      throw new Error("clearing active issue-enrichment leases requires --force-active true; use --expired-only true for expired-only cleanup");
    }
    const statePath = args["state-path"] ?? config.statePath;
    const state = new ReviewStateStore(statePath);
    try {
      const result = state.clearIssueEnrichmentRunLeases({ expiredOnly, dryRun });
      const recommendedActions = buildIssueEnrichmentLeaseClearRecommendations({
        dryRun,
        expiredOnly,
        activeMatched: result.activeMatched,
        expiredMatched: result.expiredMatched
      });
      console.log(redactSecrets(JSON.stringify({ ok: true, statePath, forceActive, ...result, recommendedActions }, null, 2)));
    } finally {
      state.close();
    }
    return;
  }

  if (command === "clear-review-queue-leases") {
    const config = loadConfig(args.config);
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const confirm = args.confirm === undefined ? false : parseBooleanArg(args.confirm, "--confirm");
    const expiredOnly = args["expired-only"] === undefined ? true : parseBooleanArg(args["expired-only"], "--expired-only");
    const forceActive = args["force-active"] === undefined ? false : parseBooleanArg(args["force-active"], "--force-active");
    if (!dryRun && !confirm) {
      throw new Error("clear-review-queue-leases requires --confirm true when --dry-run false");
    }
    if (!dryRun && !expiredOnly && !forceActive) {
      throw new Error("clearing active review queue leases requires --force-active true; use --expired-only true for expired-only cleanup");
    }
    const statePath = args["state-path"] ?? config.statePath;
    const state = new ReviewStateStore(statePath);
    try {
      const result = state.clearReviewQueueLeases({
        dryRun,
        expiredOnly,
        forceActive,
        leaseTtlMs: config.reviewConcurrency.leaseTtlMs,
        ...(args.repo ? { repo: parseSingleArg(args.repo, "--repo") } : {}),
        ...(args.pr ? { pullNumber: parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr") } : {}),
        ...(args["job-id"] ? { jobId: parseSingleArg(args["job-id"], "--job-id") } : {})
      });
      const recommendedActions = buildReviewQueueLeaseClearRecommendations({
        dryRun,
        expiredOnly,
        forceActive,
        expiredMatched: result.expiredMatched,
        activeMatched: result.activeMatched
      });
      console.log(redactSecrets(JSON.stringify({
        ok: true,
        statePath,
        forceActive,
        ...result,
        recommendedActions
      }, null, 2)));
    } finally {
      state.close();
    }
    return;
  }

  if (command === "finishing-touch-dry-run") {
    if (!args.repo) throw new Error("--repo is required for finishing-touch-dry-run");
    if (!args.pr) throw new Error("--pr is required for finishing-touch-dry-run");
    if (!args["head-sha"]) throw new Error("--head-sha is required for finishing-touch-dry-run");
    if (!args["current-head"]) throw new Error("--current-head is required for finishing-touch-dry-run");
    if (!args.author) throw new Error("--author is required for finishing-touch-dry-run");
    if (!args["comment-id"]) throw new Error("--comment-id is required for finishing-touch-dry-run");
    if (args["dry-run"] !== undefined && args["dry-run"] !== "true" && args["dry-run"] !== "false") {
      throw new Error("--dry-run must be true or false");
    }
    if (args.record !== undefined && args.record !== "true" && args.record !== "false") {
      throw new Error("--record must be true or false");
    }
    const dryRun = args["dry-run"] !== "false";
    const record = args.record === "true";
    if (dryRun && record) throw new Error("--record true requires --dry-run false");
    const repo = parseSingleArg(args.repo, "--repo");
    const headSha = parseSingleArg(args["head-sha"], "--head-sha");
    const author = parseSingleArg(args.author, "--author");
    const action = resolveFinishingTouchAction({
      action: args.action,
      body: args.body,
      botMentions: args["bot-mentions"]
    });
    const pullNumber = parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr");
    const commentId = parsePositiveInteger(parseSingleArg(args["comment-id"], "--comment-id"), "--comment-id");
    const trustedAuthors = parseCsv(args["trusted-authors"]);
    const worktreeClean = args["worktree-clean"] === undefined
      ? true
      : parseBooleanArg(args["worktree-clean"], "--worktree-clean");
    const trigger = parseSingleArg(args.body ?? args.action ?? action, "--body");
    const draft = buildFinishingTouchDraft({
      repo,
      pullNumber,
      headSha,
      action,
      author,
      commentId,
      trigger,
      ...(args["generated-at"] ? { generatedAt: args["generated-at"] } : {})
    });
    const validation = validateFinishingTouchRequest({
      repo,
      pullNumber,
      headSha,
      currentHeadSha: parseSingleArg(args["current-head"], "--current-head"),
      commentId,
      author,
      trustedAuthors,
      worktreeClean,
      action,
      proposedOutput: draft
    });
    if (!validation.ok) {
      console.log(redactSecrets(JSON.stringify({ ok: false, dryRun, validation }, null, 2)));
      process.exitCode = 1;
      return;
    }
    let stored;
    if (record) {
      const config = loadConfig(args.config);
      const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
      try {
        stored = state.recordFinishingTouchDraft({
          repo,
          pullNumber,
          headSha,
          commandCommentId: commentId,
          action,
          author,
          trigger,
          status: "drafted",
          proposedOutput: draft
        });
      } finally {
        state.close();
      }
    }
    console.log(redactSecrets(JSON.stringify({
      ok: true,
      dryRun,
      recorded: Boolean(stored),
      draft,
      ...(stored ? { stored } : {})
    }, null, 2)));
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
    const outputRoot = assertEvalOutputDirSafe(args["output-root"]);
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
            outputDir: join(outputRoot, runId)
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
    mkdirSync(outputRoot, { recursive: true });
    writeFileSync(join(outputRoot, "suite-summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
    const scorecards = results.flatMap((result) => "scorecard" in result ? [result.scorecard] : []);
    writeFileSync(join(outputRoot, "promotion-decision.md"), buildEvalPromotionDecisionMarkdown({
      ok: summary.ok,
      scenarioCount: summary.scenarioCount,
      missingSuites,
      scorecards
    }));
    console.log(JSON.stringify(summary, null, 2));
    if (!summary.ok) process.exitCode = 1;
    return;
  }

  if (command === "eval-sticky-vs-cold") {
    if (!args.input) throw new Error("--input is required for eval-sticky-vs-cold");
    if (!args["output-root"]) throw new Error("--output-root is required for eval-sticky-vs-cold");
    assertEvalOutputDirSafe(args["output-root"]);
    const input = readJsonInput(args.input, "--input") as Parameters<typeof runStickyVsColdEval>[0];
    const result = runStickyVsColdEval(input, {
      outputRoot: args["output-root"]
    });
    console.log(JSON.stringify(result.summary, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "run-once" || command === "review-pr") {
    if (command === "review-pr" && (!args.repo || !args.pr)) {
      console.log(JSON.stringify({
        ok: false,
        command: "review-pr",
        error: "review-pr requires --repo and --pr so the public alias cannot scan every configured repository"
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    const repo = args.repo ? parseSingleArg(args.repo, "--repo") : undefined;
    const dryRun = args["dry-run"] !== "false";
    if (command === "review-pr" && !dryRun && args.confirm !== "true") {
      console.log(JSON.stringify({
        ok: false,
        command: "review-pr",
        ...(repo ? { repo } : {}),
        error: "review-pr requires --confirm true when --dry-run false is used"
      }, null, 2));
      process.exitCode = 1;
      return;
    }
    let reviewPrExpectedHeadSha: string | undefined;
    if (command === "review-pr" && !dryRun) {
      const configPath = args.config ? parseSingleArg(args.config, "--config") : undefined;
      if (!configPath) {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          ...(repo ? { repo } : {}),
          error: "review-pr requires --config when --dry-run false is used"
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (!existsSync(configPath) || !statSync(configPath).isFile()) {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          ...(repo ? { repo } : {}),
          error: "review-pr --config must point to an existing config file when --dry-run false is used"
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      if (args["head-sha"] && args["expected-head"] && args["head-sha"] !== args["expected-head"]) {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          ...(repo ? { repo } : {}),
          error: "review-pr --head-sha and --expected-head must match when both are provided"
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      reviewPrExpectedHeadSha = args["head-sha"] ?? args["expected-head"];
      if (!reviewPrExpectedHeadSha) {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          ...(repo ? { repo } : {}),
          error: "review-pr requires --head-sha when --dry-run false is used"
        }, null, 2));
        process.exitCode = 1;
        return;
      }
    }
    if (command === "review-pr") {
      const config = loadConfig(args.config);
      const allowedRepoError = validateReviewPrRepoAllowed(config, repo!);
      if (allowedRepoError) {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          repo: repo!,
          error: allowedRepoError
        }, null, 2));
        process.exitCode = 1;
        return;
      }
    }
    const useZCode = args.zcode !== "false";
    let pullNumber: number | undefined;
    try {
      pullNumber = args.pr ? parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr") : undefined;
    } catch (error) {
      if (command === "review-pr") {
        console.log(JSON.stringify({
          ok: false,
          command: "review-pr",
          ...(repo ? { repo } : {}),
          error: error instanceof Error ? error.message : String(error)
        }, null, 2));
        process.exitCode = 1;
        return;
      }
      throw error;
    }
    const result = await runOnceCliCommand({
      options: {
        configPath: args.config,
        dryRun,
        repo,
        pullNumber,
        useZCode,
        expectedHeadSha: reviewPrExpectedHeadSha
      },
      commandName: command
    });
    console.log(result.output);
    if (result.exitCode !== 0) process.exitCode = result.exitCode;
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
    const statePath = args["state-path"] ?? config.statePath;
    const state = new ReviewStateStore(statePath);
    try {
      const checkedAt = new Date();
      const expiredOnly = args["expired-only"] === "true";
      const limit = args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined;
      const rows = state.listProviderCooldownReviews({
        repo: args.repo,
        expiredOnly,
        limit
      });
      const expiredCount = rows.filter((row) => row.expired).length;
      const durableQueue = collectOperatorReviewQueue(statePath, {
        repo: args.repo,
        now: checkedAt
      });
      const activeProviderCooldowns = state.listRepoProviderCooldowns({ activeOnly: true, now: checkedAt });
      const budget = buildReviewBudgetStatus({
        config,
        jobs: collectBudgetJobsForSelection(statePath, durableQueue.jobs, checkedAt),
        now: checkedAt,
        includeDetails: false,
        inputJobLimit: durableQueue.jobs.length + activeProviderCooldowns.length
      });
      const failedQueueJobs = durableQueue.summary.failed;
      const retryableProviderDeferred = durableQueue.summary.retryableProviderDeferred;
      const readyToRetry = budget.providerDeferred.readyToRetry;
      const activeProviderCooldownCount = activeProviderCooldowns.length;
      const gates = [
        {
          name: "provider_cooldowns_no_expired_rows",
          ok: expiredCount === 0,
          detail: `${expiredCount} expired provider cooldown row(s)`
        },
        {
          name: "provider_cooldowns_no_failed_queue_jobs",
          ok: failedQueueJobs === 0,
          detail: `${failedQueueJobs} failed durable queue job(s)`
        },
        {
          name: "provider_cooldowns_no_retryable_provider_deferred_jobs",
          ok: retryableProviderDeferred === 0,
          detail:
            `${retryableProviderDeferred} retryable provider-deferred job(s); ` +
            `${readyToRetry} ready now; ${budget.providerDeferred.waitingProviderCapacity} waiting provider capacity`
        }
      ];
      const ok = gates.every((gate) => gate.ok);
      console.log(JSON.stringify({
        ok,
        healthState: ok
          ? "provider_cooldowns_ok"
          : retryableProviderDeferred > 0 && (readyToRetry === 0 || activeProviderCooldownCount > 0)
            ? "provider_cooldowns_backpressured"
            : "provider_cooldowns_actionable",
        runtimeOk: ok,
        checkedAt: checkedAt.toISOString(),
        expiredOnly,
        ...(args.repo ? { repo: args.repo } : {}),
        summary: {
          total: rows.length,
          expired: expiredCount,
          failedQueueJobs,
          providerDeferredJobs: durableQueue.summary.providerDeferred,
          retryableProviderDeferredJobs: retryableProviderDeferred,
          readyToRetryProviderDeferredJobs: readyToRetry,
          activeProviderCooldowns: activeProviderCooldownCount,
          waitingProviderCapacity: budget.providerDeferred.waitingProviderCapacity,
          waitingCooldown: budget.providerDeferred.waitingCooldown
        },
        failedGates: failedGates(gates),
        recommendedActions: providerCooldownRecommendedActions({
          configPath: args.config ?? "(default config)",
          repo: args.repo,
          expiredCount,
          failedQueueJobs,
          retryableProviderDeferred,
          readyToRetry,
          activeProviderCooldownCount,
          waitingProviderCapacity: budget.providerDeferred.waitingProviderCapacity
        }),
        gates,
        count: rows.length,
        expiredCount,
        durableQueue,
        budget,
        rows
      }, null, 2));
      if (!ok) process.exitCode = 1;
    } finally {
      state.close();
    }
    return;
  }

  if (command === "provider-throttle-report") {
    const config = loadConfig(args.config);
    const report = collectProviderThrottleReport({
      statePath: args["state-path"] ?? config.statePath,
      since: args.since ? parseSingleArg(args.since, "--since") : undefined,
      timezone: args.timezone ? parseSingleArg(args.timezone, "--timezone") : undefined,
      peakStartHour: args["peak-start-hour"] ? parseHourArg(args["peak-start-hour"], "--peak-start-hour") : undefined,
      peakEndHour: args["peak-end-hour"] ? parseHourArg(args["peak-end-hour"], "--peak-end-hour") : undefined
    });
    console.log(JSON.stringify(report, null, 2));
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
    const pullNumber = Number(args.pr);
    const headSha = args["head-sha"];
    const reason = normalizeRetirementReason(args.reason);
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const config = loadConfig(args.config);
    const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
    try {
      if (dryRun) {
        const current = state.getProcessedReview(args.repo, pullNumber, headSha);
        if (!current) {
          throw new Error(`Refusing to retire missing review row for ${args.repo}#${pullNumber}@${headSha}`);
        }
        const queueJobsToRetire = state
          .listReviewQueueJobsForPull({ repo: args.repo, pullNumber, state: "failed" })
          .filter((job) => job.headSha === headSha);
        if (current.status !== "failed") {
          if (current.status === "skipped" && current.error?.startsWith("retired_failed_head:")) {
            console.log(stringifyRedactedJson({ ok: true, dryRun, alreadyRetired: current, queueJobsToRetire }));
            return;
          }
          throw new Error(
            `Refusing to retire ${args.repo}#${pullNumber}@${headSha}: status is ${current.status}, not failed`
          );
        }
        const retiredErrorPreview = buildRetiredFailedHeadError({ reason, previousError: current.error });
        console.log(stringifyRedactedJson({ ok: true, dryRun, wouldRetire: current, queueJobsToRetire, reason, retiredErrorPreview }));
        return;
      }
      const retired = state.retireFailedReview({
        repo: args.repo,
        pullNumber,
        headSha,
        reason
      });
      console.log(stringifyRedactedJson({ ok: true, dryRun, retired }));
    } finally {
      state.close();
    }
    return;
  }

  if (command === "daemon") {
    const daemonAction = args._[1];
    if (daemonAction === "start" || daemonAction === "stop" || daemonAction === "status") {
      const result = runDaemonControlCommandSafely(daemonAction, args);
      console.log(JSON.stringify(result, null, 2));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (daemonAction) {
      throw new Error("daemon subcommand must be one of: start, stop, status");
    }
    const config = loadConfig(args.config);
    const monitoredRepos = listReposToScan(config);
    let cycle = 0;
    const runOnce = args.once === "true";
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
        issueEnrichmentEnabled: config.issueEnrichment?.enabled === true,
        configPath: args.config
      });
      if (runOnce) return;
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

function runInitCommand(args: ParsedArgs): {
  ok: boolean;
  command: "init";
  configPath: string;
  created: boolean;
  examplePath: string;
  recommendedCommands: string[];
  backupPath?: string;
  error?: string;
} {
  const configPath = resolve(parseSingleArg(args.config ?? "config.local.json", "--config"));
  const examplePath = join(resolvePackageRoot(), "config.example.json");
  const force = args.force === "true";
  if (!existsSync(examplePath)) {
    return {
      ok: false,
      command: "init",
      configPath,
      created: false,
      examplePath,
      recommendedCommands: [],
      error: "config.example.json not found in the current checkout"
    };
  }
  if (existsSync(configPath) && !force) {
    return {
      ok: false,
      command: "init",
      configPath,
      created: false,
      examplePath,
      recommendedCommands: [`neondiff doctor --config ${configPath} --json`],
      error: "config already exists; rerun with --force true to overwrite"
    };
  }
  const forceTargetError = force ? validateInitForceTarget(configPath) : undefined;
  if (forceTargetError) {
    return {
      ok: false,
      command: "init",
      configPath,
      created: false,
      examplePath,
      recommendedCommands: [`neondiff init --config ${configPath}`],
      error: forceTargetError
    };
  }
  const backupPath = force && existsSync(configPath) ? backupInitForceTarget(configPath) : undefined;
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, readFileSync(examplePath, "utf8"));
  return {
    ok: true,
    command: "init",
    configPath,
    created: true,
    examplePath,
    ...(backupPath ? { backupPath } : {}),
    recommendedCommands: [
      `neondiff doctor --config ${configPath} --json`,
      `neondiff review-pr --config ${configPath} --repo owner/name --pr 123 --dry-run true --zcode false`,
      `neondiff status --config ${configPath} --json`
    ]
  };
}

function resolvePackageRoot(): string {
  for (const start of [dirname(fileURLToPath(import.meta.url)), process.cwd()]) {
    let cursor = resolve(start);
    while (true) {
      if (isNeonDiffPackageRoot(cursor)) {
        return cursor;
      }
      const parent = dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
  }
  return process.cwd();
}

function isNeonDiffPackageRoot(candidate: string): boolean {
  if (!existsSync(join(candidate, "package.json")) || !existsSync(join(candidate, "config.example.json"))) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    return packageJson.name === "evaos-code-review-bot"
      && packageJson.bin?.neondiff === "dist/src/cli.js";
  } catch {
    return false;
  }
}

function validateReviewPrRepoAllowed(config: ReturnType<typeof loadConfig>, repo: string): string | undefined {
  const configuredRepos = listReposToScan(config);
  if (!configuredRepos.map(canonicalRepoNameForCli).includes(canonicalRepoNameForCli(repo))) {
    return `review-pr repo must be present in configured repos: ${configuredRepos.join(", ") || "(none)"}`;
  }
  const policy = resolveRepoProfile(config, repo);
  if (!policy.allowed) {
    return `review-pr repo is blocked by repo policy: ${policy.reason}`;
  }
  return undefined;
}

function canonicalRepoNameForCli(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${owner?.toLowerCase() ?? ""}/${name?.toLowerCase() ?? ""}`;
}

function validateInitForceTarget(configPath: string): string | undefined {
  if (!existsSync(configPath)) return undefined;
  if (extname(configPath) !== ".json") {
    return "--force true only overwrites existing JSON config files";
  }
  const stat = statSync(configPath);
  if (!stat.isFile()) {
    return "--force true only overwrites existing JSON config files";
  }
  try {
    const parsed = JSON.parse(readFileSync(configPath, "utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "--force true only overwrites existing JSON config object files";
    }
  } catch {
    return "--force true only overwrites existing JSON config files";
  }
  return undefined;
}

function backupInitForceTarget(configPath: string): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupPath = `${configPath}.${timestamp}.bak`;
  writeFileSync(backupPath, readFileSync(configPath, "utf8"));
  return backupPath;
}

type DaemonControlResult = {
  ok: boolean;
  command: "daemon start" | "daemon stop" | "daemon status";
  dryRun?: boolean;
  launchdLabel?: string;
  launchdTarget?: string;
  operation?: "bootstrap_then_kickstart" | "kickstart_existing" | "bootout_plist" | "bootout_service" | "status";
  plistPath?: string;
  warning?: string;
  plannedCommands?: string[][];
  results?: Array<{ command: string[]; exitCode: number; stdout?: string; stderr?: string; error?: string; signal?: string }>;
  status?: ReleaseStatus;
  error?: string;
};

function runDaemonControlCommandSafely(
  action: "start" | "stop" | "status",
  args: ParsedArgs
): DaemonControlResult {
  try {
    return runDaemonControlCommand(action, args);
  } catch (error) {
    return {
      ok: false,
      command: `daemon ${action}`,
      error: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }
}

function runDaemonControlCommand(
  action: "start" | "stop" | "status",
  args: ParsedArgs
): DaemonControlResult {
  if (action === "status") {
    if (!args["launchd-label"]) {
      return {
        ok: false,
        command: "daemon status",
        error: "--launchd-label is required for daemon status"
      };
    }
    if (!args.config) {
      return {
        ok: false,
        command: "daemon status",
        error: "--config is required for daemon status"
      };
    }
    const launchdLabel = parseLaunchdLabelArg(args["launchd-label"], "--launchd-label");
    const launchdTarget = launchdServiceTarget(launchdLabel);
    const status = collectReleaseStatus({
      cwd: process.cwd(),
      configPath: parseSingleArg(args.config, "--config"),
      expectedHead: args["expected-head"],
      launchdLabel,
      statePath: args["state-path"]
    });
    return {
      ok: status.ok,
      command: "daemon status",
      launchdLabel,
      launchdTarget,
      operation: "status",
      status
    };
  }

  if (!args["launchd-label"]) {
    return {
      ok: false,
      command: `daemon ${action}`,
      error: `--launchd-label is required for daemon ${action}`
    };
  }
  const dryRun = args["dry-run"] !== "false";
  const confirm = args.confirm === "true";
  const allowExternalPlist = args["allow-external-plist"] === "true";
  const launchdLabel = parseLaunchdLabelArg(args["launchd-label"], "--launchd-label");
  const plistPath = args.plist ? resolve(parseSingleArg(args.plist, "--plist")) : undefined;
  if (plistPath) assertPlistLabelMatches(plistPath, launchdLabel);
  const launchdTarget = launchdServiceTarget(launchdLabel);
  const commands = buildDaemonLaunchctlCommands({
    action,
    launchdLabel,
    ...(plistPath ? { plistPath } : {})
  });
  const operation = daemonControlOperation(action, plistPath);
  const warning = plistPath ? daemonPlistWarning(plistPath) : undefined;
  if (dryRun) {
    return {
      ok: true,
      command: `daemon ${action}`,
      dryRun,
      launchdLabel,
      launchdTarget,
      operation,
      ...(plistPath ? { plistPath } : {}),
      ...(warning ? { warning } : {}),
      plannedCommands: commands
    };
  }
  const launchdSessionError = launchdUserSessionError();
  if (launchdSessionError) {
    return {
      ok: false,
      command: `daemon ${action}`,
      dryRun,
      launchdLabel,
      launchdTarget,
      operation,
      ...(plistPath ? { plistPath } : {}),
      ...(warning ? { warning } : {}),
      plannedCommands: commands,
      error: launchdSessionError
    };
  }
  if (warning && !allowExternalPlist) {
    return {
      ok: false,
      command: `daemon ${action}`,
      dryRun,
      launchdLabel,
      launchdTarget,
      operation,
      ...(plistPath ? { plistPath } : {}),
      warning,
      plannedCommands: commands,
      error: `daemon ${action} requires --allow-external-plist true when --dry-run false uses a --plist outside the NeonDiff package root`
    };
  }
  if (!confirm) {
    return {
      ok: false,
      command: `daemon ${action}`,
      dryRun,
      launchdLabel,
      launchdTarget,
      operation,
      ...(plistPath ? { plistPath } : {}),
      ...(warning ? { warning } : {}),
      plannedCommands: commands,
      error: `daemon ${action} requires --confirm true when --dry-run false is used`
    };
  }
  const results = runLaunchctlPlan(commands);
  return {
    ok: results.every((result) => result.exitCode === 0),
    command: `daemon ${action}`,
    dryRun,
    launchdLabel,
    launchdTarget,
    operation,
    ...(plistPath ? { plistPath } : {}),
    ...(warning ? { warning } : {}),
    results
  };
}

function buildDaemonLaunchctlCommands(input: {
  action: "start" | "stop";
  launchdLabel: string;
  plistPath?: string;
}): string[][] {
  const domain = launchdDomainTarget();
  const service = launchdServiceTarget(input.launchdLabel);
  if (input.action === "start") {
    return [
      ...(input.plistPath ? [["launchctl", "bootstrap", domain, input.plistPath]] : []),
      ["launchctl", "kickstart", "-k", service]
    ];
  }
  return input.plistPath
    ? [["launchctl", "bootout", domain, input.plistPath]]
    : [["launchctl", "bootout", service]];
}

function daemonControlOperation(
  action: "start" | "stop",
  plistPath?: string
): "bootstrap_then_kickstart" | "kickstart_existing" | "bootout_plist" | "bootout_service" {
  if (action === "start") return plistPath ? "bootstrap_then_kickstart" : "kickstart_existing";
  return plistPath ? "bootout_plist" : "bootout_service";
}

function daemonPlistWarning(plistPath: string): string | undefined {
  const packageRoot = resolvePackageRoot();
  const normalizedRoot = `${packageRoot.replace(/\/+$/, "")}/`;
  const normalizedPlist = resolve(plistPath);
  if (normalizedPlist === packageRoot || normalizedPlist.startsWith(normalizedRoot)) return undefined;
  return "--plist is outside the NeonDiff package root; use only operator-owned plist paths";
}

function runLaunchctlPlan(commands: string[][]): Array<{
  command: string[];
  exitCode: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  signal?: string;
}> {
  const results = [];
  for (const command of commands) {
    const result = runLaunchctl(command);
    results.push(result);
    if (result.exitCode !== 0) break;
  }
  return results;
}

function runLaunchctl(command: string[]): {
  command: string[];
  exitCode: number;
  stdout?: string;
  stderr?: string;
  error?: string;
  signal?: string;
} {
  const [binary, ...args] = command;
  if (binary !== "launchctl") throw new Error(`unsupported daemon control command: ${command.join(" ")}`);
  const result = spawnSync(binary, args, {
    encoding: "utf8",
    timeout: LAUNCHCTL_TIMEOUT_MS
  });
  return {
    command,
    exitCode: result.status ?? 1,
    ...(result.stdout ? { stdout: redactSecrets(result.stdout.trim()) } : {}),
    ...(result.stderr ? { stderr: redactSecrets(result.stderr.trim()) } : {}),
    ...(result.error ? { error: redactSecrets(result.error.message) } : {}),
    ...(result.signal ? { signal: result.signal } : {})
  };
}

function parseLaunchdLabelArg(value: string | string[] | undefined, label: string): string {
  if (value === undefined) throw new Error(`${label} is required`);
  const parsed = parseSingleArg(value, label);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(parsed)) {
    throw new Error(`${label} must be a launchd label using only letters, digits, dots, underscores, and hyphens`);
  }
  return parsed;
}

function assertPlistLabelMatches(plistPath: string, launchdLabel: string): void {
  if (!existsSync(plistPath)) throw new Error(`--plist does not exist: ${plistPath}`);
  const result = spawnSync("plutil", ["-extract", "Label", "raw", plistPath], {
    encoding: "utf8",
    timeout: PLUTIL_TIMEOUT_MS
  });
  if (result.error) {
    throw new Error(`failed to read --plist Label: ${redactSecrets(result.error.message)}`);
  }
  if (result.status !== 0) {
    const detail = redactSecrets((result.stderr || result.stdout || "").trim());
    throw new Error(`failed to read --plist Label${detail ? `: ${detail}` : ""}`);
  }
  const plistLabel = result.stdout.trim();
  if (plistLabel !== launchdLabel) {
    throw new Error(`--plist Label (${redactSecrets(plistLabel)}) must match --launchd-label (${redactSecrets(launchdLabel)})`);
  }
}

function launchdDomainTarget(): string {
  const uid = process.getuid?.();
  if (uid === undefined) return "gui/<uid-unavailable>";
  return `gui/${uid}`;
}

function launchdServiceTarget(label: string): string {
  return `${launchdDomainTarget()}/${label}`;
}

function launchdUserSessionError(): string | undefined {
  return process.getuid?.() === undefined
    ? "launchd daemon controls require a user session with process.getuid()"
    : undefined;
}

function collectQueueBudget(config: ReturnType<typeof loadConfig>, jobs: ReviewQueueJobRecord[]): {
  budget?: ReleaseStatus["budget"];
  budgetError?: string;
} {
  try {
    return {
      budget: buildReviewBudgetStatus({
        config,
        jobs,
        includeDetails: false,
        inputJobLimit: jobs.length
      })
    };
  } catch (error) {
    return {
      budgetError: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }
}

function collectBudgetJobsForSelection(
  statePath: string,
  selectedJobs: ReviewQueueJobRecord[],
  now?: Date
): ReviewQueueJobRecord[] {
  const jobsById = new Map<string, ReviewQueueJobRecord>();
  for (const job of collectOperatorReviewQueue(statePath, { now }).jobs) {
    if (job.state === "leased" || job.state === "running") jobsById.set(job.jobId, job);
  }
  for (const job of selectedJobs) {
    jobsById.set(job.jobId, job);
  }
  return [...jobsById.values()];
}

function failedGates(gates: Array<{ name: string; ok: boolean; detail: string }>): Array<{ name: string; ok: boolean; detail: string }> {
  return gates.filter((gate) => !gate.ok);
}

function coverageAuditGates(report: Awaited<ReturnType<typeof collectCoverageAudit>>): Array<{ name: string; ok: boolean; detail: string }> {
  return [
    {
      name: "coverage_no_unprocessed_heads",
      ok: report.summary.unprocessed === 0,
      detail: `${report.summary.unprocessed} unprocessed eligible head(s)`
    },
    {
      name: "coverage_no_read_failures",
      ok: report.summary.readFailures === 0,
      detail: `${report.summary.readFailures} read failure(s)`
    },
    {
      name: "coverage_no_stale_heads",
      ok: report.summary.staleHeads === 0,
      detail: `${report.summary.staleHeads} stale head(s)`
    }
  ];
}

function coverageAuditRecommendedActions(report: Awaited<ReturnType<typeof collectCoverageAudit>>): string[] {
  return [
    ...(report.summary.unprocessed > 0 ? ["wait for daemon cycle or run scoped run-once for unprocessed heads"] : []),
    ...(report.summary.readFailures > 0 ? ["run doctor and inspect GitHub App installation/read permissions"] : []),
    ...(report.summary.staleHeads > 0 ? ["wait for next daemon cycle or run scoped coverage audit"] : [])
  ];
}

function queueHealthGates(
  coverage: OperatorQueueSnapshot,
  durableQueue: OperatorDurableQueueSnapshot,
  budget?: ReleaseStatus["budget"]
): Array<{ name: string; ok: boolean; detail: string }> {
  const readyToRetry = budget?.providerDeferred.readyToRetry ?? durableQueue.summary.retryableProviderDeferred;
  const retryableProviderDeferred = budget?.providerDeferred.retryable ?? durableQueue.summary.retryableProviderDeferred;
  return [
    {
      name: "queue_coverage_ok",
      ok: coverage.ok,
      detail:
        `${coverage.summary.pending} pending, ${coverage.summary.readFailures} read failure(s), ` +
        `${coverage.summary.staleHeads} stale head(s)`
    },
    {
      name: "queue_no_failed_jobs",
      ok: durableQueue.summary.failed === 0,
      detail: `${durableQueue.summary.failed} failed durable queue job(s)`
    },
    {
      name: "queue_no_ready_provider_deferred_jobs",
      ok: retryableProviderDeferred === 0,
      detail:
        `${readyToRetry} ready-to-retry provider-deferred job(s); ` +
        `provider_deferred total=${budget?.providerDeferred.total ?? durableQueue.summary.providerDeferred} ` +
        `retryable=${retryableProviderDeferred} ` +
        `waiting_capacity=${budget?.providerDeferred.waitingProviderCapacity ?? 0} ` +
        `waiting_cooldown=${budget?.providerDeferred.waitingCooldown ?? 0}`
    }
  ];
}

function queueRecommendedActions(gates: Array<{ name: string; ok: boolean; detail: string }>): string[] {
  const failed = new Set(failedGates(gates).map((gate) => gate.name));
  return [
    ...(failed.has("queue_coverage_ok") ? ["inspect coverage queues, read failures, and stale heads before promotion"] : []),
    ...(failed.has("queue_no_failed_jobs") ? ["inspect operator queue failed jobs before promotion"] : []),
    ...(failed.has("queue_no_ready_provider_deferred_jobs")
      ? ["wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry"]
      : [])
  ];
}

function providerCooldownRecommendedActions(input: {
  configPath: string;
  repo?: string;
  expiredCount: number;
  failedQueueJobs: number;
  retryableProviderDeferred: number;
  readyToRetry: number;
  activeProviderCooldownCount: number;
  waitingProviderCapacity: number;
}): string[] {
  const retryCommand =
    `npx tsx src/cli.ts retry-provider-cooldowns --config ${input.configPath} ` +
    `--expired-only true --dry-run false --zcode true${input.repo ? ` --repo ${input.repo}` : ""}`;
  return [
    ...(input.failedQueueJobs > 0 ? ["inspect operator queue failed jobs before promotion"] : []),
    ...(input.activeProviderCooldownCount > 0
      ? ["wait for active provider cooldown to expire before retrying provider-deferred work"]
      : []),
    ...(input.activeProviderCooldownCount === 0 && (input.expiredCount > 0 || input.readyToRetry > 0) ? [retryCommand] : []),
    ...(input.retryableProviderDeferred > 0 && input.readyToRetry === 0 && input.waitingProviderCapacity > 0
      ? ["wait for active provider run to finish; retryable provider-deferred jobs are blocked by provider capacity"]
      : []),
    ...(input.retryableProviderDeferred > 0 && input.readyToRetry === 0 && input.waitingProviderCapacity === 0
      ? ["inspect provider-deferred queue rows; retryable jobs are blocked by a non-cooldown budget gate"]
      : [])
  ];
}

function queueActionableRows(
  durableQueue: OperatorDurableQueueSnapshot,
  budget?: ReleaseStatus["budget"],
  now = new Date()
): ReviewQueueJobRecord[] {
  const readyToRetry = budget?.providerDeferred.readyToRetry ?? durableQueue.summary.retryableProviderDeferred;
  const failed = durableQueue.jobs.filter((job) => job.state === "failed");
  const providerDeferred = readyToRetry > 0
    ? durableQueue.jobs.filter((job) => job.state === "provider_deferred" && isProviderDeferredQueueJobEligible(job, now))
    : [];
  return [...failed, ...providerDeferred];
}

function isProviderDeferredQueueJobEligible(job: ReviewQueueJobRecord, now: Date): boolean {
  if (job.state !== "provider_deferred") return false;
  if (!job.nextEligibleAt) return true;
  const eligibleAtMs = Date.parse(job.nextEligibleAt);
  return !Number.isFinite(eligibleAtMs) || eligibleAtMs <= now.getTime();
}

async function buildDoctorGithubReport(config: BotConfig) {
  const github = new GitHubApi(config.github);
  const monitoredRepos = listReposToScan(config);
  const readChecks = [];
  let activeRepoChecks = 0;
  const appCredentialsConfigured = github.canPostAsApp();
  const hasFallbackReadToken = Boolean(config.github.token);

  for (const repo of monitoredRepos) {
    const repoPolicy = resolveRepoProfile(config, repo);
    const policy = buildRepoPolicySnapshot(config, repo);
    if (!repoPolicy.allowed) {
      readChecks.push({ repo, ok: true, policy, skippedByPolicy: repoPolicy.reason });
      continue;
    }
    activeRepoChecks += 1;
    if (!appCredentialsConfigured && !hasFallbackReadToken) {
      readChecks.push({
        repo,
        ok: false,
        policy,
        error: "GitHub App credentials or fallback read token are required before checking repository access."
      });
      continue;
    }
    try {
      const pulls = await github.listOpenPulls(repo);
      readChecks.push({ repo, ok: true, policy, openPullCount: pulls.length });
    } catch (error) {
      readChecks.push({
        repo,
        ok: false,
        policy,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const ok = appCredentialsConfigured && activeRepoChecks > 0 && readChecks.every((check) => check.ok);
  return {
    ok,
    command: "doctor github",
    purpose: "Verify GitHub App installation visibility and repo read access without provider or ZCode checks.",
    monitoredRepos,
    activeRepoChecks,
    appCredentials: {
      appIdConfigured: Boolean(config.github.appId),
      privateKeyConfigured: Boolean(config.github.privateKeyPath),
      fallbackTokenConfigured: Boolean(config.github.token)
    },
    github: {
      canPostAsApp: appCredentialsConfigured,
      readMode: appCredentialsConfigured ? "app_installation" : hasFallbackReadToken ? "fallback_token" : "unconfigured",
      botLogin: config.github.botLogin ?? "evaos-code-review-bot[bot]",
      apiBaseUrl: config.github.apiBaseUrl ?? "https://api.github.com",
      readChecks
    },
    requiredRepositoryPermissions: [
      "Metadata: read",
      "Contents: read",
      "Pull requests: read/write",
      "Checks: read",
      "Actions: read"
    ],
    optionalPermissions: [
      "Issues: read/write only for separately allowlisted issue-enrichment repos"
    ],
    licenseBoundary: {
      publicReposFree: config.license?.publicReposFree ?? true,
      privateReposRequireEntitlement: config.license?.privateReposRequireEntitlement ?? true,
      privateRepoDataStaysLocal: true
    },
    nextCommands: [
      "neondiff review-pr --config config.local.json --repo owner/repo --pr 123 --dry-run true --zcode false",
      "neondiff daemon status --config config.local.json --launchd-label com.example.neondiff"
    ],
    troubleshooting: [
      ...(appCredentialsConfigured ? [] : ["Set EVAOS_REVIEW_BOT_APP_ID and EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH, or configure github.appId/privateKeyPath outside git."]),
      ...(activeRepoChecks > 0 ? [] : ["Add at least one enabled repo to pilotRepos or repoProfiles before using this as an install proof."]),
      ...(readChecks.some((check) => !check.ok) ? ["Confirm the GitHub App is installed on selected repositories with the required repository permissions."] : [])
    ]
  };
}

function buildHelp(command?: string) {
  return {
    ok: true,
    ...(command ? { command } : {}),
    commands: {
      public: [
        "init",
        "config inspect",
        "config patch",
        "pricing",
        "providers list",
        "providers doctor",
        "doctor",
        "doctor github",
        "daemon start",
        "daemon stop",
        "daemon status",
        "license activate",
        "license status",
        "license deactivate",
        "status",
        "review-pr"
      ],
      operator: [
        "status",
        "runtime-inventory",
        "agents",
        "queue",
        "dashboard",
        "budget-status",
        "review-head-gate",
        "coverage",
        "cooldowns",
        "why"
      ],
      existing: [
        "doctor",
        "release-status",
        "review-head-gate",
        "coverage-audit",
        "build-memory-packet",
        "build-gitnexus-context-packet",
        "build-github-related-context-packet",
        "build-skill-pack",
        "build-enrichment-comment",
        "issue-enrichment-scan",
        "clear-issue-enrichment-leases",
        "clear-review-queue-leases",
        "finishing-touch-dry-run",
        "provider-cooldowns",
        "provider-throttle-report",
        "retry-provider-cooldowns",
        "retry-failed",
        "retire-failed",
        "run-once",
        "daemon",
        "eval-offline",
        "eval-suite",
        "eval-sticky-vs-cold"
      ]
    },
    examples: [
      "neondiff init --config config.local.json",
      "neondiff config inspect --config config.local.json",
      "neondiff config patch --config config.local.json --input desktop-patch.json --dry-run true",
      "desktop-patch.json uses nested object shape, e.g. {\"zcode\":{\"cliPath\":\"/path/to/neondiff\"}}",
      "neondiff pricing",
      "neondiff providers list --config config.local.json --json",
      "neondiff providers doctor --config config.local.json --json",
      "neondiff providers doctor --config config.local.json --provider ollama-local --smoke true --json",
      "neondiff license activate --config config.local.json --license-key-env NEONDIFF_LICENSE_KEY --json",
      "neondiff license status --config config.local.json --json",
      "neondiff license deactivate --config config.local.json --json",
      "neondiff doctor --config config.local.json --json",
      "neondiff doctor github --config config.local.json --json",
      "neondiff review-pr --config config.local.json --repo owner/repo --pr 123 --dry-run true --zcode false",
      "neondiff daemon status --config config.local.json --launchd-label com.example.neondiff",
      "neondiff daemon start --launchd-label com.example.neondiff --dry-run true",
      "neondiff daemon stop --launchd-label com.example.neondiff --dry-run true",
      "npx tsx src/cli.ts daemon --config /path/to/live.json --dry-run true --once true",
      "npx tsx src/cli.ts status --config /path/to/live.json --launchd-label com.electricsheephq.evaos-code-review-bot",
      "npx tsx src/cli.ts release-status --config /path/to/live.json --expected-head \"$(git rev-parse HEAD)\" --public-release-manifest docs/public-release-manifest.json --expected-public-version vX.Y.Z-beta.N --launchd-label com.electricsheephq.evaos-code-review-bot",
      "npx tsx src/cli.ts runtime-inventory --config /path/to/live.json --launchd-label com.electricsheephq.evaos-code-review-bot",
      "npx tsx src/cli.ts runtime-inventory --config /path/to/live.json --human",
      "npx tsx src/cli.ts review-head-gate --config /path/to/live.json --repo owner/repo --pr 123 --head-sha \"$(gh pr view 123 --repo owner/repo --json headRefOid --jq .headRefOid)\"",
      "npx tsx src/cli.ts agents --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json --state provider_deferred",
      "npx tsx src/cli.ts dashboard --config /path/to/live.json --status blocked_on_proof",
      "npx tsx src/cli.ts dashboard --config /path/to/live.json --human",
      "npx tsx src/cli.ts budget-status --config /path/to/live.json",
      "npx tsx src/cli.ts provider-throttle-report --config /path/to/live.json --since 7d --timezone Asia/Singapore",
      "provider-throttle-report peak-window flags use inclusive local-hour buckets, e.g. --peak-start-hour 14 --peak-end-hour 18 includes 14:00 through 18:00",
      "npx tsx src/cli.ts why --config /path/to/live.json --repo owner/repo --pr 123",
      "npx tsx src/cli.ts build-memory-packet --config /path/to/live.json --repo owner/repo --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-gitnexus-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-github-related-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-skill-pack --config /path/to/live.json --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-enrichment-comment --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-enrichment-comment --config /path/to/live.json --repo owner/repo --issue 456 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts issue-enrichment-scan --config /path/to/live.json --dry-run true --output-dir /path/to/evidence",
      "npx tsx src/cli.ts clear-issue-enrichment-leases --config /path/to/live.json --dry-run true --expired-only true",
      "npx tsx src/cli.ts clear-review-queue-leases --config /path/to/live.json --dry-run true --expired-only true",
      "npx tsx src/cli.ts eval-sticky-vs-cold --input /path/to/sticky-vs-cold.json --output-root /Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/$(date +%F)/sticky-vs-cold",
      "npx tsx src/cli.ts finishing-touch-dry-run --config /path/to/live.json --repo owner/repo --pr 123 --head-sha HEAD --current-head HEAD --comment-id 456 --author maintainer --trusted-authors maintainer --body '@evaos-code-review-bot explain risk'",
      "npx tsx src/cli.ts cooldowns --config /path/to/live.json --expired-only true"
    ]
  };
}

function stringifyProviderOutput(input: unknown): string {
  return JSON.stringify(redactProviderOutput(input), null, 2);
}

function redactProviderOutput(input: unknown, key?: string): unknown {
  if (typeof input === "string") return key === "apiKeyEnv" ? input : redactSecrets(input);
  if (input instanceof Date) return input.toISOString();
  if (Array.isArray(input)) return input.map((item) => redactProviderOutput(item));
  if (input && typeof input === "object") {
    const output: Record<string, unknown> = {};
    for (const [entryKey, value] of Object.entries(input)) output[entryKey] = redactProviderOutput(value, entryKey);
    return output;
  }
  return input;
}

function isHelpRequested(args: ParsedArgs): boolean {
  if (args.help === "true") return true;
  return args._.slice(1).some((arg) => arg === "help" || arg === "-h" || arg === "--help");
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
      setParsedArg(parsed, key, next);
      index += 1;
    } else {
      setParsedArg(parsed, key, "true");
    }
  }
  return parsed;
}

function licenseConfigFromArgs(base: LicenseConfig, args: ParsedArgs): LicenseConfig {
  const config = {
    ...base,
    ...(args["license-api-url"] ? { apiBaseUrl: parseSingleArg(args["license-api-url"], "--license-api-url") } : {}),
    ...(args["license-cache-path"] ? { cachePath: parseSingleArg(args["license-cache-path"], "--license-cache-path") } : {}),
    ...(args["license-key-path"] ? { keyPath: parseSingleArg(args["license-key-path"], "--license-key-path") } : {}),
    ...(args["license-storage"] ? { storageBackend: parseLicenseStorageBackend(parseSingleArg(args["license-storage"], "--license-storage")) } : {})
  };
  validateLicenseConfigOverride(config, "config.license");
  return config;
}

function resolveLicenseKeyArg(args: ParsedArgs): string {
  if (args["license-key"]) {
    throw new Error("license activate no longer accepts --license-key because argv can expose secrets; use --license-key-env");
  }
  if (args["license-key-env"]) {
    const envName = parseSingleArg(args["license-key-env"], "--license-key-env");
    const value = process.env[envName];
    if (!value) throw new Error(`license activate --license-key-env ${envName} did not resolve to a non-empty environment variable`);
    return value;
  }
  throw new Error("license activate requires --license-key-env");
}

function parseLicenseStorageBackend(value: string): "keychain" | "file" {
  if (value === "keychain" || value === "file") return value;
  throw new Error("--license-storage must be keychain or file");
}

function setParsedArg(parsed: ParsedArgs, key: string, value: string): void {
  if (parsed[key] !== undefined) throw new Error(`--${key} must be provided once`);
  parsed[key] = value;
}

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function parseHourArg(value: string | string[], label: string): number {
  const parsed = Number(parseSingleArg(value, label));
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 23) throw new Error(`${label} must be an hour from 0 to 23`);
  return parsed;
}

function parseBooleanArg(value: string | string[], label: string): boolean {
  const parsed = parseSingleArg(value, label);
  if (parsed === "true") return true;
  if (parsed === "false") return false;
  throw new Error(`${label} must be true or false`);
}

function parseSingleArg(value: string | string[], label: string): string {
  if (Array.isArray(value)) throw new Error(`${label} must be provided once`);
  return value;
}

function parseCanonicalIsoTimestamp(value: string, label: string): Date {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    throw new Error(`${label} must be a canonical ISO timestamp`);
  }
  return new Date(parsed);
}

function buildIssueEnrichmentLeaseClearRecommendations(input: {
  dryRun: boolean;
  expiredOnly: boolean;
  activeMatched: number;
  expiredMatched: number;
}): string[] {
  if (!input.dryRun) return [];
  const recommendations: string[] = [];
  if (input.expiredMatched > 0) {
    recommendations.push("rerun with --dry-run false --confirm true --expired-only true to clear only expired issue-enrichment worker lease(s)");
  }
  if (input.activeMatched > 0 && !input.expiredOnly) {
    recommendations.push("active issue-enrichment lease(s) matched; verify no worker is running before rerunning with --dry-run false --confirm true --expired-only false --force-active true");
  }
  return recommendations;
}

function buildReviewQueueLeaseClearRecommendations(input: {
  dryRun: boolean;
  expiredOnly: boolean;
  forceActive: boolean;
  activeMatched: number;
  expiredMatched: number;
}): string[] {
  if (!input.dryRun) return [];
  const recommendations: string[] = [];
  if (input.expiredMatched > 0) {
    recommendations.push("rerun with --dry-run false --confirm true --expired-only true to requeue expired review queue lease(s) and delete stale review run lease(s)");
  }
  if (input.activeMatched > 0 && !input.expiredOnly && !input.forceActive) {
    recommendations.push("active review queue lease(s) matched; verify no worker is running before rerunning with --dry-run false --confirm true --expired-only false --force-active true");
  }
  return recommendations;
}

function resolveFinishingTouchAction(input: {
  action?: string | string[];
  body?: string | string[];
  botMentions?: string | string[];
}): FinishingTouchAction {
  if (input.action !== undefined) {
    const action = parseSingleArg(input.action, "--action");
    if (FINISHING_TOUCH_ACTIONS.includes(action as FinishingTouchAction)) return action as FinishingTouchAction;
    throw new Error(`--action must be one of: ${FINISHING_TOUCH_ACTIONS.join(", ")}`);
  }
  if (input.body === undefined) throw new Error("one of --action or --body is required");
  const body = parseSingleArg(input.body, "--body");
  const botMentions = parseCsv(input.botMentions);
  const parsed = parseFinishingTouchCommand({
    body,
    botMentions: botMentions.length > 0 ? botMentions : ["@evaos-code-review-bot"]
  });
  if (!parsed) {
    throw new Error(`--body must contain one of the finishing-touch commands for mentions ${botMentions.join(", ") || "@evaos-code-review-bot"}`);
  }
  return parsed.action;
}

function parseCsv(value?: string | string[]): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((entry) => entry.split(",")).map((entry) => entry.trim()).filter(Boolean);
}

function assertMemoryPacketOutputDirSafe(outputDir: string, evidenceDir: string): string {
  const evidenceRoot = realPathPreservingMissing(evidenceDir);
  const target = realPathPreservingMissing(outputDir);
  if (!isPathInsideOrEqual(target, evidenceRoot)) {
    throw new Error("--output-dir must be inside the configured evidenceDir");
  }
  if (isInsideGitCheckout(target)) {
    throw new Error("--output-dir must not be inside the repository checkout or another repository checkout");
  }
  return target;
}

function isPathInsideOrEqual(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function isInsideGitCheckout(target: string): boolean {
  let cursor = target;
  const root = parsePath(cursor).root;
  for (;;) {
    if (existsSync(join(cursor, ".git"))) return true;
    if (cursor === root) return false;
    cursor = dirname(cursor);
  }
}

function realPathPreservingMissing(inputPath: string): string {
  const resolved = resolve(inputPath);
  const missingSegments: string[] = [];
  let cursor = resolved;
  const root = parsePath(cursor).root;
  while (!existsSync(cursor)) {
    if (cursor === root) throw new Error(`Path does not have an existing parent: ${inputPath}`);
    missingSegments.unshift(basename(cursor));
    cursor = dirname(cursor);
  }
  return join(realpathSync.native(cursor), ...missingSegments);
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

function readJsonInput(path: string, flagName: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to parse ${flagName} ${path}: ${detail}`);
  }
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
  "public-release-manifest"?: string;
  "expected-public-version"?: string;
  "verify-public-rollback-refs"?: string;
  "launchd-label"?: string;
  "state-path"?: string;
  "dry-run"?: string;
  "expired-only"?: string;
  "force-active"?: string;
  confirm?: string;
  "head-sha"?: string;
  input?: string;
  "input-dir"?: string;
  "output-dir"?: string;
  "output-root"?: string;
  "memory-root"?: string;
  "generated-at"?: string;
  "include-stale"?: string;
  "note-limit"?: string;
  "max-bytes"?: string;
  "record-build"?: string;
  fingerprint?: string;
  format?: string;
  limit?: string;
  "budget-detail-limit"?: string;
  "budget-job-limit"?: string;
  "job-limit"?: string;
  state?: string;
  status?: string;
  priority?: string;
  "stale-head-reason"?: string;
  zcode?: string;
  "active-only"?: string;
  human?: string;
  json?: string;
  "verify-current-heads"?: string;
  [key: string]: string | string[] | undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
