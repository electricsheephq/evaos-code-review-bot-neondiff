import { existsSync, readFileSync } from "node:fs";
import type { EnrichmentConfig } from "./enrichment.js";
import type { GitNexusContextConfig } from "./gitnexus-context.js";
import type { GitHubRelatedContextConfig } from "./github-related-context.js";
import { DEFAULT_ISSUE_ENRICHMENT_CONFIG, type IssueEnrichmentConfig } from "./issue-enrichment.js";
import type { SkillPackContextConfig } from "./skill-packs.js";

export interface BotConfig {
  pilotRepos: string[];
  pollIntervalMs: number;
  skipDrafts: boolean;
  workRoot: string;
  statePath: string;
  evidenceDir: string;
  canaryPulls?: string[];
  activation: {
    reviewExistingOpenPrsOnActivation: boolean;
  };
  reviewConcurrency: {
    maxActiveRuns: number;
    leaseTtlMs: number;
  };
  reviewerSessions?: {
    enabled: boolean;
    ttlMs: number;
    headCountLimit: number;
  };
  reviewScheduler?: ReviewSchedulerConfig;
  providerCooldown: {
    enabled: boolean;
    durationMs: number;
    requestRateLimitDurationMs: number;
    overloadDurationMs: number;
    quotaDurationMs: number;
    transientRetryAttempts: number;
    transientRetryBaseDelayMs: number;
    transientRetryMaxDelayMs: number;
  };
  walkthrough: {
    enabled: boolean;
    postIssueComment: boolean;
  };
  reviewStatusComment?: {
    enabled: boolean;
  };
  repoMemory?: RepoMemoryConfig;
  gitnexusContext?: GitNexusContextConfig;
  githubRelatedContext?: GitHubRelatedContextConfig;
  skillPacks?: SkillPackContextConfig;
  enrichment?: EnrichmentConfig;
  issueEnrichment?: IssueEnrichmentConfig;
  repoProfiles?: RepoProfilesConfig;
  commands: CommandConfig;
  zcode: {
    cliPath: string;
    appConfigPath: string;
    model: string;
    providerId?: string;
    timeoutMs: number;
    maxPatchBytes: number;
    retryMaxRetries: number;
  };
  github: {
    appId?: string;
    privateKeyPath?: string;
    token?: string;
    apiBaseUrl?: string;
    botLogin?: string;
    requestTimeoutMs?: number;
  };
}

export interface RepoProfilesConfig {
  enableOrgFallbacks?: boolean;
  repos?: Record<string, RepoProfileConfig>;
  orgFallbacks?: Record<string, RepoProfileConfig>;
}

export interface RepoProfileConfig {
  enabled?: boolean;
  displayName?: string;
  defaultBranch?: string;
  reviewProfile?: "chill" | "assertive";
  promptNote?: string;
  pathFilters?: string[];
  pathInstructions?: Record<string, string[]>;
  riskyPaths?: string[];
  proofExpectations?: string[];
  validationHints?: string[];
  readinessHints?: string[];
  autoReview?: RepoAutoReviewConfig;
  preMergeChecks?: RepoPreMergeChecksConfig;
  finishingTouches?: RepoFinishingTouchesConfig;
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
}

export interface RepoAutoReviewConfig {
  baseBranches?: string[];
  labels?: string[];
}

export interface RepoPreMergeChecksConfig {
  title?: RepoPreMergeCheckConfig;
  description?: RepoPreMergeCheckConfig;
  linkedIssue?: RepoPreMergeCheckConfig;
  testEvidence?: RepoPreMergeCheckConfig;
  docs?: RepoPreMergeCheckConfig;
  docstrings?: RepoPreMergeCheckConfig;
}

export interface RepoPreMergeCheckConfig {
  mode: "off" | "warning" | "error";
  instructions?: string;
  threshold?: number;
}

export interface RepoFinishingTouchesConfig {
  docstrings?: RepoFinishingTouchConfig;
  unitTests?: RepoFinishingTouchConfig;
  stackedPr?: RepoFinishingTouchConfig;
}

export interface RepoFinishingTouchConfig {
  enabled: boolean;
  instructions?: string;
}

export interface CommandConfig {
  enabled: boolean;
  botMentions: string[];
  trustedAuthors: string[];
  acknowledge: boolean;
}

