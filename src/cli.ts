import { loadConfig } from "./config.js";
import { formatDaemonLog } from "./daemon-log.js";
import { GitHubApi } from "./github.js";
import { collectReleaseStatus } from "./release-status.js";
import { listReposToScan, resolveRepoProfile } from "./repo-policy.js";
import { runOnce } from "./worker.js";
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
      if (!repoPolicy.allowed) {
        readChecks.push({ repo, ok: true, skippedByPolicy: repoPolicy.reason });
        continue;
      }
      try {
        await github.listOpenPulls(repo);
        readChecks.push({ repo, ok: true });
      } catch (error) {
        readChecks.push({
          repo,
          ok: false,
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

  if (command === "daemon") {
    const config = loadConfig(args.config);
    const monitoredRepos = listReposToScan(config);
    let cycle = 0;
    for (;;) {
      cycle += 1;
      const dryRun = args["dry-run"] !== "false";
      console.log(formatDaemonLog({
        event: "daemon_cycle_start",
        cycle,
        dryRun,
        pilotRepos: config.pilotRepos,
        monitoredRepos,
        canaryPulls: config.canaryPulls ?? []
      }));
      try {
        const result = await runOnce({ configPath: args.config, dryRun });
        console.log(formatDaemonLog({
          event: "daemon_cycle_complete",
          cycle,
          dryRun,
          result
        }));
      } catch (error) {
        console.error(formatDaemonLog({
          event: "daemon_cycle_failed",
          level: "error",
          cycle,
          dryRun,
          error: error instanceof Error ? error.message : String(error)
        }));
        throw error;
      }
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

interface ParsedArgs {
  _: string[];
  config?: string;
  repo?: string;
  pr?: string;
  "expected-head"?: string;
  "launchd-label"?: string;
  "state-path"?: string;
  "dry-run"?: string;
  zcode?: string;
  [key: string]: string | string[] | undefined;
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
