import { existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { dirname, join } from "node:path";
import { DEFAULT_CONTEXT_BUDGET_CONFIG, type ContextBudgetConfig } from "./context-budget.js";
import type { EnrichmentConfig } from "./enrichment.js";
import type { GitNexusContextConfig } from "./gitnexus-context.js";
import type { GitHubRelatedContextConfig } from "./github-related-context.js";
import { DEFAULT_ISSUE_ENRICHMENT_CONFIG, type IssueEnrichmentConfig } from "./issue-enrichment.js";
import { resolveEnvAlias } from "./env-alias.js";
import type { LicenseConfig } from "./license.js";
import { assertPathOutsideProtectedRoot, getProtectedCheckoutRoots } from "./path-safety.js";
import {
  buildPublicConfidencePolicy,
  isPublicConfidenceDisplayAllowed,
  isUsablePublicConfidenceEvidenceUrl,
  PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS,
  PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS,
  PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS,
  PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND,
  type PublicConfidenceDisplayPolicy
} from "./public-confidence.js";
import { isApiKeyEnvName, isProviderId, isProviderStructuredOutputMode, PROVIDER_STRUCTURED_OUTPUT_MODES, SCHEMA_FEEDBACK_RETRY_MAX, type ProviderRegistryConfig } from "./providers.js";
import { REGRESSION_CATEGORIES, type CategoryPrecisionFloors, type RequestChangesConfidenceFloors } from "./regression-taxonomy.js";
import type { ReviewMode, ReviewModeDefinition, ReviewModesConfig } from "./review-mode-types.js";
import { validateRelativePacketPath, type RepoWikiContextConfig } from "./repo-wiki-context.js";
import { containsSecretLikeText } from "./secrets.js";
import type { SkillPackContextConfig } from "./skill-packs.js";

const MAX_LICENSE_OFFLINE_GRACE_MS = 15 * 60_000;

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
  riskWeightedQueue?: RiskWeightedQueueConfig;
  /** Review mode router (#266, default off / absent). Absent ⇒ byte-identical + zero evidence. */
  reviewModes?: ReviewModesConfig;
  calibrationLoop?: CalibrationLoopConfig;
  providerCooldown: {
    enabled: boolean;
    durationMs: number;
    requestRateLimitDurationMs: number;
    overloadDurationMs: number;
    quotaDurationMs: number;
    overloadBackoffMaxDurationMs: number;
    overloadBackoffJitterMs: number;
    transientRetryAttempts: number;
    transientRetryBaseDelayMs: number;
    transientRetryMaxDelayMs: number;
  };
  contextBudget?: ContextBudgetConfig;
  walkthrough: {
    enabled: boolean;
    postIssueComment: boolean;
  };
  reviewStatusComment?: {
    enabled: boolean;
  };
  confidenceCalibration?: {
    publicDisplay: PublicConfidenceDisplayPolicy;
  };
  reviewGate?: ReviewGateConfig;
  repoMemory?: RepoMemoryConfig;
  repoWikiContext?: RepoWikiContextConfig;
  gitnexusContext?: GitNexusContextConfig;
  githubRelatedContext?: GitHubRelatedContextConfig;
  skillPacks?: SkillPackContextConfig;
  enrichment?: EnrichmentConfig;
  issueEnrichment?: IssueEnrichmentConfig;
  license?: LicenseConfig;
  desktop?: DesktopConfig;
  providers?: ProviderRegistryConfig;
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

export interface DesktopConfig {
  openAICompatibleEndpoint?: string;
  updateChannel?: string;
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
  reviewScheduler?: RepoReviewSchedulerConfig;
  suggestedLabels?: string[];
  suggestedReviewers?: string[];
}

export interface RepoReviewSchedulerConfig {
  maxActiveHeads?: number;
  maxQueuedHeads?: number;
  /** Terminal for the exact PR head when set to "skip"; use "defer" for transient bursts. */
  overflowAction?: "defer" | "skip";
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
  docs?: RepoFinishingTouchConfig;
  docstrings?: RepoFinishingTouchConfig;
  unitTests?: RepoFinishingTouchConfig;
  simplifySuggestion?: RepoFinishingTouchConfig;
  changelogDraft?: RepoFinishingTouchConfig;
  riskExplanation?: RepoFinishingTouchConfig;
  reviewReady?: RepoFinishingTouchConfig;
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
  /** Public review/re-review command policy (#345, default off). Separate from trustedAuthors. */
  publicCommands?: PublicCommandsConfig;
}

export interface PublicCommandsConfig {
  /** When false (default/unset), only trusted authors trigger anything — byte-identical to today. */
  enabled: boolean;
  /** Actions a non-trusted author may trigger. Validation permits ONLY "review"/"re-review". */
  actions: Array<"review" | "re-review">;
  /** Per-{repo,pr,head,author,action} cooldown window for public invocations. */
  cooldownMinutes: number;
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

export interface ReviewGateConfig {
  /** Max inline comments posted per review; the highest-ranked findings survive the cap. */
  maxInlineComments: number;
  /** Optional per-severity confidence floors for REQUEST_CHANGES eligibility (default off). */
  requestChangesConfidenceFloors?: RequestChangesConfidenceFloors;
  /** Optional confidence subtracted (0..1, floor 0) from findings recovered via the strict-JSON
   * retry path (#304). Default off; quieter-only — lower confidence can only demote ranking/floors. */
  retryDegradedConfidencePenalty?: number;
  /** Opt-in P0/P1 self-consistency re-check (#303, default off). Owner-approved; adds provider cost. */
  selfConsistency?: SelfConsistencyConfig;
  /** Optional per-category precision floors (#286 PR C, default off). Operator-curated from the
   * aggregate calibration report: a listed category loses REQUEST_CHANGES eligibility (quieter-only).
   * Values come from the aggregate via the operator; nothing reads the aggregate at review time. */
  categoryPrecisionFloors?: CategoryPrecisionFloors;
}

export interface SelfConsistencyConfig {
  /** When false (default), no second draw runs — byte-identical output, zero extra provider calls. */
  enabled: boolean;
  /** Severities to re-check; default ["P0","P1"]. Only P0/P1 are permitted. */
  severities?: Array<"P0" | "P1">;
  /** Provider-registry id for the second draw; absent ⇒ same provider as the main review. */
  provider?: string;
  /** Cost bound: max findings re-checked per review, in ranked order. Default 5. */
  maxFindingsPerReview?: number;
}

export interface RiskWeightedQueueConfig {
  /** When false (default), enqueue priority stays the flat backgroundPriority — byte-identical. */
  enabled: boolean;
  /** Priority for PRs whose changed surface matches a required-validation category (lower = sooner). */
  elevatedPriority?: number;
  /** Priority for docs-only PRs (typically >= backgroundPriority to defer them). */
  docsOnlyPriority?: number;
  /** Lease-time aging guarantee (#346, default off). Prevents starvation of below-baseline jobs. */
  aging?: QueueAgingConfig;
}

export interface QueueAgingConfig {
  /** When false (default/unset), lease order is byte-identical to today. */
  enabled: boolean;
  /** A queued job waiting longer than this is aged UP to baseline at lease time (never demoted). */
  maxWaitMinutes: number;
}

export interface CalibrationLoopConfig {
  /** Daemon-scheduled outcome observation (#357, default off). Records outcome labels + evidence
   * only — never aggregates, promotes, writes config, or posts to GitHub. */
  observeSchedule?: ObserveScheduleConfig;
}

export interface ObserveScheduleConfig {
  /** When false (default/unset), zero observer calls / zero observation GitHub reads — byte-identical. */
  enabled: boolean;
  /** Minimum minutes between observe passes (schedule is "due" when now − lastObserveAt ≥ this). */
  intervalMinutes: number;
  /** Hard bound on GitHub reads per observe pass. */
  maxPullsPerCycle: number;
  /** Do not re-observe the same repo more often than this. */
  perRepoCooldownMinutes: number;
  /** Only revisit findings/PRs recorded within this window. */
  lookbackDays: number;
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
  pilotRepos: ["example-org/example-repo"],
  pollIntervalMs: 90_000,
  skipDrafts: true,
  // workRoot must resolve outside this checkout (validateWorkRootIsolation); /tmp/neondiff is a
  // portable placeholder that satisfies that check on any machine without edits.
  workRoot: "/tmp/neondiff/runtime",
  statePath: "/tmp/neondiff/state/reviews.sqlite",
  evidenceDir: "/tmp/neondiff/evidence",
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
  riskWeightedQueue: {
    enabled: false
  },
  providerCooldown: {
    enabled: true,
    durationMs: 15 * 60_000,
    requestRateLimitDurationMs: 90_000,
    overloadDurationMs: 2 * 60_000,
    quotaDurationMs: 30 * 60_000,
    overloadBackoffMaxDurationMs: 10 * 60_000,
    overloadBackoffJitterMs: 30_000,
    transientRetryAttempts: 4,
    transientRetryBaseDelayMs: 2_000,
    transientRetryMaxDelayMs: 20_000
  },
  contextBudget: DEFAULT_CONTEXT_BUDGET_CONFIG,
  walkthrough: {
    enabled: true,
    postIssueComment: false
  },
  reviewStatusComment: {
    enabled: false
  },
  confidenceCalibration: {
    publicDisplay: buildPublicConfidencePolicy()
  },
  reviewGate: {
    maxInlineComments: 25
  },
  repoMemory: {
    enabled: false,
    memoryRoot: ".evaos/repo-memory",
    packetVersion: "repo-memory-packet-v0.2",
    maxPacketBytes: 12_000,
    maxStateNotes: 20,
    includeStaleNotes: false
  },
  repoWikiContext: {
    enabled: false,
    packetPath: ".neondiff/repo-wiki-packet.json",
    maxPacketBytes: 12_000,
    includeStaleContext: false
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
  license: {
    enabled: false,
    apiBaseUrl: undefined,
    cachePath: "",
    storageBackend: "file",
    keyPath: undefined,
    keychainService: "com.electricsheephq.neondiff.license",
    keychainAccount: "default",
    requestTimeoutMs: 10_000,
    offlineGraceMs: MAX_LICENSE_OFFLINE_GRACE_MS,
    publicReposFree: true,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: true
  },
  desktop: {
    openAICompatibleEndpoint: "http://localhost:8000/v1",
    updateChannel: "dev"
  },
  providers: {
    defaultProviderId: "zcode-glm",
    providers: {
      "zcode-glm": {
        enabled: true,
        adapter: "zcode",
        displayName: "GLM/Z.ai through ZCode",
        model: "GLM-5.2",
        authMode: "zcode-app-config",
        contextWindowTokens: 128_000,
        timeoutMs: 180_000,
        retryMaxRetries: 0,
        capabilities: {
          review: true,
          jsonOutput: true,
          local: false,
          streaming: false
        }
      },
      "ollama-local": {
        enabled: false,
        adapter: "openai-compatible",
        displayName: "Ollama local OpenAI-compatible endpoint",
        baseUrl: "http://localhost:11434/v1",
        model: "qwen2.5-coder:7b",
        authMode: "none",
        contextWindowTokens: 32_000,
        timeoutMs: 180_000,
        retryMaxRetries: 1,
        retrySchemaFeedbackMax: 2,
        capabilities: {
          review: true,
          jsonOutput: true,
          local: true,
          streaming: false
        }
      },
      "openai-compatible": {
        enabled: false,
        adapter: "openai-compatible",
        displayName: "OpenAI-compatible BYOK or gateway endpoint",
        baseUrl: "https://example.invalid/v1",
        model: "model-id",
        authMode: "api-key-env",
        apiKeyEnv: "NEONDIFF_PROVIDER_API_KEY",
        contextWindowTokens: 128_000,
        timeoutMs: 180_000,
        retryMaxRetries: 1,
        retrySchemaFeedbackMax: 2,
        capabilities: {
          review: true,
          jsonOutput: true,
          local: false,
          streaming: false
        }
      },
      anthropic: {
        enabled: false,
        adapter: "anthropic",
        displayName: "Anthropic native adapter placeholder",
        model: "claude-sonnet-4",
        authMode: "api-key-env",
        apiKeyEnv: "ANTHROPIC_API_KEY",
        contextWindowTokens: 200_000,
        timeoutMs: 180_000,
        retryMaxRetries: 1,
        capabilities: {
          review: false,
          jsonOutput: true,
          local: false,
          streaming: false
        }
      },
      openai: {
        enabled: false,
        adapter: "openai",
        displayName: "OpenAI native adapter placeholder",
        model: "gpt-4.1",
        authMode: "api-key-env",
        apiKeyEnv: "OPENAI_API_KEY",
        contextWindowTokens: 128_000,
        timeoutMs: 180_000,
        retryMaxRetries: 1,
        capabilities: {
          review: false,
          jsonOutput: true,
          local: false,
          streaming: false
        }
      },
      gemini: {
        enabled: false,
        adapter: "gemini",
        displayName: "Gemini native adapter placeholder",
        model: "gemini-2.5-pro",
        authMode: "api-key-env",
        apiKeyEnv: "GEMINI_API_KEY",
        contextWindowTokens: 1_000_000,
        timeoutMs: 180_000,
        retryMaxRetries: 1,
        capabilities: {
          review: false,
          jsonOutput: true,
          local: false,
          streaming: false
        }
      }
    }
  },
  commands: {
    enabled: false,
    botMentions: ["@neondiff"],
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
  return loadConfigFromObject(fromFile);
}

export function loadConfigFromObject(fromFile: unknown): BotConfig {
  const merged = deepMerge(DEFAULT_CONFIG, fromFile) as BotConfig;

  merged.github.appId = resolveEnvAlias({
    primaryName: "NEONDIFF_GITHUB_APP_ID",
    legacyName: "EVAOS_REVIEW_BOT_APP_ID",
    valueLabel: "github.appId"
  }) ?? merged.github.appId;
  merged.github.privateKeyPath = resolveEnvAlias({
    primaryName: "NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH",
    legacyName: "EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH",
    valueLabel: "github.privateKeyPath"
  }) ?? merged.github.privateKeyPath;
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
  validateNonEmptyString(config.workRoot, "config.workRoot");
  validateWorkRootIsolation(config);
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
  const riskWeightedQueue = config.riskWeightedQueue ?? DEFAULT_CONFIG.riskWeightedQueue!;
  config.riskWeightedQueue = riskWeightedQueue;
  validateRiskWeightedQueueConfig(riskWeightedQueue, "config.riskWeightedQueue", reviewScheduler.backgroundPriority);
  // reviewModes is absent-by-default (#266): never default it in, so absent ⇒ byte-identical + zero
  // evidence. Validate only when the operator supplies it; validation is fail-closed and demote-only.
  if (config.reviewModes !== undefined) {
    validateReviewModesConfig(config.reviewModes, "config.reviewModes", config);
  }
  if (config.calibrationLoop !== undefined) validateCalibrationLoopConfig(config.calibrationLoop, "config.calibrationLoop");
  validateBoolean(config.providerCooldown.enabled, "config.providerCooldown.enabled");
  validatePositiveInteger(config.providerCooldown.durationMs, "config.providerCooldown.durationMs");
  validatePositiveInteger(config.providerCooldown.requestRateLimitDurationMs, "config.providerCooldown.requestRateLimitDurationMs");
  validatePositiveInteger(config.providerCooldown.overloadDurationMs, "config.providerCooldown.overloadDurationMs");
  validatePositiveInteger(config.providerCooldown.quotaDurationMs, "config.providerCooldown.quotaDurationMs");
  validatePositiveInteger(config.providerCooldown.overloadBackoffMaxDurationMs, "config.providerCooldown.overloadBackoffMaxDurationMs");
  validateNonNegativeInteger(config.providerCooldown.overloadBackoffJitterMs, "config.providerCooldown.overloadBackoffJitterMs");
  validateNonNegativeInteger(config.providerCooldown.transientRetryAttempts, "config.providerCooldown.transientRetryAttempts");
  validatePositiveInteger(config.providerCooldown.transientRetryBaseDelayMs, "config.providerCooldown.transientRetryBaseDelayMs");
  validatePositiveInteger(config.providerCooldown.transientRetryMaxDelayMs, "config.providerCooldown.transientRetryMaxDelayMs");
  const contextBudget = { ...DEFAULT_CONTEXT_BUDGET_CONFIG, ...(config.contextBudget ?? {}) };
  config.contextBudget = contextBudget;
  validateContextBudgetConfig(contextBudget, "config.contextBudget");
  validateBoolean(config.walkthrough.enabled, "config.walkthrough.enabled");
  validateBoolean(config.walkthrough.postIssueComment, "config.walkthrough.postIssueComment");
  const reviewStatusComment = config.reviewStatusComment ?? DEFAULT_CONFIG.reviewStatusComment!;
  config.reviewStatusComment = reviewStatusComment;
  validateBoolean(reviewStatusComment.enabled, "config.reviewStatusComment.enabled");
  const confidenceCalibration = config.confidenceCalibration ?? DEFAULT_CONFIG.confidenceCalibration!;
  if (!isRecord(confidenceCalibration)) {
    throw new Error("config.confidenceCalibration must be an object");
  }
  if (confidenceCalibration.publicDisplay !== undefined && !isRecord(confidenceCalibration.publicDisplay)) {
    throw new Error("config.confidenceCalibration.publicDisplay must be an object");
  }
  validatePublicConfidenceDisplayFloorOverrides(confidenceCalibration.publicDisplay, "config.confidenceCalibration.publicDisplay");
  confidenceCalibration.publicDisplay = buildPublicConfidencePolicy(confidenceCalibration.publicDisplay);
  validatePublicConfidenceDisplayConfig(confidenceCalibration.publicDisplay, "config.confidenceCalibration.publicDisplay");
  config.confidenceCalibration = confidenceCalibration;
  const reviewGate = config.reviewGate ?? DEFAULT_CONFIG.reviewGate!;
  config.reviewGate = reviewGate;
  validateReviewGateConfig(reviewGate, "config.reviewGate");
  const repoMemory = config.repoMemory ?? DEFAULT_CONFIG.repoMemory!;
  config.repoMemory = repoMemory;
  validateRepoMemoryConfig(repoMemory, "config.repoMemory");
  const repoWikiContext = config.repoWikiContext ?? DEFAULT_CONFIG.repoWikiContext!;
  config.repoWikiContext = repoWikiContext;
  validateRepoWikiContextConfig(repoWikiContext, "config.repoWikiContext");
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
  const license = { ...DEFAULT_CONFIG.license!, ...(config.license ?? {}) };
  license.cachePath = license.cachePath || join(dirname(config.statePath), "license", "entitlement-cache.json");
  if (license.storageBackend === "file" && !license.keyPath) {
    license.keyPath = join(dirname(config.statePath), "license", "license-key.txt");
  }
  config.license = license;
  validateLicenseConfig(license, "config.license");
  const desktop = config.desktop ?? DEFAULT_CONFIG.desktop!;
  config.desktop = desktop;
  validateDesktopConfig(desktop, "config.desktop");
  const providers = config.providers ?? DEFAULT_CONFIG.providers!;
  config.providers = providers;
  validateProviderRegistryConfig(providers, "config.providers");
  validateBoolean(config.commands.enabled, "config.commands.enabled");
  validateStringArray(config.commands.botMentions, "config.commands.botMentions");
  validateStringArray(config.commands.trustedAuthors, "config.commands.trustedAuthors");
  validateBoolean(config.commands.acknowledge, "config.commands.acknowledge");
  if (config.commands.publicCommands !== undefined) {
    validatePublicCommandsConfig(config.commands.publicCommands, "config.commands.publicCommands");
  }
  validateNonEmptyString(config.zcode.cliPath, "config.zcode.cliPath");
  validateNonEmptyString(config.zcode.appConfigPath, "config.zcode.appConfigPath");
  validateNonEmptyString(config.zcode.model, "config.zcode.model");
  validatePositiveInteger(config.zcode.timeoutMs, "config.zcode.timeoutMs");
  validatePositiveInteger(config.zcode.maxPatchBytes, "config.zcode.maxPatchBytes");
  validateNonNegativeInteger(config.zcode.retryMaxRetries, "config.zcode.retryMaxRetries");
  validateOptionalString(config.zcode.providerId, "config.zcode.providerId");
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

function validatePublicConfidenceDisplayConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.mode !== "uncalibrated" && value.mode !== "calibrated") {
    throw new Error(`${label}.mode must be uncalibrated or calibrated`);
  }
  validatePositiveInteger(value.minLabeledFindings, `${label}.minLabeledFindings`);
  validatePositiveInteger(value.minP0P1Labels, `${label}.minP0P1Labels`);
  validatePositiveInteger(value.minNegativeControlScenarios, `${label}.minNegativeControlScenarios`);
  validateProbability(value.minWilsonLowerBound, `${label}.minWilsonLowerBound`);
  if (value.labeledFindings !== undefined) validateNonNegativeInteger(value.labeledFindings, `${label}.labeledFindings`);
  if (value.p0p1Labels !== undefined) validateNonNegativeInteger(value.p0p1Labels, `${label}.p0p1Labels`);
  if (value.negativeControlScenarios !== undefined) validateNonNegativeInteger(value.negativeControlScenarios, `${label}.negativeControlScenarios`);
  if (value.wilsonLowerBound !== undefined) validateProbability(value.wilsonLowerBound, `${label}.wilsonLowerBound`);
  validateOptionalString(value.evidenceUrl, `${label}.evidenceUrl`);
  validateOptionalString(value.datasetId, `${label}.datasetId`);
  const policy = value as unknown as PublicConfidenceDisplayPolicy;
  if (value.mode === "calibrated" && !isPublicConfidenceDisplayAllowed(policy)) {
    if (!isUsablePublicConfidenceEvidenceUrl(typeof value.evidenceUrl === "string" ? value.evidenceUrl : undefined)) {
      throw new Error(`${label}.evidenceUrl must be an https URL when mode=calibrated`);
    }
    if (typeof value.datasetId !== "string" || value.datasetId.trim().length === 0) {
      throw new Error(`${label}.datasetId is required when mode=calibrated`);
    }
    if (typeof value.labeledFindings !== "number" || value.labeledFindings < (value.minLabeledFindings as number)) {
      throw new Error(`${label}.labeledFindings must be >= minLabeledFindings before public confidence display is calibrated`);
    }
    if (typeof value.p0p1Labels !== "number" || value.p0p1Labels < (value.minP0P1Labels as number)) {
      throw new Error(`${label}.p0p1Labels must be >= minP0P1Labels before public confidence display is calibrated`);
    }
    if (
      typeof value.negativeControlScenarios !== "number" ||
      value.negativeControlScenarios < (value.minNegativeControlScenarios as number)
    ) {
      throw new Error(`${label}.negativeControlScenarios must be >= minNegativeControlScenarios before public confidence display is calibrated`);
    }
    if (typeof value.wilsonLowerBound !== "number" || value.wilsonLowerBound < (value.minWilsonLowerBound as number)) {
      throw new Error(`${label}.wilsonLowerBound must be >= minWilsonLowerBound before public confidence display is calibrated`);
    }
  }
}

function validatePublicConfidenceDisplayFloorOverrides(value: unknown, label: string): void {
  if (!isRecord(value)) return;
  if (value.minLabeledFindings !== undefined && (value.minLabeledFindings as number) < PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS) {
    throw new Error(`${label}.minLabeledFindings must be >= ${PUBLIC_CONFIDENCE_MIN_LABELED_FINDINGS}`);
  }
  if (value.minP0P1Labels !== undefined && (value.minP0P1Labels as number) < PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS) {
    throw new Error(`${label}.minP0P1Labels must be >= ${PUBLIC_CONFIDENCE_MIN_P0_P1_LABELS}`);
  }
  if (
    value.minNegativeControlScenarios !== undefined &&
    (value.minNegativeControlScenarios as number) < PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS
  ) {
    throw new Error(`${label}.minNegativeControlScenarios must be >= ${PUBLIC_CONFIDENCE_MIN_NEGATIVE_CONTROL_SCENARIOS}`);
  }
  if (value.minWilsonLowerBound !== undefined && (value.minWilsonLowerBound as number) < PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND) {
    throw new Error(`${label}.minWilsonLowerBound must be >= ${PUBLIC_CONFIDENCE_MIN_WILSON_LOWER_BOUND}`);
  }
}

function validatePublicCommandsConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "actions" && key !== "cooldownMinutes") {
      throw new Error(`${label} has unknown key "${key}"; expected only enabled, actions, or cooldownMinutes`);
    }
  }
  validateBoolean(value.enabled, `${label}.enabled`);
  if (!Array.isArray(value.actions) || value.actions.length === 0) {
    throw new Error(`${label}.actions must be a non-empty array`);
  }
  for (const action of value.actions) {
    if (action !== "review" && action !== "re-review") {
      throw new Error(`${label}.actions entries must be one of review, re-review`);
    }
  }
  validatePositiveInteger(value.cooldownMinutes, `${label}.cooldownMinutes`);
}

function validateReviewGateConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validatePositiveInteger(value.maxInlineComments, `${label}.maxInlineComments`);
  if (value.requestChangesConfidenceFloors !== undefined) {
    if (!isRecord(value.requestChangesConfidenceFloors)) {
      throw new Error(`${label}.requestChangesConfidenceFloors must be an object`);
    }
    for (const key of Object.keys(value.requestChangesConfidenceFloors)) {
      if (key !== "P0" && key !== "P1") {
        throw new Error(`${label}.requestChangesConfidenceFloors has unknown key "${key}"; expected only P0 or P1`);
      }
    }
    for (const severity of ["P0", "P1"] as const) {
      const floor = value.requestChangesConfidenceFloors[severity];
      if (floor !== undefined) validateProbability(floor, `${label}.requestChangesConfidenceFloors.${severity}`);
    }
  }
  if (value.retryDegradedConfidencePenalty !== undefined) {
    validateProbability(value.retryDegradedConfidencePenalty, `${label}.retryDegradedConfidencePenalty`);
  }
  if (value.categoryPrecisionFloors !== undefined) {
    if (!isRecord(value.categoryPrecisionFloors)) {
      throw new Error(`${label}.categoryPrecisionFloors must be an object`);
    }
    for (const [category, floor] of Object.entries(value.categoryPrecisionFloors)) {
      if (!(REGRESSION_CATEGORIES as string[]).includes(category)) {
        throw new Error(`${label}.categoryPrecisionFloors has unknown category "${category}"`);
      }
      validateProbability(floor, `${label}.categoryPrecisionFloors.${category}`);
    }
  }
  if (value.selfConsistency !== undefined) validateSelfConsistencyConfig(value.selfConsistency, `${label}.selfConsistency`);
}

function validateSelfConsistencyConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  if (value.severities !== undefined) {
    if (!Array.isArray(value.severities) || value.severities.length === 0) {
      throw new Error(`${label}.severities must be a non-empty array of P0 or P1`);
    }
    for (const severity of value.severities) {
      if (severity !== "P0" && severity !== "P1") {
        throw new Error(`${label}.severities entries must be P0 or P1`);
      }
    }
  }
  if (value.provider !== undefined && typeof value.provider !== "string") {
    throw new Error(`${label}.provider must be a string`);
  }
  if (value.maxFindingsPerReview !== undefined) {
    validatePositiveInteger(value.maxFindingsPerReview, `${label}.maxFindingsPerReview`);
  }
}

function validateCalibrationLoopConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "observeSchedule") throw new Error(`${label} has unknown key "${key}"; expected only observeSchedule`);
  }
  if (value.observeSchedule !== undefined) validateObserveScheduleConfig(value.observeSchedule, `${label}.observeSchedule`);
}

function validateObserveScheduleConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  const allowed = new Set(["enabled", "intervalMinutes", "maxPullsPerCycle", "perRepoCooldownMinutes", "lookbackDays"]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new Error(`${label} has unknown key "${key}"; expected only enabled, intervalMinutes, maxPullsPerCycle, perRepoCooldownMinutes, lookbackDays`);
  }
  validateBoolean(value.enabled, `${label}.enabled`);
  validatePositiveInteger(value.intervalMinutes, `${label}.intervalMinutes`);
  validatePositiveInteger(value.maxPullsPerCycle, `${label}.maxPullsPerCycle`);
  validatePositiveInteger(value.perRepoCooldownMinutes, `${label}.perRepoCooldownMinutes`);
  validatePositiveInteger(value.lookbackDays, `${label}.lookbackDays`);
}

