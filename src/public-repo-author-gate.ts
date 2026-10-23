import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildCodexRuntimeEnv } from "./codex-runtime.js";
import type { PublicRepoAuthorGateConfig } from "./config.js";
import { DEFAULT_PUBLIC_REPO_AUTHOR_GATE } from "./public-repo-author-gate-defaults.js";
import type { PullRequestSummary } from "./types.js";

export type RepositoryVisibility = "public" | "private" | "unknown";
/** The author identity the gate decides on; a pull summary and a mapped issue or comment both fit. */
export interface GateAuthorIdentity { authorAssociation?: string | null; authorLogin?: string | null }
/** The config the gate reads; BotConfig fits, and so does the issue-enrichment config subset. */
export interface PublicRepoAuthorGateSettings {
  reviewGate?: { publicRepoAuthorGate?: PublicRepoAuthorGateConfig };
  codexRuntime?: { enabled: boolean };
}

export function visibilityFromRepositoryFlags(
  repo: { private?: boolean | null; visibility?: string | null } | undefined
): RepositoryVisibility {
  if (repo?.private === true || repo?.visibility === "private" || repo?.visibility === "internal") return "private";
  if (repo?.visibility === "public" || repo?.private === false) return "public";
  return "unknown";
}

// Shared with license admission: use the GitHub base repository, never fork visibility.
export function visibilityFromPullSummary(pull: PullRequestSummary): RepositoryVisibility {
  return visibilityFromRepositoryFlags(pull.base.repo);
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

export function matchesTrustedAuthor(config: PublicRepoAuthorGateSettings, author: GateAuthorIdentity): boolean {
  const gate = config.reviewGate?.publicRepoAuthorGate ?? DEFAULT_PUBLIC_REPO_AUTHOR_GATE;
  return Boolean((author.authorAssociation && gate.allowedAssociations.includes(author.authorAssociation)) ||
    (author.authorLogin && gate.allowedLogins.some(login => login.toLowerCase() === author.authorLogin!.toLowerCase())));
}

export function isPublicRepoAuthorGateEnabled(config: PublicRepoAuthorGateSettings): boolean {
  const gate = config.reviewGate?.publicRepoAuthorGate ?? DEFAULT_PUBLIC_REPO_AUTHOR_GATE;
  return gate.mode === "on" ||
    (gate.mode === "auto" && config.codexRuntime?.enabled === true && !codexChildUsesApiKeyOnly());
}

/** The one gate predicate for pull and issue authors: only a known-private repository is exempt. */
export function isAuthorBlockedOnPublicRepo(
  config: PublicRepoAuthorGateSettings, author: GateAuthorIdentity, visibility: RepositoryVisibility,
  enabled = isPublicRepoAuthorGateEnabled(config)
): boolean {
  if (!enabled || visibility === "private") return false;
  return !matchesTrustedAuthor(config, author);
}

export function isUntrustedPublicAuthor(
  config: PublicRepoAuthorGateSettings, pull: PullRequestSummary, visibility = visibilityFromPullSummary(pull)
): boolean {
  // Like the author gate, only a known-private repository is exempt; unknown visibility is restricted.
  return visibility !== "private" && !matchesTrustedAuthor(config, pull);
}

export function isPublicRepoAuthorBlocked(
  config: PublicRepoAuthorGateSettings, pull: PullRequestSummary, visibility = visibilityFromPullSummary(pull)
): boolean {
  return isAuthorBlockedOnPublicRepo(config, pull, visibility);
}
