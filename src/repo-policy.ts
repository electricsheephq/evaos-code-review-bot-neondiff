import type { BotConfig, RepoProfileConfig } from "./config.js";
import type { PullFilePatch } from "./types.js";

export type RepoProfileSource = "default" | "explicit" | "org_fallback";
export type RepoProfileSkipReason = "repo_profile_disabled" | "repo_profile_missing";

export interface ResolvedRepoProfile extends RepoProfileConfig {
  repo: string;
  source: RepoProfileSource;
}

export type RepoProfileResolution =
  | { allowed: true; profile: ResolvedRepoProfile }
  | { allowed: false; reason: RepoProfileSkipReason };

export function listReposToScan(config: BotConfig): string[] {
  const configured = unique(config.pilotRepos);
  if (configured.length > 0) return configured;

  const explicitRepos = Object.entries(config.repoProfiles?.repos ?? {})
    .filter(([, profile]) => profile.enabled !== false)
    .map(([repo]) => repo);
  return unique(explicitRepos);
}

export function resolveRepoProfile(config: BotConfig, repo: string): RepoProfileResolution {
  const registry = config.repoProfiles;
  if (!hasProfileRegistry(registry)) {
    return {
      allowed: true,
      profile: normalizeProfile(repo, "default", {})
    };
  }

  const explicit = registry?.repos?.[repo];
  if (explicit) {
    if (explicit.enabled === false) return { allowed: false, reason: "repo_profile_disabled" };
    return {
      allowed: true,
      profile: normalizeProfile(repo, "explicit", explicit)
    };
  }

  const org = repo.split("/")[0];
  const fallback = org ? registry?.orgFallbacks?.[org] : undefined;
  if (fallback && fallback.enabled === false) return { allowed: false, reason: "repo_profile_disabled" };
  if (registry?.enableOrgFallbacks && fallback) {
    return {
      allowed: true,
      profile: normalizeProfile(repo, "org_fallback", fallback)
    };
  }

  return { allowed: false, reason: "repo_profile_missing" };
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
  pushList(lines, "Path filters", profile.pathFilters);
  pushList(lines, "High-risk paths", profile.riskyPaths);
  pushList(lines, "Proof expectations", profile.proofExpectations);
  pushList(lines, "Validation hints", profile.validationHints);
  pushList(lines, "Readiness hints", profile.readinessHints);

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
    source,
    reviewProfile: profile.reviewProfile ?? "assertive"
  };
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

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
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