function validateRiskWeightedQueueConfig(value: unknown, label: string, backgroundPriority: number): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  if (value.elevatedPriority !== undefined) validateNonNegativeInteger(value.elevatedPriority, `${label}.elevatedPriority`);
  if (value.docsOnlyPriority !== undefined) validateNonNegativeInteger(value.docsOnlyPriority, `${label}.docsOnlyPriority`);
  if (value.enabled) {
    const elevatedPriority = value.elevatedPriority ?? Math.min(backgroundPriority, 10);
    const docsOnlyPriority = value.docsOnlyPriority ?? backgroundPriority;
    if (elevatedPriority > docsOnlyPriority) {
      throw new Error(`${label}.elevatedPriority must be <= ${label}.docsOnlyPriority because lower priority values lease sooner`);
    }
  }
  if (value.aging !== undefined) validateQueueAgingConfig(value.aging, `${label}.aging`);
}

function validateQueueAgingConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "maxWaitMinutes") {
      throw new Error(`${label} has unknown key "${key}"; expected only enabled or maxWaitMinutes`);
    }
  }
  validateBoolean(value.enabled, `${label}.enabled`);
  validatePositiveInteger(value.maxWaitMinutes, `${label}.maxWaitMinutes`);
}

const REVIEW_MODES: ReviewMode[] = ["light", "standard", "deep"];
const REVIEW_MODE_DEFINITION_KEYS = new Set(["selfConsistency", "contextAddons", "targetMinutes"]);
const REVIEW_MODES_TOP_KEYS = new Set(["enabled", "defaultMode", "modes", "routing"]);
const REVIEW_MODE_ROUTING_KEYS = new Set(["docsOnly", "elevatedSurfaces", "floorCalibratedCategories"]);

