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

export type ReviewSettingsSectionKey =
  | "reviewSummary"
  | "walkthrough"
  | "changedFiles"
  | "effortEstimate"
  | "relatedContext"
  | "suggestedLabels"
  | "suggestedReviewers"
  | "statusComment";

export interface ReviewSettingsPreviewSection {
  key: ReviewSettingsSectionKey;
  label: string;
  enabled: boolean;
  mode: "inline_review" | "issue_comment" | "walkthrough" | "sticky_status" | "suggestion_only";
}

export type ReviewSettingsProfileId = "conservative" | "balanced" | "assertive";

export interface ReviewSettingsProfileMetadata {
  id: ReviewSettingsProfileId;
  label: string;
  description: string;
  repoReviewProfile: NonNullable<RepoProfileConfig["reviewProfile"]>;
  defaultSections: ReviewSettingsSectionKey[];
  suggestionBehavior: "suggestion_only";
}

export interface ReviewSettingsPathInstruction {
  pattern: string;
  instructions: string[];
}

export type UnsupportedReviewSettingStatus = "roadmap_only" | "unsupported";

export interface UnsupportedReviewSettingEvidence {
  key: string;
  label: string;
  status: UnsupportedReviewSettingStatus;
  reason: string;
  safeAlternative: string;
}

export interface ReviewSettingsPreview {
  profile: "chill" | "assertive";
  sampleProfile?: ReviewSettingsProfileMetadata;
  sections: ReviewSettingsPreviewSection[];
  pathInstructions: ReviewSettingsPathInstruction[];
  suggestions: {
    labels: string[];
    reviewers: string[];
    autoApply: false;
  };
  unsupportedSettings?: UnsupportedReviewSettingEvidence[];
  roadmapOnly: string[];
}

export type PullFileFilterReason =
  | "no_profile_filters"
  | "matched_profile_include"
  | "matched_safety_include"
  | "excluded_by_profile"
  | "no_matching_include";

export interface PullFileFilterDecision {
  filename: string;
  included: boolean;
  reason: PullFileFilterReason;
  pattern?: string;
}

export interface PullFileFilterImpact {
  originalCount: number;
  includedCount: number;
  excludedCount: number;
  profileIncludeFilters: string[];
  profileExcludeFilters: string[];
  safetyIncludePatterns: string[];
  included: PullFileFilterDecision[];
  excluded: PullFileFilterDecision[];
}

const SAFETY_INCLUDE_PATTERNS = [
  ".github/**",
  "README.md",
  "AGENTS.md",
  "CHANGELOG.md",
  "SECURITY.md",
  "CODEOWNERS",
  "Dockerfile",
  "Dockerfile.*",
  "docker-compose*.yml",
  "Makefile",
  "justfile",
  "package.json",
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "tsconfig*.json",
  "vite.config.*",
  "vitest.config.*",
  "playwright.config.*",
  "next.config.*",
  "tailwind.config.*",
  "eslint.config.*",
  ".npmrc",
  ".nvmrc",
  ".node-version",
  ".env.example",
  ".gitleaks.toml",
  ".gitattributes",
  ".gitignore",
  "go.mod",
  "go.sum",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "uv.lock",
  "requirements*.txt",
  "poetry.lock",
  "Pipfile",
  "Pipfile.lock",
  "**/*.plist",
  "**/*.entitlements",
  "**/*.entitlements.plist"
];