export interface ReviewSchedulerConfig {
  enabled: boolean;
  maxProviderActive: number;
  maxOrgActive: number;
  maxRepoActive: number;
  maxQueuedPerRepo: number;
  manualCommandReserve: number;
  backgroundPriority: number;
}

export interface RepoMemoryConfig {
  enabled: boolean;
  memoryRoot: string;
  packetVersion: string;
  maxPacketBytes: number;
  maxStateNotes: number;
  includeStaleNotes: boolean;
}

const DEFAULT_CONFIG: BotConfig = {
  pilotRepos: ["electricsheephq/WorldOS", "100yenadmin/evaOS-GUI"],
  pollIntervalMs: 90_000,
  skipDrafts: true,
  workRoot: "/Volumes/LEXAR/repos/evaos-code-review-bot/runtime",
  statePath: "/Volumes/LEXAR/Codex/evaos-code-review-bot/state/reviews.sqlite",
  evidenceDir: "/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence",
  canaryPulls: undefined,
  activation: {
    reviewExistingOpenPrsOnActivation: false
  },
  reviewConcurrency: {
    maxActiveRuns: 1,
    leaseTtlMs: 15 * 60_000
  },
  reviewerSessions: {
    enabled: false,
    ttlMs: 8 * 60 * 60_000,
    headCountLimit: 10
  },
  reviewScheduler: {
    enabled: false,
    maxProviderActive: 2,
    maxOrgActive: 3,
    maxRepoActive: 1,
    maxQueuedPerRepo: 10,
    manualCommandReserve: 1,
    backgroundPriority: 50
  },
  providerCooldown: {
    enabled: true,
    durationMs: 15 * 60_000,
    requestRateLimitDurationMs: 90_000,
    overloadDurationMs: 2 * 60_000,
    quotaDurationMs: 30 * 60_000,
    transientRetryAttempts: 4,
    transientRetryBaseDelayMs: 2_000,
    transientRetryMaxDelayMs: 20_000
  },
  walkthrough: {
    enabled: true,
    postIssueComment: false
  },
  reviewStatusComment: {
    enabled: false
  },
  repoMemory: {
    enabled: false,
    memoryRoot: ".evaos/repo-memory",
    packetVersion: "repo-memory-packet-v0.1",
    maxPacketBytes: 12_000,
    maxStateNotes: 20,
    includeStaleNotes: false
  },
  gitnexusContext: {
    enabled: false,
    packetVersion: "gitnexus-context-packet-v0.1",
    maxPacketBytes: 40_000,
    maxRelatedItems: 8,
    queryLimit: 3,
    commandTimeoutMs: 10_000,
    maxCommandOutputBytes: 8_000,
    includeStaleContext: false,
    repoAliases: {},
    generatedPathPatterns: [
      "dist/**",
      "build/**",
      "coverage/**",
      "Library/**",
      "Temp/**",
      "**/*.min.js",
      "**/*.bundle.js",
      "**/*.lock"
    ]
  },
  githubRelatedContext: {
    enabled: false,
    packetVersion: "github-related-context-packet-v0.1",
    maxRelatedItems: 6,
    maxTitleChars: 160,
    maxBodyBytes: 1_200,
    maxPacketBytes: 12_000,
    requestTimeoutMs: 5_000,
    includeCrossRepoRefs: false
  },
  skillPacks: {
    enabled: false,
    packetVersion: "skill-pack-context-packet-v0.1",
    skillRoot: "/Volumes/LEXAR/Codex/evaos-code-review-bot/skills",
    allowlist: [],
    maxSkillBytes: 8_000,
    maxPacketBytes: 16_000
  },
  enrichment: {
    enabled: false,
    postIssueComment: false,
    packetVersion: "enrichment-comment-v0.1",
    maxRelatedRefs: 8,
    maxSuggestions: 8
  },
  issueEnrichment: DEFAULT_ISSUE_ENRICHMENT_CONFIG,
  commands: {
    enabled: false,
    botMentions: ["@evaos-code-review-bot"],
    trustedAuthors: [],
    acknowledge: false
  },
  zcode: {
    cliPath: "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    appConfigPath: "/Volumes/LEXAR/zcode/.zcode/v2/config.json",
    model: "GLM-5.2",
    timeoutMs: 180_000,
    maxPatchBytes: 80_000,
    retryMaxRetries: 0
  },
  github: {}
};

