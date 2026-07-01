import { loadConfig } from "./config.js";
import { collectCoverageAudit, CoverageStateReader } from "./coverage-audit.js";
import { runDaemonCycle } from "./daemon.js";
import { GitHubApi } from "./github.js";
import { collectReleaseStatus } from "./release-status.js";
import { buildRepoPolicySnapshot, listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { ReviewStateStore } from "./state.js";
import { isSuccessfulRetryStatus, retryFailedHead, retryProviderCooldowns, runOnce } from "./worker.js";
import { resolveZCodeProviderEnv } from "./zcode-env.js";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0];

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
        configPath: args.config
      });
      await new Promise((resolve) => setTimeout(resolve, config.pollIntervalMs));
    }
  }

  throw new Error(`Unknown command: ${command ?? "(missing)"}`);
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
  limit?: string;
  zcode?: string;
  [key: string]: string | string[] | undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
