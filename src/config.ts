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
  riskyPaths?: string[];
  proofExpectations?: string[];
  validationHints?: string[];
  readinessHints?: string[];
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
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
    maxActiveRuns: 5,
    leaseTtlMs: 15 * 60_000
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
  if (!Array.isArray(config.pilotRepos)) throw new Error("config.pilotRepos must be an array");
  if (!Array.isArray(config.commands.botMentions)) throw new Error("config.commands.botMentions must be an array");
  if (!Array.isArray(config.commands.trustedAuthors)) throw new Error("config.commands.trustedAuthors must be an array");
  if (!config.repoProfiles) return;

  validateProfileRecord(config.repoProfiles.repos, "repoProfiles.repos");
  validateProfileRecord(config.repoProfiles.orgFallbacks, "repoProfiles.orgFallbacks");
}

function validateProfileRecord(record: Record<string, RepoProfileConfig> | undefined, label: string): void {
  if (!record) return;
  for (const [key, profile] of Object.entries(record)) {
    if (!isRecord(profile)) throw new Error(`${label}.${key} must be an object`);
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
      const value = profile[field];
      if (value !== undefined && (!Array.isArray(value) || value.some((entry) => typeof entry !== "string"))) {
        throw new Error(`${label}.${key}.${field} must be an array of strings`);
      }
    }
  }
}