export function loadConfig(configPath?: string): BotConfig {
  const fromFile = configPath && existsSync(configPath) ? JSON.parse(readFileSync(configPath, "utf8")) : {};
  const merged = deepMerge(DEFAULT_CONFIG, fromFile) as BotConfig;

  merged.github.appId = process.env.EVAOS_REVIEW_BOT_APP_ID ?? merged.github.appId;
  merged.github.privateKeyPath = process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH ?? merged.github.privateKeyPath;
  merged.github.token = process.env.GITHUB_TOKEN ?? merged.github.token;
  validateConfig(merged);

  return merged;
}

function deepMerge(base: unknown, overlay: unknown): unknown {
  if (!isRecord(base) || !isRecord(overlay)) return overlay ?? base;
  const output: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    output[key] = key in output ? deepMerge(output[key], value) : value;
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateConfig(config: BotConfig): void {
  validateStringArray(config.pilotRepos, "config.pilotRepos");
  for (const repo of config.pilotRepos) validateRepoName(repo, "config.pilotRepos");
  if (config.canaryPulls !== undefined) {
    validateStringArray(config.canaryPulls, "config.canaryPulls");
    for (const canary of config.canaryPulls) validateCanaryPull(canary, "config.canaryPulls");
  }
  validateBoolean(config.skipDrafts, "config.skipDrafts");
  validatePositiveInteger(config.pollIntervalMs, "config.pollIntervalMs");
  validateBoolean(config.activation.reviewExistingOpenPrsOnActivation, "config.activation.reviewExistingOpenPrsOnActivation");
  validatePositiveInteger(config.reviewConcurrency.maxActiveRuns, "config.reviewConcurrency.maxActiveRuns");
  validatePositiveInteger(config.reviewConcurrency.leaseTtlMs, "config.reviewConcurrency.leaseTtlMs");
  const reviewerSessions = config.reviewerSessions ?? DEFAULT_CONFIG.reviewerSessions!;
  config.reviewerSessions = reviewerSessions;
  validateBoolean(reviewerSessions.enabled, "config.reviewerSessions.enabled");
  validatePositiveInteger(reviewerSessions.ttlMs, "config.reviewerSessions.ttlMs");
  validatePositiveInteger(reviewerSessions.headCountLimit, "config.reviewerSessions.headCountLimit");
  const reviewScheduler = config.reviewScheduler ?? DEFAULT_CONFIG.reviewScheduler!;
  config.reviewScheduler = reviewScheduler;
  validateReviewSchedulerConfig(reviewScheduler, "config.reviewScheduler");
  validateBoolean(config.providerCooldown.enabled, "config.providerCooldown.enabled");
  validatePositiveInteger(config.providerCooldown.durationMs, "config.providerCooldown.durationMs");
  validatePositiveInteger(config.providerCooldown.requestRateLimitDurationMs, "config.providerCooldown.requestRateLimitDurationMs");
  validatePositiveInteger(config.providerCooldown.overloadDurationMs, "config.providerCooldown.overloadDurationMs");
  validatePositiveInteger(config.providerCooldown.quotaDurationMs, "config.providerCooldown.quotaDurationMs");
  validateNonNegativeInteger(config.providerCooldown.transientRetryAttempts, "config.providerCooldown.transientRetryAttempts");
  validatePositiveInteger(config.providerCooldown.transientRetryBaseDelayMs, "config.providerCooldown.transientRetryBaseDelayMs");
  validatePositiveInteger(config.providerCooldown.transientRetryMaxDelayMs, "config.providerCooldown.transientRetryMaxDelayMs");
  validateBoolean(config.walkthrough.enabled, "config.walkthrough.enabled");
  validateBoolean(config.walkthrough.postIssueComment, "config.walkthrough.postIssueComment");
  const reviewStatusComment = config.reviewStatusComment ?? DEFAULT_CONFIG.reviewStatusComment!;
  config.reviewStatusComment = reviewStatusComment;
  validateBoolean(reviewStatusComment.enabled, "config.reviewStatusComment.enabled");
  const repoMemory = config.repoMemory ?? DEFAULT_CONFIG.repoMemory!;
  config.repoMemory = repoMemory;
  validateRepoMemoryConfig(repoMemory, "config.repoMemory");
  const gitnexusContext = config.gitnexusContext ?? DEFAULT_CONFIG.gitnexusContext!;
  config.gitnexusContext = gitnexusContext;
  validateGitNexusContextConfig(gitnexusContext, "config.gitnexusContext");
  const githubRelatedContext = config.githubRelatedContext ?? DEFAULT_CONFIG.githubRelatedContext!;
  config.githubRelatedContext = githubRelatedContext;
  validateGitHubRelatedContextConfig(githubRelatedContext, "config.githubRelatedContext");
  const skillPacks = config.skillPacks ?? DEFAULT_CONFIG.skillPacks!;
  config.skillPacks = skillPacks;
  validateSkillPacksConfig(skillPacks, "config.skillPacks");
  const enrichment = config.enrichment ?? DEFAULT_CONFIG.enrichment!;
  config.enrichment = enrichment;
  validateEnrichmentConfig(enrichment, "config.enrichment");
  const issueEnrichment = config.issueEnrichment ?? DEFAULT_CONFIG.issueEnrichment!;
  config.issueEnrichment = issueEnrichment;
  validateIssueEnrichmentConfig(issueEnrichment, "config.issueEnrichment");
  validateBoolean(config.commands.enabled, "config.commands.enabled");
  validateStringArray(config.commands.botMentions, "config.commands.botMentions");
  validateStringArray(config.commands.trustedAuthors, "config.commands.trustedAuthors");
  validateBoolean(config.commands.acknowledge, "config.commands.acknowledge");
  validatePositiveInteger(config.zcode.timeoutMs, "config.zcode.timeoutMs");
  validatePositiveInteger(config.zcode.maxPatchBytes, "config.zcode.maxPatchBytes");
  validateNonNegativeInteger(config.zcode.retryMaxRetries, "config.zcode.retryMaxRetries");
  validateOptionalString(config.github.apiBaseUrl, "config.github.apiBaseUrl");
  validateOptionalString(config.github.botLogin, "config.github.botLogin");
  if (config.github.requestTimeoutMs !== undefined) validatePositiveInteger(config.github.requestTimeoutMs, "config.github.requestTimeoutMs");

  if (!config.repoProfiles) return;

  if (config.repoProfiles.enableOrgFallbacks !== undefined) {
    validateBoolean(config.repoProfiles.enableOrgFallbacks, "repoProfiles.enableOrgFallbacks");
  }
  validateProfileRecord(config.repoProfiles.repos, "repoProfiles.repos");
  validateProfileRecord(config.repoProfiles.orgFallbacks, "repoProfiles.orgFallbacks");
}

function validateRepoMemoryConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.memoryRoot, `${label}.memoryRoot`);
  validateOptionalString(value.packetVersion, `${label}.packetVersion`);
  if (typeof value.memoryRoot !== "string" || value.memoryRoot.trim().length === 0) {
    throw new Error(`${label}.memoryRoot must be a non-empty string`);
  }
  if (typeof value.packetVersion !== "string" || value.packetVersion.trim().length === 0) {
    throw new Error(`${label}.packetVersion must be a non-empty string`);
  }
  validatePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`);
  validatePositiveInteger(value.maxStateNotes, `${label}.maxStateNotes`);
  validateBoolean(value.includeStaleNotes, `${label}.includeStaleNotes`);
}

function validateGitNexusContextConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.packetVersion, `${label}.packetVersion`);
  if (typeof value.packetVersion !== "string" || value.packetVersion.trim().length === 0) {
    throw new Error(`${label}.packetVersion must be a non-empty string`);
  }
  validatePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`);
  validatePositiveInteger(value.maxRelatedItems, `${label}.maxRelatedItems`);
  validatePositiveInteger(value.queryLimit, `${label}.queryLimit`);
  validatePositiveInteger(value.commandTimeoutMs, `${label}.commandTimeoutMs`);
  validatePositiveInteger(value.maxCommandOutputBytes, `${label}.maxCommandOutputBytes`);
  validateBoolean(value.includeStaleContext, `${label}.includeStaleContext`);
  validateOptionalStringArray(value.generatedPathPatterns, `${label}.generatedPathPatterns`);
  if (!Array.isArray(value.generatedPathPatterns)) {
    throw new Error(`${label}.generatedPathPatterns must be an array of non-empty strings`);
  }
  if (value.repoAliases !== undefined) {
    if (!isRecord(value.repoAliases)) throw new Error(`${label}.repoAliases must be an object`);
    for (const [repo, alias] of Object.entries(value.repoAliases)) {
      validateRepoName(repo, `${label}.repoAliases`);
      if (typeof alias !== "string" || alias.trim().length === 0) {
        throw new Error(`${label}.repoAliases.${repo} must be a non-empty string`);
      }
    }
  }
}

function validateGitHubRelatedContextConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.packetVersion, `${label}.packetVersion`);
  if (typeof value.packetVersion !== "string" || value.packetVersion.trim().length === 0) {
    throw new Error(`${label}.packetVersion must be a non-empty string`);
  }
  validatePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`);
  validatePositiveInteger(value.maxRelatedItems, `${label}.maxRelatedItems`);
  validatePositiveInteger(value.maxTitleChars, `${label}.maxTitleChars`);
  validateNonNegativeInteger(value.maxBodyBytes, `${label}.maxBodyBytes`);
  validatePositiveInteger(value.requestTimeoutMs, `${label}.requestTimeoutMs`);
  validateBoolean(value.includeCrossRepoRefs, `${label}.includeCrossRepoRefs`);
  if (typeof value.maxPacketBytes === "number" && value.maxPacketBytes < 500) {
    throw new Error(`${label}.maxPacketBytes must be at least 500`);
  }
  if (typeof value.maxTitleChars === "number" && value.maxTitleChars < 20) {
    throw new Error(`${label}.maxTitleChars must be at least 20`);
  }
}

function validateSkillPacksConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.packetVersion, `${label}.packetVersion`);
  if (typeof value.packetVersion !== "string" || value.packetVersion.trim().length === 0) {
    throw new Error(`${label}.packetVersion must be a non-empty string`);
  }
  validateOptionalString(value.skillRoot, `${label}.skillRoot`);
  if (typeof value.skillRoot !== "string" || value.skillRoot.trim().length === 0) {
    throw new Error(`${label}.skillRoot must be a non-empty string`);
  }
  if (!Array.isArray(value.allowlist)) throw new Error(`${label}.allowlist must be an array`);
  for (const [index, entry] of value.allowlist.entries()) {
    if (!isRecord(entry)) throw new Error(`${label}.allowlist.${index} must be an object`);
    validateOptionalString(entry.id, `${label}.allowlist.${index}.id`);
    validateOptionalString(entry.path, `${label}.allowlist.${index}.path`);
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_.-]+$/.test(entry.id)) {
      throw new Error(`${label}.allowlist.${index}.id must be a stable identifier`);
    }
    if (typeof entry.path !== "string" || entry.path.trim().length === 0) {
      throw new Error(`${label}.allowlist.${index}.path must be a non-empty string`);
    }
  }
  validatePositiveInteger(value.maxSkillBytes, `${label}.maxSkillBytes`);
  validatePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`);
  if (typeof value.maxPacketBytes === "number" && value.maxPacketBytes < 500) {
    throw new Error(`${label}.maxPacketBytes must be at least 500`);
  }
}

function validateEnrichmentConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateBoolean(value.postIssueComment, `${label}.postIssueComment`);
  validateOptionalString(value.packetVersion, `${label}.packetVersion`);
  if (typeof value.packetVersion !== "string" || value.packetVersion.trim().length === 0) {
    throw new Error(`${label}.packetVersion must be a non-empty string`);
  }
  validatePositiveInteger(value.maxRelatedRefs, `${label}.maxRelatedRefs`);
  validatePositiveInteger(value.maxSuggestions, `${label}.maxSuggestions`);
}

function validateIssueEnrichmentConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateBoolean(value.postIssueComment, `${label}.postIssueComment`);
  validateStringArray(value.allowlist, `${label}.allowlist`);
  const allowlist = value.allowlist as string[];
  for (const repo of allowlist) validateRepoName(repo, `${label}.allowlist`);
  validatePositiveInteger(value.maxIssuesPerCycle, `${label}.maxIssuesPerCycle`);
  validateNonNegativeInteger(value.maxCommentsPerCycle, `${label}.maxCommentsPerCycle`);
  validatePositiveInteger(value.globalMaxIssuesPerCycle, `${label}.globalMaxIssuesPerCycle`);
  validateNonNegativeInteger(value.globalMaxCommentsPerCycle, `${label}.globalMaxCommentsPerCycle`);
  validatePositiveInteger(value.maxActiveRuns, `${label}.maxActiveRuns`);
  // leaseTtlMs is the stuck-worker recovery bound and worst-case abnormal-exit stall; cooldownMs is per-issue cadence.
  validatePositiveInteger(value.leaseTtlMs, `${label}.leaseTtlMs`);
  validatePositiveInteger(value.cooldownMs, `${label}.cooldownMs`);
  validatePositiveInteger(value.burstWindowMs, `${label}.burstWindowMs`);
  validatePositiveInteger(value.maxIssuesPerBurst, `${label}.maxIssuesPerBurst`);
  validatePositiveInteger(value.lookbackMs, `${label}.lookbackMs`);
  validateBoolean(value.processExistingOpenIssuesOnActivation, `${label}.processExistingOpenIssuesOnActivation`);
  if (typeof value.maxIssuesPerCycle === "number" && typeof value.maxCommentsPerCycle === "number" && value.maxCommentsPerCycle > value.maxIssuesPerCycle) {
    throw new Error(`${label}.maxCommentsPerCycle must be <= ${label}.maxIssuesPerCycle`);
  }
  if (
    typeof value.globalMaxIssuesPerCycle === "number" &&
    typeof value.globalMaxCommentsPerCycle === "number" &&
    value.globalMaxCommentsPerCycle > value.globalMaxIssuesPerCycle
  ) {
    throw new Error(`${label}.globalMaxCommentsPerCycle must be <= ${label}.globalMaxIssuesPerCycle`);
  }
  if (value.repos !== undefined) {
    if (!isRecord(value.repos)) throw new Error(`${label}.repos must be an object`);
    for (const [repo, override] of Object.entries(value.repos)) {
      validateRepoName(repo, `${label}.repos`);
      validateIssueEnrichmentRepoOverride(override, `${label}.repos.${repo}`);
    }
  }
}

