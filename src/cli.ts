#!/usr/bin/env node
import { loadConfig } from "./config.js";
import { collectCoverageAudit, CoverageStateReader } from "./coverage-audit.js";
import { runDaemonCycle } from "./daemon.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, parse as parsePath, resolve, sep } from "node:path";
import { REQUIRED_SUITES, runOfflineEval } from "./eval-harness.js";
import { buildEnrichmentComment } from "./enrichment.js";
import { GitHubApi } from "./github.js";
import { buildGitNexusContextPacket } from "./gitnexus-context.js";
import { buildGitHubRelatedContextPacket } from "./github-related-context.js";
import {
  buildOperatorDashboard,
  buildRuntimeInventory,
  buildOperatorQueue,
  buildOperatorStatus,
  collectBotProcessInventory,
  collectOperatorLeases,
  collectOperatorProviderCooldowns,
  collectOperatorRepoProviderCooldowns,
  collectOperatorReviewReadiness,
  collectOperatorReviewQueue,
  explainPullStatus,
  formatOperatorDashboardHuman,
  formatRuntimeInventoryHuman,
  summarizeAgentInventory
} from "./operator-cli.js";
import { collectReleaseStatus, type ReleaseStatus } from "./release-status.js";
import { buildRepoMemoryPacket, readRepoMemoryMarkdown } from "./repo-memory.js";
import { buildRepoPolicySnapshot, listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { redactSecrets } from "./secrets.js";
import { buildSkillPackContextPacket } from "./skill-packs.js";
import { listRepoMemoryNotesReadOnly, ReviewStateStore, type ReviewQueueJobState } from "./state.js";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "./validation-selector.js";
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
      repoMemory: config.repoMemory,
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
      launchdLabel: args["launchd-label"],
      statePath: args["state-path"],
      budgetDetails: args["budget-details"] === "true",
      ...(budgetDetailLimit !== undefined ? { budgetDetailLimit } : {}),
      ...(budgetJobLimit !== undefined ? { budgetJobLimit } : {})
    });
    console.log(JSON.stringify(status, null, 2));
    if (!status.ok) process.exitCode = 1;
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
    const ok = status.budget?.enabled === true && status.budget.details.inputJobsTruncated !== true;
    console.log(JSON.stringify({
      ok,
      checkedAt: status.checkedAt,
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
    const durableQueue = collectOperatorReviewQueue(args["state-path"] ?? config.statePath, {
      repo: args.repo,
      state: parseReviewQueueJobState(args.state),
      limit: args.limit ? parsePositiveInteger(args.limit, "--limit") : undefined
    });
    const output = { ...queue, ok: queue.ok, coverage: queue, durableQueue, ...collectQueueBudget(args) };
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
    if (!args.pr) throw new Error("--pr is required for build-enrichment-comment");
    const repo = parseSingleArg(args.repo, "--repo");
    const pullNumber = parsePositiveInteger(parseSingleArg(args.pr, "--pr"), "--pr");
    const config = loadConfig(args.config);
    const github = new GitHubApi(config.github);
    const pull = await github.getPull(repo, pullNumber);
    const files = await github.listPullFiles(repo, pullNumber);
    const repoPolicy = resolveRepoProfile(config, repo);
    if (!repoPolicy.allowed) throw new Error(`Repo ${repo} is skipped by policy: ${repoPolicy.reason}`);
    const validation = buildChangedSurfaceValidationReport({
      repo,
      pull,
      files,
      profile: repoPolicy.profile
    });
    const proof = evaluateProofRequirements({ pull, validation });
    const enrichmentConfig = config.enrichment!;
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

function collectQueueBudget(args: ParsedArgs): {
  budget?: ReleaseStatus["budget"];
  budgetError?: string;
} {
  try {
    return {
      budget: collectReleaseStatus({
        cwd: process.cwd(),
        configPath: args.config,
        expectedHead: args["expected-head"],
        launchdLabel: args["launchd-label"],
        statePath: args["state-path"]
      }).budget
    };
  } catch (error) {
    return {
      budgetError: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }
}

function buildHelp() {
  return {
    ok: true,
    commands: {
      operator: [
        "status",
        "runtime-inventory",
        "agents",
        "queue",
        "dashboard",
        "budget-status",
        "coverage",
        "cooldowns",
        "why"
      ],
      existing: [
        "doctor",
        "release-status",
        "coverage-audit",
        "build-memory-packet",
        "build-gitnexus-context-packet",
        "build-github-related-context-packet",
        "build-skill-pack",
        "build-enrichment-comment",
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
      "npx tsx src/cli.ts runtime-inventory --config /path/to/live.json --launchd-label com.electricsheephq.evaos-code-review-bot",
      "npx tsx src/cli.ts runtime-inventory --config /path/to/live.json --human",
      "npx tsx src/cli.ts agents --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json",
      "npx tsx src/cli.ts queue --config /path/to/live.json --state provider_deferred",
      "npx tsx src/cli.ts dashboard --config /path/to/live.json --status blocked_on_proof",
      "npx tsx src/cli.ts dashboard --config /path/to/live.json --human",
      "npx tsx src/cli.ts budget-status --config /path/to/live.json",
      "npx tsx src/cli.ts why --config /path/to/live.json --repo owner/repo --pr 123",
      "npx tsx src/cli.ts build-memory-packet --config /path/to/live.json --repo owner/repo --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-gitnexus-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-github-related-context-packet --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-skill-pack --config /path/to/live.json --output-dir /path/to/evidence",
      "npx tsx src/cli.ts build-enrichment-comment --config /path/to/live.json --repo owner/repo --pr 123 --output-dir /path/to/evidence",
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

function parseNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
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
