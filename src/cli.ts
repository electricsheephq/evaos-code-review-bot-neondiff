#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { loadConfig, validateLicenseConfigOverride, type BotConfig } from "./config.js";
import { collectCoverageAudit, CoverageStateReader } from "./coverage-audit.js";
import { collectProviderThrottleReport } from "./provider-throttle-report.js";
import { runDaemonCycle, shouldExitDaemonAfterFailedCycle } from "./daemon.js";
import {
  runLaunchdControlCommand,
  type LaunchctlResult
} from "./launchd-control.js";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { basename, dirname, extname, join, parse as parsePath, resolve, sep } from "node:path";
import { homedir } from "node:os";
import {
  assertEvalOutputDirSafe,
  buildEvalPromotionDecisionMarkdown,
  REQUIRED_SUITES,
  runOfflineEval,
  runStickyVsColdEval
} from "./eval-harness.js";
import { runDocsDriftEval, runRepoWikiContextAbEval } from "./openwiki-eval-gates.js";
import { inspectConfigForDesktop, patchConfigForDesktop } from "./config-cli.js";
import { buildEnrichmentComment, buildIssueEnrichmentDryRunOutput } from "./enrichment.js";
import {
  buildFinishingTouchDryRunContract,
  buildFinishingTouchDraft,
  FINISHING_TOUCH_ACTIONS,
  parseFinishingTouchCommand,
  validateFinishingTouchRequest,
  type FinishingTouchAction
} from "./finishing-touches.js";
import { GitHubApi, type GitHubRepositoryAccessProof, type GitHubRepositoryVisibility } from "./github.js";
import { buildGitNexusContextPacket } from "./gitnexus-context.js";
import { buildGitNexusRefreshPreflight } from "./gitnexus-refresh-preflight.js";
import { buildGitHubRelatedContextPacket, type GitHubRelatedIssueOrPull } from "./github-related-context.js";
import {
  buildIssueEnrichmentStatus,
  collectIssueEnrichmentScan,
  DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS,
  resolveIssueEnrichmentRepoPolicy,
  runIssueEnrichmentCycle,
  type IssueEnrichmentCycleGithub,
  type IssueEnrichmentCycleResult,
  type IssueEnrichmentConfig,
  type IssueEnrichmentRepoReadCheck
} from "./issue-enrichment.js";
import { activateLicense, deactivateLicense, getLicenseStatus, type LicenseConfig } from "./license.js";
import { requireActiveProductionLicense, type ProductionLicenseAdmission } from "./license-admission.js";
import { resolveProductionLicensePolicy } from "./license-production-policy.js";
import { runLocalDashboardPreviewSmoke, startLocalDashboardServer } from "./local-dashboard.js";
import {
  assertOutcomeLedgerOutputDirEmpty,
  readOutcomeLedgerInput,
  writeOutcomeLedgerPacket
} from "./outcome-ledger.js";
import {
  buildCheckoutIssuanceSmokeRequestResult,
  runCheckoutIssuanceSmoke,
  validateCheckoutIssuanceUrl
} from "./checkout-issuance-smoke.js";
import {
  readOutcomeScorecardInput,
  writeOutcomeScorecardPacket
} from "./outcome-scorecard.js";
import { buildReviewBudgetStatus } from "./review-budget.js";
import { selectReviewMode } from "./review-mode-router.js";
import type { ReviewMode } from "./review-mode-types.js";
import { readReviewLensEvalScenario, runReviewLensEval, type ReviewLensEvalMode } from "./review-lens-eval.js";
import type { PullFilePatch, PullRequestSummary } from "./types.js";
import {
  buildOperatorDashboard,
  buildRuntimeInventory,
  buildOperatorQueue,
  buildOperatorStatus,
  buildReleaseMonitoringCoverage,
  buildReleaseStatusCommandOutput,
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
import { runProvidersVerifyCommand } from "./providers-verify-command.js";
import { collectReleaseStatus, collectReleaseStatusWithConfig, type ReleaseStatus } from "./release-status.js";
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
import { readOutcomeObserverInput, recordNegativeControlLabels, runOutcomeObserverFromInput } from "./outcome-observer.js";
import { aggregateCalibrationLabels, writeCalibrationAggregatePacket } from "./calibration-aggregate.js";
import { runCalibrationPromotion } from "./calibration-promote.js";
import { writePrecisionBadgeEndpoint } from "./precision-badge.js";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "./validation-selector.js";
import { isSuccessfulRetryStatus, retryFailedHead, retryProviderCooldowns } from "./worker.js";
import { resolveZCodeProviderEnv } from "./zcode-env.js";
import { parsePositiveInteger } from "./cli-args.js";
import { readSecretFromStdin } from "./secret-stdin.js";
import { classifyCommandLicensePolicy, type CommandLicensePolicy } from "./command-license-policy.js";

const LAUNCHCTL_TIMEOUT_MS = 15_000;
const PLUTIL_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

  if (args.version === "true" || command === "-v") {
    console.log(resolvePackageVersion());
    return;
  }

  if (!command || command === "help" || command === "--help" || command === "-h") {
    console.log(JSON.stringify(buildHelp(), null, 2));
    return;
  }

  if (isHelpRequested(args)) {
    console.log(JSON.stringify(buildHelp(command), null, 2));
    return;
  }

  const commandLicensePolicy = classifyCommandLicensePolicy({
    command,
    subcommand: args._[1],
    smoke: command === "providers" && args._[1] === "doctor" && args.smoke === "true",
    dryRun: args["dry-run"] !== "false",
    coverageBacked: isCoverageBackedCommand(command, args)
  });
  if (commandLicensePolicy.mode === "requires_license"
    && isKnownCLICommand(command)
    && !deferCommandAdmissionUntilValidated(command)) {
    await requireClassifiedCommandAdmission(commandLicensePolicy, args.config);
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
      if (!result.ok) process.exitCode = 1;
      return;
    }
    if (configAction === "patch") {
      if (!args.config) throw new Error("config patch requires --config");
      if (!args.input) throw new Error("config patch requires --input");
      const result = patchConfigForDesktop({
        configPath: parseSingleArg(args.config, "--config"),
        inputPath: parseSingleArg(args.input, "--input"),
        dryRun: args["dry-run"] !== "false",
        confirm: args.confirm === "true",
        expectedRevision: args["expected-revision"] !== undefined
          ? parseSingleArg(args["expected-revision"], "--expected-revision")
          : undefined
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

  if (command === "checkout-issuance-smoke") {
    const url = parseSingleArg(args.url ?? "https://neondiff-license.fly.dev/v1/admin/licenses/issue", "--url");
    const releaseVersion = parseSingleArg(args["release-version"] ?? "v1.0.0", "--release-version");
    const checkoutLookupKey = parseSingleArg(args["checkout-lookup-key"] ?? "neondiff_monthly", "--checkout-lookup-key");
    const idempotencyKey = args["idempotency-key"] ? parseSingleArg(args["idempotency-key"], "--idempotency-key") : undefined;
    const providerAccountId = parseSingleArg(args["provider-account-id"] ?? "", "--provider-account-id");
    const providerMode = parseSingleArg(args["provider-mode"] ?? "", "--provider-mode");
    const externalSubscriptionId = parseSingleArg(args["external-subscription-id"] ?? "", "--external-subscription-id");
    const externalCheckoutId = parseSingleArg(args["external-checkout-id"] ?? "", "--external-checkout-id");
    const urlCheck = validateCheckoutIssuanceUrl(url);
    if (!urlCheck.ok) {
      console.log(stringifyRedactedJson({
        ok: false,
        command: "checkout-issuance-smoke",
        errorCode: "invalid_url",
        detail: urlCheck.detail,
        proofBoundary: "No authenticated checkout issuance proof was produced."
      }));
      process.exitCode = 1;
      return;
    }
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    if (dryRun) {
      const requestResult = buildCheckoutIssuanceSmokeRequestResult({
        releaseVersion,
        checkoutLookupKey,
        providerAccountId,
        providerMode,
        externalSubscriptionId,
        externalCheckoutId,
        ...(idempotencyKey ? { idempotencyKey } : {})
      });
      if (!requestResult.ok) {
        console.log(stringifyRedactedJson({
          ok: false,
          command: "checkout-issuance-smoke",
          errorCode: requestResult.errorCode,
          detail: requestResult.detail,
          proofBoundary: "No authenticated checkout issuance proof was produced."
        }));
        process.exitCode = 1;
        return;
      }
      console.log(stringifyRedactedJson({
        ok: true,
        command: "checkout-issuance-smoke",
        mode: "dry_run",
        url,
        releaseVersion,
        requestPreview: requestResult.requestPreview,
        proofBoundary: "Dry-run request preview only; no owner-held secret was read and no network request was sent."
      }));
      return;
    }
    const secretEnvName = parseSingleArg(args["secret-env"] ?? "LICENSE_ISSUANCE_SECRET", "--secret-env");
    const result = await runCheckoutIssuanceSmoke({
      url,
      releaseVersion,
      checkoutLookupKey,
      providerAccountId,
      providerMode,
      externalSubscriptionId,
      externalCheckoutId,
      confirmLiveIssuance: args["confirm-live-issuance"] === undefined
        ? false
        : parseBooleanArg(args["confirm-live-issuance"], "--confirm-live-issuance"),
      secretEnvName,
      ...(idempotencyKey ? { idempotencyKey } : {}),
      ...(args.output ? { outputPath: parseSingleArg(args.output, "--output") } : {})
    });
    console.log(stringifyRedactedJson(result));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "providers") {
    const action = args._[1];
    if (action === "verify") {
      const execution = await runProvidersVerifyCommand({
        configPath: args.config,
        providerId: args.provider,
        apiKeyStdin: args["api-key-stdin"],
        allowRemoteSmoke: args["allow-remote-smoke"],
        expectedConfigRevision: args["expected-config-revision"],
        stdin: process.stdin
      });
      console.log(stringifyProviderOutput(execution.output));
      if (execution.exitCode !== 0) process.exitCode = execution.exitCode;
      return;
    }
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
      const smoke = args.smoke === undefined ? false : parseBooleanArg(args.smoke, "--smoke");
      if (smoke) {
        const admission = await requireActiveProductionLicense({
          operation: "provider_smoke",
          config: config.license!
        });
        if (!admission.ok) {
          console.log(stringifyProviderOutput({
            ok: false,
            command: "providers doctor",
            error: `license ${admission.decision.status}: ${admission.decision.detail}`
          }));
          process.exitCode = 1;
          return;
        }
      }
      const result = await doctorProviderRegistry({
        registry: config.providers!,
        ...(providerId ? { providerId } : {}),
        smoke
      });
      console.log(stringifyProviderOutput({
        ...result,
        proofBoundary: "Provider readiness check only; alternate providers are not selected for live review execution by this command."
      }));
      if (!result.ok) process.exitCode = 1;
      return;
    }
    throw new Error("providers subcommand must be one of: list, doctor, verify");
  }

  if (command === "license") {
    const action = args._[1];
    const config = loadConfig(args.config);
    const licenseConfig = licenseConfigFromArgs(config.license!, args);
    if (action === "activate") {
      const licenseKey = await resolveLicenseKeyArg(args, process.stdin);
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
      canPostAsApp: github.canPostAsApp(),
      issueReadChecks: await collectIssueEnrichmentReadChecks(config, github)
    });
    const ok = readChecks.every((check) => check.ok) && issueEnrichment.ok;
    console.log(stringifyRedactedJson({
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
    }));
    if (!ok) process.exitCode = 1;
    return;
  }

  if (command === "release-status") {
    if (args.repo !== undefined || args.pr !== undefined) {
      throw new Error("release-status does not support --repo/--pr; use coverage-audit for scoped coverage checks");
    }
    const budgetDetailLimit = args["budget-detail-limit"]
      ? parsePositiveInteger(args["budget-detail-limit"], "--budget-detail-limit")
      : undefined;
    const budgetJobLimit = args["budget-job-limit"]
      ? parsePositiveInteger(args["budget-job-limit"], "--budget-job-limit")
      : undefined;
    const requireCoverage = args["require-coverage"] === undefined
      ? false
      : parseBooleanArg(args["require-coverage"], "--require-coverage");
    const collectCoverage = requireCoverage ||
      (args.coverage === undefined ? false : parseBooleanArg(args.coverage, "--coverage"));
    const config = loadConfig(args.config);
    const status = collectReleaseStatusWithConfig({
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
    }, config);
    const coverageReport = collectCoverage
      ? await collectCoverageReport(args, config)
      : undefined;
    const monitoringCoverage = buildReleaseMonitoringCoverage({
      report: coverageReport,
      required: requireCoverage,
      recommendedCommand: buildReleaseCoverageCommand(args)
    });
    const output = buildReleaseStatusCommandOutput({
      status,
      monitoringCoverage,
      requireCoverage
    });
    console.log(stringifyRedactedJson(output));
    if (!output.ok) process.exitCode = 1;
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
    console.log(stringifyRedactedJson({
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
    }));
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
    console.log(stringifyRedactedJson(status));
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
    if (shouldUseOperatorDashboard(args)) {
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
      console.log(args.human === "true" ? formatOperatorDashboardHuman(dashboard) : stringifyRedactedJson(dashboard));
      if (!dashboard.ok) process.exitCode = 1;
      return;
    }
    const configPath = resolve(parseSingleArg(args.config ?? "config.local.json", "--config"));
    const config = loadConfig(configPath);
    if (args["preview-smoke"] !== undefined && parseBooleanArg(args["preview-smoke"], "--preview-smoke")) {
      const outputDir = resolve(parseSingleArg(args["output-dir"] ?? "runtime/dashboard-preview-smoke", "--output-dir"));
      const smoke = await runLocalDashboardPreviewSmoke({
        config,
        configPath,
        configExists: existsSync(configPath),
        outputDir,
        host: args.host ? parseSingleArg(args.host, "--host") : "127.0.0.1",
        port: args.port ? parseNonNegativeInteger(parseSingleArg(args.port, "--port"), "--port") : 0,
        launchdLabel: args["launchd-label"] ? parseSingleArg(args["launchd-label"], "--launchd-label") : undefined,
        providerId: args.provider ? parseSingleArg(args.provider, "--provider") : undefined,
        allowRemoteSmoke: args["allow-remote-smoke"] === undefined ? false : parseBooleanArg(args["allow-remote-smoke"], "--allow-remote-smoke"),
        screenshotPath: args["screenshot-path"] ? resolve(parseSingleArg(args["screenshot-path"], "--screenshot-path")) : undefined,
        sourceSha: args["source-sha"] ? parseSingleArg(args["source-sha"], "--source-sha") : readCurrentGitHead(process.cwd())
      });
      console.log(stringifyRedactedJson(smoke));
      if (!smoke.ok) process.exitCode = 1;
      return;
    }
    const handle = await startLocalDashboardServer({
      config,
      configPath,
      configExists: existsSync(configPath),
      host: args.host ? parseSingleArg(args.host, "--host") : "127.0.0.1",
      port: args.port ? parseNonNegativeInteger(parseSingleArg(args.port, "--port"), "--port") : 0,
      launchdLabel: args["launchd-label"] ? parseSingleArg(args["launchd-label"], "--launchd-label") : undefined,
      openBrowser: args.open === undefined ? true : parseBooleanArg(args.open, "--open"),
      allowRemoteSmoke: args["allow-remote-smoke"] === undefined ? false : parseBooleanArg(args["allow-remote-smoke"], "--allow-remote-smoke")
    });
    console.log(stringifyRedactedJson({
      ok: true,
      command: "dashboard",
      mode: "local_html",
      url: handle.url,
      openAttempted: handle.openAttempted,
      openOk: handle.openOk,
      status: handle.status,
      proofBoundary: "Starts a local HTML dashboard only; it does not prove signed desktop release, appcast, notarization, or live review quality."
    }));
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
      writeFileSync(join(safeOutputDir, "repo-memory-packet.md"), redactSecrets(result.packet.markdown));
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
      if (result.ok) writeFileSync(join(safeOutputDir, "gitnexus-context-packet.md"), redactSecrets(result.packet.markdown));
    }
    const format = args.format ?? "json";
    const redactedJson = stringifyRedactedJson(result);
    const redactedMarkdown = result.ok ? redactSecrets(result.packet.markdown) : undefined;
    if (format === "markdown") {
      console.log(redactedMarkdown ?? redactedJson);
    } else if (format === "both" && result.ok) {
      console.log(`${redactedJson}\n\n${redactedMarkdown}`);
    } else {
      console.log(redactedJson);
    }
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "gitnexus-refresh-preflight") {
    const repoPath = args["repo-path"] ? parseSingleArg(args["repo-path"], "--repo-path") : ".";
    const indexInfoText = args["index-info-file"]
      ? readFileSync(parseSingleArg(args["index-info-file"], "--index-info-file"), "utf8")
      : collectGitNexusPreflightText(repoPath);
    const result = buildGitNexusRefreshPreflight({
      repoPath,
      ...(args["repo-alias"] ? { repoAlias: parseSingleArg(args["repo-alias"], "--repo-alias") } : {}),
      indexInfoText,
      env: process.env,
      indexOnlyFallback: args["index-only-fallback"] === undefined
        ? false
        : parseBooleanArg(args["index-only-fallback"], "--index-only-fallback"),
      allowDimensionChange: args["allow-dimension-change"] === undefined
        ? false
        : parseBooleanArg(args["allow-dimension-change"], "--allow-dimension-change")
    });
    console.log(stringifyRedactedJson({
      command: "gitnexus-refresh-preflight",
      proofBoundary: "Preflight only; this command does not run gitnexus analyze or mutate the index.",
      ...result
    }));
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
      if (result.ok) writeFileSync(join(safeOutputDir, "github-related-context-packet.md"), redactSecrets(result.packet.markdown));
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
      if (result.ok) writeFileSync(join(safeOutputDir, "skill-pack-context-packet.md"), redactSecrets(result.packet.markdown));
    }
    const jsonOutput = redactSecrets(JSON.stringify(result, null, 2));
    console.log(jsonOutput);
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "build-enrichment-comment") {
    if (!args.repo) throw new Error("--repo is required for build-enrichment-comment");
    if (Boolean(args.pr) === Boolean(args.issue)) throw new Error("exactly one of --pr or --issue is required for build-enrichment-comment");
    if (Array.isArray(args.issue)) throw new Error("--issue must be provided once for build-enrichment-comment");
    const repo = parseSingleArg(args.repo, "--repo");
    const config = loadConfig(args.config);
    await requireClassifiedCommandAdmission(commandLicensePolicy, args.config, config);
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
        maxSuggestions: enrichmentConfig.maxSuggestions,
        publicConfidencePolicy: config.confidenceCalibration?.publicDisplay
      });
      if (args["output-dir"]) {
        const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
        mkdirSync(safeOutputDir, { recursive: true });
        writeFileSync(join(safeOutputDir, "enrichment-comment.json"), `${redactSecrets(JSON.stringify(output, null, 2))}\n`);
        if (!output.skipped) writeFileSync(join(safeOutputDir, "enrichment.md"), redactSecrets(output.body));
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
      postIssueComment: false,
      publicConfidencePolicy: config.confidenceCalibration?.publicDisplay
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
      writeFileSync(join(safeOutputDir, "enrichment.md"), redactSecrets(enrichment.body));
    }
    console.log(redactSecrets(JSON.stringify(output, null, 2)));
    return;
  }

  if (command === "issue-enrichment-scan") {
    const config = loadConfig(args.config);
    const dryRun = args["dry-run"] !== "false";
    if (!dryRun) throw new Error("issue-enrichment-scan currently supports dry-run only; live issue comments require a separate promotion gate");
    const licenseAdmission = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: config.license!
    });
    if (!licenseAdmission.ok) {
      throw new Error(`license ${licenseAdmission.decision.status}: ${licenseAdmission.decision.detail}`);
    }
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

  if (command === "issue-enrichment-run") {
    if (!args.repo) throw new Error("--repo is required for issue-enrichment-run");
    const repo = parseSingleArg(args.repo, "--repo");
    const issueNumbers = parseIssueNumberArgs(args.issue);
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const confirm = args.confirm === undefined ? false : parseBooleanArg(args.confirm, "--confirm");
    const force = args.force === undefined ? false : parseBooleanArg(args.force, "--force");
    if (dryRun && force) {
      throw new Error("issue-enrichment-run --force true requires --dry-run false");
    }
    if (!dryRun && !confirm) {
      throw new Error("issue-enrichment-run requires --confirm true when --dry-run false");
    }
    const config = loadConfig(args.config);
    const issueConfig = config.issueEnrichment;
    if (!issueConfig) throw new Error("issue-enrichment-run requires issueEnrichment config");
    if (!issueConfig.enabled) throw new Error("issue-enrichment-run requires issueEnrichment.enabled true");
    if (!dryRun && !issueConfig.postIssueComment) {
      throw new Error("issue-enrichment-run live posting requires issueEnrichment.postIssueComment true");
    }
    const policy = resolveIssueEnrichmentRepoPolicy(issueConfig, repo);
    if (!policy.allowed) throw new Error(`Repo ${repo} is skipped by issue-enrichment policy: ${policy.reason}`);
    const licenseAdmission = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: config.license!
    });
    if (!licenseAdmission.ok) {
      throw new Error(`license ${licenseAdmission.decision.status}: ${licenseAdmission.decision.detail}`);
    }
    const github = new GitHubApi(config.github);
    const liveStatus = buildIssueEnrichmentStatus({ config, canPostAsApp: github.canPostAsApp() });
    const statusBlockers = dryRun
      ? liveStatus.blockers.filter((blocker) => !DRY_RUN_IGNORED_ISSUE_ENRICHMENT_BLOCKERS.has(blocker))
      : liveStatus.blockers;
    if (statusBlockers.length > 0) {
      const missingThresholds = liveStatus.liveThresholdsMissingRepos.length
        ? `; liveThresholdsMissingRepos=${liveStatus.liveThresholdsMissingRepos.join(",")}`
        : "";
      const mode = dryRun ? "dry-run" : "live posting";
      throw new Error(`issue-enrichment-run ${mode} blocked: ${statusBlockers.join(", ")}${missingThresholds}`);
    }
    const runLimit = effectiveIssueEnrichmentRunLimit(issueConfig, policy, {
      postIssueComment: !dryRun && issueConfig.postIssueComment
    });
    if (issueNumbers.length > runLimit.value) {
      throw new Error(
        `issue-enrichment-run selected issue count ${issueNumbers.length} exceeds configured selected-run prefetch cap ${runLimit.value} (${runLimit.binding}; cap is conservative and uses selected issue count before fetch)`
      );
    }
    const issues: GitHubRelatedIssueOrPull[] = [];
    type IssueEnrichmentPreview = Extract<ReturnType<typeof buildIssueEnrichmentDryRunOutput>, { skipped: false }>;
    const previewOutputs: IssueEnrichmentPreview[] = [];
    let selectedIssuesLoaded = false;
    const loadSelectedIssues = async () => {
      if (selectedIssuesLoaded) return issues;
      for (const issueNumber of issueNumbers) {
        const issue = await github.getIssueOrPull(repo, issueNumber, { tolerateUnreadable: true });
        if (!issue) {
          throw new Error(`Issue ${repo}#${issueNumber} was not found or is not readable; run doctor github and confirm GitHub App Issues permission before live issue enrichment.`);
        }
        const preview = buildIssueEnrichmentDryRunOutput({
          repo,
          issue,
          allowedLabels: policy.suggestions.allowedLabels,
          allowedOwners: policy.suggestions.allowedReviewers,
          validationSuggestions: ["Confirm owner, acceptance criteria, and validation evidence before implementation."],
          maxRelatedRefs: config.enrichment?.maxRelatedRefs,
          maxSuggestions: config.enrichment?.maxSuggestions,
          publicConfidencePolicy: config.confidenceCalibration?.publicDisplay
        });
        if (preview.skipped) {
          throw new Error(`Issue ${repo}#${issueNumber} is not eligible for issue enrichment: ${preview.reason}`);
        }
        issues.push(issue);
        previewOutputs.push(preview);
      }
      selectedIssuesLoaded = true;
      return issues;
    };
    if (dryRun) await loadSelectedIssues();

    const state = new ReviewStateStore(args["state-path"] ?? config.statePath);
    let preacquiredLease: { leaseId: string } | undefined;
    let leaseTransferredToCycle = false;
    try {
      if (!dryRun) {
        preacquiredLease = state.tryAcquireIssueEnrichmentRunLease(issueConfig.maxActiveRuns, issueConfig.leaseTtlMs, new Date());
        if (preacquiredLease) await loadSelectedIssues();
      }
      const cycleGithub: IssueEnrichmentCycleGithub = {
        listIssuesForEnrichment: async (requestedRepo) => {
          if (requestedRepo !== repo) {
            throw new Error(`issue-enrichment-run internal repo mismatch: requested ${requestedRepo}, expected ${repo}`);
          }
          return loadSelectedIssues();
        },
        canPostAsApp: () => github.canPostAsApp(),
        upsertIssueComment: (input) => github.upsertIssueComment(input)
      };
      const cycleInput = {
        config,
        state,
        github: cycleGithub,
        dryRun,
        repo,
        includeExisting: true,
        advanceWatermarks: false,
        force,
        licenseAdmission: licenseAdmission.admission,
        ...(preacquiredLease ? { preacquiredLease } : {})
      };
      if (preacquiredLease) leaseTransferredToCycle = true;
      const result = await runIssueEnrichmentCycle(cycleInput);
      const liveExitReason = dryRun ? undefined : issueEnrichmentRunLiveExitReason(result);
      const output = {
        command: "issue-enrichment-run",
        repo,
        issueNumbers,
        force,
        ...(liveExitReason ? { exitReason: liveExitReason } : {}),
        ...result
      };
      if (args["output-dir"]) {
        const safeOutputDir = assertMemoryPacketOutputDirSafe(args["output-dir"], config.evidenceDir);
        mkdirSync(safeOutputDir, { recursive: true });
        writeFileSync(join(safeOutputDir, "issue-enrichment-run.json"), `${redactSecrets(JSON.stringify(output, null, 2))}\n`);
        const resultIssueNumbers = new Set(
          result.items
            .filter((item) =>
              dryRun ||
              (!item.skippedExisting && item.recordStatus !== "deferred" && item.recordStatus !== "skipped")
            )
            .map((item) => item.issueNumber)
        );
        for (const preview of previewOutputs) {
          if (!resultIssueNumbers.has(preview.issueNumber)) continue;
          writeFileSync(join(safeOutputDir, `issue-${preview.issueNumber}.md`), redactSecrets(preview.body));
        }
      }
      console.log(redactSecrets(JSON.stringify(output, null, 2)));
      if (!result.ok || liveExitReason === "lease_busy" || liveExitReason === "no_work") process.exitCode = 1;
    } finally {
      if (preacquiredLease && !leaseTransferredToCycle) state.releaseIssueEnrichmentRunLease(preacquiredLease.leaseId);
      state.close();
    }
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
    const currentHeadSha = parseSingleArg(args["current-head"], "--current-head");
    const author = parseSingleArg(args.author, "--author");
    const action = resolveFinishingTouchAction({
      action: args.action,
      body: args.body,
      botMentions: args["bot-mentions"]
    });
    const pullNumber = parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr");
    const commentId = parsePositiveInteger(parseSingleArg(args["comment-id"], "--comment-id"), "--comment-id");
    await requireClassifiedCommandAdmission(commandLicensePolicy, args.config);
    const trustedAuthors = parseCsv(args["trusted-authors"]);
    const worktreeCleanArg = args["worktree-clean"];
    const worktreeCleanExplicit = worktreeCleanArg !== undefined;
    const worktreeClean = worktreeCleanExplicit
      ? parseBooleanArg(worktreeCleanArg, "--worktree-clean")
      : true;
    const worktreeCleanState = worktreeCleanExplicit
      ? worktreeClean ? "verified_clean" : "dirty"
      : "assumed_clean";
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
      currentHeadSha,
      commentId,
      author,
      trustedAuthors,
      worktreeClean,
      action,
      proposedOutput: draft
    });
    if (!validation.ok) {
      const contract = buildFinishingTouchDryRunContract({
        dryRun,
        recorded: false,
        draft,
        currentHeadSha,
        worktreeClean,
        worktreeCleanState,
        trustedAuthors,
        validation
      });
      console.log(redactSecrets(JSON.stringify({ ok: false, dryRun, validation, contract }, null, 2)));
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
    const contract = buildFinishingTouchDryRunContract({
      dryRun,
      recorded: Boolean(stored),
      draft,
      currentHeadSha,
      worktreeClean,
      worktreeCleanState,
      trustedAuthors,
      validation
    });
    console.log(redactSecrets(JSON.stringify({
      ok: true,
      dryRun,
      recorded: Boolean(stored),
      contract,
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

  if (command === "eval-repo-wiki-context-ab") {
    if (!args.input) throw new Error("--input is required for eval-repo-wiki-context-ab");
    if (!args["output-root"]) throw new Error("--output-root is required for eval-repo-wiki-context-ab");
    const outputRoot = assertEvalOutputDirSafe(parseSingleArg(args["output-root"], "--output-root"));
    const input = readJsonInput(parseSingleArg(args.input, "--input"), "--input") as Parameters<typeof runRepoWikiContextAbEval>[0];
    const result = runRepoWikiContextAbEval(input, { outputRoot });
    console.log(JSON.stringify(result.summary, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "eval-openwiki-docs-drift") {
    if (!args.input) throw new Error("--input is required for eval-openwiki-docs-drift");
    if (!args["output-root"]) throw new Error("--output-root is required for eval-openwiki-docs-drift");
    const outputRoot = assertEvalOutputDirSafe(parseSingleArg(args["output-root"], "--output-root"));
    const input = readJsonInput(parseSingleArg(args.input, "--input"), "--input") as Parameters<typeof runDocsDriftEval>[0];
    const result = runDocsDriftEval(input, { outputRoot });
    console.log(JSON.stringify(result.summary, null, 2));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "review-bench") {
    const subcommand = args._[1];
    if (subcommand === "prepare-adjudication") {
      if (!args.candidate) throw new Error("--candidate is required for review-bench prepare-adjudication");
      if (!args.artifacts) throw new Error("--artifacts is required for review-bench prepare-adjudication");
      if (!args.output) throw new Error("--output is required for review-bench prepare-adjudication");
      const outputDirectory = assertEvalOutputDirSafe(parseSingleArg(args.output, "--output"));
      const { prepareReviewBenchAdjudicationPacket } = await import("./review-bench-adjudication-packets.js");
      const summary = prepareReviewBenchAdjudicationPacket({
        candidatePath: parseSingleArg(args.candidate, "--candidate"),
        artifactsDirectory: parseSingleArg(args.artifacts, "--artifacts"),
        outputDirectory
      });
      console.log(stringifyRedactedJson({ command: "review-bench", subcommand, ...summary }));
      return;
    }
    if (subcommand === "verify-adjudication") {
      if (!args.packet) throw new Error("--packet is required for review-bench verify-adjudication");
      if (!args.primary) throw new Error("--primary is required for review-bench verify-adjudication");
      if (!args.secondary) throw new Error("--secondary is required for review-bench verify-adjudication");
      if (!args.receipt) throw new Error("--receipt is required for review-bench verify-adjudication");
      const receiptPath = parseSingleArg(args.receipt, "--receipt");
      assertEvalOutputDirSafe(dirname(receiptPath));
      const { verifyReviewBenchAdjudicationResponses } = await import("./review-bench-adjudication-packets.js");
      const summary = verifyReviewBenchAdjudicationResponses({
        packetPath: parseSingleArg(args.packet, "--packet"),
        primaryResponsePath: parseSingleArg(args.primary, "--primary"),
        secondaryResponsePath: parseSingleArg(args.secondary, "--secondary"),
        ...(args.resolver === undefined ? {} : {
          resolverResponsePath: parseSingleArg(args.resolver, "--resolver")
        }),
        receiptPath
      });
      console.log(stringifyRedactedJson({ command: "review-bench", subcommand, ...summary }));
      if (summary.status === "needs_resolution") process.exitCode = 1;
      return;
    }
    if (subcommand !== "verify-sources") {
      throw new Error(
        "review-bench subcommand must be: verify-sources, prepare-adjudication, or verify-adjudication"
      );
    }
    if (!args.corpus) throw new Error("--corpus is required for review-bench verify-sources");
    if (!args.artifacts) throw new Error("--artifacts is required for review-bench verify-sources");
    if (!args.receipt) throw new Error("--receipt is required for review-bench verify-sources");
    const receiptPath = parseSingleArg(args.receipt, "--receipt");
    assertEvalOutputDirSafe(dirname(receiptPath));
    const { runReviewBenchSourceAdmission } = await import("./review-bench-source-admission.js");
    const receipt = await runReviewBenchSourceAdmission({
      corpusPath: parseSingleArg(args.corpus, "--corpus"),
      artifactsDirectory: parseSingleArg(args.artifacts, "--artifacts"),
      receiptPath
    });
    console.log(stringifyRedactedJson({
      command: "review-bench",
      subcommand: "verify-sources",
      ...receipt
    }));
    return;
  }

  if (command === "review-lenses-eval") {
    if (args["output-root"] === undefined || (Array.isArray(args["output-root"]) && args["output-root"].length === 0)) {
      throw new Error("--output-root is required for review-lenses-eval");
    }
    const hasInput = args.input !== undefined;
    const hasInputDir = args["input-dir"] !== undefined;
    if (hasInput === hasInputDir) throw new Error("review-lenses-eval requires exactly one of --input or --input-dir");
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const mode = parseReviewLensEvalMode(args.mode);
    const scenarioPaths = hasInput
      ? [parseSingleArg(args.input!, "--input")]
      : listJsonFiles(parseSingleArg(args["input-dir"]!, "--input-dir"));
    const result = runReviewLensEval({
      scenarios: scenarioPaths.map((scenarioPath) => readReviewLensEvalScenario(scenarioPath)),
      outputRoot: parseSingleArg(args["output-root"], "--output-root"),
      mode,
      dryRun
    });
    console.log(stringifyRedactedJson(result.summary));
    if (!result.summary.ok) process.exitCode = 1;
    return;
  }

  if (command === "outcome-ledger") {
    if (args.input === undefined || (Array.isArray(args.input) && args.input.length === 0)) {
      throw new Error("--input is required for outcome-ledger");
    }
    if (args["output-dir"] === undefined || (Array.isArray(args["output-dir"]) && args["output-dir"].length === 0)) {
      throw new Error("--output-dir is required for outcome-ledger");
    }
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    if (!dryRun) throw new Error("outcome-ledger is dry-run only in this release");
    const ledgerInput = readOutcomeLedgerInput(parseSingleArg(args.input, "--input"));
    const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
    assertEvalOutputDirSafe(outputDir);
    assertOutcomeLedgerOutputDirEmpty(outputDir);
    const result = writeOutcomeLedgerPacket({ ledgerInput, outputDir });
    console.log(stringifyRedactedJson({
      command: "outcome-ledger",
      dryRun,
      ...result
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "outcome-scorecard") {
    if (args.input === undefined || (Array.isArray(args.input) && args.input.length === 0)) {
      throw new Error("--input is required for outcome-scorecard");
    }
    if (args["output-dir"] === undefined || (Array.isArray(args["output-dir"]) && args["output-dir"].length === 0)) {
      throw new Error("--output-dir is required for outcome-scorecard");
    }
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    if (!dryRun) throw new Error("outcome-scorecard is dry-run only in this release");
    const scorecardInput = readOutcomeScorecardInput(parseSingleArg(args.input, "--input"));
    const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
    assertEvalOutputDirSafe(outputDir);
    const result = writeOutcomeScorecardPacket({ scorecardInput, outputDir });
    console.log(stringifyRedactedJson({
      command: "outcome-scorecard",
      dryRun,
      outputDir,
      ...result
    }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "review-mode") {
    if (args.input === undefined || (Array.isArray(args.input) && args.input.length === 0)) {
      throw new Error("--input is required for review-mode");
    }
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    if (!dryRun) throw new Error("review-mode is dry-run only in this release");
    const config = loadConfig(args.config);
    const routerInput = readReviewModeInput(parseSingleArg(args.input, "--input"));
    const selection = selectReviewMode({ config, ...routerInput });
    if (args["output-dir"] !== undefined) {
      const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
      assertEvalOutputDirSafe(outputDir);
      mkdirSync(outputDir, { recursive: true });
      // Zero evidence writes when the router is disabled/absent (selection === undefined).
      if (selection !== undefined) {
        writeFileSync(join(outputDir, "review-mode.json"), `${stringifyRedactedJson(selection)}\n`);
      }
    }
    console.log(stringifyRedactedJson({
      ok: true,
      command: "review-mode",
      dryRun,
      enabled: selection !== undefined,
      selection: selection ?? null
    }));
    return;
  }

  if (command === "outcome-observe") {
    if (args.input === undefined || (Array.isArray(args.input) && args.input.length === 0)) {
      throw new Error("--input is required for outcome-observe");
    }
    if (args["output-dir"] === undefined || (Array.isArray(args["output-dir"]) && args["output-dir"].length === 0)) {
      throw new Error("--output-dir is required for outcome-observe");
    }
    // Dry-run-first (#286 PR A): default reads-and-reports without persisting labels.
    const dryRun = args["dry-run"] === undefined ? true : parseBooleanArg(args["dry-run"], "--dry-run");
    const markNegativeControl = args["mark-negative-control"] === undefined
      ? false
      : parseBooleanArg(args["mark-negative-control"], "--mark-negative-control");
    const config = loadConfig(args.config ? parseSingleArg(args.config, "--config") : undefined);
    const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
    assertEvalOutputDirSafe(outputDir);
    const entries = readOutcomeObserverInput(parseSingleArg(args.input, "--input"));
    const store = new ReviewStateStore(config.statePath);
    try {
      if (markNegativeControl) {
        // Explicit negative control (#286 PR C): a WRITE, so it requires --dry-run false. Refuses any
        // run that posted findings (recordNegativeControlLabels enforces the clean-run precondition).
        if (dryRun) throw new Error("outcome-observe --mark-negative-control requires --dry-run false because it records explicit_control labels");
        const result = recordNegativeControlLabels({ store, reviews: entries.map((entry) => entry.review) });
        console.log(stringifyRedactedJson({ command: "outcome-observe", mode: "mark-negative-control", dryRun, outputDir, ok: true, recorded: result.recorded }));
        return;
      }
      const result = runOutcomeObserverFromInput({ store, entries, evidenceDir: outputDir, dryRun });
      console.log(stringifyRedactedJson({ command: "outcome-observe", dryRun, outputDir, ...result }));
      if (!result.ok) process.exitCode = 1;
    } finally {
      store.close();
    }
    return;
  }

  if (command === "calibration-aggregate") {
    if (args["output-dir"] === undefined || (Array.isArray(args["output-dir"]) && args["output-dir"].length === 0)) {
      throw new Error("--output-dir is required for calibration-aggregate");
    }
    // Read-only aggregation (#286 PR B): reads finding_outcome_labels; evaluates the public-confidence
    // floors and reports eligibility, but NEVER mutates config or switches public display.
    const config = loadConfig(args.config ? parseSingleArg(args.config, "--config") : undefined);
    const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
    assertEvalOutputDirSafe(outputDir);
    const repo = args.repo ? parseSingleArg(args.repo, "--repo") : undefined;
    const store = new ReviewStateStore(config.statePath);
    try {
      const labels = store.listFindingOutcomeLabels(repo ? { repo } : {});
      const result = writeCalibrationAggregatePacket({ labels, outputDir });
      console.log(stringifyRedactedJson({
        command: "calibration-aggregate",
        outputDir,
        ok: result.ok,
        labeledFindings: result.aggregate.labeledFindings,
        p0p1Labels: result.aggregate.p0p1Labels,
        negativeControlScenarios: result.aggregate.negativeControlScenarios,
        eligible: result.aggregate.eligible,
        reason: result.aggregate.reason
      }));
      if (!result.ok) process.exitCode = 1;
    } finally {
      store.close();
    }
    return;
  }

  if (command === "calibration-promote") {
    if (args.input === undefined || (Array.isArray(args.input) && args.input.length === 0)) {
      throw new Error("--input is required for calibration-promote (the aggregate-calibration.json)");
    }
    if (args["output-dir"] === undefined || (Array.isArray(args["output-dir"]) && args["output-dir"].length === 0)) {
      throw new Error("--output-dir is required for calibration-promote");
    }
    // Human-gated (#286 PR C): requires --confirm; default writes a config PATCH FILE the operator
    // applies by hand. --apply additionally requires --i-understand-live-config. It NEVER sets
    // publicDisplay.mode — flipping to "calibrated" stays a deliberate manual human edit.
    const outputDir = parseSingleArg(args["output-dir"], "--output-dir");
    assertEvalOutputDirSafe(outputDir);
    // When --config is supplied, gate against the operator's EFFECTIVE floors (Math.max(hard,
    // configured)) so promote can't declare numbers eligible that the live config would reject.
    const policyOverride = args.config
      ? loadConfig(parseSingleArg(args.config, "--config")).confidenceCalibration?.publicDisplay
      : undefined;
    const result = runCalibrationPromotion({
      aggregatePath: parseSingleArg(args.input, "--input"),
      outputDir,
      confirm: args.confirm === undefined ? false : parseBooleanArg(args.confirm, "--confirm"),
      apply: args.apply === undefined ? false : parseBooleanArg(args.apply, "--apply"),
      iUnderstandLiveConfig: args["i-understand-live-config"] === undefined
        ? false
        : parseBooleanArg(args["i-understand-live-config"], "--i-understand-live-config"),
      ...(policyOverride ? { policyOverride } : {})
    });
    console.log(stringifyRedactedJson({ command: "calibration-promote", ...result }));
    if (!result.ok) process.exitCode = 1;
    return;
  }

  if (command === "badge") {
    if (args.output === undefined || (Array.isArray(args.output) && args.output.length === 0)) {
      throw new Error("--output is required for badge");
    }
    const config = loadConfig(args.config ? parseSingleArg(args.config, "--config") : undefined);
    const repo = args.repo ? parseSingleArg(args.repo, "--repo") : undefined;
    const store = new ReviewStateStore(config.statePath);
    try {
      const labels = store.listFindingOutcomeLabels(repo ? { repo } : {});
      const aggregate = aggregateCalibrationLabels(labels);
      const result = writePrecisionBadgeEndpoint({
        aggregate,
        publicDisplay: config.confidenceCalibration?.publicDisplay,
        outputPath: parseSingleArg(args.output, "--output")
      });
      console.log(stringifyRedactedJson({
        command: "badge",
        ok: result.ok,
        outputPath: result.outputPath,
        publicMode: result.publicMode,
        allowed: result.allowed,
        missingThresholds: result.missingThresholds,
        labeledFindings: result.labeledFindings,
        wilsonLowerBound: result.wilsonLowerBound,
        displayWilsonLowerBound: result.displayWilsonLowerBound,
        proofBoundary: result.proofBoundary,
        schemaVersion: result.badge.schemaVersion,
        label: result.badge.label,
        message: result.badge.message,
        color: result.badge.color,
        ...(repo ? { repo } : {})
      }));
    } finally {
      store.close();
    }
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
      commandName: command,
      admitImpl: async () => {
        const admission = await requireClassifiedCommandAdmission(commandLicensePolicy, args.config);
        if (!admission) throw new Error("review commands require production license admission");
        return admission;
      }
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
      if (daemonAction === "start"
        && args["dry-run"] === "false"
        && args.confirm === "true") {
        await requireClassifiedCommandAdmission(commandLicensePolicy, args.config);
      }
      const result = runDaemonControlCommandSafely(daemonAction, args);
      console.log(stringifyRedactedJson(result));
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
      const cycleResult = await runDaemonCycle({
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
      if (shouldExitDaemonAfterFailedCycle(cycleResult, runOnce)) {
        process.exitCode = 1;
        return;
      }
      if (runOnce) {
        return;
      }
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
  const exampleConfig = readFileSync(examplePath, "utf8");
  if (force) {
    writeFileAtomic(configPath, exampleConfig);
  } else {
    writeNewFile(configPath, exampleConfig);
  }
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
    ],
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

function resolvePackageVersion(): string {
  const packageJson = JSON.parse(readFileSync(join(resolvePackageRoot(), "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || packageJson.version.length === 0) {
    throw new Error("package.json is missing a version string");
  }
  return packageJson.version;
}

function isNeonDiffPackageRoot(candidate: string): boolean {
  if (!existsSync(join(candidate, "package.json")) || !existsSync(join(candidate, "config.example.json"))) {
    return false;
  }
  try {
    const packageJson = JSON.parse(readFileSync(join(candidate, "package.json"), "utf8"));
    return ["neondiff", "evaos-code-review-bot"].includes(packageJson.name)
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
  writeNewFile(backupPath, readFileSync(configPath, "utf8"));
  return backupPath;
}

function writeNewFile(path: string, contents: string): void {
  const fd = openSync(path, "wx", 0o600);
  try {
    writeFileSync(fd, contents);
  } finally {
    closeSync(fd);
  }
}

function writeFileAtomic(path: string, contents: string): void {
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    renameSync(tempPath, path);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

type DaemonControlResult = {
  ok: boolean;
  command: "daemon start" | "daemon stop" | "daemon status";
  platform?: string;
  serviceManager?: "launchd" | "systemd";
  docs?: string;
  dryRun?: boolean;
  launchdLabel?: string;
  launchdTarget?: string;
  launchdLoaded?: boolean;
  operation?: "bootstrap_then_kickstart" | "kickstart_existing" | "bootout_plist" | "bootout_service" | "status";
  plistPath?: string;
  warning?: string;
  plannedCommands?: string[][];
  results?: LaunchctlResult[];
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
  const platform = currentDaemonPlatform();
  if (platform !== "darwin") return unsupportedNonDarwinDaemonControl(action, platform);

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
  const requestedPlistPath = args.plist ? resolve(parseSingleArg(args.plist, "--plist")) : undefined;
  const launchdTarget = launchdServiceTarget(launchdLabel);
  const standardPlistPath = defaultLaunchdPlistPath(launchdLabel);
  return runLaunchdControlCommand({
    action,
    dryRun,
    confirm,
    allowExternalPlist,
    launchdLabel,
    launchdTarget,
    launchdDomain: launchdDomainTarget(),
    standardPlistPath,
    ...(requestedPlistPath ? { requestedPlistPath } : {})
  }, {
    executeLaunchctl: runLaunchctl,
    plistExists: existsSync,
    assertPlistLabelMatches,
    plistWarning: daemonPlistWarning,
    launchdSessionError: launchdUserSessionError
  });
}

function currentDaemonPlatform(): string {
  return process.env.NEONDIFF_TEST_PLATFORM || process.platform;
}

function unsupportedNonDarwinDaemonControl(
  action: "start" | "stop" | "status",
  platform: string
): DaemonControlResult {
  const isLinux = platform === "linux";
  return {
    ok: false,
    command: `daemon ${action}`,
    platform,
    ...(isLinux ? { serviceManager: "systemd" as const, docs: "docs/systemd.md" } : { docs: "docs/docker.md" }),
    error:
      `launchd daemon controls are only supported on macOS; detected ${platform}. ` +
      (isLinux
        ? "On Linux, use systemd with docs/systemd.md or Docker with docs/docker.md."
        : "Use Docker with docs/docker.md, or run this on Linux with docs/systemd.md.")
  };
}

function defaultLaunchdPlistPath(launchdLabel: string): string {
  return join(process.env.HOME || homedir(), "Library", "LaunchAgents", `${launchdLabel}.plist`);
}

function daemonPlistWarning(plistPath: string): string | undefined {
  const packageRoot = resolvePackageRoot();
  const normalizedRoot = `${packageRoot.replace(/\/+$/, "")}/`;
  const normalizedPlist = resolve(plistPath);
  if (normalizedPlist === packageRoot || normalizedPlist.startsWith(normalizedRoot)) return undefined;
  return "--plist is outside the NeonDiff package root; use only operator-owned plist paths";
}

function runLaunchctl(command: string[]): LaunchctlResult {
  const [binary, ...args] = command;
  if (binary !== "launchctl") throw new Error(`unsupported daemon control command: ${command.join(" ")}`);
  const result = spawnSync("/bin/launchctl", args, {
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
  const plistLabel = readPlistLabel(plistPath);
  if (plistLabel !== launchdLabel) {
    throw new Error(`--plist Label (${redactSecrets(plistLabel)}) must match --launchd-label (${redactSecrets(launchdLabel)})`);
  }
}

function readPlistLabel(plistPath: string): string {
  const result = spawnSync("/usr/bin/plutil", ["-extract", "Label", "raw", plistPath], {
    encoding: "utf8",
    timeout: PLUTIL_TIMEOUT_MS
  });
  if (result.error) {
    if ((result.error as NodeJS.ErrnoException).code === "ENOENT") return readPlistLabelFromXml(plistPath);
    throw new Error(`failed to read --plist Label: ${redactSecrets(result.error.message)}`);
  }
  if (result.status !== 0) {
    const detail = redactSecrets((result.stderr || result.stdout || "").trim());
    throw new Error(`failed to read --plist Label${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout.trim();
}

function readPlistLabelFromXml(plistPath: string): string {
  const xml = readFileSync(plistPath, "utf8");
  const match = xml.match(/<key>\s*Label\s*<\/key>\s*<string>([\s\S]*?)<\/string>/);
  if (!match) throw new Error("failed to read --plist Label: Label key missing");
  return decodeXmlText(match[1]!.trim());
}

function decodeXmlText(value: string): string {
  return value
    .replaceAll("&quot;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
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

function buildReleaseCoverageCommand(args: ParsedArgs): string {
  const parts = ["npx", "tsx", "src/cli.ts", "release-status"];
  appendCommandArg(parts, "--config", args.config);
  appendCommandArg(parts, "--expected-head", args["expected-head"]);
  appendCommandArg(parts, "--public-release-manifest", args["public-release-manifest"]);
  appendCommandArg(parts, "--expected-public-version", args["expected-public-version"]);
  appendCommandArg(parts, "--verify-public-rollback-refs", args["verify-public-rollback-refs"]);
  appendCommandArg(parts, "--launchd-label", args["launchd-label"]);
  appendCommandArg(parts, "--state-path", args["state-path"]);
  parts.push("--require-coverage", "true");
  return parts.map(shellQuoteCommandArg).join(" ");
}

function appendCommandArg(parts: string[], name: string, value: string | string[] | undefined): void {
  if (value === undefined) return;
  parts.push(name, parseSingleArg(value, name));
}

function shellQuoteCommandArg(value: string): string {
  return /^[A-Za-z0-9_./:=@%+-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", "'\\''")}'`;
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
    if (appCredentialsConfigured) {
      const proof = await github.probeRepositoryAccess(repo);
      const gatePreview = buildDoctorGithubLicenseGatePreview(config, proof);
      readChecks.push({
        repo,
        ok: proof.app_can_read_metadata && proof.app_can_read_pull_requests,
        policy,
        ...proof,
        ...gatePreview
      });
      continue;
    }
    try {
      const pulls = await github.listOpenPulls(repo);
      const gatePreview = buildDoctorGithubLicenseGatePreview(config, {
        visibility_result: "unknown",
        app_can_read_metadata: false,
        app_can_read_pull_requests: false
      });
      readChecks.push({
        repo,
        ok: false,
        policy,
        openPullCount: pulls.length,
        repo_full_name: repo,
        readMode: "fallback_token",
        visibility_result: "unknown",
        visibility_source: "unavailable",
        installation_id_present: false,
        app_can_read_metadata: false,
        app_can_read_pull_requests: false,
        github_api_error_class: "missing_app_credentials",
        github_api_error: "Fallback-token reads are not GitHub App installation-scope proof.",
        ...gatePreview
      });
    } catch (error) {
      readChecks.push({
        repo,
        ok: false,
        policy,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const issueReadChecks = await collectIssueEnrichmentReadChecks(config, github);
  const issueEnrichment = buildIssueEnrichmentStatus({
    config,
    canPostAsApp: appCredentialsConfigured,
    issueReadChecks
  });
  const ok = appCredentialsConfigured && activeRepoChecks > 0 && readChecks.every((check) => check.ok) && issueEnrichment.ok;
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
      botLogin: config.github.botLogin ?? "configured GitHub App bot",
      apiBaseUrl: config.github.apiBaseUrl ?? "https://api.github.com",
      readChecks
    },
    issueEnrichment: {
      ...issueEnrichment,
      readChecks: issueReadChecks
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
      ...(appCredentialsConfigured ? [] : ["Set NEONDIFF_GITHUB_APP_ID and NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH, or configure github.appId/privateKeyPath outside git. Legacy EVAOS_REVIEW_BOT_* aliases remain supported for existing internal deployments."]),
      ...(activeRepoChecks > 0 ? [] : ["Add at least one enabled repo to pilotRepos or repoProfiles before using this as an install proof."]),
      ...(readChecks.some((check) => !check.ok) ? ["Confirm the GitHub App is installed on selected repositories with the required repository permissions."] : [])
    ]
  };
}

function buildDoctorGithubLicenseGatePreview(
  config: BotConfig,
  proof: Pick<GitHubRepositoryAccessProof, "visibility_result" | "app_can_read_metadata" | "app_can_read_pull_requests">
): {
  license_gate_decision: string;
  pre_checkout_gate_result: string;
} {
  const visibility: GitHubRepositoryVisibility = proof.visibility_result;
  const publicReposFree = config.license?.publicReposFree ?? true;
  const privateReposRequireEntitlement = config.license?.privateReposRequireEntitlement ?? true;
  const appScopeBlocksCheckout = !proof.app_can_read_metadata || !proof.app_can_read_pull_requests;
  if (appScopeBlocksCheckout) {
    return {
      license_gate_decision: licenseGateDecisionForVisibility(visibility, publicReposFree, privateReposRequireEntitlement),
      pre_checkout_gate_result: "blocked_before_checkout"
    };
  }
  if (visibility === "public" && publicReposFree) {
    return {
      license_gate_decision: "public_free_allowed",
      pre_checkout_gate_result: "allowed"
    };
  }
  if (visibility === "unknown" && privateReposRequireEntitlement) {
    return {
      license_gate_decision: "unknown_visibility_fail_closed",
      pre_checkout_gate_result: "blocked_before_checkout"
    };
  }
  if ((visibility === "private" || visibility === "internal") && privateReposRequireEntitlement) {
    return {
      license_gate_decision: "active_private_entitlement_required",
      pre_checkout_gate_result: "blocked_until_entitlement_proof"
    };
  }
  if (visibility === "public" && !publicReposFree) {
    return {
      license_gate_decision: "active_public_entitlement_required",
      pre_checkout_gate_result: "blocked_until_entitlement_proof"
    };
  }
  return {
    license_gate_decision: "repo_visibility_allowed_by_policy",
    pre_checkout_gate_result: "allowed"
  };
}

function licenseGateDecisionForVisibility(
  visibility: GitHubRepositoryVisibility,
  publicReposFree: boolean,
  privateReposRequireEntitlement: boolean
): string {
  if (visibility === "public" && publicReposFree) return "public_free_allowed";
  if (visibility === "public" && !publicReposFree) return "active_public_entitlement_required";
  if (visibility === "unknown" && privateReposRequireEntitlement) return "unknown_visibility_fail_closed";
  if (visibility === "private" || visibility === "internal") {
    return privateReposRequireEntitlement ? "active_private_entitlement_required" : "repo_visibility_allowed_by_policy";
  }
  return "app_installation_scope_required";
}

async function collectIssueEnrichmentReadChecks(
  config: BotConfig,
  github: GitHubApi
): Promise<IssueEnrichmentRepoReadCheck[]> {
  const issueConfig = config.issueEnrichment;
  if (!issueConfig || issueConfig.allowlist.length === 0) return [];
  const canRead = github.canPostAsApp() || Boolean(config.github.token);
  const checks: IssueEnrichmentRepoReadCheck[] = [];
  for (const repo of issueConfig.allowlist) {
    const policy = resolveIssueEnrichmentRepoPolicy(issueConfig, repo);
    if (!policy.allowed) {
      checks.push({ repo, ok: true, skippedByPolicy: policy.reason });
      continue;
    }
    if (!canRead) {
      checks.push({
        repo,
        ok: false,
        error: "GitHub App credentials or fallback read token are required before checking issue-enrichment repository access."
      });
      continue;
    }
    try {
      const issues = await github.listIssuesForEnrichment(repo, {
        state: "open",
        perPage: 1,
        pageLimit: 1,
        excludePullRequests: true,
        minIssueResults: 1
      });
      checks.push({ repo, ok: true, readableIssueCount: issues.length });
    } catch (error) {
      checks.push({
        repo,
        ok: false,
        error: redactSecrets(error instanceof Error ? error.message : String(error))
      });
    }
  }
  return checks;
}

interface CommandUsageFlag {
  name: string;
  description: string;
}

interface CommandUsage {
  description: string;
  flags: CommandUsageFlag[];
}

// Minimal per-command usage registry for `neondiff <command> --help`. Kept
// intentionally small (not every command) - see AGENTS.md "do not rewrite the
// help system" guidance in issue #319. Unlisted commands fall back to the
// generic command list in buildHelp, same as before this registry existed.
const COMMAND_USAGE: Record<string, CommandUsage> = {
  init: {
    description: "Create a local config.local.json from the packaged config.example.json.",
    flags: [
      { name: "--config", description: "Path to write the local config file (default config.local.json)." },
      { name: "--force", description: "Overwrite an existing JSON config-looking file at --config." }
    ]
  },
  pricing: {
    description: "Print the redacted local pricing/cost model output.",
    flags: []
  },
  badge: {
    description: "Write a Shields endpoint JSON precision badge from the calibration aggregate gate.",
    flags: [
      { name: "--config", description: "Path to the config file (default config.local.json)." },
      { name: "--repo", description: "Optional repo scope for outcome labels, owner/name." },
      { name: "--output", description: "Path to write the Shields endpoint JSON (required)." }
    ]
  },
  doctor: {
    description: "Check repo read access, provider env, and issue-enrichment readiness (add `github` for GitHub-only checks).",
    flags: [
      { name: "--config", description: "Path to the config file (default config.local.json)." }
    ]
  },
  status: {
    description: "Report combined release, coverage, agent, provider-cooldown, and durable-queue health as one gate.",
    flags: [
      { name: "--config", description: "Path to the config file (default config.local.json)." },
      { name: "--repo", description: "Scope provider-cooldown and durable-queue rows to a single repo." },
      { name: "--limit", description: "Cap the number of provider-cooldown/durable-queue rows returned." },
      { name: "--expected-head", description: "Expected release head SHA to verify against." },
      { name: "--launchd-label", description: "launchd label to inspect for daemon liveness." },
      { name: "--state-path", description: "Override the SQLite state path (defaults to config.statePath)." }
    ]
  },
  "release-status": {
    description: "Report release/runtime health; add --require-coverage true to also gate active repo App-read coverage.",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--expected-head", description: "Expected release head SHA to verify against." },
      { name: "--launchd-label", description: "launchd label to inspect for daemon liveness." },
      { name: "--state-path", description: "Override the SQLite state path (defaults to config.statePath)." },
      { name: "--coverage", description: "true to attach active repo coverage as advisory output; top-level gates remain runtime-only unless --require-coverage true is set." },
      { name: "--require-coverage", description: "true to fail release-status when active repo coverage has unreadable, unprocessed, or stale heads." },
      { name: "--public-release-manifest", description: "Public release manifest to validate for source-beta releases." },
      { name: "--expected-public-version", description: "Expected public release version/tag when validating a public manifest." }
    ]
  },
  "checkout-issuance-smoke": {
    description: "Dry-run or run the owner-held authenticated checkout issuance smoke and emit a redacted release-status proof.",
    flags: [
      { name: "--url", description: "Full /v1/admin/licenses/issue URL (default https://neondiff-license.fly.dev/v1/admin/licenses/issue)." },
      { name: "--release-version", description: "Release version recorded in the proof (default v1.0.0)." },
      { name: "--checkout-lookup-key", description: "Checkout lookup key to smoke: neondiff_monthly, neondiff_yearly, or neondiff_org_yearly." },
      { name: "--provider-account-id", description: "Required Stripe account ID for the same test or live environment as the correlated objects." },
      { name: "--provider-mode", description: "Required Stripe environment: test or live. Cross-environment correlation is rejected." },
      { name: "--external-subscription-id", description: "Required Stripe subscription ID from the selected provider mode; no ID is synthesized." },
      { name: "--external-checkout-id", description: "Required Stripe Checkout Session ID from the selected provider mode; no ID is synthesized." },
      { name: "--idempotency-key", description: "Optional stable smoke idempotency key; defaults to release/version/lookup-key." },
      { name: "--dry-run", description: "true by default; false sends the live POST." },
      { name: "--confirm-live-issuance", description: "Must be true with --dry-run false before reading --secret-env and sending the POST." },
      { name: "--secret-env", description: "Env var name holding the owner-held issuance bearer secret; raw secrets are never accepted on argv." },
      { name: "--output", description: "Optional proof JSON path, normally docs/evidence/license-checkout-issuance-authenticated.json." }
    ]
  },
  "review-pr": {
    description: "Run a single dry-run-by-default PR review for one repo/PR (public alias of run-once, scoped to one PR).",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--repo", description: "Repo to review, owner/name (required)." },
      { name: "--pr", description: "Pull request number to review (required)." },
      { name: "--dry-run", description: "true (default) or false; false requires --confirm true." },
      { name: "--confirm", description: "Must be true to allow --dry-run false." }
    ]
  },
  "run-once": {
    description: "Run a single review cycle across configured repos (internal/operator alias of review-pr's cycle).",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--repo", description: "Optional repo to scope the cycle to, owner/name." },
      { name: "--dry-run", description: "true (default) or false; false requires --confirm true." },
      { name: "--confirm", description: "Must be true to allow --dry-run false." }
    ]
  },
  "review-lenses-eval": {
    description: "Run dry-run comparison evidence for default-off review lenses; no posting, provider calls, live config mutation, or activation.",
    flags: [
      { name: "--input", description: "Single review-lens eval scenario JSON." },
      { name: "--input-dir", description: "Directory of review-lens eval scenario JSON files." },
      { name: "--output-root", description: "Eval evidence output root outside the checkout." },
      { name: "--mode", description: "deterministic (default) or model-shadow; model-shadow remains provider-free and dry-run only." },
      { name: "--dry-run", description: "true by default; false is rejected." }
    ]
  },
  "review-bench": {
    description: "Prepare and verify private Corpus v1 human-adjudication evidence or verify public sources; no model/provider execution or publication.",
    flags: [
      { name: "--candidate", description: "Canonical candidate manifest for prepare-adjudication." },
      { name: "--output", description: "Fresh private output directory for prepare-adjudication." },
      { name: "--packet", description: "Blinded packet JSON for verify-adjudication." },
      { name: "--primary", description: "Canonical primary human-response JSON for verify-adjudication." },
      { name: "--secondary", description: "Canonical secondary human-response JSON for verify-adjudication." },
      { name: "--resolver", description: "Optional canonical resolver-response JSON when disagreements exist." },
      { name: "--corpus", description: "Corpus v1 JSON manifest to validate and live-reverify." },
      { name: "--artifacts", description: "Digest-named source/rubric/protocol artifacts for preparation or source verification." },
      { name: "--receipt", description: "Fresh immutable receipt JSON path outside the checkout." }
    ]
  },
  daemon: {
    description: "Control or run the review daemon: `daemon start|stop|status`, or no subcommand to run the poll loop directly.",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--launchd-label", description: "launchd label for start/stop/status subcommands." },
      { name: "--dry-run", description: "true (default) or false for the direct poll loop." },
      { name: "--once", description: "true to run a single cycle instead of looping (direct poll loop only)." }
    ]
  },
  providers: {
    description: "Inspect or verify the provider registry: `providers list`, `providers doctor`, or `providers verify`.",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--provider", description: "Scope providers doctor or verify to a single provider id." },
      { name: "--smoke", description: "true to run a live smoke check in providers doctor." },
      { name: "--api-key-stdin", description: "Must be true for providers verify; reads the submitted key from bounded stdin." },
      { name: "--allow-remote-smoke", description: "true to consent to hosted provider verification." },
      { name: "--expected-config-revision", description: "Lowercase SHA-256 config revision to pin before stdin is read." }
    ]
  },
  dashboard: {
    description: "Start and open the local first-run HTML dashboard; use --operator true for the JSON operator dashboard.",
    flags: [
      { name: "--config", description: "Path to the config file (default config.local.json)." },
      { name: "--host", description: "Dashboard bind host (default 127.0.0.1)." },
      { name: "--port", description: "Dashboard port (default 0, choose an available port)." },
      { name: "--open", description: "true (default) to open the dashboard in the browser." },
      { name: "--preview-smoke", description: "true to run a one-shot local HTML dashboard route smoke and write an evidence packet." },
      { name: "--output-dir", description: "Evidence directory for --preview-smoke (default runtime/dashboard-preview-smoke)." },
      { name: "--screenshot-path", description: "Optional browser/Playwright screenshot path to record in preview-smoke evidence." },
      { name: "--source-sha", description: "Source SHA to record in preview-smoke evidence (defaults to git rev-parse HEAD)." },
      { name: "--allow-remote-smoke", description: "true to allow hosted provider API-key verification." },
      { name: "--operator", description: "true to use the legacy operator JSON/human dashboard." }
    ]
  },
  license: {
    description: "Manage the license: `license activate|status|deactivate`.",
    flags: [
      { name: "--config", description: "Path to the config file." },
      { name: "--license-key-stdin", description: "true to read one bounded license key from stdin (activate only)." },
      { name: "--repo", description: "Repo to scope activation/status to, owner/name." },
      { name: "--refresh", description: "true to force a fresh status check instead of cached." }
    ]
  }
};

function buildHelp(command?: string) {
  const usage = command ? COMMAND_USAGE[command] : undefined;
  const packageVersion = resolvePackageVersion();
  return {
    ok: true,
    licenseBoundary: {
      sourceAvailableCommercial: true,
      activationRequired: "Supported public, private, internal, and unknown repository review requires live API-backed activation.",
      packageVersion,
      releaseState: packageVersion === "1.0.3"
        ? "Mandatory activation is staged for v1.0.4; public npm latest v1.0.3 does not enforce this boundary."
        : `This package reports ${packageVersion}; verify the matching npm version and GitHub Release before relying on activation enforcement.`
    },
    ...(command ? { command } : {}),
    ...(usage ? { usage: { command, ...usage } } : {}),
    commands: {
      public: [
        "init",
        "config inspect",
        "config patch",
        "pricing",
        "badge",
        "dashboard",
        "providers list",
        "providers doctor",
        "providers verify",
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
        "gitnexus-refresh-preflight",
        "build-memory-packet",
        "build-gitnexus-context-packet",
        "build-github-related-context-packet",
        "build-skill-pack",
        "build-enrichment-comment",
        "issue-enrichment-scan",
        "issue-enrichment-run",
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
        "eval-sticky-vs-cold",
        "eval-repo-wiki-context-ab",
        "eval-openwiki-docs-drift",
        "review-bench verify-sources",
        "review-bench prepare-adjudication",
        "review-bench verify-adjudication",
        "review-lenses-eval",
        "outcome-ledger",
        "outcome-scorecard",
        "review-mode",
        "outcome-observe",
        "calibration-aggregate",
        "calibration-promote",
        "badge"
      ]
    },
    examples: [
      "neondiff init --config config.local.json",
      "neondiff config inspect --config config.local.json",
      "neondiff config patch --config config.local.json --input desktop-patch.json --dry-run true",
      "desktop-patch.json uses nested object shape, e.g. {\"zcode\":{\"cliPath\":\"/path/to/neondiff\"}}",
      "neondiff pricing",
      "neondiff badge --config config.local.json --output docs/badges/precision.json",
      "neondiff dashboard --config config.local.json",
      "neondiff dashboard --preview-smoke true --config config.local.json --output-dir runtime/dashboard-preview-smoke",
      "neondiff providers list --config config.local.json --json",
      "neondiff providers doctor --config config.local.json --json",
      "neondiff providers doctor --config config.local.json --provider ollama-local --smoke true --json",
      "neondiff providers verify --config config.local.json --provider openai-compatible --api-key-stdin true --allow-remote-smoke true --json",
      "security find-generic-password -s YOUR_APPROVED_SOURCE -w | neondiff license activate --config config.local.json --license-key-stdin true --json",
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
      "npx tsx src/cli.ts dashboard --operator true --config /path/to/live.json --status blocked_on_proof",
      "npx tsx src/cli.ts dashboard --operator true --config /path/to/live.json --human",
      "npx tsx src/cli.ts budget-status --config /path/to/live.json",
      "npx tsx src/cli.ts provider-throttle-report --config /path/to/live.json --since 7d --timezone Asia/Singapore",
      "provider-throttle-report peak-window flags use inclusive local-hour buckets, e.g. --peak-start-hour 14 --peak-end-hour 18 includes 14:00 through 18:00",
      "npx tsx src/cli.ts why --config /path/to/live.json --repo owner/repo --pr 123",
      "npx tsx src/cli.ts gitnexus-refresh-preflight --repo-path . --repo-alias evaos-code-review-bot-neondiff",
      "npx tsx src/cli.ts build-memory-packet --config /path/to/live.json --repo owner/repo --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-gitnexus-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-github-related-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-skill-pack --config /path/to/live.json --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-enrichment-comment --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-enrichment-comment --config /path/to/live.json --repo owner/repo --issue 456 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts issue-enrichment-scan --config /path/to/live.json --dry-run true --output-dir /path/to/evidence",
      "npx tsx src/cli.ts issue-enrichment-run --config /path/to/live.json --repo owner/repo --issue 456 --dry-run true --output-dir /path/to/evidence",
      "npx tsx src/cli.ts issue-enrichment-run --config /path/to/live.json --repo owner/repo --issue 456 --dry-run false --confirm true",
      "npx tsx src/cli.ts clear-issue-enrichment-leases --config /path/to/live.json --dry-run true --expired-only true",
      "npx tsx src/cli.ts clear-review-queue-leases --config /path/to/live.json --dry-run true --expired-only true",
      "npx tsx src/cli.ts eval-sticky-vs-cold --input /path/to/sticky-vs-cold.json --output-root /Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/$(date +%F)/sticky-vs-cold",
      "npx tsx src/cli.ts eval-repo-wiki-context-ab --input /path/to/repo-wiki-ab.json --output-root /Volumes/LEXAR/Codex/neondiff-openwiki-context/$(date +%F)/eval-gates/ab",
      "npx tsx src/cli.ts eval-openwiki-docs-drift --input /path/to/docs-drift.json --output-root /Volumes/LEXAR/Codex/neondiff-openwiki-context/$(date +%F)/eval-gates/docs-drift",
      "npx tsx src/cli.ts review-bench verify-sources --corpus /path/to/corpus.json --artifacts /path/to/source-artifacts --receipt /Volumes/LEXAR/Codex/evals/neondiff-local-review-bench/source-admission.json",
      "npx tsx src/cli.ts review-bench prepare-adjudication --candidate /path/to/candidate.json --artifacts /path/to/source-artifacts --output /Volumes/LEXAR/Codex/evals/neondiff-local-review-bench/adjudication-packet",
      "npx tsx src/cli.ts review-bench verify-adjudication --packet /path/to/packet.json --primary /path/to/primary.json --secondary /path/to/secondary.json --receipt /Volumes/LEXAR/Codex/evals/neondiff-local-review-bench/adjudication-receipt.json",
      "npx tsx src/cli.ts review-lenses-eval --input-dir tests/fixtures/review-lenses-eval --output-root /Volumes/LEXAR/Codex/evals/zcode-glm-pr-review/$(date +%F)/review-lenses-eval-gate-$(date +%H%M%S) --dry-run true",
      "npx tsx src/cli.ts outcome-ledger --input /path/to/outcome-ledger-input.json --dry-run true --output-dir /path/to/evidence/outcome-ledger-run",
      "npx tsx src/cli.ts outcome-scorecard --input /path/to/outcome-scorecard-input.json --dry-run true --output-dir /path/to/evidence/outcome-scorecard-run",
      "npx tsx src/cli.ts outcome-observe --config /path/to/live.json --input /path/to/outcome-observer-input.json --dry-run true --output-dir /path/to/evidence/outcome-observe-run",
      "npx tsx src/cli.ts calibration-aggregate --config /path/to/live.json --output-dir /path/to/evidence/calibration-aggregate-run",
      "npx tsx src/cli.ts calibration-promote --input /path/to/evidence/calibration-aggregate-run/aggregate-calibration.json --output-dir /path/to/evidence/calibration-promote-run --confirm true",
      "npx tsx src/cli.ts badge --config /path/to/live.json --repo owner/repo --output docs/badges/precision.json",
      "npx tsx src/cli.ts finishing-touch-dry-run --config /path/to/live.json --repo owner/repo --pr 123 --head-sha HEAD --current-head HEAD --comment-id 456 --author maintainer --trusted-authors maintainer --body '@neondiff explain risk'",
      "npx tsx src/cli.ts cooldowns --config /path/to/live.json --expired-only true"
    ],
    outcomeLedger: {
      notes: [
        "The outcome-ledger command is dry-run only.",
        "--dry-run defaults to true for outcome-ledger; --dry-run false is rejected until live posting is explicitly implemented.",
        "Failed safety gates or secret redaction failures exit non-zero; unknown gates remain visible in the packet but do not fail the dry run."
      ]
    },
    outcomeScorecard: {
      notes: [
        "The outcome-scorecard command is dry-run only.",
        "Scores above 3 require direct evidence links.",
        "Safety failures cap the score at 1 and all public claims remain advisory-only."
      ]
    },
    reviewMode: {
      notes: [
        "The review-mode command is dry-run only.",
        "It previews light/standard/deep routing from the changed surface and config-promoted precision (reviewGate.categoryPrecisionFloors) and reports the resolved demote-only analysis plan.",
        "A mode selects analysis depth and spend only; posting behavior (gate, caps, floors, REQUEST_CHANGES eligibility, redaction) is identical across modes. When reviewModes is absent or disabled the selection is null and no evidence is written."
      ]
    }
  };
}

function isKnownCLICommand(command: string): boolean {
  const groups = buildHelp().commands;
  return Object.values(groups)
    .flat()
    .some((entry) => entry.split(" ", 1)[0] === command);
}

function stringifyProviderOutput(input: unknown): string {
  return JSON.stringify(redactProviderOutput(input), null, 2);
}

function collectGitNexusPreflightText(repoPath: string): string {
  const status = spawnSync("gitnexus", ["status"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  const doctor = spawnSync("gitnexus", ["doctor"], {
    cwd: repoPath,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 1024 * 1024
  });
  return [
    "$ gitnexus status",
    formatSpawnSyncDiagnostics("gitnexus status", status),
    status.stdout,
    status.stderr,
    "$ gitnexus doctor",
    formatSpawnSyncDiagnostics("gitnexus doctor", doctor),
    doctor.stdout,
    doctor.stderr
  ].filter(Boolean).join("\n");
}

function formatSpawnSyncDiagnostics(command: string, result: ReturnType<typeof spawnSync>): string | undefined {
  const error = result.error as NodeJS.ErrnoException | undefined;
  const diagnostics = [
    `[${command} exit status=${result.status ?? "null"} signal=${result.signal ?? "null"}]`,
    error ? `[${command} error code=${error.code ?? "unknown"} message=${formatSpawnSyncDiagnosticMessage(error.message)}]` : undefined
  ].filter(Boolean);
  return diagnostics.length > 0 ? diagnostics.join("\n") : undefined;
}

function formatSpawnSyncDiagnosticMessage(message: string): string {
  return message.replaceAll("]", ")");
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

function shouldUseOperatorDashboard(args: ParsedArgs): boolean {
  if (args.operator !== undefined && parseBooleanArg(args.operator, "--operator")) return true;
  return [
    "human",
    "json",
    "repo",
    "status",
    "state",
    "state-path",
    "job-limit",
    "priority",
    "stale-head-reason",
    "include-history",
    "limit"
  ].some((key) => args[key] !== undefined);
}

function isCoverageBackedCommand(command: string, args: ParsedArgs): boolean {
  if (command === "coverage" || command === "status" || command === "runtime-inventory" || command === "queue" || command === "why") {
    return true;
  }
  if (command === "dashboard") return shouldUseOperatorDashboard(args);
  if (command !== "release-status") return false;
  return (args.coverage !== undefined && parseBooleanArg(args.coverage, "--coverage"))
    || (args["require-coverage"] !== undefined
      && parseBooleanArg(args["require-coverage"], "--require-coverage"));
}

const admissionAfterValidationCommands = new Set([
  "providers",
  "daemon",
  "issue-enrichment-run",
  "issue-enrichment-scan",
  "review-pr",
  "run-once",
  "retry-failed",
  "retry-provider-cooldowns",
  "finishing-touch-dry-run",
  "build-enrichment-comment"
]);

function deferCommandAdmissionUntilValidated(command: string): boolean {
  return admissionAfterValidationCommands.has(command);
}

async function requireClassifiedCommandAdmission(
  policy: CommandLicensePolicy,
  configPath?: string,
  loadedConfig?: BotConfig
): Promise<ProductionLicenseAdmission | undefined> {
  if (policy.mode === "setup_safe") return undefined;
  const config = loadedConfig ?? loadConfig(configPath);
  const operation = policy.operation === "review_cycle" ? "review_discovery" : policy.operation;
  const admission = await requireActiveProductionLicense({ operation, config: config.license! });
  if (!admission.ok) {
    throw new Error(`license ${admission.decision.status}: ${admission.decision.detail}`);
  }
  return admission.admission;
}

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { _: [] };
  const repeatableArgs = repeatableArgsForCommand(argv);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) {
      parsed._.push(arg);
      continue;
    }
    const key = arg.slice(2);
    const next = argv[index + 1];
    if (next && !next.startsWith("--")) {
      setParsedArg(parsed, key, next, repeatableArgs);
      index += 1;
    } else {
      setParsedArg(parsed, key, "true", repeatableArgs);
    }
  }
  return parsed;
}

function repeatableArgsForCommand(argv: string[]): Set<string> {
  const command = argv.find((arg) => !arg.startsWith("--"));
  return command === "issue-enrichment-run" ? new Set(["issue"]) : new Set();
}

function licenseConfigFromArgs(base: LicenseConfig, args: ParsedArgs): LicenseConfig {
  if (args["license-api-url"]) {
    throw new Error("--license-api-url is not supported; the supported distribution pins the canonical license API");
  }
  const config = resolveProductionLicensePolicy({
    ...base,
    ...(args["license-cache-path"] ? { cachePath: parseSingleArg(args["license-cache-path"], "--license-cache-path") } : {}),
    ...(args["license-key-path"] ? { keyPath: parseSingleArg(args["license-key-path"], "--license-key-path") } : {}),
    ...(args["license-storage"] ? { storageBackend: parseLicenseStorageBackend(parseSingleArg(args["license-storage"], "--license-storage")) } : {})
  });
  validateLicenseConfigOverride(config, "config.license");
  return config;
}

async function resolveLicenseKeyArg(args: ParsedArgs, stdin: NodeJS.ReadableStream): Promise<string> {
  if (args["license-key"]) {
    throw new Error("license activate does not accept --license-key because argv can expose secrets; use --license-key-stdin true");
  }
  if (args["license-key-env"]) {
    throw new Error("license activate does not accept --license-key-env because process environments can expose secrets; use --license-key-stdin true");
  }
  if (args["license-key-stdin"] !== "true") {
    throw new Error("license activate requires --license-key-stdin true");
  }
  let key: string;
  try {
    key = await readSecretFromStdin(stdin, 512, 5_000);
  } catch (error) {
    throw new Error((error instanceof Error ? error.message : "license secret stdin could not be read").replaceAll("provider secret", "license secret"));
  }
  if (!/^nd_live_[A-Za-z0-9_-]{8,}$/.test(key)) {
    throw new Error("license secret stdin is not one valid production key");
  }
  return key;
}

function parseLicenseStorageBackend(value: string): "keychain" | "file" {
  if (value === "keychain" || value === "file") return value;
  throw new Error("--license-storage must be keychain or file");
}

function setParsedArg(parsed: ParsedArgs, key: string, value: string, repeatableArgs: Set<string>): void {
  const existing = parsed[key];
  if (existing !== undefined) {
    if (!repeatableArgs.has(key)) throw new Error(`--${key} must be provided once`);
    parsed[key] = Array.isArray(existing) ? [...existing, value] : [existing, value];
    return;
  }
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

function parseIssueNumberArgs(value: string | string[] | undefined): number[] {
  if (value === undefined) throw new Error("--issue is required for issue-enrichment-run");
  const values = Array.isArray(value) ? value : [value];
  const issueNumbers: number[] = [];
  const seen = new Set<number>();
  for (const entry of values) {
    const issueNumber = parsePositiveInteger(entry, "--issue");
    if (seen.has(issueNumber)) continue;
    seen.add(issueNumber);
    issueNumbers.push(issueNumber);
  }
  return issueNumbers;
}

function effectiveIssueEnrichmentRunLimit(
  config: IssueEnrichmentConfig,
  policy: ReturnType<typeof resolveIssueEnrichmentRepoPolicy>,
  input: { postIssueComment: boolean }
): { binding: string; value: number } {
  const limits = [
    { field: "repo.maxIssuesPerCycle", value: policy.throttle.maxIssuesPerCycle },
    { field: "repo.maxIssuesPerBurst", value: policy.throttle.maxIssuesPerBurst },
    { field: "globalMaxIssuesPerCycle", value: config.globalMaxIssuesPerCycle }
  ];
  if (input.postIssueComment) {
    limits.push(
      { field: "repo.maxCommentsPerCycle", value: policy.throttle.maxCommentsPerCycle },
      { field: "globalMaxCommentsPerCycle", value: config.globalMaxCommentsPerCycle }
    );
  }
  const binding = limits.reduce((best, candidate) => candidate.value < best.value ? candidate : best);
  return {
    binding: `${binding.field}=${binding.value}`,
    value: binding.value
  };
}

function issueEnrichmentRunLiveExitReason(
  result: IssueEnrichmentCycleResult
): "failed" | "lease_busy" | "no_work" | undefined {
  if (!result.ok) return "failed";
  if (result.summary.workerSkipped > 0) return "lease_busy";
  const liveNoWork =
    result.summary.posted === 0 &&
    result.summary.failed === 0 &&
    result.summary.alreadyProcessed === 0 &&
    result.summary.dryRunRecorded === 0 &&
    result.summary.skippedRecorded === 0 &&
    result.summary.deferredRecorded === 0;
  return liveNoWork ? "no_work" : undefined;
}

function parseSingleArg(value: string | string[], label: string): string {
  if (Array.isArray(value)) throw new Error(`${label} must be provided once`);
  return value;
}

function readCurrentGitHead(cwd: string): string | undefined {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  });
  if (result.status !== 0) return undefined;
  const head = result.stdout.trim();
  return /^[0-9a-f]{40}$/i.test(head) ? head : undefined;
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
    botMentions: botMentions.length > 0 ? botMentions : ["@neondiff"]
  });
  if (!parsed) {
    throw new Error(`--body must contain one of the finishing-touch commands for mentions ${botMentions.join(", ") || "@neondiff"}`);
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

function readReviewModeInput(path: string): {
  repo: string;
  pull: PullRequestSummary;
  files: PullFilePatch[];
  repoOverrideMode?: ReviewMode;
} {
  const value = readJsonInput(path, "--input");
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("review-mode --input must be a JSON object with repo, pull, and files");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.repo !== "string" || record.repo.length === 0) {
    throw new Error("review-mode --input.repo must be a non-empty string");
  }
  // Validate the pull shape the changed-surface classifier and evidence writers dereference, so a
  // malformed dry-run input fails here with an actionable message instead of an opaque downstream error.
  if (!record.pull || typeof record.pull !== "object" || Array.isArray(record.pull)) {
    throw new Error("review-mode --input.pull must be an object");
  }
  const pull = record.pull as Record<string, unknown>;
  if (typeof pull.number !== "number" || !Number.isInteger(pull.number)) {
    throw new Error("review-mode --input.pull.number must be an integer");
  }
  if (typeof pull.title !== "string") {
    throw new Error("review-mode --input.pull.title must be a string");
  }
  if (!Array.isArray(record.files)) throw new Error("review-mode --input.files must be an array");
  record.files.forEach((file, index) => {
    if (!file || typeof file !== "object" || Array.isArray(file) || typeof (file as Record<string, unknown>).filename !== "string") {
      throw new Error(`review-mode --input.files[${index}] must be an object with a string filename`);
    }
  });
  const override = record.repoOverrideMode;
  if (override !== undefined && override !== "light" && override !== "standard" && override !== "deep") {
    throw new Error("review-mode --input.repoOverrideMode must be light, standard, or deep");
  }
  return {
    repo: record.repo,
    pull: record.pull as PullRequestSummary,
    files: record.files as PullFilePatch[],
    ...(override !== undefined ? { repoOverrideMode: override as ReviewMode } : {})
  };
}

function parseReviewLensEvalMode(value?: string | string[]): ReviewLensEvalMode {
  if (value === undefined) return "deterministic";
  const parsed = parseSingleArg(value, "--mode");
  if (parsed === "deterministic" || parsed === "model-shadow") return parsed;
  throw new Error("--mode must be deterministic or model-shadow");
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
  issue?: string | string[];
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
  force?: string;
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
  console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exitCode = 1;
});
