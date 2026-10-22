import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCodexRuntimeEnv } from "./codex-runtime.js";
import { DEFAULT_PUBLIC_REPO_AUTHOR_GATE, type BotConfig } from "./config.js";
import type { PullRequestSummary } from "./types.js";

// Shared with license admission: use the GitHub base repository, never fork visibility.
export function visibilityFromPullSummary(pull: PullRequestSummary): "public" | "private" | "unknown" {
  const repo = pull.base.repo;
  if (repo.private === true || repo.visibility === "private" || repo.visibility === "internal") return "private";
  if (repo.visibility === "public" || repo.private === false) return "public";
  return "unknown";
}

// API-key auth only counts when the key reaches the Codex child and no ChatGPT login file sits
// where the read-only sandbox can still read it.
export function codexChildUsesApiKeyOnly(
  child: NodeJS.ProcessEnv = buildCodexRuntimeEnv(process.env),
  fileExists: (path: string) => boolean = existsSync
): boolean {
  if (!child.CODEX_API_KEY && !child.OPENAI_API_KEY) return false;
  return !fileExists(join(child.CODEX_HOME || join(homedir(), ".codex"), "auth.json"));
}

function matchesTrustedAuthor(config: BotConfig, pull: PullRequestSummary): boolean {
  const gate = config.reviewGate?.publicRepoAuthorGate ?? DEFAULT_PUBLIC_REPO_AUTHOR_GATE;
  return Boolean((pull.authorAssociation && gate.allowedAssociations.includes(pull.authorAssociation)) ||
    (pull.authorLogin && gate.allowedLogins.some(login => login.toLowerCase() === pull.authorLogin!.toLowerCase())));
}

export function isUntrustedPublicAuthor(
  config: BotConfig, pull: PullRequestSummary, visibility = visibilityFromPullSummary(pull)
): boolean {
  return visibility === "public" && !matchesTrustedAuthor(config, pull);
}

export function isPublicRepoAuthorBlocked(
  config: BotConfig, pull: PullRequestSummary, visibility = visibilityFromPullSummary(pull)
): boolean {
  const gate = config.reviewGate?.publicRepoAuthorGate ?? DEFAULT_PUBLIC_REPO_AUTHOR_GATE;
  const enabled = gate.mode === "on" ||
    (gate.mode === "auto" && config.codexRuntime?.enabled === true && !codexChildUsesApiKeyOnly());
  if (!enabled || visibility === "private") return false;
  return !matchesTrustedAuthor(config, pull);
}
