import { accessSync, constants, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import type { BotConfig } from "./config.js";
import type { CodexReasoningEffort } from "./codex-runtime.js";
import { callLicenseApi } from "./license.js";
import { resolveProductionLicensePolicy } from "./license-production-policy.js";
import { readProductionFileLicenseSecret } from "./license-secret-store.js";

// CI-only metadata: only buildCiConfig can set it; never loaded from user config.
const ciMachineIds = new WeakMap<BotConfig, string | undefined>();

export function ciLicenseMachineId(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const ownerId = env.GITHUB_REPOSITORY_OWNER_ID;
  if (!ownerId || ownerId.trim() !== ownerId || !/^[1-9][0-9]*$/.test(ownerId)) return undefined;
  return createHash("sha256").update("neondiff-ci:owner:" + ownerId).digest("base64url");
}

/**
 * Called once at scoped admission, before checkout, providers, or review posting.
 * Activation is owner-scoped: it omits `repo`, since the license API binds an
 * activation to the first repository it names and would refuse every later
 * repository under the same owner.
 */
export async function activateCiLicenseForReview(
  config: BotConfig, visibility: "public" | "private" | "unknown", fetchImpl?: typeof fetch
): Promise<string | undefined> {
  if (!ciMachineIds.has(config) || visibility === "public") return undefined;
  const license = resolveProductionLicensePolicy(config.license!);
  const missingKey = "license missing: set NEONDIFF_LICENSE_KEY_FILE to a runner-owned 0600 license key file for private repository reviews";
  if (!license.keyPath) throw new Error(missingKey);
  const machineId = ciMachineIds.get(config);
  if (!machineId) throw new Error("CI license activation requires a positive integer GITHUB_REPOSITORY_OWNER_ID");
  const licenseKey = readProductionFileLicenseSecret(license.keyPath);
  if (!licenseKey) throw new Error(missingKey);
  const activated = await callLicenseApi({ config: license, path: "/v1/license/activate", licenseKey, machineId, fetchImpl });
  if (!activated.ok) {
    if (activated.status === "scope_mismatch") {
      throw new Error("this license is active for a different GitHub organization or account; deactivate it there or use another license");
    }
    throw new Error(`license ${activated.status}: ${activated.detail}`);
  }
  return machineId;
}

export interface CiPullContext {
  repo: string;
  pullNumber: number;
  headSha?: string;
  eventName: string;
}

export function readCiPullContext(env: NodeJS.ProcessEnv = process.env): CiPullContext {
  if (env.GITHUB_ACTIONS !== "true") throw new Error("--ci requires GitHub Actions");
  const repo = env.GITHUB_REPOSITORY;
  if (!repo || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) throw new Error("GITHUB_REPOSITORY must be owner/name");
  if (!env.GITHUB_EVENT_PATH) throw new Error("GITHUB_EVENT_PATH is required");
  let event;
  try { event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8")); }
  catch { throw new Error("GITHUB_EVENT_PATH must contain readable event JSON"); }
  const pull = event?.pull_request;
  const pullNumber = pull?.number ?? (event?.issue?.pull_request ? event.issue.number : undefined);
  if (!Number.isSafeInteger(pullNumber) || pullNumber <= 0) throw new Error("event has no valid pull request number");
  const headSha = pull?.head?.sha;
  if (pull && (typeof headSha !== "string" || !/^[a-f0-9]{40}$/i.test(headSha))) throw new Error("event pull request head SHA is invalid");
  return { repo, pullNumber, headSha, eventName: env.GITHUB_EVENT_NAME ?? "" };
}

export function buildCiConfig(base: BotConfig, ctx: CiPullContext, env: NodeJS.ProcessEnv = process.env): BotConfig {
  const effort = env.NEONDIFF_REASONING_EFFORT ?? "high";
  if (!["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("NEONDIFF_REASONING_EFFORT must be a valid Codex reasoning effort");
  const cliPath = (env.PATH ?? "").split(delimiter).map((dir) => resolve(dir, "codex")).find((path) => {
    try { accessSync(path, constants.X_OK); return true; } catch { return false; }
  });
  if (!cliPath) throw new Error("--ci requires codex on PATH");
  const root = join(env.RUNNER_TEMP || tmpdir(), "neondiff-ci");
  const config: BotConfig = {
    ...base,
    pilotRepos: [ctx.repo],
    statePath: join(root, "state", "reviews.sqlite"),
    evidenceDir: join(root, "evidence"),
    workRoot: join(root, "work"),
    commands: { ...base.commands, enabled: false },
    github: { ...base.github, botLogin: "github-actions[bot]" },
    license: {
      ...base.license!, storageBackend: "file", keyPath: env.NEONDIFF_LICENSE_KEY_FILE || undefined,
      cachePath: join(root, "license", "cache.json")
    },
    codexRuntime: { ...base.codexRuntime!, enabled: true, cliPath, model: env.NEONDIFF_MODEL || "gpt-6.1-sol", reasoningEffort: effort as CodexReasoningEffort }
  };
  ciMachineIds.set(config, ciLicenseMachineId(env));
  return config;
}
