import { DEFAULT_PUBLIC_REPO_AUTHOR_GATE, type BotConfig } from "./config.js";
import type { PullRequestSummary } from "./types.js";

// Shared with license admission: use the GitHub base repository, never fork visibility.
export function visibilityFromPullSummary(pull: PullRequestSummary): "public" | "private" | "unknown" {
  const repo = pull.base.repo;
  if (repo.private === true || repo.visibility === "private" || repo.visibility === "internal") return "private";
  if (repo.visibility === "public" || repo.private === false) return "public";
  return "unknown";
}

export function isPublicRepoAuthorBlocked(
  config: BotConfig, pull: PullRequestSummary, visibility = visibilityFromPullSummary(pull)
): boolean {
  const gate = config.reviewGate?.publicRepoAuthorGate ?? DEFAULT_PUBLIC_REPO_AUTHOR_GATE;
  const enabled = gate.mode === "on" || (gate.mode === "auto" && config.codexRuntime?.enabled === true &&
    !process.env.CODEX_API_KEY && !process.env.OPENAI_API_KEY);
  if (!enabled || visibility === "private") return false;
  return !(pull.authorAssociation && gate.allowedAssociations.includes(pull.authorAssociation)) &&
    !(pull.authorLogin && gate.allowedLogins.some((login) => login.toLowerCase() === pull.authorLogin!.toLowerCase()));
}