function validateIssueEnrichmentRepoOverride(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.enabled !== undefined) validateBoolean(value.enabled, `${label}.enabled`);
  if (value.maxIssuesPerCycle !== undefined) validatePositiveInteger(value.maxIssuesPerCycle, `${label}.maxIssuesPerCycle`);
  if (value.maxCommentsPerCycle !== undefined) validateNonNegativeInteger(value.maxCommentsPerCycle, `${label}.maxCommentsPerCycle`);
  if (value.cooldownMs !== undefined) validatePositiveInteger(value.cooldownMs, `${label}.cooldownMs`);
  if (value.burstWindowMs !== undefined) validatePositiveInteger(value.burstWindowMs, `${label}.burstWindowMs`);
  if (value.maxIssuesPerBurst !== undefined) validatePositiveInteger(value.maxIssuesPerBurst, `${label}.maxIssuesPerBurst`);
  if (value.lookbackMs !== undefined) validatePositiveInteger(value.lookbackMs, `${label}.lookbackMs`);
  if (value.processExistingOpenIssuesOnActivation !== undefined) {
    validateBoolean(value.processExistingOpenIssuesOnActivation, `${label}.processExistingOpenIssuesOnActivation`);
  }
  if (
    typeof value.maxIssuesPerCycle === "number" &&
    typeof value.maxCommentsPerCycle === "number" &&
    value.maxCommentsPerCycle > value.maxIssuesPerCycle
  ) {
    throw new Error(`${label}.maxCommentsPerCycle must be <= ${label}.maxIssuesPerCycle`);
  }
}

function validateProfileRecord(record: Record<string, RepoProfileConfig> | undefined, label: string): void {
  if (!record) return;
  for (const [key, profile] of Object.entries(record)) {
    if (label.endsWith(".repos")) validateRepoName(key, label);
    if (label.endsWith(".orgFallbacks")) validateOwnerName(key, label);
    if (!isRecord(profile)) throw new Error(`${label}.${key} must be an object`);
    if (profile.enabled !== undefined) validateBoolean(profile.enabled, `${label}.${key}.enabled`);
    validateOptionalString(profile.displayName, `${label}.${key}.displayName`);
    validateOptionalString(profile.defaultBranch, `${label}.${key}.defaultBranch`);
    validateOptionalString(profile.promptNote, `${label}.${key}.promptNote`);
    if (profile.reviewProfile && profile.reviewProfile !== "chill" && profile.reviewProfile !== "assertive") {
      throw new Error(`${label}.${key}.reviewProfile must be "chill" or "assertive"`);
    }
    for (const field of [
      "pathFilters",
      "riskyPaths",
      "proofExpectations",
      "validationHints",
      "readinessHints",
      "suggestedLabels",
      "suggestedReviewers"
    ] as const) {
      validateOptionalStringArray(profile[field], `${label}.${key}.${field}`);
    }
    validatePathInstructions(profile.pathInstructions, `${label}.${key}.pathInstructions`);
    validateAutoReview(profile.autoReview, `${label}.${key}.autoReview`);
    validatePreMergeChecks(profile.preMergeChecks, `${label}.${key}.preMergeChecks`);
    validateFinishingTouches(profile.finishingTouches, `${label}.${key}.finishingTouches`);
  }
}