const REVIEW_SETTINGS_PROFILE_MATRIX: ReviewSettingsProfileMetadata[] = [
  {
    id: "conservative",
    label: "Conservative",
    description: "Minimal, low-noise review posture for early rollout and sensitive repositories.",
    repoReviewProfile: "chill",
    defaultSections: ["reviewSummary", "walkthrough", "changedFiles"],
    suggestionBehavior: "suggestion_only"
  },
  {
    id: "balanced",
    label: "Balanced",
    description: "Default user-facing posture with summaries, walkthrough detail, effort, and related context.",
    repoReviewProfile: "assertive",
    defaultSections: ["reviewSummary", "walkthrough", "changedFiles", "effortEstimate", "relatedContext"],
    suggestionBehavior: "suggestion_only"
  },
  {
    id: "assertive",
    label: "Assertive",
    description: "Higher-signal review posture for release, runtime, and regression-sensitive repositories.",
    repoReviewProfile: "assertive",
    defaultSections: [
      "reviewSummary",
      "walkthrough",
      "changedFiles",
      "effortEstimate",
      "relatedContext",
      "suggestedLabels",
      "suggestedReviewers",
      "statusComment"
    ],
    suggestionBehavior: "suggestion_only"
  }
];

const UNSUPPORTED_REVIEW_SETTINGS_MATRIX: UnsupportedReviewSettingEvidence[] = [
  {
    key: "autoApplyLabels",
    label: "Auto-apply labels",
    status: "roadmap_only",
    reason: "Requires explicit GitHub App permission, repo opt-in, and eval evidence before mutation.",
    safeAlternative: "Emit suggestedLabels as suggestion-only preview evidence."
  },
  {
    key: "autoRequestReviewers",
    label: "Auto-request reviewers",
    status: "roadmap_only",
    reason: "Requires explicit GitHub App permission, repo opt-in, and reviewer-selection eval evidence before mutation.",
    safeAlternative: "Emit suggestedReviewers as suggestion-only preview evidence."
  },
  {
    key: "requiredStatusChecks",
    label: "Required status checks",
    status: "roadmap_only",
    reason: "Review status comments are descriptive; this bot does not create or enforce branch-protection checks.",
    safeAlternative: "Use reviewStatusComment.enabled for sticky descriptive status only."
  },
  {
    key: "autoFixOrApplySuggestions",
    label: "Auto-fix or apply suggestions",
    status: "unsupported",
    reason: "NeonDiff review previews never mutate PR code or apply patches.",
    safeAlternative: "Open a human-reviewed follow-up PR from a separate implementation lane."
  }
];

export function buildReviewSettingsProfileMatrix(): ReviewSettingsProfileMetadata[] {
  return REVIEW_SETTINGS_PROFILE_MATRIX.map(cloneReviewSettingsProfile);
}