/**
 * Validate the reviewModes config (#266), fail-closed and demote-only:
 * - unknown keys anywhere are rejected;
 * - every mode key (light/standard/deep) must be present;
 * - a mode may only DEMOTE from base config — a mode that would enable selfConsistency when base has
 *   it off (or context add-ons when base has them off) is rejected at load, not silently ignored.
 */
function validateReviewModesConfig(value: unknown, label: string, config: BotConfig): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!REVIEW_MODES_TOP_KEYS.has(key)) {
      throw new Error(`${label} has unknown key "${key}"; expected only enabled, defaultMode, modes, or routing`);
    }
  }
  validateBoolean(value.enabled, `${label}.enabled`);
  if (!(REVIEW_MODES as string[]).includes(String(value.defaultMode))) {
    throw new Error(`${label}.defaultMode must be light, standard, or deep`);
  }
  if (!isRecord(value.modes)) throw new Error(`${label}.modes must be an object`);
  for (const key of Object.keys(value.modes)) {
    if (!(REVIEW_MODES as string[]).includes(key)) {
      throw new Error(`${label}.modes has unknown mode "${key}"; expected only light, standard, or deep`);
    }
  }
  const baseSelfConsistency = config.reviewGate?.selfConsistency?.enabled ?? false;
  const baseContextAddons = (config.repoWikiContext?.enabled ?? false) || (config.gitnexusContext?.enabled ?? false) || (config.githubRelatedContext?.enabled ?? false);
  const modes = value.modes as Record<string, unknown>;
  for (const mode of REVIEW_MODES) {
    // Distinguish an entirely ABSENT required mode key from a present-but-wrong-type value, so the
    // error matches the docstring ("every mode key must be present") instead of a generic type error.
    if (!(mode in modes)) throw new Error(`${label}.modes.${mode} is required`);
    validateReviewModeDefinition(modes[mode], `${label}.modes.${mode}`, baseSelfConsistency, baseContextAddons);
  }
  if (value.routing !== undefined) validateReviewModeRouting(value.routing, `${label}.routing`);
}

