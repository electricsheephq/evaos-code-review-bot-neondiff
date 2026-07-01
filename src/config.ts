import { existsSync, readFileSync } from "node:fs";

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
  validateBoolean(config.commands.enabled, "config.commands.enabled");
  validateStringArray(config.commands.botMentions, "config.commands.botMentions");
  validateStringArray(config.commands.trustedAuthors, "config.commands.trustedAuthors");
  validateBoolean(config.commands.acknowledge, "config.commands.acknowledge");
  validatePositiveInteger(config.zcode.timeoutMs, "config.zcode.timeoutMs");
  validatePositiveInteger(config.zcode.maxPatchBytes, "config.zcode.maxPatchBytes");
  validateNonNegativeInteger(config.zcode.retryMaxRetries, "config.zcode.retryMaxRetries");

  if (!config.repoProfiles) return;

  if (config.repoProfiles.enableOrgFallbacks !== undefined) {
    validateBoolean(config.repoProfiles.enableOrgFallbacks, "repoProfiles.enableOrgFallbacks");
  }
  validateProfileRecord(config.repoProfiles.repos, "repoProfiles.repos");
  validateProfileRecord(config.repoProfiles.orgFallbacks, "repoProfiles.orgFallbacks");
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
  if (!/^[A-Za-z0-9_.-]+$/.test(value)) throw new Error(`${label} must contain only GitHub name characters`);
}

function validateCanaryPull(value: string, label: string): void {
  const [repo, pullNumber, extra] = value.split("#");
  if (extra !== undefined || !repo || !pullNumber || !/^[1-9][0-9]*$/.test(pullNumber)) {
    throw new Error(`${label} entries must use owner/repo#number`);
  }
  validateRepoName(repo, label);
}
