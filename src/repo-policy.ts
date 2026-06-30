import type { BotConfig, RepoProfileConfig } from "./config.js";
import type { PullFilePatch } from "./types.js";

export type RepoProfileSource = "default" | "explicit" | "org_fallback";
export type RepoProfileSkipReason = "repo_profile_disabled" | "repo_profile_missing";

export interface ResolvedRepoProfile extends RepoProfileConfig {
  repo: string;
  canonicalRepo: string;
  source: RepoProfileSource;
}

export type RepoProfileResolution =
  | { allowed: true; profile: ResolvedRepoProfile }
  | { allowed: false; reason: RepoProfileSkipReason };

export interface RepoPolicySnapshot {
  repo: string;
  canonicalRepo: string;
  allowed: boolean;
  source?: RepoProfileSource;
  displayName?: string;
  reviewProfile?: "chill" | "assertive";
  pathFilters?: string[];
  autoReview?: RepoProfileConfig["autoReview"];
  preMergeChecks?: RepoProfileConfig["preMergeChecks"];
  finishingTouches?: RepoProfileConfig["finishingTouches"];
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
  skippedByPolicy?: RepoProfileSkipReason;
}

export function listReposToScan(config: BotConfig): string[] {
  const configured = uniqueRepos(config.pilotRepos);
  if (configured.length > 0) return configured;

  const explicitRepos = Object.entries(config.repoProfiles?.repos ?? {})
    .filter(([, profile]) => profile.enabled !== false)
    .map(([repo]) => repo);
  return uniqueRepos(explicitRepos);
}

export function resolveRepoProfile(config: BotConfig, repo: string): RepoProfileResolution {
  const registry = config.repoProfiles;
  if (!hasProfileRegistry(registry)) {
    return {
      allowed: true,
      profile: normalizeProfile(repo, "default", {})
    };
  }

  const explicit = findProfileByRepo(registry?.repos, repo);
  if (explicit) {
    const [, profile] = explicit;
    const explicitRepo = explicit[0];
    if (profile.enabled === false) return { allowed: false, reason: "repo_profile_disabled" };
    return {
      allowed: true,
      profile: normalizeProfile(explicitRepo, "explicit", profile)
    };
  }

  const org = repo.split("/")[0];
  const fallback = org ? findProfileByOwner(registry?.orgFallbacks, org) : undefined;
  if (fallback && fallback[1].enabled === false) return { allowed: false, reason: "repo_profile_disabled" };
  if (registry?.enableOrgFallbacks && fallback) {
    return {
      allowed: true,
      profile: normalizeProfile(repo, "org_fallback", fallback[1])
    };
  }

  return { allowed: false, reason: "repo_profile_missing" };
}

export function buildRepoPolicySnapshot(config: BotConfig, repo: string): RepoPolicySnapshot {
  const resolution = resolveRepoProfile(config, repo);
  if (!resolution.allowed) {
    return {
      repo,
      canonicalRepo: canonicalRepoName(repo),
      allowed: false,
      skippedByPolicy: resolution.reason
    };
  }

  const profile = resolution.profile;
  return {
    repo,
    canonicalRepo: profile.canonicalRepo,
    allowed: true,
    source: profile.source,
    displayName: profile.displayName,
    reviewProfile: profile.reviewProfile,
    pathFilters: profile.pathFilters,
    autoReview: profile.autoReview,
    preMergeChecks: profile.preMergeChecks,
    finishingTouches: profile.finishingTouches,
    suggestedLabels: profile.suggestedLabels,
    suggestedReviewers: profile.suggestedReviewers
  };
}

export function filterPullFilesForProfile(files: PullFilePatch[], profile: ResolvedRepoProfile): PullFilePatch[] {
  const filters = profile.pathFilters?.filter(Boolean) ?? [];
  if (filters.length === 0) return files;

  const includeFilters = filters.filter((pattern) => !pattern.startsWith("!"));
  const excludeFilters = filters.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));

  return files.filter((file) => {
    const included = includeFilters.length === 0 || includeFilters.some((pattern) => matchesGlob(file.filename, pattern));
    const excluded = excludeFilters.some((pattern) => matchesGlob(file.filename, pattern));
    return included && !excluded;
  });
}

export function buildRepoProfilePromptSection(profile: ResolvedRepoProfile): string {
  const lines = [
    "Repository profile guidance:",
    `- Repo: ${profile.repo}`,
    `- Source: ${profile.source}`,
    `- Display name: ${profile.displayName ?? profile.repo}`,
    `- Review profile: ${profile.reviewProfile ?? "assertive"}`
  ];

  if (profile.defaultBranch) lines.push(`- Default branch: ${profile.defaultBranch}`);
  if (profile.promptNote) lines.push(`- Repo-specific instruction: ${profile.promptNote}`);
  pushAutoReview(lines, profile.autoReview);
  pushList(lines, "Path filters", profile.pathFilters);
  pushPathInstructions(lines, profile.pathInstructions);
  pushList(lines, "High-risk paths", profile.riskyPaths);
  pushList(lines, "Proof expectations", profile.proofExpectations);
  pushList(lines, "Validation hints", profile.validationHints);
  pushList(lines, "Readiness hints", profile.readinessHints);
  pushPreMergeChecks(lines, profile.preMergeChecks);
  pushFinishingTouches(lines, profile.finishingTouches);
  pushList(lines, "Allowed label suggestions", profile.suggestedLabels);
  pushList(lines, "Allowed reviewer suggestions", profile.suggestedReviewers);

  return lines.join("\n");
}