function validateReviewModeDefinition(
  value: unknown,
  label: string,
  baseSelfConsistency: boolean,
  baseContextAddons: boolean
): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!REVIEW_MODE_DEFINITION_KEYS.has(key)) {
      throw new Error(`${label} has unknown key "${key}"; expected only selfConsistency, contextAddons, or targetMinutes`);
    }
  }
  const definition = value as ReviewModeDefinition;
  if (definition.selfConsistency !== undefined) validateBoolean(definition.selfConsistency, `${label}.selfConsistency`);
  if (definition.contextAddons !== undefined) validateBoolean(definition.contextAddons, `${label}.contextAddons`);
  if (definition.targetMinutes !== undefined) validatePositiveInteger(definition.targetMinutes, `${label}.targetMinutes`);
  // Demote-only: a mode may only turn a stage OFF. Enabling a stage the base config has disabled is a
  // load-time error, so the router can never make the bot do MORE analysis than base config allows.
  if (definition.selfConsistency === true && !baseSelfConsistency) {
    throw new Error(`${label}.selfConsistency cannot be true when base config disables selfConsistency (modes are demote-only)`);
  }
  if (definition.contextAddons === true && !baseContextAddons) {
    throw new Error(`${label}.contextAddons cannot be true when base config disables context add-ons (modes are demote-only)`);
  }
}

function validateReviewModeRouting(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!REVIEW_MODE_ROUTING_KEYS.has(key)) {
      throw new Error(`${label} has unknown key "${key}"; expected only docsOnly, elevatedSurfaces, or floorCalibratedCategories`);
    }
    if (!(REVIEW_MODES as string[]).includes(String((value as Record<string, unknown>)[key]))) {
      throw new Error(`${label}.${key} must be light, standard, or deep`);
    }
  }
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

function validateRepoWikiContextConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.packetPath, `${label}.packetPath`);
  if (typeof value.packetPath !== "string" || value.packetPath.trim().length === 0) {
    throw new Error(`${label}.packetPath must be a non-empty string`);
  }
  const packetPathError = validateRelativePacketPath(value.packetPath);
  if (packetPathError) throw new Error(`${label}.packetPath ${packetPathError.replace(/^Repo wiki packetPath /, "")}`);
  validatePositiveInteger(value.maxPacketBytes, `${label}.maxPacketBytes`);
  validateBoolean(value.includeStaleContext, `${label}.includeStaleContext`);
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
  if (value.relevanceScoring !== undefined) {
    validateRelevanceScoringConfig(value.relevanceScoring, `${label}.relevanceScoring`);
  }
}

function validateRelevanceScoringConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (key !== "enabled" && key !== "weights") {
      throw new Error(`${label} has unknown key "${key}"; expected only enabled or weights`);
    }
  }
  validateBoolean(value.enabled, `${label}.enabled`);
  if (value.weights !== undefined) {
    if (!isRecord(value.weights)) throw new Error(`${label}.weights must be an object`);
    const allowed = new Set(["kind", "pathOverlap", "lexical", "recency", "state"]);
    for (const [key, weight] of Object.entries(value.weights)) {
      if (!allowed.has(key)) throw new Error(`${label}.weights has unknown key "${key}"`);
      if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0 || weight > 1) {
        throw new Error(`${label}.weights.${key} must be a number from 0 to 1`);
      }
    }
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
  validateStringArray(value.allowedLabels, `${label}.allowedLabels`);
  validateStringArray(value.allowedReviewers, `${label}.allowedReviewers`);
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
  validateOptionalStringArray(value.allowedLabels, `${label}.allowedLabels`);
  validateOptionalStringArray(value.allowedReviewers, `${label}.allowedReviewers`);
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

function validateLicenseConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  validateOptionalString(value.apiBaseUrl, `${label}.apiBaseUrl`);
  validateLicenseApiBaseUrl(value.apiBaseUrl, `${label}.apiBaseUrl`);
  if (value.enabled === true && typeof value.apiBaseUrl !== "string") {
    throw new Error(`${label}.apiBaseUrl is required when ${label}.enabled=true`);
  }
  validateOptionalString(value.cachePath, `${label}.cachePath`);
  if (typeof value.cachePath !== "string" || value.cachePath.trim().length === 0) {
    throw new Error(`${label}.cachePath must be a non-empty string`);
  }
  assertPathOutsideProtectedRoot({
    path: value.cachePath,
    protectedRoot: process.cwd(),
    protectedRoots: getProtectedCheckoutRoots(),
    pathLabel: `${label}.cachePath`,
    protectedRootLabel: "protected checkout root"
  });
  validateOptionalString(value.storageBackend, `${label}.storageBackend`);
  if (value.storageBackend !== "keychain" && value.storageBackend !== "file") {
    throw new Error(`${label}.storageBackend must be keychain or file`);
  }
  validateOptionalString(value.keyPath, `${label}.keyPath`);
  if (value.storageBackend === "file" && (typeof value.keyPath !== "string" || value.keyPath.trim().length === 0)) {
    throw new Error(`${label}.keyPath is required when ${label}.storageBackend=file`);
  }
  if (typeof value.keyPath === "string" && value.keyPath.trim().length > 0) {
    assertPathOutsideProtectedRoot({
      path: value.keyPath,
      protectedRoot: process.cwd(),
      protectedRoots: getProtectedCheckoutRoots(),
      pathLabel: `${label}.keyPath`,
      protectedRootLabel: "protected checkout root"
    });
  }
  validateOptionalString(value.keychainService, `${label}.keychainService`);
  validateOptionalString(value.keychainAccount, `${label}.keychainAccount`);
  if (typeof value.keychainService !== "string" || value.keychainService.trim().length === 0) {
    throw new Error(`${label}.keychainService must be a non-empty string`);
  }
  if (typeof value.keychainAccount !== "string" || value.keychainAccount.trim().length === 0) {
    throw new Error(`${label}.keychainAccount must be a non-empty string`);
  }
  validatePositiveInteger(value.requestTimeoutMs, `${label}.requestTimeoutMs`);
  validateNonNegativeInteger(value.offlineGraceMs, `${label}.offlineGraceMs`);
  const offlineGraceMs = value.offlineGraceMs as number;
  if (offlineGraceMs > MAX_LICENSE_OFFLINE_GRACE_MS) {
    throw new Error(`${label}.offlineGraceMs must be <= ${MAX_LICENSE_OFFLINE_GRACE_MS}`);
  }
  validateBoolean(value.publicReposFree, `${label}.publicReposFree`);
  validateBoolean(value.privateReposRequireEntitlement, `${label}.privateReposRequireEntitlement`);
  validateBoolean(value.updateEntitlementRequiresLicense, `${label}.updateEntitlementRequiresLicense`);
}

