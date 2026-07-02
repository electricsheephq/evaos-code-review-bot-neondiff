import type { BotConfig } from "./config.js";
import type { PullRequestSummary } from "./types.js";

export interface RepoActivationLookup {
  getRepoActivation?(repo: string): { activatedAt: string } | undefined;
}

export function isPreActivationExistingPull(input: {
  config: Pick<BotConfig, "activation">;
  state: RepoActivationLookup;
  repo: string;
  pull: PullRequestSummary;
}): boolean {
  if (input.config.activation.reviewExistingOpenPrsOnActivation) return false;
  const activation = input.state.getRepoActivation?.(input.repo);
  if (!activation || !input.pull.created_at) return false;
  const activatedAtMs = Date.parse(activation.activatedAt);
  const pullCreatedAtMs = Date.parse(input.pull.created_at);
  if (!Number.isFinite(activatedAtMs) || !Number.isFinite(pullCreatedAtMs)) return false;
  return pullCreatedAtMs <= activatedAtMs;
}