function normalizeProfile(
  repo: string,
  source: RepoProfileSource,
  profile: RepoProfileConfig
): ResolvedRepoProfile {
  return {
    ...profile,
    repo,
    canonicalRepo: canonicalRepoName(repo),
    source,
    reviewProfile: profile.reviewProfile ?? "assertive"
  };
}

function findProfileByRepo(
  profiles: Record<string, RepoProfileConfig> | undefined,
  repo: string
): [string, RepoProfileConfig] | undefined {
  if (!profiles) return undefined;
  const target = canonicalRepoName(repo);
  return Object.entries(profiles).find(([candidate]) => canonicalRepoName(candidate) === target);
}

function findProfileByOwner(
  profiles: Record<string, RepoProfileConfig> | undefined,
  owner: string
): [string, RepoProfileConfig] | undefined {
  if (!profiles) return undefined;
  const target = owner.toLowerCase();
  return Object.entries(profiles).find(([candidate]) => candidate.toLowerCase() === target);
}

function hasProfileRegistry(registry: BotConfig["repoProfiles"]): boolean {
  return Boolean(
    registry &&
      ((registry.repos && Object.keys(registry.repos).length > 0) ||
        (registry.orgFallbacks && Object.keys(registry.orgFallbacks).length > 0))
  );
}

function pushList(lines: string[], label: string, values: string[] | undefined): void {
  if (!values || values.length === 0) return;
  lines.push(`- ${label}: ${values.join("; ")}`);
}

function pushAutoReview(lines: string[], autoReview: ResolvedRepoProfile["autoReview"]): void {
  if (!autoReview) return;
  pushList(lines, "Auto-review base branches", autoReview.baseBranches);
  pushList(lines, "Auto-review label filters", autoReview.labels);
}

function pushPathInstructions(lines: string[], pathInstructions: ResolvedRepoProfile["pathInstructions"]): void {
  if (!pathInstructions || Object.keys(pathInstructions).length === 0) return;
  lines.push("- Path-specific instructions:");
  for (const [pattern, instructions] of Object.entries(pathInstructions)) {
    lines.push(`  - ${pattern}: ${instructions.join("; ")}`);
  }
}

function pushPreMergeChecks(lines: string[], checks: ResolvedRepoProfile["preMergeChecks"]): void {
  if (!checks) return;
  const entries = Object.entries(checks).filter(([, check]) => check !== undefined);
  if (entries.length === 0) return;
  lines.push("- Pre-merge checks (advisory; do not invent CI status):");
  for (const [name, check] of entries) {
    if (!check) continue;
    const details = [`mode=${check.mode}`];
    if (check.threshold !== undefined) details.push(`threshold=${check.threshold}`);
    if (check.instructions) details.push(check.instructions);
    lines.push(`  - ${name}: ${details.join("; ")}`);
  }
}

function pushFinishingTouches(lines: string[], touches: ResolvedRepoProfile["finishingTouches"]): void {
  if (!touches) return;
  const entries = Object.entries(touches).filter(([, touch]) => touch !== undefined);
  if (entries.length === 0) return;
  lines.push("- Finishing-touch commands (declarations only; do not execute or offer as active unless enabled):");
  for (const [name, touch] of entries) {
    if (!touch) continue;
    const details = [`enabled=${touch.enabled}`];
    if (touch.instructions) details.push(touch.instructions);
    lines.push(`  - ${name}: ${details.join("; ")}`);
  }
}

function uniqueRepos(values: string[]): string[] {
  const seen = new Set<string>();
  const output: string[] = [];
  for (const value of values.filter(Boolean)) {
    const canonical = canonicalRepoName(value);
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    output.push(value);
  }
  return output;
}

function canonicalRepoName(repo: string): string {
  const [owner, name] = repo.split("/");
  return `${owner?.toLowerCase() ?? ""}/${name?.toLowerCase() ?? ""}`;
}

function matchesGlob(path: string, pattern: string): boolean {
  const normalizedPath = path.replace(/^\/+/, "");
  const normalizedPattern = pattern.replace(/^\/+/, "");
  return globToRegExp(normalizedPattern).test(normalizedPath);
}

function globToRegExp(pattern: string): RegExp {
  const placeholder = "\0DOUBLE_STAR\0";
  const escaped = pattern
    .replaceAll("**", placeholder)
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
    .replaceAll("*", "[^/]*")
    .replaceAll(placeholder, ".*");
  return new RegExp(`^${escaped}$`);
}