export function buildUnsupportedReviewSettingsMatrix(): UnsupportedReviewSettingEvidence[] {
  return UNSUPPORTED_REVIEW_SETTINGS_MATRIX.map((entry) => ({ ...entry }));
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

export function buildReviewSettingsPreview(config: BotConfig, profile: ResolvedRepoProfile): ReviewSettingsPreview {
  const walkthroughEnabled = config.walkthrough.enabled;
  const walkthroughPostsSeparately = config.walkthrough.postIssueComment;
  const walkthroughMode = walkthroughPostsSeparately ? "issue_comment" : "inline_review";
  const labels = profile.suggestedLabels ?? [];
  const reviewers = profile.suggestedReviewers ?? [];
  const unsupportedSettings = buildUnsupportedReviewSettingsMatrix();
  return {
    profile: profile.reviewProfile ?? "assertive",
    sampleProfile: sampleProfileForReviewProfile(profile.reviewProfile ?? "assertive"),
    sections: [
      { key: "reviewSummary", label: "Review summary", enabled: true, mode: "inline_review" },
      { key: "walkthrough", label: "Walkthrough", enabled: walkthroughEnabled, mode: walkthroughMode },
      { key: "changedFiles", label: "Changed-files table", enabled: walkthroughEnabled, mode: "walkthrough" },
      { key: "effortEstimate", label: "Effort estimate", enabled: walkthroughEnabled, mode: "walkthrough" },
      { key: "relatedContext", label: "Related issues/PRs", enabled: walkthroughEnabled, mode: "walkthrough" },
      { key: "suggestedLabels", label: "Suggested labels", enabled: labels.length > 0, mode: "suggestion_only" },
      { key: "suggestedReviewers", label: "Suggested reviewers", enabled: reviewers.length > 0, mode: "suggestion_only" },
      { key: "statusComment", label: "Review status comment", enabled: config.reviewStatusComment?.enabled === true, mode: "sticky_status" }
    ],
    pathInstructions: Object.entries(profile.pathInstructions ?? {}).map(([pattern, instructions]) => ({
      pattern,
      instructions
    })),
    suggestions: {
      labels,
      reviewers,
      autoApply: false
    },
    unsupportedSettings,
    roadmapOnly: unsupportedSettings
      .filter((entry) => entry.status === "roadmap_only")
      .map((entry) => entry.label.toLowerCase())
  };
}

export function filterPullFilesForProfile(files: PullFilePatch[], profile: ResolvedRepoProfile): PullFilePatch[] {
  const impact = buildPullFileFilterImpact(files, profile);
  const included = new Set(impact.included.map((decision) => decision.filename));
  return files.filter((file) => included.has(file.filename));
}

export function buildPullFileFilterImpact(
  files: PullFilePatch[],
  profile: ResolvedRepoProfile
): PullFileFilterImpact {
  const filters = profile.pathFilters?.filter(Boolean) ?? [];
  const includeFilters = filters.filter((pattern) => !pattern.startsWith("!"));
  const excludeFilters = filters.filter((pattern) => pattern.startsWith("!")).map((pattern) => pattern.slice(1));
  const decisions = files.map((file) => decideFileFilter(file.filename, includeFilters, excludeFilters));
  const included = decisions.filter((decision) => decision.included);
  const excluded = decisions.filter((decision) => !decision.included);
  return {
    originalCount: files.length,
    includedCount: included.length,
    excludedCount: excluded.length,
    profileIncludeFilters: includeFilters,
    profileExcludeFilters: excludeFilters,
    safetyIncludePatterns: SAFETY_INCLUDE_PATTERNS,
    included,
    excluded
  };
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

function sampleProfileForReviewProfile(reviewProfile: NonNullable<RepoProfileConfig["reviewProfile"]>): ReviewSettingsProfileMetadata {
  const id: ReviewSettingsProfileId = reviewProfile === "chill" ? "conservative" : "assertive";
  const profile = REVIEW_SETTINGS_PROFILE_MATRIX.find((candidate) => candidate.id === id);
  if (!profile) throw new Error(`Missing review settings profile metadata for ${id}`);
  return cloneReviewSettingsProfile(profile);
}

function cloneReviewSettingsProfile(profile: ReviewSettingsProfileMetadata): ReviewSettingsProfileMetadata {
  return {
    ...profile,
    defaultSections: [...profile.defaultSections]
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

function decideFileFilter(
  filename: string,
  includeFilters: string[],
  excludeFilters: string[]
): PullFileFilterDecision {
  const excludePattern = excludeFilters.find((pattern) => matchesGlob(filename, pattern));
  if (excludePattern) {
    return {
      filename,
      included: false,
      reason: "excluded_by_profile",
      pattern: excludePattern
    };
  }

  if (includeFilters.length === 0) {
    return {
      filename,
      included: true,
      reason: "no_profile_filters"
    };
  }

  const includePattern = includeFilters.find((pattern) => matchesGlob(filename, pattern));
  if (includePattern) {
    return {
      filename,
      included: true,
      reason: "matched_profile_include",
      pattern: includePattern
    };
  }

  const safetyPattern = SAFETY_INCLUDE_PATTERNS.find((pattern) => matchesGlob(filename, pattern));
  if (safetyPattern) {
    return {
      filename,
      included: true,
      reason: "matched_safety_include",
      pattern: safetyPattern
    };
  }

  return {
    filename,
    included: false,
    reason: "no_matching_include"
  };
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