export function validateLicenseConfigOverride(value: LicenseConfig, label = "config.license"): void {
  validateLicenseConfig(value, label);
}

function validateLicenseApiBaseUrl(value: unknown, label: string): void {
  if (value === undefined) return;
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol === "https:") return;
  if (parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)) return;
  throw new Error(`${label} must use https unless it points to localhost/loopback for local testing`);
}

function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  const mappedIpv4 = ipv4MappedIpv6Address(normalized);
  return mappedIpv4 ? isLoopbackHost(mappedIpv4) : false;
}

function isUnsafeProviderHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (isLoopbackHost(hostname)) return false;
  if (
    normalized === "metadata" ||
    normalized === "metadata.google.internal" ||
    normalized === "metadata.azure.internal" ||
    normalized === "0.0.0.0" ||
    normalized === "169.254.169.254" ||
    normalized === "100.100.100.200"
  ) {
    return true;
  }
  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateOrLinkLocalIpv4(normalized);
  if (ipVersion === 6) return isPrivateOrLinkLocalIpv6(normalized);
  return false;
}

function isPrivateOrLinkLocalIpv4(value: string): boolean {
  const parts = value.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  return a === 10 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254) ||
    (a === 100 && b >= 64 && b <= 127);
}

function isPrivateOrLinkLocalIpv6(value: string): boolean {
  const mappedIpv4 = ipv4MappedIpv6Address(value);
  if (mappedIpv4) return isPrivateOrLinkLocalIpv4(mappedIpv4);
  const firstHextet = Number.parseInt(value.split(":")[0] ?? "", 16);
  return value === "::" ||
    value.startsWith("fc") ||
    value.startsWith("fd") ||
    (Number.isInteger(firstHextet) && firstHextet >= 0xfe80 && firstHextet <= 0xfebf);
}

function ipv4MappedIpv6Address(value: string): string | undefined {
  const normalized = value.toLowerCase();
  if (!normalized.startsWith("::ffff:")) return undefined;
  const suffix = normalized.slice("::ffff:".length);
  if (isIP(suffix) === 4) return suffix;
  const parts = suffix.split(":");
  if (parts.length !== 2) return undefined;
  const high = Number.parseInt(parts[0], 16);
  const low = Number.parseInt(parts[1], 16);
  if ([high, low].some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return undefined;
  return `${high >> 8}.${high & 0xff}.${low >> 8}.${low & 0xff}`;
}

function validateDesktopConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateOptionalString(value.openAICompatibleEndpoint, `${label}.openAICompatibleEndpoint`);
  validateOptionalString(value.updateChannel, `${label}.updateChannel`);
  if (typeof value.openAICompatibleEndpoint === "string" && value.openAICompatibleEndpoint.trim().length === 0) {
    throw new Error(`${label}.openAICompatibleEndpoint must not be empty`);
  }
  if (typeof value.updateChannel === "string" && value.updateChannel.trim().length === 0) {
    throw new Error(`${label}.updateChannel must not be empty`);
  }
}

function validateProviderRegistryConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateOptionalString(value.defaultProviderId, `${label}.defaultProviderId`);
  if (typeof value.defaultProviderId !== "string" || value.defaultProviderId.trim().length === 0) {
    throw new Error(`${label}.defaultProviderId must be a non-empty string`);
  }
  if (!isRecord(value.providers)) throw new Error(`${label}.providers must be an object`);
  if (!Object.prototype.hasOwnProperty.call(value.providers, value.defaultProviderId)) {
    throw new Error(`${label}.defaultProviderId must reference a configured provider`);
  }
  for (const [providerId, provider] of Object.entries(value.providers)) {
    validateProviderId(providerId, `${label}.providers`);
    validateProviderRegistryEntry(provider, `${label}.providers.${providerId}`);
  }
}