function validateAutoReview(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateOptionalStringArray(value.baseBranches, `${label}.baseBranches`);
  validateOptionalStringArray(value.labels, `${label}.labels`);
}

function validatePreMergeChecks(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const field of ["title", "description", "linkedIssue", "testEvidence", "docs", "docstrings"] as const) {
    validatePreMergeCheck(value[field], `${label}.${field}`);
  }
}

function validatePreMergeCheck(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.mode !== "off" && value.mode !== "warning" && value.mode !== "error") {
    throw new Error(`${label}.mode must be "off", "warning", or "error"`);
  }
  validateOptionalString(value.instructions, `${label}.instructions`);
  if (value.threshold !== undefined) validatePercentage(value.threshold, `${label}.threshold`);
}

function validateFinishingTouches(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const field of ["docstrings", "unitTests", "stackedPr"] as const) {
    validateFinishingTouch(value[field], `${label}.${field}`);
  }
}

function validateFinishingTouch(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.instructions, `${label}.instructions`);
}

function validateReviewSchedulerConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validatePositiveInteger(value.maxProviderActive, `${label}.maxProviderActive`);
  validatePositiveInteger(value.maxOrgActive, `${label}.maxOrgActive`);
  validatePositiveInteger(value.maxRepoActive, `${label}.maxRepoActive`);
  validatePositiveInteger(value.maxQueuedPerRepo, `${label}.maxQueuedPerRepo`);
  validateNonNegativeInteger(value.manualCommandReserve, `${label}.manualCommandReserve`);
  validateNonNegativeInteger(value.backgroundPriority, `${label}.backgroundPriority`);
  const maxProviderActive = Number(value.maxProviderActive);
  const manualCommandReserve = Number(value.manualCommandReserve);
  if (manualCommandReserve > maxProviderActive) {
    throw new Error(`${label}.manualCommandReserve must be <= ${label}.maxProviderActive`);
  }
}

function validatePathInstructions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const [pathPattern, instructions] of Object.entries(value)) {
    if (!pathPattern.trim()) throw new Error(`${label} keys must be non-empty path patterns`);
    validateStringArray(instructions, `${label}.${pathPattern}`);
  }
}

function validateOptionalString(value: unknown, label: string): void {
  if (value !== undefined && typeof value !== "string") throw new Error(`${label} must be a string`);
}

function validateStringArray(value: unknown, label: string): void {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length === 0)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
}

function validateOptionalStringArray(value: unknown, label: string): void {
  if (value === undefined) return;
  validateStringArray(value, label);
}

function validateBoolean(value: unknown, label: string): void {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
}

function validatePositiveInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
}

function validateNonNegativeInteger(value: unknown, label: string): void {
  if (!Number.isInteger(value) || Number(value) < 0) throw new Error(`${label} must be a non-negative integer`);
}

function validatePercentage(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new Error(`${label} must be a number from 0 to 100`);
  }
}

function validateRepoName(value: string, label: string): void {
  const [owner, repo, extra] = value.split("/");
  if (extra !== undefined || !owner || !repo) throw new Error(`${label} entries must be GitHub owner/repo names`);
  validateOwnerName(owner, `${label}.${value}.owner`);
  validateOwnerName(repo, `${label}.${value}.repo`);
}

function validateOwnerName(value: string, label: string): void {
  if (value === "." || value === "..") throw new Error(`${label} must contain only GitHub name characters`);
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${label} must contain only GitHub name characters`);
}

function validateCanaryPull(value: string, label: string): void {
  const [repo, pullNumber, extra] = value.split("#");
  if (extra !== undefined || !repo || !pullNumber || !/^[1-9][0-9]*$/.test(pullNumber)) {
    throw new Error(`${label} entries must use owner/repo#number`);
  }
  validateRepoName(repo, label);
}