function validateProviderRegistryEntry(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  if (typeof value.adapter !== "string") throw new Error(`${label}.adapter must be a string`);
  if (typeof value.authMode !== "string") throw new Error(`${label}.authMode must be a string`);
  const adapter = value.adapter;
  const authMode = value.authMode;
  if (!["zcode", "openai-compatible", "anthropic", "openai", "gemini"].includes(adapter)) {
    throw new Error(`${label}.adapter must be zcode, openai-compatible, anthropic, openai, or gemini`);
  }
  validateOptionalString(value.displayName, `${label}.displayName`);
  validateOptionalString(value.baseUrl, `${label}.baseUrl`);
  if (typeof value.baseUrl === "string") validateProviderBaseUrl(value.baseUrl, `${label}.baseUrl`);
  validateOptionalString(value.model, `${label}.model`);
  if (typeof value.model !== "string" || value.model.trim().length === 0) throw new Error(`${label}.model must be a non-empty string`);
  if (!["zcode-app-config", "api-key-env", "none"].includes(authMode)) {
    throw new Error(`${label}.authMode must be zcode-app-config, api-key-env, or none`);
  }
  validateProviderAdapterAuthMode(adapter, authMode, label);
  validateOptionalString(value.apiKeyEnv, `${label}.apiKeyEnv`);
  if (typeof value.apiKeyEnv === "string" && !isApiKeyEnvName(value.apiKeyEnv)) {
    throw new Error(`${label}.apiKeyEnv must be an uppercase environment variable name, not a provider key`);
  }
  if (value.contextWindowTokens !== undefined) validatePositiveInteger(value.contextWindowTokens, `${label}.contextWindowTokens`);
  if (value.timeoutMs !== undefined) validatePositiveInteger(value.timeoutMs, `${label}.timeoutMs`);
  if (value.retryMaxRetries !== undefined) validateNonNegativeInteger(value.retryMaxRetries, `${label}.retryMaxRetries`);
  if (value.retrySchemaFeedbackMax !== undefined) {
    if (adapter !== "openai-compatible") {
      throw new Error(`${label}.retrySchemaFeedbackMax is only supported for openai-compatible providers`);
    }
    validateIntegerRange(value.retrySchemaFeedbackMax, `${label}.retrySchemaFeedbackMax`, 0, SCHEMA_FEEDBACK_RETRY_MAX);
  }
  if (value.structuredOutputMode !== undefined && !isProviderStructuredOutputMode(value.structuredOutputMode)) {
    throw new Error(`${label}.structuredOutputMode must be one of ${PROVIDER_STRUCTURED_OUTPUT_MODES.join(", ")}`);
  }
  if (!isRecord(value.capabilities)) throw new Error(`${label}.capabilities must be an object`);
  for (const capability of ["review", "jsonOutput", "local", "streaming"] as const) {
    validateBoolean(value.capabilities[capability], `${label}.capabilities.${capability}`);
  }
  if (typeof value.baseUrl === "string" && isLoopbackProviderBaseUrl(value.baseUrl) && value.capabilities.local !== true) {
    throw new Error(`${label}.capabilities.local must be true for loopback provider baseUrl`);
  }
  if (adapter === "openai-compatible" && value.enabled === true && typeof value.baseUrl !== "string") {
    throw new Error(`${label}.baseUrl is required when enabled openai-compatible provider`);
  }
  if (authMode === "api-key-env" && value.enabled === true && typeof value.apiKeyEnv !== "string") {
    throw new Error(`${label}.apiKeyEnv is required when enabled provider uses api-key-env`);
  }
}

function validateContextBudgetConfig(value: unknown, label: string): void {
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  validateBoolean(value.enabled, `${label}.enabled`);
  if (value.overflow !== "skip" && value.overflow !== "chunk") {
    throw new Error(`${label}.overflow must be skip or chunk`);
  }
  validatePositiveInteger(value.reservedOutputTokens, `${label}.reservedOutputTokens`);
  validatePositiveInteger(value.charsPerToken, `${label}.charsPerToken`);
  validatePositiveFiniteNumber(value.providerFudgeFactor, `${label}.providerFudgeFactor`);
  validatePositiveInteger(value.maxChunks, `${label}.maxChunks`);
}

function validateProviderAdapterAuthMode(adapter: string, authMode: string, label: string): void {
  const allowedByAdapter: Record<string, string[]> = {
    zcode: ["zcode-app-config"],
    "openai-compatible": ["api-key-env", "none"],
    anthropic: ["api-key-env"],
    openai: ["api-key-env"],
    gemini: ["api-key-env"]
  };
  if (!allowedByAdapter[adapter]?.includes(authMode)) {
    throw new Error(`${label}.authMode ${authMode} is not supported for ${adapter} provider`);
  }
}

function validateProviderId(value: string, label: string): void {
  if (!isProviderId(value)) {
    throw new Error(`${label} keys must be stable provider identifiers`);
  }
}

function validateProviderBaseUrl(value: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label} must use http or https`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not include username or password credentials`);
  if (containsSecretLikeText(decodeURIComponent(`${parsed.pathname}${parsed.hash}`))) {
    throw new Error(`${label} must not include secret-like path or fragment values`);
  }
  for (const key of parsed.searchParams.keys()) {
    if (/(key|token|secret|password|session|cookie)/i.test(key)) {
      throw new Error(`${label} must not include credential query parameters`);
    }
  }
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} must use https unless it points to localhost/loopback`);
  }
  if (isUnsafeProviderHost(parsed.hostname)) {
    throw new Error(`${label} must not point to private, link-local, or cloud metadata hosts`);
  }
}

function isLoopbackProviderBaseUrl(value: string): boolean {
  try {
    return isLoopbackHost(new URL(value).hostname);
  } catch {
    return false;
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
    validateRepoReviewSchedulerConfig(profile.reviewScheduler, `${label}.${key}.reviewScheduler`);
  }
}

function validateRepoReviewSchedulerConfig(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  if (value.maxActiveHeads !== undefined) validatePositiveInteger(value.maxActiveHeads, `${label}.maxActiveHeads`);
  if (value.maxQueuedHeads !== undefined) validatePositiveInteger(value.maxQueuedHeads, `${label}.maxQueuedHeads`);
  if (value.overflowAction !== undefined && value.overflowAction !== "defer" && value.overflowAction !== "skip") {
    throw new Error(`${label}.overflowAction must be "defer" or "skip"`);
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
  for (const field of [
    "docs",
    "docstrings",
    "unitTests",
    "simplifySuggestion",
    "changelogDraft",
    "riskExplanation",
    "reviewReady",
    "stackedPr"
  ] as const) {
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

function validateWorkRootIsolation(config: BotConfig): void {
  assertPathOutsideProtectedRoot({
    path: config.workRoot,
    protectedRoot: undefined,
    protectedRoots: getProtectedCheckoutRoots(),
    pathLabel: "config.workRoot",
    protectedRootLabel: "the current repository checkout"
  });
}

function validatePathInstructions(value: unknown, label: string): void {
  if (value === undefined) return;
  if (!isRecord(value)) throw new Error(`${label} must be an object`);
  for (const [pathPattern, instructions] of Object.entries(value)) {
    if (!pathPattern.trim()) throw new Error(`${label} keys must be non-empty path patterns`);
    validateStringArray(instructions, `${label}.${pathPattern}`);
  }
}

function validateNonEmptyString(value: unknown, label: string): void {
  if (typeof value !== "string" || value.trim().length === 0) throw new Error(`${label} must be a non-empty string`);
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

function validatePositiveFiniteNumber(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive finite number`);
  }
}

function validateIntegerRange(value: unknown, label: string, min: number, max: number): void {
  if (!Number.isInteger(value) || Number(value) < min || Number(value) > max) {
    throw new Error(`${label} must be an integer from ${min} to ${max}`);
  }
}

function validateProbability(value: unknown, label: string): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(`${label} must be a number from 0 to 1`);
  }
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
