import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "./config.js";
import { buildReviewBudgetStatus, type ReviewBudgetStatus } from "./review-budget.js";
import { containsSecretLikeText } from "./secrets.js";
import { parseProviderCooldownError, PROVIDER_COOLDOWN_ERROR_PREFIX } from "./state.js";
import { buildZCodeTimeoutInspectCommand, summarizeZCodeTimeoutErrors, ZCODE_TIMEOUT_ERROR_PREFIX } from "./zcode-timeout.js";
import type { BotConfig } from "./config.js";
import type { ReviewQueueJobRecord } from "./state.js";

export interface ReleaseRepoStatus {
  branch: string;
  head: string;
  dirtyFiles: string[];
}

export interface ReleaseLaunchdStatus {
  label: string;
  state: "running" | "not_running" | "unknown";
  pid?: number;
  configPath?: string;
  dryRun?: boolean;
  nodeOptions?: string;
  usesSystemCa?: boolean;
}

export interface ReleaseDatabaseStatus {
  rowCount: number;
  errorCount: number;
  skippedCount?: number;
  reviewerSessionCount?: number;
  activeReviewerSessionCount?: number;
  expiredReviewerSessionCount?: number;
  retryCoveredReviewerSessionCount?: number;
  reviewerSessionsByRepo?: ReviewerSessionRepoStatus[];
  providerCooldownCount?: number;
  activeProviderCooldownCount?: number;
  expiredProviderCooldownCount?: number;
  activeGlobalProviderCooldownCount?: number;
  coveredExpiredProviderCooldownCount?: number;
  coveredByActiveQueueRetryProviderCooldownCount?: number;
  retryableExpiredProviderCooldownCount?: number;
  providerThrottleState?: "none" | "active" | "expired_retryable";
  reviewQueueJobCount?: number;
  queuedReviewQueueJobCount?: number;
  leasedReviewQueueJobCount?: number;
  runningReviewQueueJobCount?: number;
  providerDeferredReviewQueueJobCount?: number;
  retryableProviderDeferredReviewQueueJobCount?: number;
  failedReviewQueueJobCount?: number;
  zcodeTimeoutFailedReviewQueueJobCount?: number;
  retryableZCodeTimeoutFailedReviewQueueJobCount?: number;
  exhaustedZCodeTimeoutFailedReviewQueueJobCount?: number;
  reviewRunLeaseCount?: number;
  staleReviewRunLeaseCount?: number;
  staleActiveReviewQueueJobCount?: number;
  reviewQueueJobsByRepo?: ReviewQueueRepoStatus[];
}

export interface ReviewerSessionRepoStatus {
  repo: string;
  total: number;
  active: number;
  expired: number;
  retryCovered?: number;
}

export interface ReviewQueueRepoStatus {
  repo: string;
  total: number;
  queued: number;
  leased: number;
  running: number;
  providerDeferred: number;
  retryableProviderDeferred: number;
  failed: number;
}

export interface ReleaseHeartbeatStatus {
  status: "fresh" | "active" | "stale" | "missing";
  maxAgeMs: number;
  activeMaxAgeMs?: number;
  latestAt?: string;
  ageMs?: number;
  cycle?: number;
  event?: string;
  dryRun?: boolean;
  activeCycle?: number;
  activeStartedAt?: string;
  activeAgeMs?: number;
}

export interface ReleaseStatusInput {
  repo: ReleaseRepoStatus;
  expectedHead?: string;
  configPath: string;
  launchd: ReleaseLaunchdStatus;
  database: ReleaseDatabaseStatus;
  heartbeat: ReleaseHeartbeatStatus;
  budget?: ReviewBudgetStatus;
  publicRelease?: PublicReleaseStatus;
  now?: Date;
}

export interface PublicReleaseStatus {
  manifestPath: string;
  ok: boolean;
  version: string;
  releaseLevel: string;
  releaseLevelGate: PublicReleaseGateStatus & {
    state: string;
  };
  docs: PublicReleaseGateStatus & {
    setupPath?: string;
    releaseNotesPath?: string;
    websiteRepo?: string;
    changelogPath?: string;
    changelogHeadVersion?: string;
    changelogReleaseNotesPath?: string;
  };
  licenseApi: PublicReleaseGateStatus & {
    requiredForThisRelease: boolean;
    state: string;
    trackingIssue?: string;
    healthUrl?: string;
    healthProofPath?: string;
    checkoutIssuanceRequiredForThisRelease?: boolean;
    checkoutIssuanceRequiredDeclaredForThisRelease?: boolean;
    checkoutIssuanceUrl?: string;
    checkoutIssuanceProofPath?: string;
    checkoutIssuanceAuthenticatedProofPath?: string;
    activationProofPath?: string;
    checkoutIssuanceState?: string;
    checkoutIssuanceTrackingIssue?: string;
  };
  updateChannels: {
    ok: boolean;
    channels: PublicReleaseChannelStatus[];
  };
}

export interface PublicReleaseGateStatus {
  ok: boolean;
  expectedVersion?: string;
  actualVersion?: string;
  detail: string;
}

export interface PublicReleaseChannelStatus {
  name: string;
  ok: boolean;
  state: string;
  requiredForThisRelease: boolean;
  version?: string;
  rollback?: string;
  rollbackRepository?: string;
  trackingIssue?: string;
  detail: string;
}

export interface ReleaseStatus {
  ok: boolean;
  checkedAt: string;
  summary: {
    blockingErrorRows: number;
    failedQueueJobs: number;
    staleReviewLeases: number;
    providerDeferredQueueJobs: number;
    retryableProviderDeferredQueueJobs: number;
    readyToRetryProviderDeferredJobs: number;
    zcodeTimeoutFailedQueueJobs?: number;
    retryableZCodeTimeoutFailedQueueJobs?: number;
    exhaustedZCodeTimeoutFailedQueueJobs?: number;
    expiredProviderCooldowns: number;
    retryableExpiredProviderCooldowns: number;
    activeProviderCooldowns: number;
  };
  releaseUnit: {
    channel: "local-beta";
    sourceHead: string;
    branch: string;
    configPath: string;
  };
  repo: ReleaseRepoStatus;
  launchd: ReleaseLaunchdStatus;
  database: ReleaseDatabaseStatus;
  heartbeat: ReleaseHeartbeatStatus;
  budget?: ReviewBudgetStatus;
  publicRelease?: PublicReleaseStatus;
  recommendedActions: string[];
  gates: Array<{ name: string; ok: boolean; detail: string }>;
  rollback: {
    restartCommand: string;
    unloadCommand: string;
  };
}

const REQUIRED_PUBLIC_UPDATE_CHANNELS = ["cli", "daemon"] as const;
const PUBLIC_RELEASE_LEVELS = new Set(["beta", "source-beta", "stable"]);
const MAX_PUBLIC_VERSION_TAG_LENGTH = 128;
const LICENSE_PROOF_MAX_AGE_DAYS = 30;
const LICENSE_PROOF_MAX_AGE_MS = LICENSE_PROOF_MAX_AGE_DAYS * 24 * 60 * 60 * 1_000;
const LICENSE_PROOF_MAX_FUTURE_SKEW_MS = 5 * 60 * 1_000;
const REQUIRED_PUBLIC_UPDATE_CHANNEL_STATES = new Set(["source_checkout", "launchd_prerelease", "healthy", "published"]);
const CHECKOUT_ISSUANCE_READY_STATE = "ready";
const CHECKOUT_ISSUANCE_DEFERRED_STATES = new Set(["deferred", "pending_secret_and_website_publish"]);
const CHECKOUT_ISSUANCE_STATES = new Set([
  CHECKOUT_ISSUANCE_READY_STATE,
  ...CHECKOUT_ISSUANCE_DEFERRED_STATES
]);
const CHECKOUT_ISSUANCE_LOOKUP_KEYS = new Set([
  "neondiff_monthly",
  "neondiff_yearly",
  "neondiff_org_yearly"
]);
const AUTHENTICATED_CHECKOUT_PROOF_FIELDS = new Set([
  "evidenceKind",
  "releaseVersion",
  "observedAt",
  "method",
  "url",
  "statusCode",
  "redactedResponse",
  "captureContext"
]);
const AUTHENTICATED_CHECKOUT_REDACTED_RESPONSE_FIELDS = new Set([
  "status",
  "replayed",
  "checkoutLookupKey",
  "issuedLicensePrefix",
  "issuedLicenseFingerprint"
]);
const GENERAL_OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATES = new Set([
  ...REQUIRED_PUBLIC_UPDATE_CHANNEL_STATES,
  "deferred",
  "disabled",
  "not_applicable",
  "pending"
]);
const OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATE_OVERRIDES = new Map([
  ["website", new Set([...GENERAL_OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATES, "pending-site-sync"])],
  ["desktop", new Set([...GENERAL_OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATES, "post_1_0"])]
]);

export function buildReleaseStatus(input: ReleaseStatusInput): ReleaseStatus {
  const expectedHeadOk = !input.expectedHead || input.repo.head === input.expectedHead;
  const branchOk = input.repo.branch === "main";
  const cleanOk = input.repo.dirtyFiles.length === 0;
  const launchdRunningOk = input.launchd.state === "running";
  const launchdConfigOk = input.launchd.configPath === input.configPath;
  const launchdSystemCaOk = input.launchd.usesSystemCa === true;
  const dbOk = input.database.errorCount === 0;
  const providerThrottleState = input.database.providerThrottleState ?? inferProviderThrottleState(input.database);
  const retryableExpiredProviderCooldownCount =
    input.database.retryableExpiredProviderCooldownCount ??
    Math.max(
      0,
      (input.database.expiredProviderCooldownCount ?? 0) - (input.database.coveredExpiredProviderCooldownCount ?? 0)
    );
  const expiredProviderCooldownOk = retryableExpiredProviderCooldownCount === 0;
  const failedQueueJobsOk = (input.database.failedReviewQueueJobCount ?? 0) === 0;
  const zcodeTimeoutFailedQueueJobCount = input.database.zcodeTimeoutFailedReviewQueueJobCount ?? 0;
  const retryableZCodeTimeoutFailedQueueJobCount = input.database.retryableZCodeTimeoutFailedReviewQueueJobCount ?? 0;
  const exhaustedZCodeTimeoutFailedQueueJobCount = input.database.exhaustedZCodeTimeoutFailedReviewQueueJobCount ?? 0;
  const zcodeTimeoutFailedQueueJobsOk = zcodeTimeoutFailedQueueJobCount === 0;
  const staleReviewLeaseCount = (input.database.staleReviewRunLeaseCount ?? 0) +
    (input.database.staleActiveReviewQueueJobCount ?? 0);
  const staleReviewLeasesOk = staleReviewLeaseCount === 0;
  const actionableProviderDeferredQueueJobs =
    input.budget?.providerDeferred.readyToRetry ??
    (input.database.retryableProviderDeferredReviewQueueJobCount ?? 0);
  const retryableDeferredQueueJobsOk = actionableProviderDeferredQueueJobs === 0;
  const heartbeatOk = input.heartbeat.status === "fresh" || input.heartbeat.status === "active";
  const retryProviderCooldownCommand =
    `npx tsx src/cli.ts retry-provider-cooldowns --config ${input.configPath} ` +
    "--expired-only true --dry-run false --zcode true";
  const inspectZCodeTimeoutCommand = buildZCodeTimeoutInspectCommand(input.configPath);
  const runtimeGates = [
    {
      name: "expected_head",
      ok: expectedHeadOk,
      detail: input.expectedHead ? `${input.repo.head} ${expectedHeadOk ? "==" : "!="} ${input.expectedHead}` : "not configured"
    },
    {
      name: "clean_checkout",
      ok: cleanOk,
      detail: cleanOk ? "clean" : `${input.repo.dirtyFiles.length} dirty file(s)`
    },
    {
      name: "release_branch",
      ok: branchOk,
      detail: input.repo.branch
    },
    {
      name: "launchd_running",
      ok: launchdRunningOk,
      detail: input.launchd.state
    },
    {
      name: "launchd_config",
      ok: launchdConfigOk,
      detail: input.launchd.configPath ?? "not detected"
    },
    {
      name: "launchd_node_system_ca",
      ok: launchdSystemCaOk,
      detail: input.launchd.usesSystemCa === undefined
        ? "NODE_OPTIONS not detected"
        : input.launchd.usesSystemCa
          ? "NODE_OPTIONS includes --use-system-ca"
          : "NODE_OPTIONS missing --use-system-ca"
    },
    {
      name: "live_db_no_errors",
      ok: dbOk,
      detail:
        `${input.database.errorCount} blocking error row(s)` +
        describeProviderCooldownCounts(input.database)
    },
    {
      name: "provider_cooldown_backlog",
      ok: expiredProviderCooldownOk,
      detail: expiredProviderCooldownOk
        ? describeProviderCooldownBacklog(input.database, providerThrottleState)
        : `${describeProviderCooldownBacklog(input.database, providerThrottleState)}; retry: ${retryProviderCooldownCommand}`
    },
    {
      name: "queue_no_failed_jobs",
      ok: failedQueueJobsOk,
      detail: `${input.database.failedReviewQueueJobCount ?? 0} failed durable queue job(s)`
    },
    {
      name: "queue_no_zcode_timeout_failed_jobs",
      ok: zcodeTimeoutFailedQueueJobsOk,
      detail:
        `${zcodeTimeoutFailedQueueJobCount} ZCode timeout failed durable queue job(s); ` +
        `retryable=${retryableZCodeTimeoutFailedQueueJobCount} exhausted=${exhaustedZCodeTimeoutFailedQueueJobCount}`
    },
    {
      name: "queue_no_stale_review_leases",
      ok: staleReviewLeasesOk,
      detail:
        `${input.database.staleReviewRunLeaseCount ?? 0} stale review run lease(s); ` +
        `${input.database.staleActiveReviewQueueJobCount ?? 0} stale active queue job(s)`
    },
    {
      name: "queue_no_retryable_provider_deferred_jobs",
      ok: retryableDeferredQueueJobsOk,
      detail: describeProviderDeferredQueueStatus(input.database, input.budget)
    },
    {
      name: "daemon_heartbeat_recent",
      ok: heartbeatOk,
      detail: describeHeartbeat(input.heartbeat)
    }
  ];
  const publicReleaseGates = input.publicRelease
    ? [
        {
          name: "public_release_level",
          ok: input.publicRelease.releaseLevelGate.ok,
          detail: input.publicRelease.releaseLevelGate.detail
        },
        {
          name: "public_docs_version",
          ok: input.publicRelease.docs.ok,
          detail: input.publicRelease.docs.detail
        },
        {
          name: "public_license_api_state",
          ok: input.publicRelease.licenseApi.ok,
          detail: input.publicRelease.licenseApi.detail
        },
        {
          name: "public_update_channels",
          ok: input.publicRelease.updateChannels.ok,
          detail: describePublicUpdateChannels(input.publicRelease.updateChannels.channels)
        }
      ]
    : [];
  const gates = [
    ...runtimeGates,
    ...publicReleaseGates
  ];

  return {
    ok: gates.every((gate) => gate.ok),
    checkedAt: (input.now ?? new Date()).toISOString(),
    summary: {
      blockingErrorRows: input.database.errorCount,
      failedQueueJobs: input.database.failedReviewQueueJobCount ?? 0,
      staleReviewLeases: staleReviewLeaseCount,
      providerDeferredQueueJobs: input.database.providerDeferredReviewQueueJobCount ?? 0,
      retryableProviderDeferredQueueJobs: input.database.retryableProviderDeferredReviewQueueJobCount ?? 0,
      readyToRetryProviderDeferredJobs: actionableProviderDeferredQueueJobs,
      zcodeTimeoutFailedQueueJobs: zcodeTimeoutFailedQueueJobCount,
      retryableZCodeTimeoutFailedQueueJobs: retryableZCodeTimeoutFailedQueueJobCount,
      exhaustedZCodeTimeoutFailedQueueJobs: exhaustedZCodeTimeoutFailedQueueJobCount,
      expiredProviderCooldowns: input.database.expiredProviderCooldownCount ?? 0,
      retryableExpiredProviderCooldowns: retryableExpiredProviderCooldownCount,
      activeProviderCooldowns: input.database.activeProviderCooldownCount ?? 0
    },
    releaseUnit: {
      channel: "local-beta",
      sourceHead: input.repo.head,
      branch: input.repo.branch,
      configPath: input.configPath
    },
    repo: input.repo,
    launchd: input.launchd,
    database: input.database,
    heartbeat: input.heartbeat,
    ...(input.budget ? { budget: input.budget } : {}),
    ...(input.publicRelease ? { publicRelease: input.publicRelease } : {}),
    recommendedActions: [
      ...(input.publicRelease && !input.publicRelease.ok
        ? [`inspect public release manifest ${input.publicRelease.manifestPath}`]
        : []),
      ...(expiredProviderCooldownOk
        ? retryableDeferredQueueJobsOk
          ? []
          : ["wait for the next scheduler cycle or inspect provider-deferred jobs marked ready_to_retry"]
        : [
            retryProviderCooldownCommand,
            `npx tsx src/cli.ts provider-cooldowns --config ${input.configPath} --expired-only true`
          ]),
      ...(!staleReviewLeasesOk
        ? [`npx tsx src/cli.ts clear-review-queue-leases --config ${input.configPath} --dry-run true --expired-only true`]
        : []),
      ...(!zcodeTimeoutFailedQueueJobsOk
        ? [inspectZCodeTimeoutCommand]
        : [])
    ],
    gates,
    rollback: {
      restartCommand: `launchctl kickstart -k gui/$(id -u)/${input.launchd.label}`,
      unloadCommand: `launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/${input.launchd.label}.plist`
    }
  };
}

export function collectReleaseStatus(input: {
  cwd: string;
  configPath?: string;
  expectedHead?: string;
  publicReleaseManifestPath?: string;
  expectedPublicVersion?: string;
  verifyPublicRollbackRefs?: boolean;
  launchdLabel?: string;
  statePath?: string;
  budgetDetails?: boolean;
  budgetDetailLimit?: number;
  budgetJobLimit?: number;
  now?: Date;
}): ReleaseStatus {
  const config = loadConfig(input.configPath);
  return collectReleaseStatusWithConfig(input, config);
}

export function collectReleaseStatusWithConfig(input: {
  cwd: string;
  configPath?: string;
  expectedHead?: string;
  publicReleaseManifestPath?: string;
  expectedPublicVersion?: string;
  verifyPublicRollbackRefs?: boolean;
  launchdLabel?: string;
  statePath?: string;
  budgetDetails?: boolean;
  budgetDetailLimit?: number;
  budgetJobLimit?: number;
  now?: Date;
}, config: BotConfig): ReleaseStatus {
  validatePublicReleaseManifestInputs(input);
  const configPath = input.configPath ?? "(default config)";
  const now = input.now ?? new Date();
  const statePath = input.statePath ?? config.statePath;
  return buildReleaseStatus({
    repo: readRepoStatus(input.cwd),
    expectedHead: input.expectedHead,
    configPath,
    launchd: readLaunchdStatus(input.launchdLabel ?? "com.electricsheephq.evaos-code-review-bot"),
    database: readDatabaseStatus(statePath, now, config.reviewConcurrency.leaseTtlMs),
    heartbeat: readHeartbeatStatus(
      statePath,
      config.pollIntervalMs * 2,
      Math.max(config.pollIntervalMs * 2, (config.zcode.timeoutMs * 2) + 60_000),
      now
    ),
    budget: readReviewBudgetStatus(statePath, config, now, {
      includeDetails: input.budgetDetails === true,
      detailLimit: input.budgetDetailLimit,
      jobLimit: input.budgetJobLimit ?? 1_000
    }),
    ...(input.publicReleaseManifestPath
      ? {
          publicRelease: readPublicReleaseManifestStatus({
            cwd: input.cwd,
            manifestPath: input.publicReleaseManifestPath,
            expectedVersion: input.expectedPublicVersion,
            verifyRollbackRefs: input.verifyPublicRollbackRefs === true,
            now
          })
        }
      : {}),
    now
  });
}

export function validatePublicReleaseManifestInputs(input: {
  publicReleaseManifestPath?: string;
  expectedPublicVersion?: string;
}): void {
  if (input.publicReleaseManifestPath && !input.expectedPublicVersion) {
    throw new Error("--expected-public-version is required when --public-release-manifest is provided");
  }
  if (input.expectedPublicVersion && !input.publicReleaseManifestPath) {
    throw new Error("--public-release-manifest is required when --expected-public-version is provided");
  }
  if (input.expectedPublicVersion && input.expectedPublicVersion.length > MAX_PUBLIC_VERSION_TAG_LENGTH) {
    throw new Error(`--expected-public-version is too long (max ${MAX_PUBLIC_VERSION_TAG_LENGTH} characters)`);
  }
  if (input.expectedPublicVersion && !isPublicVersionTag(input.expectedPublicVersion)) {
    throw new Error("--expected-public-version must be a semver tag like v1.0.0 or v1.0.0-beta.1");
  }
}

export function readPublicReleaseManifestStatus(input: {
  cwd: string;
  manifestPath: string;
  expectedVersion?: string;
  verifyRollbackRefs?: boolean;
  allowStaleActivationProof?: boolean;
  now?: Date;
}): PublicReleaseStatus {
  const absolutePath = resolve(input.cwd, input.manifestPath);
  if (!existsSync(absolutePath)) {
    return {
      manifestPath: input.manifestPath,
      ok: false,
      version: "(missing)",
      releaseLevel: "unknown",
      releaseLevelGate: {
        ok: false,
        state: "missing",
        detail: "release level missing because manifest is absent"
      },
      docs: {
        ok: false,
        expectedVersion: input.expectedVersion,
        detail: `public release manifest missing at ${input.manifestPath}`
      },
      licenseApi: {
        ok: false,
        requiredForThisRelease: true,
        state: "missing",
        detail: "license API state missing because manifest is absent"
      },
      updateChannels: {
        ok: false,
        channels: []
      }
    };
  }

  try {
    const manifest = JSON.parse(readFileSync(absolutePath, "utf8")) as unknown;
    const root = asRecord(manifest);
    const docs = asRecord(root.docs);
    const licenseApi = asRecord(root.licenseApi);
    const updateChannels = asRecord(root.updateChannels);
    const version = readString(root.version) ?? "(missing)";
    const expectedVersion = input.expectedVersion;
    const releaseLevel = readString(root.releaseLevel) ?? "unknown";
    const expectedVersionOk = expectedVersion !== undefined && isPublicVersionTag(expectedVersion);
    const releaseLevelOk = PUBLIC_RELEASE_LEVELS.has(releaseLevel);
    const docsVersion = readString(docs.version) ?? "(missing)";
    const setupPath = readString(docs.setupPath);
    const releaseNotesPath = readString(docs.releaseNotesPath);
    const changelog = readChangelogHead(input.cwd);
    const docsPathChecks = [
      setupPath
        ? { label: "setup", path: setupPath, exists: existsSync(resolve(input.cwd, setupPath)) }
        : { label: "setupPath", path: "(missing)", exists: false },
      releaseNotesPath
        ? { label: "release notes", path: releaseNotesPath, exists: existsSync(resolve(input.cwd, releaseNotesPath)) }
        : { label: "releaseNotesPath", path: "(missing)", exists: false }
    ];
    const missingDocsPaths = docsPathChecks.filter((pathCheck) => !pathCheck.exists);
    const manifestVersionOk = expectedVersionOk && version === expectedVersion;
    const docsVersionOk = expectedVersionOk && docsVersion === expectedVersion;
    const expectedReleaseNotesPath = expectedVersionOk ? `docs/releases/${expectedVersion}.md` : undefined;
    const releaseNotesPathOk = expectedReleaseNotesPath !== undefined && releaseNotesPath === expectedReleaseNotesPath;
    const expectedChangelogVersion = expectedVersionOk ? stripLeadingV(expectedVersion) : undefined;
    const changelogVersionOk =
      expectedChangelogVersion !== undefined &&
      changelog.version === expectedChangelogVersion;
    const changelogReleaseNotesPathOk =
      expectedReleaseNotesPath !== undefined &&
      changelog.releaseNotesPath === expectedReleaseNotesPath;
    const docsOk =
      expectedVersionOk &&
      manifestVersionOk &&
      docsVersionOk &&
      releaseNotesPathOk &&
      changelogVersionOk &&
      changelogReleaseNotesPathOk &&
      missingDocsPaths.length === 0;
    const licenseState = readString(licenseApi.state) ?? "missing";
    const licenseRequired = releaseLevel === "source-beta"
      ? (readBoolean(licenseApi.requiredForThisRelease) ?? true)
      : true;
    const licenseHealthProofPath = readString(licenseApi.healthProofPath);
    const licenseHealthUrl = readString(licenseApi.healthUrl);
    const explicitLicenseIssuanceRequired = readBoolean(licenseApi.checkoutIssuanceRequiredForThisRelease);
    const releaseLevelSupportsCheckoutIssuance =
      releaseLevel === "stable" || releaseLevel === "beta" || releaseLevel === "source-beta";
    const releaseRequiresCheckoutIssuance = releaseLevelSupportsCheckoutIssuance;
    // Only source-beta can explicitly defer checkout issuance. Stable and beta
    // releases force this gate on regardless of a false manifest declaration.
    const sourceBetaExplicitlyDefersCheckoutIssuance =
      explicitLicenseIssuanceRequired === false && releaseLevel === "source-beta";
    const licenseIssuanceRequired =
      releaseRequiresCheckoutIssuance && !sourceBetaExplicitlyDefersCheckoutIssuance;
    const licenseIssuanceUrl = readString(licenseApi.checkoutIssuanceUrl);
    const licenseIssuanceProofPath = readString(licenseApi.checkoutIssuanceProofPath);
    const licenseIssuanceAuthenticatedProofPath = readString(licenseApi.checkoutIssuanceAuthenticatedProofPath);
    const licenseActivationProofPath = readString(licenseApi.activationProofPath);
    const licenseIssuanceState = readString(licenseApi.checkoutIssuanceState);
    const licenseIssuanceTrackingIssue = readString(licenseApi.checkoutIssuanceTrackingIssue);
    const licenseNeedsHealthProof = licenseRequired && licenseState === "healthy";
    const licenseHealthMetadataFailures = validateLicenseHealthMetadata({
      cwd: input.cwd,
      healthUrl: licenseHealthUrl,
      healthProofPath: licenseHealthProofPath,
      proofRequired: licenseNeedsHealthProof
    });
    const licenseHealthProof = licenseNeedsHealthProof
      ? validateLicenseHealthProof({
          cwd: input.cwd,
          proofPath: licenseHealthProofPath,
          expectedReleaseVersion: expectedVersion,
          expectedUrl: licenseHealthUrl,
          now: input.now
        })
      : { ok: true, detail: "" };
    const licenseHealthProofOk = licenseHealthProof.ok;
    const licenseNeedsIssuanceProof = licenseIssuanceRequired;
    const licenseIssuanceMetadataFailures = validateLicenseIssuanceMetadata({
      cwd: input.cwd,
      issuanceUrl: licenseIssuanceUrl,
      issuanceProofPath: licenseIssuanceProofPath,
      issuanceState: licenseIssuanceState,
      issuanceTrackingIssue: licenseIssuanceTrackingIssue,
      proofRequired: licenseNeedsIssuanceProof,
      deferralPolicyApplies: releaseLevelSupportsCheckoutIssuance,
      issuanceRequiredExplicit: explicitLicenseIssuanceRequired,
      releaseLevel,
      healthUrl: licenseHealthUrl
    });
    const licenseIssuanceProof = licenseNeedsIssuanceProof
      ? validateLicenseIssuanceProof({
          cwd: input.cwd,
          proofPath: licenseIssuanceProofPath,
          expectedReleaseVersion: expectedVersion,
          expectedUrl: licenseIssuanceUrl,
          now: input.now
        })
      : { ok: true, detail: "" };
    const licenseIssuanceProofOk = licenseIssuanceProof.ok;
    const licenseNeedsAuthenticatedIssuanceProof = licenseNeedsIssuanceProof && releaseLevel === "stable";
    const licenseShouldValidateAuthenticatedIssuanceProof =
      licenseNeedsAuthenticatedIssuanceProof || licenseIssuanceAuthenticatedProofPath !== undefined;
    const licenseIssuanceAuthenticatedProof = licenseShouldValidateAuthenticatedIssuanceProof
      ? validateAuthenticatedLicenseIssuanceProof({
          cwd: input.cwd,
          proofPath: licenseIssuanceAuthenticatedProofPath,
          expectedReleaseVersion: expectedVersion,
          expectedUrl: licenseIssuanceUrl,
          now: input.now
        })
      : { ok: true, detail: "" };
    const licenseIssuanceAuthenticatedProofOk = licenseIssuanceAuthenticatedProof.ok;
    const licenseNeedsActivationProof = releaseLevel === "stable" && isVersionAtLeast(expectedVersion, "v1.0.4");
    const licenseActivationProof = licenseNeedsActivationProof
      ? validateMandatoryActivationProofPath({
          cwd: input.cwd,
          proofPath: licenseActivationProofPath,
          expectedReleaseVersion: expectedVersion,
          allowStaleProof: input.allowStaleActivationProof === true,
          now: input.now
        })
      : { ok: true, detail: "" };
    const licenseActivationProofOk = licenseActivationProof.ok;
    const licenseMetadataFailures = licenseHealthMetadataFailures.concat(licenseIssuanceMetadataFailures);
    const licenseMetadataOk = licenseMetadataFailures.length === 0;
    const licenseOk =
      isLicenseApiStateAcceptable(licenseState, licenseRequired) &&
      licenseMetadataOk &&
      licenseHealthProofOk &&
      licenseIssuanceProofOk &&
      licenseIssuanceAuthenticatedProofOk &&
      licenseActivationProofOk;
    const licenseDetailParts = [
      ...(licenseNeedsHealthProof ? [licenseHealthProof.detail] : []),
      ...(licenseNeedsIssuanceProof ? [licenseIssuanceProof.detail] : []),
      ...(licenseShouldValidateAuthenticatedIssuanceProof ? [licenseIssuanceAuthenticatedProof.detail] : []),
      ...(licenseNeedsActivationProof ? [licenseActivationProof.detail] : []),
      ...licenseMetadataFailures
    ].filter(Boolean);
    const declaredChannelNames = Object.keys(updateChannels);
    const channelNames = [
      ...REQUIRED_PUBLIC_UPDATE_CHANNELS,
      ...declaredChannelNames.filter((name) => !isRequiredPublicUpdateChannel(name))
    ];
    const channels = channelNames.map((name) =>
      buildPublicReleaseChannelStatus(name, asRecord(updateChannels[name]), {
        cwd: input.cwd,
        releaseLevel,
        verifyRollbackRefs: input.verifyRollbackRefs === true
      })
    );
    const channelsOk = channels.every((channel) => channel.ok);
    return {
      manifestPath: input.manifestPath,
      ok: releaseLevelOk && docsOk && licenseOk && channelsOk,
      version,
      releaseLevel,
      releaseLevelGate: {
        ok: releaseLevelOk,
        state: releaseLevel,
        detail: releaseLevelOk
          ? `release level ${releaseLevel}`
          : `release level ${releaseLevel} is not one of beta, source-beta, stable`
      },
      docs: {
        ok: docsOk,
        expectedVersion,
        actualVersion: docsVersion,
        setupPath,
        releaseNotesPath,
        changelogPath: changelog.path,
        changelogHeadVersion: changelog.version,
        changelogReleaseNotesPath: changelog.releaseNotesPath,
        websiteRepo: readString(docs.websiteRepo),
        detail: docsOk
          ? `manifest version ${version}, docs version ${docsVersion}, and CHANGELOG head ${changelog.version} match ${expectedVersion}; checked setup, release notes, and changelog paths`
          : [
              expectedVersion
                ? manifestVersionOk
                  ? `manifest version ${version} matches ${expectedVersion}`
                  : expectedVersionOk
                    ? `manifest version ${version} does not match ${expectedVersion}`
                    : "--expected-public-version must be a semver tag like v1.0.0 or v1.0.0-beta.1"
                : "--expected-public-version is required",
              ...(expectedVersion
                ? [
                    docsVersionOk
                      ? `docs version ${docsVersion} matches ${expectedVersion}`
                      : `docs version ${docsVersion} does not match ${expectedVersion}`
                  ]
                : []),
              ...(releaseNotesPath && expectedReleaseNotesPath && !releaseNotesPathOk
                ? [`release notes path ${releaseNotesPath} does not match ${expectedReleaseNotesPath}`]
                : []),
              ...(expectedVersion
                ? [
                    changelogVersionOk
                      ? `CHANGELOG head ${changelog.version} matches ${expectedChangelogVersion}`
                      : `CHANGELOG head ${changelog.version ?? "(missing)"} does not match ${expectedChangelogVersion}`
                  ]
                : []),
              ...(changelog.releaseNotesPath && expectedReleaseNotesPath && !changelogReleaseNotesPathOk
                ? [`CHANGELOG release notes path ${changelog.releaseNotesPath} does not match ${expectedReleaseNotesPath}`]
                : []),
              ...(!changelog.exists ? [`CHANGELOG missing at ${changelog.path}`] : []),
              ...missingDocsPaths.map((pathCheck) => `${pathCheck.label} missing at ${pathCheck.path}`)
            ].join("; ")
      },
      licenseApi: {
        ok: licenseOk,
        requiredForThisRelease: licenseRequired,
        state: licenseState,
        trackingIssue: readString(licenseApi.trackingIssue),
        healthUrl: licenseHealthUrl,
        healthProofPath: licenseHealthProofPath,
        checkoutIssuanceRequiredForThisRelease: licenseIssuanceRequired,
        checkoutIssuanceRequiredDeclaredForThisRelease: explicitLicenseIssuanceRequired,
        checkoutIssuanceUrl: licenseIssuanceUrl,
        checkoutIssuanceProofPath: licenseIssuanceProofPath,
        checkoutIssuanceAuthenticatedProofPath: licenseIssuanceAuthenticatedProofPath,
        activationProofPath: licenseActivationProofPath,
        checkoutIssuanceState: licenseIssuanceState,
        checkoutIssuanceTrackingIssue: licenseIssuanceTrackingIssue,
        detail: licenseOk
          ? `license API state ${licenseState}; requiredForThisRelease=${licenseRequired}${
              licenseDetailParts.length ? `; ${licenseDetailParts.join("; ")}` : ""
            }`
          : `license API state ${licenseState} blocks this release; requiredForThisRelease=${licenseRequired}${
              licenseDetailParts.length
                ? `; ${licenseDetailParts.join("; ")}`
                : ""
            }`
      },
      updateChannels: {
        ok: channelsOk,
        channels
      }
    };
  } catch (error) {
    return {
      manifestPath: input.manifestPath,
      ok: false,
      version: "(invalid)",
      releaseLevel: "unknown",
      releaseLevelGate: {
        ok: false,
        state: "invalid",
        detail: "release level unavailable because manifest is invalid"
      },
      docs: {
        ok: false,
        expectedVersion: input.expectedVersion,
        detail: `public release manifest is invalid JSON: ${error instanceof Error ? error.message : String(error)}`
      },
      licenseApi: {
        ok: false,
        requiredForThisRelease: true,
        state: "invalid",
        detail: "license API state unavailable because manifest is invalid"
      },
      updateChannels: {
        ok: false,
        channels: []
      }
    };
  }
}

function buildPublicReleaseChannelStatus(
  name: string,
  channel: Record<string, unknown>,
  options: { cwd?: string; releaseLevel: string; verifyRollbackRefs?: boolean }
): PublicReleaseChannelStatus {
  const state = readString(channel.state) ?? "missing";
  const requiredForThisRelease =
    isRequiredPublicUpdateChannel(name) ||
    options.releaseLevel !== "source-beta" ||
    (readBoolean(channel.requiredForThisRelease) ?? true);
  const version = readString(channel.version);
  const rollback = readString(channel.rollback);
  const rollbackRepository = readString(channel.rollbackRepository);
  const trackingIssue = readString(channel.trackingIssue);
  const stateOk = isUpdateChannelStateAcceptable(name, state, requiredForThisRelease);
  const rollbackCheck = rollback ? checkRollbackCommand(rollback, { ...options, rollbackRepository }) : { ok: false, missingMetadata: "rollback command" };
  const missingRequiredMetadata = [
    ...(requiredForThisRelease && !version ? ["version"] : []),
    ...(requiredForThisRelease && !rollbackCheck.ok ? [rollbackCheck.missingMetadata] : [])
  ];
  const metadataOk = missingRequiredMetadata.length === 0;
  const ok = stateOk && metadataOk;
  return {
    name,
    ok,
    state,
    requiredForThisRelease,
    version,
    rollback,
    rollbackRepository,
    trackingIssue,
    detail: ok
      ? `${name} state ${state}; requiredForThisRelease=${requiredForThisRelease}`
      : `${name} state ${state} blocks this release; requiredForThisRelease=${requiredForThisRelease}${
          missingRequiredMetadata.length ? `; missing ${missingRequiredMetadata.join(", ")}` : ""
        }`
  };
}

function describePublicUpdateChannels(channels: PublicReleaseChannelStatus[]): string {
  if (channels.length === 0) return "no public update channels declared";
  return channels
    .map((channel) =>
      `${channel.name}=${channel.state}${channel.ok ? "" : " [BLOCKED]"}${channel.requiredForThisRelease ? "" : " (not required)"}`
    )
    .join("; ");
}

function isRequiredPublicUpdateChannel(name: string): boolean {
  return REQUIRED_PUBLIC_UPDATE_CHANNELS.includes(name as typeof REQUIRED_PUBLIC_UPDATE_CHANNELS[number]);
}

function checkRollbackCommand(
  rollback: string,
  options: { cwd?: string; verifyRollbackRefs?: boolean; rollbackRepository?: string }
): { ok: boolean; missingMetadata: "rollback command" | "rollback target" } {
  if (/\s*(?:&&|\|\||;)\s*/.test(rollback)) return { ok: false, missingMetadata: "rollback command" };
  const command = rollback.trim();
  const resetTarget = command.match(/^git\s+reset\s+--hard\s+([^\s;&|]+)$/)?.[1];
  if (resetTarget) return checkRollbackTarget(resetTarget, options);
  const revertTarget = command.match(/^git\s+revert\s+(?:--no-edit\s+)?([^\s;&|]+)$/)?.[1];
  if (revertTarget) return checkRollbackTarget(revertTarget, options);
  return { ok: false, missingMetadata: "rollback command" };
}

function checkRollbackTarget(
  target: string,
  options: { cwd?: string; verifyRollbackRefs?: boolean; rollbackRepository?: string }
): { ok: boolean; missingMetadata: "rollback command" | "rollback target" } {
  const targetFormatOk = isRollbackVersionTagRef(target) || /^[0-9a-f]{40}$/i.test(target);
  if (!targetFormatOk) return { ok: false, missingMetadata: "rollback command" };
  if (options.verifyRollbackRefs !== true) return { ok: true, missingMetadata: "rollback command" };
  if (options.rollbackRepository && options.cwd) {
    const currentRepository = readCurrentGitHubRepository(options.cwd);
    const packageRepository = readPackageGitHubRepository(options.cwd);
    if (!currentRepository && !packageRepository) {
      return { ok: false, missingMetadata: "rollback target" };
    }
    if (options.rollbackRepository !== currentRepository && options.rollbackRepository !== packageRepository) {
      return { ok: true, missingMetadata: "rollback command" };
    }
  }
  if (!options.cwd || !isGitWorktree(options.cwd)) return { ok: false, missingMetadata: "rollback target" };
  return gitCommitishExists(options.cwd, target)
    ? { ok: true, missingMetadata: "rollback command" }
    : { ok: false, missingMetadata: "rollback target" };
}

function readCurrentGitHubRepository(cwd: string): string | undefined {
  try {
    return normalizeGitHubRepository(git(cwd, ["config", "--get", "remote.origin.url"]));
  } catch {
    return undefined;
  }
}

function readPackageGitHubRepository(cwd: string): string | undefined {
  try {
    const pkg = JSON.parse(readFileSync(resolve(cwd, "package.json"), "utf8")) as unknown;
    const repository = asRecord(pkg).repository;
    if (typeof repository === "string") return normalizeGitHubRepository(repository);
    const repositoryUrl = readString(asRecord(repository).url);
    return repositoryUrl ? normalizeGitHubRepository(repositoryUrl) : undefined;
  } catch {
    return undefined;
  }
}

function normalizeGitHubRepository(remoteUrl: string): string | undefined {
  const withoutGitSuffix = remoteUrl.trim().replace(/\.git$/, "");
  const sshMatch = withoutGitSuffix.match(/^git@github\.com:([^/]+\/[^/]+)$/);
  if (sshMatch) return sshMatch[1];
  const httpsMatch = withoutGitSuffix.match(/^(?:git\+)?https:\/\/(?:[^/@]+@)?github\.com\/([^/]+\/[^/]+)$/);
  if (httpsMatch) return httpsMatch[1];
  return undefined;
}

function isPublicVersionTag(version: string): boolean {
  if (version.length > MAX_PUBLIC_VERSION_TAG_LENGTH) return false;
  if (!version.startsWith("v")) return false;
  return isSemver(version.slice(1));
}

function isVersionAtLeast(version: string | undefined, minimum: string): boolean {
  const parseCore = (value: string | undefined): [number, number, number] | undefined => {
    const match = value?.match(/^v(\d+)\.(\d+)\.(\d+)(?:[-+]|$)/);
    if (!match) return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const actual = parseCore(version);
  const floor = parseCore(minimum);
  if (!actual || !floor) return false;
  for (let index = 0; index < actual.length; index += 1) {
    if (actual[index] !== floor[index]) return actual[index] > floor[index];
  }
  return true;
}

function isRollbackVersionTagRef(target: string): boolean {
  const prefix = "refs/tags/";
  return target.startsWith(prefix) && isPublicVersionTag(target.slice(prefix.length));
}

function isSemver(version: string): boolean {
  const buildIndex = version.indexOf("+");
  const withoutBuild = buildIndex === -1 ? version : version.slice(0, buildIndex);
  const build = buildIndex === -1 ? undefined : version.slice(buildIndex + 1);
  if (build !== undefined && !isDotSeparatedBuildMetadata(build)) return false;

  const prereleaseIndex = withoutBuild.indexOf("-");
  const core = prereleaseIndex === -1 ? withoutBuild : withoutBuild.slice(0, prereleaseIndex);
  const prerelease = prereleaseIndex === -1 ? undefined : withoutBuild.slice(prereleaseIndex + 1);
  const coreParts = core.split(".");
  if (coreParts.length !== 3 || !coreParts.every(isSemverNumericIdentifier)) return false;
  return prerelease === undefined || isDotSeparatedPrerelease(prerelease);
}

function isDotSeparatedPrerelease(value: string): boolean {
  const parts = value.split(".");
  return parts.length > 0 && parts.every((part) =>
    part.length > 0 &&
    isSemverIdentifier(part) &&
    (!isAllAsciiDigits(part) || isSemverNumericIdentifier(part))
  );
}

function isDotSeparatedBuildMetadata(value: string): boolean {
  const parts = value.split(".");
  return parts.length > 0 && parts.every((part) => part.length > 0 && isSemverIdentifier(part));
}

function isSemverNumericIdentifier(value: string): boolean {
  if (!isAllAsciiDigits(value)) return false;
  return value === "0" || !value.startsWith("0");
}

function isAllAsciiDigits(value: string): boolean {
  if (value.length === 0) return false;
  for (const char of value) {
    if (char < "0" || char > "9") return false;
  }
  return true;
}

function isSemverIdentifier(value: string): boolean {
  for (const char of value) {
    if (
      (char >= "0" && char <= "9") ||
      (char >= "A" && char <= "Z") ||
      (char >= "a" && char <= "z") ||
      char === "-"
    ) {
      continue;
    }
    return false;
  }
  return true;
}

function isGitWorktree(cwd: string): boolean {
  try {
    return execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"]
    }).trim() === "true";
  } catch {
    return false;
  }
}

function gitCommitishExists(cwd: string, target: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--verify", `${target}^{commit}`], {
      cwd,
      stdio: "ignore"
    });
    return true;
  } catch {
    return false;
  }
}

function isLicenseApiStateAcceptable(state: string, requiredForThisRelease: boolean): boolean {
  if (requiredForThisRelease) return state === "healthy";
  return state === "healthy" || state === "not_applicable" || state === "disabled" || state === "pending";
}

function validateLicenseProofObservedAt(observedAt: string | undefined, now?: Date): string[] {
  if (!observedAt) return ["observedAt must be a valid ISO timestamp"];
  const observedAtMs = Date.parse(observedAt);
  if (Number.isNaN(observedAtMs)) return ["observedAt must be a valid ISO timestamp"];

  const failures: string[] = [];
  const nowMs = (now ?? new Date()).getTime();
  if (observedAtMs > nowMs + LICENSE_PROOF_MAX_FUTURE_SKEW_MS) {
    failures.push("observedAt must not be more than 5 minutes in the future");
  }
  if (nowMs - observedAtMs > LICENSE_PROOF_MAX_AGE_MS) {
    failures.push(`observedAt must be no older than ${LICENSE_PROOF_MAX_AGE_DAYS} days`);
  }
  return failures;
}

function validateMandatoryActivationProofPath(input: {
  cwd: string;
  proofPath?: string;
  expectedReleaseVersion?: string;
  allowStaleProof?: boolean;
  now?: Date;
}): { ok: boolean; detail: string } {
  if (!input.proofPath) {
    return { ok: false, detail: "missing mandatory activation proof path (no activationProofPath declared)" };
  }
  const confinedPath = resolveConfinedEvidenceProofPath(input.cwd, input.proofPath, "activationProofPath");
  if (!confinedPath.ok) {
    return { ok: false, detail: `invalid mandatory activation proof ${input.proofPath}: ${confinedPath.detail}` };
  }
  if (!existsSync(confinedPath.absolutePath)) {
    return { ok: false, detail: `missing mandatory activation proof ${input.proofPath}` };
  }
  let proof: Record<string, unknown>;
  let serialized: string;
  try {
    serialized = readFileSync(confinedPath.absolutePath, "utf8");
    proof = asRecord(JSON.parse(serialized));
  } catch {
    return { ok: false, detail: `invalid mandatory activation proof ${input.proofPath}: proof JSON is invalid` };
  }

  const installedCandidate = asRecord(proof.installedCandidate);
  const productionLifecycle = asRecord(proof.productionLifecycle);
  const matrix = asRecord(proof.matrix);
  const desktop = asRecord(proof.desktop);
  const redaction = asRecord(proof.redaction);
  const failures: string[] = [];
  const requireTrue = (value: unknown, field: string): void => {
    if (value !== true) failures.push(`${field} must be true`);
  };
  const requireZero = (value: unknown, field: string): void => {
    if (value !== 0) failures.push(`${field} must be zero`);
  };
  const requireSha256 = (value: unknown, field: string): void => {
    if (!/^[a-f0-9]{64}$/.test(readString(value) ?? "")) failures.push(`${field} must be a SHA-256 digest`);
  };

  const unexpectedTopLevelKeys = collectUnexpectedKeys(proof, new Set([
    "evidenceKind",
    "releaseVersion",
    "observedAt",
    "harness",
    "installedCandidate",
    "productionLifecycle",
    "matrix",
    "installUpgrade",
    "dashboard",
    "desktop",
    "redaction",
    "artifacts"
  ]));
  if (unexpectedTopLevelKeys.length) failures.push(`unexpected proof fields: ${unexpectedTopLevelKeys.join(", ")}`);

  if (readString(proof.evidenceKind) !== "mandatory_activation_no_bypass") {
    failures.push("evidenceKind must be mandatory_activation_no_bypass");
  }
  if (!input.expectedReleaseVersion) {
    failures.push("expected releaseVersion must be present");
  } else if (readString(proof.releaseVersion) !== input.expectedReleaseVersion) {
    failures.push(`releaseVersion must match ${input.expectedReleaseVersion}`);
  }
  const observedAt = readString(proof.observedAt);
  const observedAtFailures = validateLicenseProofObservedAt(observedAt, input.now);
  failures.push(...(input.allowStaleProof
    ? observedAtFailures.filter((failure) => !failure.startsWith("observedAt must be no older than"))
    : observedAtFailures));
  if (observedAt && !input.allowStaleProof) {
    const observedAtMs = Date.parse(observedAt);
    const effectiveNow = input.now ?? new Date();
    if (!Number.isNaN(observedAtMs) && effectiveNow.getTime() - observedAtMs > 24 * 60 * 60 * 1_000) {
      failures.push("observedAt must be no older than 24 hours for mandatory activation proof");
    }
  }

  const harness = asRecord(proof.harness);
  const unexpectedHarnessKeys = collectUnexpectedKeys(harness, new Set(["name", "version", "sourceHead", "runId"]));
  if (unexpectedHarnessKeys.length) failures.push(`unexpected harness fields: ${unexpectedHarnessKeys.join(", ")}`);
  if (readString(harness.name) !== "neondiff-license-lifecycle-smoke") {
    failures.push("harness.name must be neondiff-license-lifecycle-smoke");
  }
  if (harness.version !== 1) failures.push("harness.version must be 1");
  if (!/^[a-f0-9]{40}$/.test(readString(harness.sourceHead) ?? "")) {
    failures.push("harness.sourceHead must be a full lowercase Git SHA");
  }
  if (!/^[a-f0-9]{64}$/.test(readString(harness.runId) ?? "")) {
    failures.push("harness.runId must be a SHA-256 run identity");
  }

  const packageVersion = input.expectedReleaseVersion?.slice(1);
  const unexpectedInstalledKeys = collectUnexpectedKeys(installedCandidate, new Set([
    "packageVersion",
    "binaryVersion",
    "sourceHead",
    "packShasum",
    "packIntegrity",
    "installSource"
  ]));
  if (unexpectedInstalledKeys.length) failures.push(`unexpected installedCandidate fields: ${unexpectedInstalledKeys.join(", ")}`);
  if (!packageVersion || readString(installedCandidate.packageVersion) !== packageVersion) {
    failures.push(`installedCandidate.packageVersion must match ${packageVersion ?? "the release version"}`);
  }
  if (readString(installedCandidate.binaryVersion) !== packageVersion) {
    failures.push(`installedCandidate.binaryVersion must match ${packageVersion ?? "the release version"}`);
  }
  if (!/^[a-f0-9]{40}$/.test(readString(installedCandidate.sourceHead) ?? "")) {
    failures.push("installedCandidate.sourceHead must be a full lowercase Git SHA");
  }
  if (!/^[a-f0-9]{40}$/.test(readString(installedCandidate.packShasum) ?? "")) {
    failures.push("installedCandidate.packShasum must be the npm pack SHA-1 digest");
  }
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(readString(installedCandidate.packIntegrity) ?? "")) {
    failures.push("installedCandidate.packIntegrity must be the npm pack SHA-512 integrity");
  }
  if (readString(installedCandidate.installSource) !== "npm_pack_tarball") {
    failures.push("installedCandidate.installSource must be npm_pack_tarball");
  }
  if (readString(harness.sourceHead) !== readString(installedCandidate.sourceHead)) {
    failures.push("harness.sourceHead must match installedCandidate.sourceHead");
  }

  const unexpectedLifecycleKeys = collectUnexpectedKeys(productionLifecycle, new Set(["apiBaseUrl", "licenseFingerprint", "steps"]));
  if (unexpectedLifecycleKeys.length) failures.push(`unexpected productionLifecycle fields: ${unexpectedLifecycleKeys.join(", ")}`);
  if (readString(productionLifecycle.apiBaseUrl) !== "https://neondiff-license.fly.dev") {
    failures.push("productionLifecycle.apiBaseUrl must be the official production API");
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(readString(productionLifecycle.licenseFingerprint) ?? "")) {
    failures.push("productionLifecycle.licenseFingerprint must be a redacted SHA-256 fingerprint");
  }

  const lifecycleRequirements = new Map<string, { outcome: string; statusCode: number }>([
    ["issue", { outcome: "succeeded", statusCode: 200 }],
    ["activate", { outcome: "succeeded", statusCode: 200 }],
    ["validate_active", { outcome: "succeeded", statusCode: 200 }],
    ["deactivate", { outcome: "succeeded", statusCode: 200 }],
    ["validate_denied", { outcome: "denied", statusCode: 409 }]
  ]);
  const lifecycleSteps = Array.isArray(productionLifecycle.steps) ? productionLifecycle.steps : [];
  const lifecycleById = new Map<string, Record<string, unknown>>();
  for (const rawStep of lifecycleSteps) {
    const step = asRecord(rawStep);
    const id = readString(step.id);
    const unexpectedStepKeys = collectUnexpectedKeys(step, new Set(["id", "outcome", "statusCode", "apiBaseUrl", "redactedResponse", "responseSha256"]));
    if (unexpectedStepKeys.length) failures.push(`unexpected productionLifecycle step fields: ${unexpectedStepKeys.join(", ")}`);
    if (!id || lifecycleById.has(id)) {
      failures.push("productionLifecycle.steps must have unique named steps");
      continue;
    }
    lifecycleById.set(id, step);
  }
  for (const [id, requirement] of lifecycleRequirements) {
    const step = lifecycleById.get(id);
    if (!step) {
      failures.push(`productionLifecycle.steps must include ${id}`);
      continue;
    }
    if (step.outcome !== requirement.outcome) failures.push(`productionLifecycle.${id}.outcome must be ${requirement.outcome}`);
    if (step.statusCode !== requirement.statusCode) failures.push(`productionLifecycle.${id}.statusCode must be ${requirement.statusCode}`);
    if (step.apiBaseUrl !== "https://neondiff-license.fly.dev") failures.push(`productionLifecycle.${id}.apiBaseUrl must be the official production API`);
    requireSha256(step.responseSha256, `productionLifecycle.${id}.responseSha256`);
  }
  for (const id of lifecycleById.keys()) {
    if (!lifecycleRequirements.has(id)) failures.push(`unexpected productionLifecycle step id: ${id}`);
  }

  const unexpectedMatrixKeys = collectUnexpectedKeys(matrix, new Set(["bypassAllowedCases", "scenarios"]));
  if (unexpectedMatrixKeys.length) failures.push(`unexpected matrix fields: ${unexpectedMatrixKeys.join(", ")}`);
  requireZero(matrix.bypassAllowedCases, "matrix.bypassAllowedCases");
  const requiredAllowedScenarioIds = new Set(["public_active", "private_active"]);
  const requiredDeniedScenarioIds = new Set([
    "unknown_repo",
    "public_denied",
    "private_denied",
    "missing_key",
    "missing_api_url",
    "offline",
    "timeout",
    "forged_cache",
    "mismatched_cache",
    "disabled_policy_attempt",
    "fake_api",
    "rate_limited",
    "server_error",
    "malformed_response",
    "revoked",
    "expired",
    "dashboard_provider_pre_activation"
  ]);
  const scenarios = Array.isArray(matrix.scenarios) ? matrix.scenarios : [];
  const scenarioIds = new Set<string>();
  for (const rawScenario of scenarios) {
    const scenario = asRecord(rawScenario);
    const id = readString(scenario.id);
    const unexpectedScenarioKeys = collectUnexpectedKeys(scenario, new Set(["id", "visibility", "expected", "actual", "sideEffects", "resultSha256"]));
    if (unexpectedScenarioKeys.length) failures.push(`unexpected matrix scenario fields: ${unexpectedScenarioKeys.join(", ")}`);
    if (!id || scenarioIds.has(id)) {
      failures.push("matrix.scenarios must have unique named scenarios");
      continue;
    }
    scenarioIds.add(id);
    const expectedOutcome = requiredAllowedScenarioIds.has(id) ? "allowed" : requiredDeniedScenarioIds.has(id) ? "denied" : undefined;
    if (!expectedOutcome) {
      failures.push(`unexpected matrix scenario id: ${id}`);
      continue;
    }
    if (scenario.expected !== expectedOutcome) failures.push(`matrix.${id}.expected must be ${expectedOutcome}`);
    if (scenario.actual !== expectedOutcome) failures.push(`matrix.${id}.actual must be ${expectedOutcome}`);
    const expectedVisibility = id === "public_active" || id === "public_denied"
      ? "public"
      : id === "private_active" || id === "private_denied"
        ? "private"
        : id === "unknown_repo"
          ? "unknown"
          : "not_applicable";
    if (scenario.visibility !== expectedVisibility) failures.push(`matrix.${id}.visibility must be ${expectedVisibility}`);
    requireSha256(scenario.resultSha256, `matrix.${id}.resultSha256`);
    const sideEffects = asRecord(scenario.sideEffects);
    const unexpectedSideEffectKeys = collectUnexpectedKeys(sideEffects, new Set(["providerCalls", "checkoutCalls", "worktreeWrites", "reviewPosts"]));
    if (unexpectedSideEffectKeys.length) failures.push(`unexpected matrix.${id}.sideEffects fields: ${unexpectedSideEffectKeys.join(", ")}`);
    requireZero(sideEffects.providerCalls, `matrix.${id}.sideEffects.providerCalls`);
    requireZero(sideEffects.checkoutCalls, `matrix.${id}.sideEffects.checkoutCalls`);
    requireZero(sideEffects.worktreeWrites, `matrix.${id}.sideEffects.worktreeWrites`);
    requireZero(sideEffects.reviewPosts, `matrix.${id}.sideEffects.reviewPosts`);
  }
  for (const id of [...requiredAllowedScenarioIds, ...requiredDeniedScenarioIds]) {
    if (!scenarioIds.has(id)) failures.push(`matrix.scenarios must include ${id}`);
  }

  const installUpgrade = asRecord(proof.installUpgrade);
  const unexpectedInstallUpgradeKeys = collectUnexpectedKeys(installUpgrade, new Set([
    "freshInstallPassed",
    "upgradedFromVersion",
    "upgradePassed",
    "resultSha256"
  ]));
  if (unexpectedInstallUpgradeKeys.length) failures.push(`unexpected installUpgrade fields: ${unexpectedInstallUpgradeKeys.join(", ")}`);
  requireTrue(installUpgrade.freshInstallPassed, "installUpgrade.freshInstallPassed");
  if (installUpgrade.upgradedFromVersion !== "1.0.3") failures.push("installUpgrade.upgradedFromVersion must be 1.0.3");
  requireTrue(installUpgrade.upgradePassed, "installUpgrade.upgradePassed");
  requireSha256(installUpgrade.resultSha256, "installUpgrade.resultSha256");

  const dashboard = asRecord(proof.dashboard);
  const unexpectedDashboardKeys = collectUnexpectedKeys(dashboard, new Set([
    "setupBlockedBeforeActivation",
    "providerBlockedBeforeActivation",
    "activatedStatusVisible",
    "resultSha256"
  ]));
  if (unexpectedDashboardKeys.length) failures.push(`unexpected dashboard fields: ${unexpectedDashboardKeys.join(", ")}`);
  requireTrue(dashboard.setupBlockedBeforeActivation, "dashboard.setupBlockedBeforeActivation");
  requireTrue(dashboard.providerBlockedBeforeActivation, "dashboard.providerBlockedBeforeActivation");
  requireTrue(dashboard.activatedStatusVisible, "dashboard.activatedStatusVisible");
  requireSha256(dashboard.resultSha256, "dashboard.resultSha256");

  const unexpectedDesktopKeys = collectUnexpectedKeys(desktop, new Set(["brokerUnavailable", "usefulWorkBlocked", "resultSha256"]));
  if (unexpectedDesktopKeys.length) failures.push(`unexpected desktop fields: ${unexpectedDesktopKeys.join(", ")}`);
  requireTrue(desktop.brokerUnavailable, "desktop.brokerUnavailable");
  requireTrue(desktop.usefulWorkBlocked, "desktop.usefulWorkBlocked");
  requireSha256(desktop.resultSha256, "desktop.resultSha256");

  const unexpectedRedactionKeys = collectUnexpectedKeys(redaction, new Set(["rawLicenseKeyAbsent", "bearerTokenAbsent", "privatePathsAbsent"]));
  if (unexpectedRedactionKeys.length) failures.push(`unexpected redaction fields: ${unexpectedRedactionKeys.join(", ")}`);
  requireTrue(redaction.rawLicenseKeyAbsent, "redaction.rawLicenseKeyAbsent");
  requireTrue(redaction.bearerTokenAbsent, "redaction.bearerTokenAbsent");
  requireTrue(redaction.privatePathsAbsent, "redaction.privatePathsAbsent");
  const requiredArtifactKinds = new Set(["production-lifecycle", "no-bypass-matrix", "dashboard", "desktop", "install-upgrade"]);
  const artifacts = Array.isArray(proof.artifacts) ? proof.artifacts : [];
  const observedArtifactKinds = new Set<string>();
  const observedArtifactRefs = new Set<string>();
  const artifactRecordsByKind = new Map<string, unknown[]>();
  for (const rawArtifact of artifacts) {
    const artifact = asRecord(rawArtifact);
    const unexpectedArtifactKeys = collectUnexpectedKeys(artifact, new Set(["kind", "ref", "sha256"]));
    if (unexpectedArtifactKeys.length) failures.push(`unexpected artifact fields: ${unexpectedArtifactKeys.join(", ")}`);
    const kind = readString(artifact.kind);
    const ref = readString(artifact.ref);
    const sha256 = readString(artifact.sha256);
    if (!kind || !requiredArtifactKinds.has(kind) || observedArtifactKinds.has(kind)) {
      failures.push("artifacts must contain each required kind exactly once");
      continue;
    }
    observedArtifactKinds.add(kind);
    requireSha256(sha256, `artifacts.${kind}.sha256`);
    if (!ref) {
      failures.push(`artifacts.${kind}.ref must be present`);
      continue;
    }
    if (observedArtifactRefs.has(ref)) {
      failures.push("artifact refs must be unique");
      continue;
    }
    observedArtifactRefs.add(ref);
    const artifactPath = resolveConfinedEvidenceProofPath(input.cwd, ref, "activationProofPath");
    if (!artifactPath.ok || !existsSync(artifactPath.absolutePath)) {
      failures.push(`artifacts.${kind}.ref must resolve within docs/evidence`);
      continue;
    }
    const artifactBytes = readFileSync(artifactPath.absolutePath);
    if (sha256 && createHash("sha256").update(artifactBytes).digest("hex") !== sha256) {
      failures.push(`artifacts.${kind}.sha256 must match the referenced artifact`);
    }
    const artifactText = artifactBytes.toString("utf8");
    if (containsSecretLikeText(artifactText) || /nd_live_[A-Za-z0-9_-]+|Bearer\s+\S+|\/Volumes\/|\/Users\//.test(artifactText)) {
      failures.push(`artifacts.${kind} contains secret-like text or a private absolute path`);
    }
    let artifactDocument: Record<string, unknown>;
    try {
      artifactDocument = asRecord(JSON.parse(artifactText));
    } catch {
      failures.push(`artifacts.${kind} must be valid JSON`);
      continue;
    }
    const unexpectedArtifactDocumentKeys = collectUnexpectedKeys(artifactDocument, new Set([
      "evidenceKind",
      "releaseVersion",
      "candidateHead",
      "packShasum",
      "packIntegrity",
      "harnessRunId",
      "records"
    ]));
    if (unexpectedArtifactDocumentKeys.length) {
      failures.push(`unexpected artifacts.${kind} document fields: ${unexpectedArtifactDocumentKeys.join(", ")}`);
    }
    if (artifactDocument.evidenceKind !== kind) failures.push(`artifacts.${kind}.evidenceKind must match its declared kind`);
    if (artifactDocument.releaseVersion !== input.expectedReleaseVersion) failures.push(`artifacts.${kind}.releaseVersion must match the release`);
    if (artifactDocument.candidateHead !== installedCandidate.sourceHead) failures.push(`artifacts.${kind}.candidateHead must match installedCandidate.sourceHead`);
    if (artifactDocument.packShasum !== installedCandidate.packShasum) failures.push(`artifacts.${kind}.packShasum must match installedCandidate.packShasum`);
    if (artifactDocument.packIntegrity !== installedCandidate.packIntegrity) failures.push(`artifacts.${kind}.packIntegrity must match installedCandidate.packIntegrity`);
    if (artifactDocument.harnessRunId !== harness.runId) failures.push(`artifacts.${kind}.harnessRunId must match harness.runId`);
    if (!Array.isArray(artifactDocument.records)) {
      failures.push(`artifacts.${kind}.records must be an array`);
    } else {
      artifactRecordsByKind.set(kind, artifactDocument.records);
    }
  }
  for (const kind of requiredArtifactKinds) {
    if (!observedArtifactKinds.has(kind)) failures.push(`artifacts must include ${kind}`);
  }
  const digestRecord = (record: Record<string, unknown>): string =>
    createHash("sha256").update(JSON.stringify(record)).digest("hex");
  const lifecycleArtifactRecords = artifactRecordsByKind.get("production-lifecycle") ?? [];
  const lifecycleArtifactById = new Map<string, Record<string, unknown>>();
  for (const rawRecord of lifecycleArtifactRecords) {
    const record = asRecord(rawRecord);
    const id = readString(record.id);
    const unexpectedRecordKeys = collectUnexpectedKeys(record, new Set(["id", "outcome", "statusCode", "apiBaseUrl", "redactedResponse"]));
    if (unexpectedRecordKeys.length) failures.push(`unexpected production-lifecycle record fields: ${unexpectedRecordKeys.join(", ")}`);
    if (!id || lifecycleArtifactById.has(id)) failures.push("production-lifecycle records must have unique ids");
    else lifecycleArtifactById.set(id, record);
  }
  for (const [id, step] of lifecycleById) {
    const record = lifecycleArtifactById.get(id);
    if (!record) {
      failures.push(`production-lifecycle artifact must include ${id}`);
      continue;
    }
    if (record.outcome !== step.outcome || record.statusCode !== step.statusCode || record.apiBaseUrl !== step.apiBaseUrl || JSON.stringify(record.redactedResponse) !== JSON.stringify(step.redactedResponse)) {
      failures.push(`production-lifecycle artifact record ${id} must match the aggregate proof`);
    }
    if (step.responseSha256 !== digestRecord(asRecord(record.redactedResponse))) failures.push(`productionLifecycle.${id}.responseSha256 must match its redacted artifact response`);
  }

  const matrixArtifactRecords = artifactRecordsByKind.get("no-bypass-matrix") ?? [];
  const matrixArtifactById = new Map<string, Record<string, unknown>>();
  for (const rawRecord of matrixArtifactRecords) {
    const record = asRecord(rawRecord);
    const id = readString(record.id);
    const unexpectedRecordKeys = collectUnexpectedKeys(record, new Set(["id", "visibility", "expected", "actual", "sideEffects"]));
    if (unexpectedRecordKeys.length) failures.push(`unexpected no-bypass-matrix record fields: ${unexpectedRecordKeys.join(", ")}`);
    if (!id || matrixArtifactById.has(id)) failures.push("no-bypass-matrix records must have unique ids");
    else matrixArtifactById.set(id, record);
  }
  for (const rawScenario of scenarios) {
    const scenario = asRecord(rawScenario);
    const id = readString(scenario.id);
    if (!id) continue;
    const record = matrixArtifactById.get(id);
    if (!record) {
      failures.push(`no-bypass-matrix artifact must include ${id}`);
      continue;
    }
    if (record.visibility !== scenario.visibility || record.expected !== scenario.expected || record.actual !== scenario.actual || JSON.stringify(record.sideEffects) !== JSON.stringify(scenario.sideEffects)) {
      failures.push(`no-bypass-matrix artifact record ${id} must match the aggregate proof`);
    }
    if (scenario.resultSha256 !== digestRecord(record)) failures.push(`matrix.${id}.resultSha256 must match its artifact record`);
  }

  const validateSingleRecordArtifact = (
    kind: "dashboard" | "desktop" | "install-upgrade",
    aggregate: Record<string, unknown>,
    hashField: string,
    allowedRecordKeys: Set<string>
  ): void => {
    const records = artifactRecordsByKind.get(kind) ?? [];
    if (records.length !== 1) {
      failures.push(`artifacts.${kind}.records must contain exactly one record`);
      return;
    }
    const record = asRecord(records[0]);
    const unexpectedRecordKeys = collectUnexpectedKeys(record, allowedRecordKeys);
    if (unexpectedRecordKeys.length) failures.push(`unexpected ${kind} record fields: ${unexpectedRecordKeys.join(", ")}`);
    for (const key of allowedRecordKeys) {
      if (record[key] !== aggregate[key]) failures.push(`${kind} artifact record must match aggregate field ${key}`);
    }
    if (aggregate[hashField] !== digestRecord(record)) failures.push(`${kind}.${hashField} must match its artifact record`);
  };
  validateSingleRecordArtifact(
    "dashboard",
    dashboard,
    "resultSha256",
    new Set(["setupBlockedBeforeActivation", "providerBlockedBeforeActivation", "activatedStatusVisible"])
  );
  validateSingleRecordArtifact("desktop", desktop, "resultSha256", new Set(["brokerUnavailable", "usefulWorkBlocked"]));
  validateSingleRecordArtifact(
    "install-upgrade",
    installUpgrade,
    "resultSha256",
    new Set(["freshInstallPassed", "upgradedFromVersion", "upgradePassed"])
  );
  if (containsSecretLikeText(serialized)) failures.push("proof contains secret-like text");
  if (/nd_live_[A-Za-z0-9_-]+|Bearer\s+\S+|\/Volumes\/|\/Users\//.test(serialized)) {
    failures.push("proof must not contain raw license keys, bearer values, or private absolute paths");
  }

  return failures.length
    ? { ok: false, detail: `invalid mandatory activation proof ${input.proofPath}: ${failures.join("; ")}` }
    : { ok: true, detail: `validated mandatory activation proof ${input.proofPath}` };
}

function validateLicenseHealthProof(input: {
  cwd: string;
  proofPath?: string;
  expectedReleaseVersion?: string;
  expectedUrl?: string;
  now?: Date;
}): { ok: boolean; detail: string } {
  if (!input.proofPath) return { ok: false, detail: "missing health proof path (no healthProofPath declared)" };
  const confinedPath = resolveConfinedHealthProofPath(input.cwd, input.proofPath);
  if (!confinedPath.ok) return { ok: false, detail: `invalid health proof ${input.proofPath}: ${confinedPath.detail}` };
  const absolutePath = confinedPath.absolutePath;
  if (!existsSync(absolutePath)) return { ok: false, detail: `missing health proof ${input.proofPath}` };

  let proof: Record<string, unknown>;
  try {
    proof = asRecord(JSON.parse(readFileSync(absolutePath, "utf8")));
  } catch {
    return { ok: false, detail: `invalid health proof ${input.proofPath}: proof JSON is invalid` };
  }

  const evidenceKind = readString(proof.evidenceKind);
  const releaseVersion = readString(proof.releaseVersion);
  const observedAt = readString(proof.observedAt);
  const method = readString(proof.method);
  const url = readString(proof.url);
  const statusCode = typeof proof.statusCode === "number" ? proof.statusCode : undefined;
  const responseBody = typeof proof.responseBody === "string" ? proof.responseBody : undefined;
  const responseBodySha256 = readString(proof.responseBodySha256);
  const captureContext = asRecord(proof.captureContext);
  const captureTool = readString(captureContext.tool);
  const captureTransport = readString(captureContext.transport);
  const captureTlsValidation = readString(captureContext.tlsValidation);
  const captureHost = readString(captureContext.capturedFrom);
  const failures: string[] = [];

  if (evidenceKind !== "license_api_healthz") failures.push("evidenceKind must be license_api_healthz");
  if (!input.expectedReleaseVersion) {
    failures.push("expected releaseVersion must be present");
  } else if (releaseVersion !== input.expectedReleaseVersion) {
    failures.push(`releaseVersion must match ${input.expectedReleaseVersion}`);
  }
  if (!input.expectedUrl) {
    failures.push("healthUrl must be present when validating health proof");
  } else if (url !== input.expectedUrl) {
    failures.push(`url must match ${input.expectedUrl}`);
  }
  if (method !== "GET") failures.push("method must be GET");
  if (statusCode !== 200) failures.push("statusCode must be 200");
  failures.push(...validateLicenseProofObservedAt(observedAt, input.now));
  if (responseBody === undefined) {
    failures.push("responseBody must be present");
  }
  if (!responseBodySha256) {
    failures.push("responseBodySha256 must be present");
  } else if (responseBody !== undefined && createHash("sha256").update(responseBody).digest("hex") !== responseBodySha256) {
    failures.push("responseBodySha256 must match responseBody");
  }
  if (!captureTool) failures.push("captureContext.tool must be present");
  if (!captureTransport) failures.push("captureContext.transport must be present");
  if (!captureTlsValidation) failures.push("captureContext.tlsValidation must be present");
  if (!captureHost) failures.push("captureContext.capturedFrom must be present");

  return failures.length
    ? { ok: false, detail: `invalid health proof ${input.proofPath}: ${failures.join("; ")}` }
    : { ok: true, detail: `validated health proof ${input.proofPath}` };
}

function validateLicenseIssuanceProof(input: {
  cwd: string;
  proofPath?: string;
  expectedReleaseVersion?: string;
  expectedUrl?: string;
  now?: Date;
}): { ok: boolean; detail: string } {
  if (!input.proofPath) return { ok: false, detail: "missing checkout issuance proof path (no checkoutIssuanceProofPath declared)" };
  const confinedPath = resolveConfinedEvidenceProofPath(input.cwd, input.proofPath, "checkoutIssuanceProofPath");
  if (!confinedPath.ok) return { ok: false, detail: `invalid checkout issuance proof ${input.proofPath}: ${confinedPath.detail}` };
  const absolutePath = confinedPath.absolutePath;
  if (!existsSync(absolutePath)) return { ok: false, detail: `missing checkout issuance proof ${input.proofPath}` };

  let proof: Record<string, unknown>;
  try {
    proof = asRecord(JSON.parse(readFileSync(absolutePath, "utf8")));
  } catch {
    return { ok: false, detail: `invalid checkout issuance proof ${input.proofPath}: proof JSON is invalid` };
  }

  const evidenceKind = readString(proof.evidenceKind);
  const releaseVersion = readString(proof.releaseVersion);
  const observedAt = readString(proof.observedAt);
  const method = readString(proof.method);
  const url = readString(proof.url);
  const statusCode = typeof proof.statusCode === "number" ? proof.statusCode : undefined;
  const responseBody = typeof proof.responseBody === "string" ? proof.responseBody : undefined;
  const responseBodySha256 = readString(proof.responseBodySha256);
  const captureContext = asRecord(proof.captureContext);
  const captureTool = readString(captureContext.tool);
  const captureTransport = readString(captureContext.transport);
  const captureTlsValidation = readString(captureContext.tlsValidation);
  const captureHost = readString(captureContext.capturedFrom);
  const failures: string[] = [];

  if (evidenceKind !== "license_api_checkout_issuance") failures.push("evidenceKind must be license_api_checkout_issuance");
  if (!input.expectedReleaseVersion) {
    failures.push("expected releaseVersion must be present");
  } else if (releaseVersion !== input.expectedReleaseVersion) {
    failures.push(`releaseVersion must match ${input.expectedReleaseVersion}`);
  }
  if (!input.expectedUrl) {
    failures.push("checkoutIssuanceUrl must be present when validating checkout issuance proof");
  } else if (url !== input.expectedUrl) {
    failures.push(`url must match ${input.expectedUrl}`);
  }
  if (method !== "POST") failures.push("method must be POST");
  // This manifest proof is the no-secret release gate: unauthenticated issuance
  // must fail closed. Authenticated issuance smoke uses owner-held secrets and
  // belongs in the deploy runbook/evidence lane, not committed manifest JSON.
  if (statusCode !== 401) failures.push("statusCode must be 401");
  failures.push(...validateLicenseProofObservedAt(observedAt, input.now));
  if (responseBody === undefined) {
    failures.push("responseBody must be present");
  }
  if (!responseBodySha256) {
    failures.push("responseBodySha256 must be present");
  } else if (responseBody !== undefined && createHash("sha256").update(responseBody).digest("hex") !== responseBodySha256) {
    failures.push("responseBodySha256 must match responseBody");
  }
  if (responseBody !== undefined) {
    try {
      const body = asRecord(JSON.parse(responseBody));
      if (readString(body.status) !== "unauthorized") failures.push("responseBody.status must be unauthorized");
    } catch {
      failures.push("responseBody must be JSON");
    }
  }
  if (!captureTool) failures.push("captureContext.tool must be present");
  if (!captureTransport) failures.push("captureContext.transport must be present");
  if (!captureTlsValidation) failures.push("captureContext.tlsValidation must be present");
  if (!captureHost) failures.push("captureContext.capturedFrom must be present");

  return failures.length
    ? { ok: false, detail: `invalid checkout issuance proof ${input.proofPath}: ${failures.join("; ")}` }
    : { ok: true, detail: `validated checkout issuance proof ${input.proofPath}` };
}

function validateAuthenticatedLicenseIssuanceProof(input: {
  cwd: string;
  proofPath?: string;
  expectedReleaseVersion?: string;
  expectedUrl?: string;
  now?: Date;
}): { ok: boolean; detail: string } {
  if (!input.proofPath) {
    return {
      ok: false,
      detail: "missing authenticated checkout issuance proof path (no checkoutIssuanceAuthenticatedProofPath declared)"
    };
  }
  if (containsSecretLikeText(input.proofPath)) {
    return {
      ok: false,
      detail: "invalid authenticated checkout issuance proof path: checkoutIssuanceAuthenticatedProofPath must not contain secret-like text"
    };
  }
  const confinedPath = resolveConfinedEvidenceProofPath(input.cwd, input.proofPath, "checkoutIssuanceAuthenticatedProofPath");
  if (!confinedPath.ok) {
    return { ok: false, detail: `invalid authenticated checkout issuance proof ${input.proofPath}: ${confinedPath.detail}` };
  }
  const absolutePath = confinedPath.absolutePath;
  if (!existsSync(absolutePath)) return { ok: false, detail: `missing authenticated checkout issuance proof ${input.proofPath}` };

  let proof: Record<string, unknown>;
  try {
    proof = asRecord(JSON.parse(readFileSync(absolutePath, "utf8")));
  } catch {
    return { ok: false, detail: `invalid authenticated checkout issuance proof ${input.proofPath}: proof JSON is invalid` };
  }

  const evidenceKind = readString(proof.evidenceKind);
  const releaseVersion = readString(proof.releaseVersion);
  const observedAt = readString(proof.observedAt);
  const method = readString(proof.method);
  const url = readString(proof.url);
  const statusCode = typeof proof.statusCode === "number" ? proof.statusCode : undefined;
  const redactedResponse = asRecord(proof.redactedResponse);
  const responseStatus = readString(redactedResponse.status);
  const replayed = typeof redactedResponse.replayed === "boolean" ? redactedResponse.replayed : undefined;
  const checkoutLookupKey = readString(redactedResponse.checkoutLookupKey);
  const issuedLicensePrefix = readString(redactedResponse.issuedLicensePrefix);
  const issuedLicenseFingerprint = readString(redactedResponse.issuedLicenseFingerprint);
  const captureContext = asRecord(proof.captureContext);
  const captureTool = readString(captureContext.tool);
  const captureTransport = readString(captureContext.transport);
  const captureTlsValidation = readString(captureContext.tlsValidation);
  const captureHost = readString(captureContext.capturedFrom);
  const failures: string[] = [];
  const unexpectedProofKeys = collectUnexpectedKeys(proof, AUTHENTICATED_CHECKOUT_PROOF_FIELDS);
  const unexpectedRedactedResponseKeys = collectUnexpectedKeys(
    redactedResponse,
    AUTHENTICATED_CHECKOUT_REDACTED_RESPONSE_FIELDS
  );

  if (evidenceKind !== "license_api_checkout_issuance_authenticated") {
    failures.push("evidenceKind must be license_api_checkout_issuance_authenticated");
  }
  if (unexpectedProofKeys.length > 0) failures.push("proof must contain only allowed top-level fields");
  if (unexpectedRedactedResponseKeys.length > 0) failures.push("redactedResponse must contain only allowed fields");
  if (!input.expectedReleaseVersion) {
    failures.push("expected releaseVersion must be present");
  } else if (releaseVersion !== input.expectedReleaseVersion) {
    failures.push(`releaseVersion must match ${input.expectedReleaseVersion}`);
  }
  if (!input.expectedUrl) {
    failures.push("checkoutIssuanceUrl must be present when validating authenticated checkout issuance proof");
  } else if (url !== input.expectedUrl) {
    failures.push(`url must match ${input.expectedUrl}`);
  }
  if (method !== "POST") failures.push("method must be POST");
  if (statusCode !== 200) failures.push("statusCode must be 200");
  failures.push(...validateLicenseProofObservedAt(observedAt, input.now));
  if (!isPlainRecord(proof.redactedResponse)) failures.push("redactedResponse must be present");
  if (responseStatus !== "issued") failures.push("redactedResponse.status must be issued");
  if (replayed === undefined) failures.push("redactedResponse.replayed must be boolean");
  if (!checkoutLookupKey || !CHECKOUT_ISSUANCE_LOOKUP_KEYS.has(checkoutLookupKey)) {
    failures.push(`redactedResponse.checkoutLookupKey must be one of ${Array.from(CHECKOUT_ISSUANCE_LOOKUP_KEYS).join(", ")}`);
  }
  if (issuedLicensePrefix !== "nd_live_") failures.push("redactedResponse.issuedLicensePrefix must be nd_live_");
  if (!issuedLicenseFingerprint || !/^sha256:[a-f0-9]{64}$/.test(issuedLicenseFingerprint)) {
    failures.push("redactedResponse.issuedLicenseFingerprint must be sha256:<64 lowercase hex chars>");
  }
  if (Object.prototype.hasOwnProperty.call(proof, "responseBody")) {
    failures.push("responseBody must be omitted from authenticated proof");
  }
  if (Object.prototype.hasOwnProperty.call(proof, "responseBodySha256")) {
    failures.push("responseBodySha256 must be omitted from authenticated proof");
  }
  const forbiddenKeys = collectForbiddenAuthenticatedProofKeys(proof);
  if (forbiddenKeys.length > 0) {
    failures.push("proof must omit sensitive field names");
  }
  const serializedProof = JSON.stringify(proof);
  if (/LICENSE_ISSUANCE_SECRET/i.test(serializedProof)) {
    failures.push("proof must not mention owner-held issuance secret names");
  }
  if (/\bBearer\s+[A-Za-z0-9._~+/=-]+/i.test(serializedProof) || containsSecretLikeText(serializedProof)) {
    failures.push("proof must not contain secret-like text");
  }
  if (!captureTool) failures.push("captureContext.tool must be present");
  if (!captureTransport) failures.push("captureContext.transport must be present");
  if (!captureTlsValidation) failures.push("captureContext.tlsValidation must be present");
  if (!captureHost) failures.push("captureContext.capturedFrom must be present");

  return failures.length
    ? { ok: false, detail: `invalid authenticated checkout issuance proof ${input.proofPath}: ${failures.join("; ")}` }
    : { ok: true, detail: `validated authenticated checkout issuance proof ${input.proofPath}` };
}

function validateLicenseHealthMetadata(input: {
  cwd: string;
  healthUrl?: string;
  healthProofPath?: string;
  proofRequired: boolean;
}): string[] {
  const failures: string[] = [];
  if (input.healthUrl) {
    const healthUrlFailure = validateLicenseHealthUrl(input.healthUrl);
    if (healthUrlFailure) failures.push(healthUrlFailure);
  }
  if (input.healthProofPath && !input.proofRequired) {
    const confinedPath = resolveConfinedHealthProofPath(input.cwd, input.healthProofPath);
    if (!confinedPath.ok) failures.push(`invalid health proof ${input.healthProofPath}: ${confinedPath.detail}`);
  }
  return failures;
}

function validateLicenseIssuanceMetadata(input: {
  cwd: string;
  issuanceUrl?: string;
  issuanceProofPath?: string;
  issuanceState?: string;
  issuanceTrackingIssue?: string;
  proofRequired: boolean;
  deferralPolicyApplies: boolean;
  issuanceRequiredExplicit?: boolean;
  releaseLevel: string;
  healthUrl?: string;
}): string[] {
  const failures: string[] = [];
  if (input.proofRequired && !input.issuanceUrl) {
    failures.push("checkoutIssuanceUrl must be present when validating checkout issuance proof");
  }
  if (input.issuanceState && !CHECKOUT_ISSUANCE_STATES.has(input.issuanceState)) {
    failures.push(
      `checkoutIssuanceState must be one of ${Array.from(CHECKOUT_ISSUANCE_STATES).sort().join(", ")}`
    );
  }
  if (input.deferralPolicyApplies && input.issuanceRequiredExplicit === false) {
    if (input.releaseLevel !== "source-beta") {
      failures.push("checkoutIssuanceRequiredForThisRelease:false is only allowed for source-beta releases");
    } else {
      if (!input.issuanceTrackingIssue) {
        failures.push("checkoutIssuanceTrackingIssue must be present when checkout issuance proof is deferred");
      }
      if (!input.issuanceState || !CHECKOUT_ISSUANCE_DEFERRED_STATES.has(input.issuanceState)) {
        failures.push("checkoutIssuanceState must be a deferred state when checkout issuance proof is deferred");
      }
    }
  }
  if (input.proofRequired && input.issuanceState && CHECKOUT_ISSUANCE_DEFERRED_STATES.has(input.issuanceState)) {
    failures.push("checkoutIssuanceState must be ready when checkout issuance proof is required");
  }
  if (input.issuanceTrackingIssue) {
    const trackingIssueFailure = validateGithubIssueUrl(
      input.issuanceTrackingIssue,
      "checkoutIssuanceTrackingIssue"
    );
    if (trackingIssueFailure) failures.push(trackingIssueFailure);
  }
  if (input.issuanceUrl) {
    // Pin checkout issuance to the health host when a valid health URL exists.
    // Source-beta can still prove the fail-closed issuance endpoint while
    // health is deferred; that posture relies on URL shape plus proof content,
    // and must not be described as end-to-end checkout fulfillment.
    const expectedHost = extractValidHealthUrlHost(input.healthUrl);
    const issuanceUrlFailure = validateLicenseIssuanceUrl(input.issuanceUrl, expectedHost);
    if (issuanceUrlFailure) failures.push(issuanceUrlFailure);
  }
  if (input.issuanceProofPath && !input.proofRequired) {
    // Required-proof path confinement is enforced inside
    // validateLicenseIssuanceProof before the proof file is read.
    const confinedPath = resolveConfinedEvidenceProofPath(input.cwd, input.issuanceProofPath, "checkoutIssuanceProofPath");
    if (!confinedPath.ok) failures.push(`invalid checkout issuance proof ${input.issuanceProofPath}: ${confinedPath.detail}`);
  }
  return failures;
}

function validateGithubIssueUrl(issueUrl: string, fieldName: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(issueUrl);
  } catch {
    return `${fieldName} must be an https GitHub issue URL with no credentials, query, or fragment`;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    !/^\/[^/]+\/[^/]+\/issues\/\d+$/.test(parsed.pathname) ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return `${fieldName} must be an https GitHub issue URL with no credentials, query, or fragment`;
  }
  return undefined;
}

function validateLicenseHealthUrl(healthUrl: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(healthUrl);
  } catch {
    return "healthUrl must be an https URL ending in /healthz with no credentials, query, or fragment";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/healthz" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return "healthUrl must be an https URL ending in /healthz with no credentials, query, or fragment";
  }
  return undefined;
}

function extractUrlHost(url?: string): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
}

function extractValidHealthUrlHost(healthUrl?: string): string | undefined {
  if (!healthUrl || validateLicenseHealthUrl(healthUrl)) return undefined;
  return extractUrlHost(healthUrl);
}

function validateLicenseIssuanceUrl(issuanceUrl: string, expectedHost?: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(issuanceUrl);
  } catch {
    return "checkoutIssuanceUrl must be an https URL ending in /v1/admin/licenses/issue with no credentials, query, or fragment";
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.pathname !== "/v1/admin/licenses/issue" ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash
  ) {
    return "checkoutIssuanceUrl must be an https URL ending in /v1/admin/licenses/issue with no credentials, query, or fragment";
  }
  if (expectedHost && parsed.hostname !== expectedHost) {
    return `checkoutIssuanceUrl host must match healthUrl host ${expectedHost}`;
  }
  return undefined;
}

function resolveConfinedHealthProofPath(cwd: string, proofPath: string): { ok: true; absolutePath: string } | { ok: false; detail: string } {
  return resolveConfinedEvidenceProofPath(cwd, proofPath, "healthProofPath");
}

function resolveConfinedEvidenceProofPath(
  cwd: string,
  proofPath: string,
  fieldName: "healthProofPath" | "checkoutIssuanceProofPath" | "checkoutIssuanceAuthenticatedProofPath" | "activationProofPath"
): { ok: true; absolutePath: string } | { ok: false; detail: string } {
  if (isAbsolute(proofPath)) {
    return { ok: false, detail: `${fieldName} must be relative and stay within docs/evidence` };
  }
  const evidenceRoot = resolve(cwd, "docs", "evidence");
  const absolutePath = resolve(cwd, proofPath);
  if (!isPathInsideOrEqual(absolutePath, evidenceRoot)) {
    return { ok: false, detail: `${fieldName} must be relative and stay within docs/evidence` };
  }
  if (!existsSync(absolutePath)) return { ok: true, absolutePath };

  let realEvidenceRoot: string;
  let realProofPath: string;
  try {
    realEvidenceRoot = realpathSync.native(evidenceRoot);
    realProofPath = realpathSync.native(absolutePath);
  } catch {
    return { ok: false, detail: `${fieldName} could not be resolved within docs/evidence` };
  }
  if (!isPathInsideOrEqual(realProofPath, realEvidenceRoot)) {
    return { ok: false, detail: `${fieldName} must be relative and stay within docs/evidence` };
  }
  return { ok: true, absolutePath: realProofPath };
}

function isPathInsideOrEqual(target: string, root: string): boolean {
  const rel = relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function collectUnexpectedKeys(value: Record<string, unknown>, allowedKeys: Set<string>): string[] {
  return Object.keys(value).filter((key) => !allowedKeys.has(key)).sort();
}

function collectForbiddenAuthenticatedProofKeys(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectForbiddenAuthenticatedProofKeys(item, `${path}[${index}]`));
  }
  if (!isPlainRecord(value)) return [];
  const forbidden: string[] = [];
  for (const [key, child] of Object.entries(value)) {
    const keyPath = path ? `${path}.${key}` : key;
    const normalized = key.toLowerCase();
    if (
      normalized === "licensekey" ||
      normalized === "responsebody" ||
      normalized === "rawresponse" ||
      normalized === "authorization" ||
      normalized === "authorizationheader" ||
      normalized === "cookie" ||
      normalized.includes("secret")
    ) {
      forbidden.push(keyPath);
    }
    forbidden.push(...collectForbiddenAuthenticatedProofKeys(child, keyPath));
  }
  return Array.from(new Set(forbidden)).sort();
}

function isUpdateChannelStateAcceptable(name: string, state: string, requiredForThisRelease: boolean): boolean {
  return requiredForThisRelease
    ? REQUIRED_PUBLIC_UPDATE_CHANNEL_STATES.has(state)
    : (OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATE_OVERRIDES.get(name) ?? GENERAL_OPTIONAL_PUBLIC_UPDATE_CHANNEL_STATES).has(state);
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isPlainRecord(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function readRepoStatus(cwd: string): ReleaseRepoStatus {
  return {
    branch: git(cwd, ["branch", "--show-current"]) || "(detached)",
    head: git(cwd, ["rev-parse", "HEAD"]),
    dirtyFiles: git(cwd, ["status", "--short"])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  };
}

function readLaunchdStatus(label: string): ReleaseLaunchdStatus {
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  const target = uid === undefined ? label : `gui/${uid}/${label}`;
  const result = spawnSync("launchctl", ["print", target], { encoding: "utf8" });
  if (result.status !== 0) return { label, state: "unknown" };
  return parseLaunchdPrintStatus(label, result.stdout);
}

export function parseLaunchdPrintStatus(label: string, stdout: string): ReleaseLaunchdStatus {
  const state = stdout.match(/\bstate = (\w+)/)?.[1] === "running" ? "running" : "not_running";
  const pidText = stdout.match(/\bpid = (\d+)/)?.[1];
  const args = extractLaunchdSection(stdout, "arguments") ?? "";
  const configMatch = args.match(/--config\s*\n\s*([^\n]+)/);
  const dryRunMatch = args.match(/--dry-run\s*\n\s*([^\n]+)/);
  const environment = extractLaunchdSection(stdout, "environment");
  const nodeOptions = normalizeLaunchdValue(readLaunchdEnvironmentValue(environment, "NODE_OPTIONS"));
  const hasLaunchdEnvironment = environment !== undefined;
  return {
    label,
    state,
    ...(pidText ? { pid: Number(pidText) } : {}),
    ...(configMatch?.[1] ? { configPath: configMatch[1].trim() } : {}),
    ...(dryRunMatch?.[1] ? { dryRun: dryRunMatch[1].trim() !== "false" } : {}),
    ...(nodeOptions ? { nodeOptions } : {}),
    ...(hasLaunchdEnvironment ? { usesSystemCa: splitNodeOptions(nodeOptions).includes("--use-system-ca") } : {})
  };
}

function extractLaunchdSection(stdout: string, sectionName: string): string | undefined {
  const lines = stdout.split(/\r?\n/);
  const sectionStart = lines.findIndex((line) => line.trim() === `${sectionName} = {`);
  if (sectionStart === -1) return undefined;

  const sectionIndent = leadingWhitespace(lines[sectionStart]).length;
  const body: string[] = [];
  for (const line of lines.slice(sectionStart + 1)) {
    if (line.trim() === "}" && leadingWhitespace(line).length <= sectionIndent) {
      return body.join("\n");
    }
    body.push(line);
  }
  return body.join("\n");
}

function leadingWhitespace(value: string): string {
  return value.match(/^\s*/)?.[0] ?? "";
}

function readLaunchdEnvironmentValue(environment: string | undefined, key: string): string | undefined {
  if (!environment) return undefined;
  for (const line of environment.split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=>\s*(.*?)\s*$/);
    if (match?.[1] === key) return match[2];
  }
  return undefined;
}

function normalizeLaunchdValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const first = trimmed[0];
  const last = trimmed[trimmed.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function splitNodeOptions(nodeOptions: string | undefined): string[] {
  return (nodeOptions ?? "")
    .split(/\s+/)
    .map((option) => option.trim())
    .filter(Boolean);
}

function readReviewBudgetStatus(
  statePath: string,
  config: BotConfig,
  now: Date,
  options: {
    includeDetails: boolean;
    detailLimit?: number;
    jobLimit?: number;
  }
): ReviewBudgetStatus {
  if (!existsSync(statePath)) {
    return buildReviewBudgetStatus({
      config,
      jobs: [],
      now,
      includeDetails: options.includeDetails,
      ...(options.detailLimit !== undefined ? { detailLimit: options.detailLimit } : {}),
      ...(options.jobLimit !== undefined ? { inputJobLimit: options.jobLimit } : {}),
      inputJobsTruncated: false
    });
  }
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const queueJobs = readReviewQueueBudgetJobs(db, options.jobLimit);
    return buildReviewBudgetStatus({
      config,
      jobs: queueJobs.jobs,
      now,
      includeDetails: options.includeDetails,
      ...(options.detailLimit !== undefined ? { detailLimit: options.detailLimit } : {}),
      ...(options.jobLimit !== undefined ? { inputJobLimit: options.jobLimit } : {}),
      inputJobsTruncated: queueJobs.truncated
    });
  } finally {
    db.close();
  }
}

function readReviewQueueBudgetJobs(
  db: DatabaseSync,
  limit?: number
): { jobs: ReviewQueueJobRecord[]; truncated: boolean } {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) return { jobs: [], truncated: false };

  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const select = (column: string, fallback = "null") =>
    columns.has(column) ? column : `${fallback} as ${column}`;
  const selectRows = `select
         job_id, attempt_id, source, lane, repo, org, pull_number, head_sha,
         ${select("base_sha")},
         ${select("provider_id")},
         priority, state,
         ${select("next_eligible_at")},
         ${select("lease_id")},
         ${select("lease_expires_at")},
         ${select("session_id")},
         ${select("comment_id")},
         ${select("review_url")},
         ${select("last_error")},
         created_at, updated_at,
         ${select("started_at")},
         ${select("finished_at")}
       from review_queue_jobs`;
  const activeRows = db
    .prepare(
      `${selectRows}
       where state in ('leased', 'running')
       order by priority asc, datetime(created_at) asc`
    )
    .all() as unknown as ReviewBudgetQueueJobRow[];
  const limitClause = limit === undefined ? "" : " limit ?";
  const pendingQuery = db
    .prepare(
      `${selectRows}
       where state in ('queued', 'provider_deferred')
       order by priority asc, datetime(created_at) asc${limitClause}`
    );
  const pendingRows = (limit === undefined
    ? pendingQuery.all()
    : pendingQuery.all(limit + 1)) as unknown as ReviewBudgetQueueJobRow[];
  const truncated = limit !== undefined && pendingRows.length > limit;
  const visiblePendingRows = truncated ? pendingRows.slice(0, limit) : pendingRows;
  return {
    jobs: [...activeRows, ...visiblePendingRows].map(mapReviewBudgetQueueJobRow),
    truncated
  };
}

function readDatabaseStatus(statePath: string, now: Date, leaseTtlMs = 15 * 60_000): ReleaseDatabaseStatus {
  if (!existsSync(statePath)) return { rowCount: 0, errorCount: 0 };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const row = db
      .prepare(
        `select count(*) as rowCount,
                sum(case when status = 'skipped' then 1 else 0 end) as skippedCount,
                sum(case
                  when status = 'skipped' and error like 'provider_rate_limit_cooldown_until=%' then 1
                  else 0
                end) as providerCooldownCount,
                sum(case
                  when status = 'failed' then 1
                  when status = 'skipped' and error like 'provider_rate_limit_cooldown_until=%' then 0
                  when status != 'skipped' and error is not null and error != '' then 1
                  else 0
                end) as errorCount
           from processed_reviews`
      )
      .get() as {
        rowCount?: number;
        skippedCount?: number | null;
        providerCooldownCount?: number | null;
        errorCount?: number | null;
      };
    const providerCooldownRows = db
      .prepare(
        `select repo, pull_number, head_sha, error
         from processed_reviews
         where status = 'skipped' and error like ?`
      )
      .all(`${PROVIDER_COOLDOWN_ERROR_PREFIX}%`) as unknown as Array<{
        repo: string;
        pull_number: number;
        head_sha: string;
        error: string | null;
      }>;
    const providerCooldowns = providerCooldownRows
      .map((providerRow) => {
        const parsed = parseProviderCooldownError(providerRow.error ?? undefined);
        return parsed
          ? {
              repo: providerRow.repo,
              pullNumber: providerRow.pull_number,
              headSha: providerRow.head_sha,
              ...parsed
            }
          : undefined;
      })
      .filter((cooldown): cooldown is ProviderCooldownCandidate => Boolean(cooldown));
    const activeGlobalProviderCooldowns = readActiveGlobalProviderCooldowns(db, now);
    const expiredProviderCooldowns = providerCooldowns.filter((cooldown) => {
      const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
      return !Number.isFinite(cooldownUntilMs) || cooldownUntilMs <= now.getTime();
    });
    const expiredProviderCooldownCount = expiredProviderCooldowns.length;
    const activeProviderCooldownCount = providerCooldowns.length - expiredProviderCooldownCount;
    const coveredByActiveQueueRetryProviderCooldownCount = activeGlobalProviderCooldowns.length > 0
      ? 0
      : countExpiredProviderCooldownsCoveredByActiveQueueRetry(db, expiredProviderCooldowns, now, leaseTtlMs);
    const coveredExpiredProviderCooldownCount = activeGlobalProviderCooldowns.length > 0
      ? expiredProviderCooldownCount
      : coveredByActiveQueueRetryProviderCooldownCount;
    const retryableExpiredProviderCooldownCount = expiredProviderCooldownCount - coveredExpiredProviderCooldownCount;
    const providerThrottleState = activeGlobalProviderCooldowns.length > 0 || activeProviderCooldownCount > 0
      ? "active"
      : retryableExpiredProviderCooldownCount > 0
        ? "expired_retryable"
        : "none";
    const reviewerSessions = readReviewerSessionCounts(db, now, leaseTtlMs);
    const reviewQueue = readReviewQueueCounts(db, now);
    const reviewRunLeases = readReviewRunLeaseCounts(db, now);
    const staleActiveReviewQueueJobCount = readStaleActiveReviewQueueJobCount(db, now, leaseTtlMs);
    return {
      rowCount: row.rowCount ?? 0,
      skippedCount: row.skippedCount ?? 0,
      reviewerSessionCount: reviewerSessions.total,
      activeReviewerSessionCount: reviewerSessions.active,
      expiredReviewerSessionCount: reviewerSessions.expired,
      retryCoveredReviewerSessionCount: reviewerSessions.retryCovered,
      reviewerSessionsByRepo: reviewerSessions.byRepo,
      providerCooldownCount: row.providerCooldownCount ?? 0,
      activeProviderCooldownCount,
      expiredProviderCooldownCount,
      activeGlobalProviderCooldownCount: activeGlobalProviderCooldowns.length,
      coveredExpiredProviderCooldownCount,
      coveredByActiveQueueRetryProviderCooldownCount,
      retryableExpiredProviderCooldownCount,
      providerThrottleState,
      reviewQueueJobCount: reviewQueue.total,
      queuedReviewQueueJobCount: reviewQueue.queued,
      leasedReviewQueueJobCount: reviewQueue.leased,
      runningReviewQueueJobCount: reviewQueue.running,
      providerDeferredReviewQueueJobCount: reviewQueue.providerDeferred,
      retryableProviderDeferredReviewQueueJobCount: reviewQueue.retryableProviderDeferred,
      failedReviewQueueJobCount: reviewQueue.failed,
      zcodeTimeoutFailedReviewQueueJobCount: reviewQueue.zcodeTimeoutFailed,
      retryableZCodeTimeoutFailedReviewQueueJobCount: reviewQueue.retryableZCodeTimeoutFailed,
      exhaustedZCodeTimeoutFailedReviewQueueJobCount: reviewQueue.exhaustedZCodeTimeoutFailed,
      reviewRunLeaseCount: reviewRunLeases.total,
      staleReviewRunLeaseCount: reviewRunLeases.stale,
      staleActiveReviewQueueJobCount,
      reviewQueueJobsByRepo: reviewQueue.byRepo,
      errorCount: row.errorCount ?? 0
    };
  } finally {
    db.close();
  }
}

function readReviewQueueCounts(
  db: DatabaseSync,
  now: Date
): {
  total: number;
  queued: number;
  leased: number;
  running: number;
  providerDeferred: number;
  retryableProviderDeferred: number;
  failed: number;
  zcodeTimeoutFailed: number;
  retryableZCodeTimeoutFailed: number;
  exhaustedZCodeTimeoutFailed: number;
  byRepo: ReviewQueueRepoStatus[];
} {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) {
    return {
      total: 0,
      queued: 0,
      leased: 0,
      running: 0,
      providerDeferred: 0,
      retryableProviderDeferred: 0,
      failed: 0,
      zcodeTimeoutFailed: 0,
      retryableZCodeTimeoutFailed: 0,
      exhaustedZCodeTimeoutFailed: 0,
      byRepo: []
    };
  }
  const nowIso = now.toISOString();
  const row = db
    .prepare(
      `select
         count(*) as total,
         sum(case when state = 'queued' then 1 else 0 end) as queued,
         sum(case when state = 'leased' then 1 else 0 end) as leased,
         sum(case when state = 'running' then 1 else 0 end) as running,
         sum(case when state = 'provider_deferred' then 1 else 0 end) as providerDeferred,
         sum(case when state = 'provider_deferred' and (next_eligible_at is null or datetime(next_eligible_at) <= datetime(?)) then 1 else 0 end) as retryableProviderDeferred,
         sum(case when state = 'failed' then 1 else 0 end) as failed
       from review_queue_jobs`
    )
    .get(nowIso) as QueueCountRow;
  const byRepoRows = db
    .prepare(
      `select
         repo,
         count(*) as total,
         sum(case when state = 'queued' then 1 else 0 end) as queued,
         sum(case when state = 'leased' then 1 else 0 end) as leased,
         sum(case when state = 'running' then 1 else 0 end) as running,
         sum(case when state = 'provider_deferred' then 1 else 0 end) as providerDeferred,
         sum(case when state = 'provider_deferred' and (next_eligible_at is null or datetime(next_eligible_at) <= datetime(?)) then 1 else 0 end) as retryableProviderDeferred,
         sum(case when state = 'failed' then 1 else 0 end) as failed
       from review_queue_jobs
       group by repo
       order by repo`
    )
    .all(nowIso) as unknown as Array<QueueCountRow & { repo: string }>;
  const timeoutRows = db
    .prepare(
      `select last_error
       from review_queue_jobs
       where state = 'failed' and last_error like ?`
    )
    .all(`${ZCODE_TIMEOUT_ERROR_PREFIX}%`) as unknown as Array<{ last_error: string | null }>;
  const timeoutCounts = summarizeZCodeTimeoutErrors(timeoutRows.map((timeoutRow) => timeoutRow.last_error));
  return {
    total: row.total ?? 0,
    queued: row.queued ?? 0,
    leased: row.leased ?? 0,
    running: row.running ?? 0,
    providerDeferred: row.providerDeferred ?? 0,
    retryableProviderDeferred: row.retryableProviderDeferred ?? 0,
    failed: row.failed ?? 0,
    zcodeTimeoutFailed: timeoutCounts.total,
    retryableZCodeTimeoutFailed: timeoutCounts.retryable,
    exhaustedZCodeTimeoutFailed: timeoutCounts.exhausted,
    byRepo: byRepoRows.map((repoRow) => ({
      repo: repoRow.repo,
      total: repoRow.total ?? 0,
      queued: repoRow.queued ?? 0,
      leased: repoRow.leased ?? 0,
      running: repoRow.running ?? 0,
      providerDeferred: repoRow.providerDeferred ?? 0,
      retryableProviderDeferred: repoRow.retryableProviderDeferred ?? 0,
      failed: repoRow.failed ?? 0
    }))
  };
}

function readReviewRunLeaseCounts(db: DatabaseSync, now: Date): { total: number; stale: number } {
  const hasLeaseTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_run_leases' limit 1")
    .get();
  if (!hasLeaseTable) return { total: 0, stale: 0 };
  const columns = new Set(
    (db.prepare("pragma table_info(review_run_leases)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const ownerPidColumn = columns.has("owner_pid") ? "owner_pid" : "null as owner_pid";
  const rows = db
    .prepare(`select lease_id, expires_at, ${ownerPidColumn} from review_run_leases`)
    .all() as unknown as Array<{ lease_id: string; expires_at: string; owner_pid: number | null }>;
  return {
    total: rows.length,
    stale: rows.filter((row) => {
      const expiresAtMs = Date.parse(row.expires_at);
      if (!Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime()) return true;
      return row.owner_pid === null || !isProcessAlive(row.owner_pid);
    }).length
  };
}

function readStaleActiveReviewQueueJobCount(db: DatabaseSync, now: Date, leaseTtlMs: number): number {
  const hasQueueTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasQueueTable) return 0;
  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (columns.has("lease_expires_at")) {
    const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
    const row = db
      .prepare(
        `select count(*) as count
         from review_queue_jobs
	         where state in ('leased', 'running')
	           and (
	             (lease_expires_at is not null and (datetime(lease_expires_at) is null or datetime(lease_expires_at) <= datetime(?)))
	             or (lease_expires_at is null and datetime(updated_at) <= datetime(?))
	           )`
      )
      .get(now.toISOString(), legacyLeaseCutoffIso) as { count?: number };
    return row.count ?? 0;
  }
  const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
  const row = db
    .prepare(
      `select count(*) as count
       from review_queue_jobs
       where state in ('leased', 'running')
         and datetime(updated_at) <= datetime(?)`
    )
    .get(legacyLeaseCutoffIso) as { count?: number };
  return row.count ?? 0;
}

function readReviewerSessionCounts(
  db: DatabaseSync,
  now: Date,
  leaseTtlMs: number
): { total: number; active: number; expired: number; retryCovered: number; byRepo: ReviewerSessionRepoStatus[] } {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'reviewer_sessions' limit 1")
    .get();
  if (!hasTable) return { total: 0, active: 0, expired: 0, retryCovered: 0, byRepo: [] };
  const rows = db
    .prepare(
      `select session_id, repo, state, expires_at, head_count_used, head_count_limit, worker_pid
       from reviewer_sessions`
    )
    .all() as unknown as ReviewerSessionCountRow[];
  const retryCoveredSessionIds = readRetryCoveredReviewerSessionIds(db, now, leaseTtlMs);
  const byRepo = new Map<string, ReviewerSessionRepoStatus>();
  let active = 0;
  let expired = 0;
  let retryCoveredCount = 0;
  for (const row of rows) {
    const repoStatus = byRepo.get(row.repo) ?? { repo: row.repo, total: 0, active: 0, expired: 0 };
    const rowActive = isReviewerSessionActiveForStatus(row, now);
    const retryCovered = !rowActive && retryCoveredSessionIds.has(row.session_id);
    const rowExpired = !retryCovered && isReviewerSessionExpiredForStatus(row, now);
    repoStatus.total += 1;
    if (rowActive || retryCovered) {
      active += 1;
      repoStatus.active += 1;
    }
    if (rowExpired) {
      expired += 1;
      repoStatus.expired += 1;
    }
    if (retryCovered) {
      retryCoveredCount += 1;
      repoStatus.retryCovered = (repoStatus.retryCovered ?? 0) + 1;
    }
    byRepo.set(row.repo, repoStatus);
  }
  return {
    total: rows.length,
    active,
    expired,
    retryCovered: retryCoveredCount,
    byRepo: [...byRepo.values()].sort((left, right) => left.repo.localeCompare(right.repo))
  };
}

interface ReviewerSessionCountRow {
  session_id: string;
  repo: string;
  state: string;
  expires_at: string | null;
  head_count_used: number;
  head_count_limit: number;
  worker_pid: number | null;
}

function isReviewerSessionActiveForStatus(row: ReviewerSessionCountRow, now: Date): boolean {
  if (row.state !== "active" && row.state !== "warming") return false;
  if (row.worker_pid !== null && !isProcessAlive(row.worker_pid)) return false;
  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  return Number.isFinite(expiresAtMs) && expiresAtMs > now.getTime() && row.head_count_used < row.head_count_limit;
}

function isReviewerSessionExpiredForStatus(row: ReviewerSessionCountRow, now: Date): boolean {
  const expiresAtMs = row.expires_at ? Date.parse(row.expires_at) : Number.NaN;
  return row.state === "expired" || !Number.isFinite(expiresAtMs) || expiresAtMs <= now.getTime() || row.head_count_used >= row.head_count_limit;
}

function readRetryCoveredReviewerSessionIds(db: DatabaseSync, now: Date, leaseTtlMs: number): Set<string> {
  const hasRequiredTables = ["reviewer_session_jobs", "review_queue_jobs"].every((tableName) =>
    Boolean(
      db
        .prepare("select 1 from sqlite_master where type = 'table' and name = ? limit 1")
        .get(tableName)
    )
  );
  if (!hasRequiredTables) return new Set();

  const queueColumns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const sessionJobColumns = new Set(
    (db.prepare("pragma table_info(reviewer_session_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  const requiredQueueColumns = ["session_id", "repo", "pull_number", "head_sha", "state", "updated_at"];
  const requiredSessionJobColumns = ["session_id", "repo", "pull_number", "head_sha"];
  if (
    requiredQueueColumns.some((column) => !queueColumns.has(column)) ||
    requiredSessionJobColumns.some((column) => !sessionJobColumns.has(column))
  ) {
    return new Set();
  }

  const hasLeaseExpiresAt = queueColumns.has("lease_expires_at");
  const activeLeaseClause = hasLeaseExpiresAt
    ? `and (
         (q.lease_expires_at is not null and datetime(q.lease_expires_at) > datetime(?))
         or (q.lease_expires_at is null and datetime(q.updated_at) > datetime(?))
       )`
    : "and datetime(q.updated_at) > datetime(?)";
  const rows = db
    .prepare(
      `select distinct sj.session_id as session_id
       from reviewer_session_jobs sj
       join review_queue_jobs q
         on q.session_id = sj.session_id
        and q.repo = sj.repo
        and q.pull_number = sj.pull_number
        and q.head_sha = sj.head_sha
       where q.state in ('leased', 'running')
       ${activeLeaseClause}`
    )
    .all(
      ...(hasLeaseExpiresAt
        ? [now.toISOString(), new Date(now.getTime() - leaseTtlMs).toISOString()]
        : [new Date(now.getTime() - leaseTtlMs).toISOString()])
    ) as unknown as Array<{ session_id: string | null }>;
  return new Set(rows.map((row) => row.session_id).filter((sessionId): sessionId is string => Boolean(sessionId)));
}

interface ProviderCooldownCandidate {
  repo: string;
  pullNumber: number;
  headSha: string;
  cooldownUntil: string;
  reason?: string;
}

function countExpiredProviderCooldownsCoveredByActiveQueueRetry(
  db: DatabaseSync,
  cooldowns: ProviderCooldownCandidate[],
  now: Date,
  leaseTtlMs: number
): number {
  if (cooldowns.length === 0) return 0;
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'review_queue_jobs' limit 1")
    .get();
  if (!hasTable) return 0;
  const columns = new Set(
    (db.prepare("pragma table_info(review_queue_jobs)").all() as unknown as Array<{ name: string }>)
      .map((column) => column.name)
  );
  if (
    !columns.has("repo") ||
    !columns.has("pull_number") ||
    !columns.has("head_sha") ||
    !columns.has("state") ||
    !columns.has("updated_at")
  ) {
    return 0;
  }
  const hasLeaseExpiresAt = columns.has("lease_expires_at");
  const leaseClause = hasLeaseExpiresAt
    ? `and (
         (lease_expires_at is not null and datetime(lease_expires_at) > datetime(?))
         or (lease_expires_at is null and datetime(updated_at) > datetime(?))
       )`
    : "and datetime(updated_at) > datetime(?)";
  const query = db.prepare(
    `select 1
     from review_queue_jobs
     where repo = ?
       and pull_number = ?
       and head_sha = ?
       and state in ('leased', 'running')
       ${leaseClause}
     limit 1`
  );
  const nowIso = now.toISOString();
  const legacyLeaseCutoffIso = new Date(now.getTime() - leaseTtlMs).toISOString();
  return cooldowns.filter((cooldown) => {
    const cooldownUntilMs = Date.parse(cooldown.cooldownUntil);
    if (!Number.isFinite(cooldownUntilMs) || cooldownUntilMs > now.getTime()) return false;
    const row = hasLeaseExpiresAt
      ? query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha, nowIso, legacyLeaseCutoffIso)
      : query.get(cooldown.repo, cooldown.pullNumber, cooldown.headSha, legacyLeaseCutoffIso);
    return Boolean(row);
  }).length;
}

function readActiveGlobalProviderCooldowns(db: DatabaseSync, now: Date): Array<{ repo: string; cooldownUntil: string }> {
  const hasTable = db
    .prepare("select 1 from sqlite_master where type = 'table' and name = 'repo_provider_cooldowns' limit 1")
    .get();
  if (!hasTable) return [];
  const rows = db
    .prepare("select repo, cooldown_until from repo_provider_cooldowns")
    .all() as unknown as Array<{ repo: string; cooldown_until: string }>;
  return rows
    .map((row) => ({ repo: row.repo, cooldownUntil: row.cooldown_until }))
    .filter((row) => {
      const cooldownUntilMs = Date.parse(row.cooldownUntil);
      return Number.isFinite(cooldownUntilMs) && cooldownUntilMs > now.getTime();
    });
}

function describeProviderCooldownCounts(database: ReleaseDatabaseStatus): string {
  const total = database.providerCooldownCount ?? 0;
  if (total === 0) return "";
  const covered = database.coveredExpiredProviderCooldownCount ?? 0;
  return (
    `; ${total} provider cooldown skip row(s)` +
    ` (${database.activeProviderCooldownCount ?? 0} active, ${database.expiredProviderCooldownCount ?? 0} expired` +
    `${covered > 0 ? `, ${covered} covered` : ""})`
  );
}

function describeProviderCooldownBacklog(
  database: ReleaseDatabaseStatus,
  providerThrottleState = inferProviderThrottleState(database)
): string {
  const queueCovered = database.coveredByActiveQueueRetryProviderCooldownCount ?? 0;
  const globallyCovered = Math.max(0, (database.coveredExpiredProviderCooldownCount ?? 0) - queueCovered);
  if (providerThrottleState === "active" && globallyCovered > 0) {
    return (
      `provider throttle active; ${globallyCovered} expired provider cooldown row(s) ` +
      "deferred by active provider cooldown"
    );
  }
  if (queueCovered > 0) {
    const retryable = database.retryableExpiredProviderCooldownCount ?? 0;
    return (
      `${queueCovered} expired provider cooldown row(s) covered by active queue retry; ` +
      `${retryable} retryable expired provider cooldown row(s); ` +
      `${database.activeProviderCooldownCount ?? 0} active provider cooldown row(s)`
    );
  }
  return `${database.expiredProviderCooldownCount ?? 0} expired provider cooldown row(s); ${database.activeProviderCooldownCount ?? 0} active provider cooldown row(s)`;
}

function describeReviewQueueCounts(database: ReleaseDatabaseStatus): string {
  const total = database.reviewQueueJobCount ?? 0;
  if (total === 0) return "";
  return (
    `; queue total=${total}` +
    ` queued=${database.queuedReviewQueueJobCount ?? 0}` +
    ` leased=${database.leasedReviewQueueJobCount ?? 0}` +
    ` running=${database.runningReviewQueueJobCount ?? 0}` +
    ` provider_deferred=${database.providerDeferredReviewQueueJobCount ?? 0}` +
    ` failed=${database.failedReviewQueueJobCount ?? 0}`
  );
}

function describeProviderDeferredQueueStatus(
  database: ReleaseDatabaseStatus,
  budget?: ReviewBudgetStatus
): string {
  if (!budget) {
    return (
      `${database.retryableProviderDeferredReviewQueueJobCount ?? 0} retryable provider-deferred queue job(s)` +
      describeReviewQueueCounts(database)
    );
  }
  const waitingCapacity =
    budget.providerDeferred.waitingProviderCapacity +
    budget.providerDeferred.waitingOrgCapacity +
    budget.providerDeferred.waitingRepoCapacity +
    budget.providerDeferred.waitingManualReserve +
    budget.providerDeferred.waitingLeaseLimit;
  return (
    `${budget.providerDeferred.readyToRetry} ready-to-retry provider-deferred queue job(s)` +
    `; provider_deferred total=${budget.providerDeferred.total}` +
    ` retryable=${budget.providerDeferred.retryable}` +
    ` waiting_cooldown=${budget.providerDeferred.waitingCooldown}` +
    ` waiting_capacity=${waitingCapacity}` +
    describeReviewQueueCounts(database)
  );
}

function inferProviderThrottleState(database: ReleaseDatabaseStatus): "none" | "active" | "expired_retryable" {
  if ((database.activeGlobalProviderCooldownCount ?? 0) > 0 || (database.activeProviderCooldownCount ?? 0) > 0) {
    return "active";
  }
  if ((database.expiredProviderCooldownCount ?? 0) > 0) return "expired_retryable";
  return "none";
}

function readHeartbeatStatus(
  statePath: string,
  maxAgeMs: number,
  activeMaxAgeMs: number,
  now: Date
): ReleaseHeartbeatStatus {
  if (!existsSync(statePath)) return { status: "missing", maxAgeMs };
  const db = new DatabaseSync(statePath, { readOnly: true });
  try {
    const table = db
      .prepare("select 1 from sqlite_master where type = 'table' and name = 'daemon_heartbeat' limit 1")
      .get();
    if (!table) return { status: "missing", maxAgeMs };

    const columns = new Set(
      (db.prepare("pragma table_info(daemon_heartbeat)").all() as unknown as Array<{ name: string }>)
        .map((column) => column.name)
    );
    const startedCycleSelect = columns.has("started_cycle") ? "started_cycle" : "null as started_cycle";
    const startedAtSelect = columns.has("started_at") ? "started_at" : "null as started_at";
    const row = db
      .prepare(
        `select cycle, event, dry_run, recorded_at, ${startedCycleSelect}, ${startedAtSelect}
         from daemon_heartbeat
         where id = 1
         limit 1`
      )
      .get() as {
        cycle: number | null;
        event: string | null;
        dry_run: number | null;
        recorded_at: string | null;
        started_cycle: number | null;
        started_at: string | null;
      } | undefined;
    if (!row) return { status: "missing", maxAgeMs };

    const latestTime = row.recorded_at ? Date.parse(row.recorded_at) : NaN;
    const activeStartedTime = row.started_at ? Date.parse(row.started_at) : NaN;
    const hasActiveCycle =
      Number.isFinite(activeStartedTime) &&
      (!Number.isFinite(latestTime) || activeStartedTime > latestTime);
    if (hasActiveCycle) {
      const activeAgeMs = Math.max(0, now.getTime() - activeStartedTime);
      return {
        status: activeAgeMs <= activeMaxAgeMs ? "active" : "stale",
        maxAgeMs,
        activeMaxAgeMs,
        ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
        ...(Number.isFinite(latestTime) ? { ageMs: Math.max(0, now.getTime() - latestTime) } : {}),
        ...(row.cycle !== null ? { cycle: row.cycle } : {}),
        ...(row.event ? { event: row.event } : {}),
        dryRun: row.dry_run === 1,
        ...(row.started_cycle !== null ? { activeCycle: row.started_cycle } : {}),
        ...(row.started_at ? { activeStartedAt: row.started_at } : {}),
        activeAgeMs
      };
    }

    if (!Number.isFinite(latestTime)) {
      return {
        status: "stale",
        maxAgeMs,
        ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
        ...(row.cycle !== null ? { cycle: row.cycle } : {}),
        ...(row.event ? { event: row.event } : {}),
        dryRun: row.dry_run === 1
      };
    }
    const ageMs = Math.max(0, now.getTime() - latestTime);
    return {
      status: ageMs <= maxAgeMs ? "fresh" : "stale",
      maxAgeMs,
      ...(row.recorded_at ? { latestAt: row.recorded_at } : {}),
      ageMs,
      ...(row.cycle !== null ? { cycle: row.cycle } : {}),
      ...(row.event ? { event: row.event } : {}),
      dryRun: row.dry_run === 1
    };
  } finally {
    db.close();
  }
}

function describeHeartbeat(heartbeat: ReleaseHeartbeatStatus): string {
  if (heartbeat.status === "missing") return `missing heartbeat row; max age ${heartbeat.maxAgeMs}ms`;
  if (heartbeat.status === "active") {
    const activeAge = heartbeat.activeAgeMs === undefined ? "unknown" : `${heartbeat.activeAgeMs}ms`;
    return (
      `active; active age ${activeAge}; max ${heartbeat.activeMaxAgeMs ?? heartbeat.maxAgeMs}ms; ` +
      `started cycle ${heartbeat.activeCycle ?? "unknown"}; last event ${heartbeat.event ?? "unknown"}; ` +
      `last cycle ${heartbeat.cycle ?? "unknown"}`
    );
  }
  const age = heartbeat.ageMs === undefined ? "unknown" : `${heartbeat.ageMs}ms`;
  const activeSuffix = heartbeat.activeAgeMs === undefined
    ? ""
    : `; active age ${heartbeat.activeAgeMs}ms; active max ${heartbeat.activeMaxAgeMs ?? heartbeat.maxAgeMs}ms; active cycle ${heartbeat.activeCycle ?? "unknown"}`;
  return `${heartbeat.status}; age ${age}; max ${heartbeat.maxAgeMs}ms; event ${heartbeat.event ?? "unknown"}; cycle ${heartbeat.cycle ?? "unknown"}${activeSuffix}`;
}

interface ChangelogHeadStatus {
  path: string;
  exists: boolean;
  version?: string;
  releaseNotesPath?: string;
}

function readChangelogHead(cwd: string): ChangelogHeadStatus {
  const path = "CHANGELOG.md";
  const absolutePath = resolve(cwd, path);
  if (!existsSync(absolutePath)) return { path, exists: false };

  const lines = readFileSync(absolutePath, "utf8").split(/\r?\n/);
  for (const line of lines) {
    const match = /^## \[([^\]]+)\](?:\s*-\s*(\S+))?/.exec(line.trim());
    if (!match || match[1] === "Unreleased") continue;
    return {
      path,
      exists: true,
      version: match[1],
      ...(match[2] ? { releaseNotesPath: match[2] } : {})
    };
  }

  return { path, exists: true };
}

function stripLeadingV(version: string): string {
  return version.startsWith("v") ? version.slice(1) : version;
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EPERM";
  }
}

interface QueueCountRow {
  total?: number;
  queued?: number | null;
  leased?: number | null;
  running?: number | null;
  providerDeferred?: number | null;
  retryableProviderDeferred?: number | null;
  failed?: number | null;
}

interface ReviewBudgetQueueJobRow {
  job_id: string;
  attempt_id: string;
  source: ReviewQueueJobRecord["source"];
  lane: ReviewQueueJobRecord["lane"];
  repo: string;
  org: string;
  pull_number: number;
  head_sha: string;
  base_sha?: string | null;
  provider_id?: string | null;
  priority: number;
  state: ReviewQueueJobRecord["state"];
  next_eligible_at?: string | null;
  lease_id?: string | null;
  lease_expires_at?: string | null;
  session_id?: string | null;
  comment_id?: number | null;
  review_url?: string | null;
  last_error?: string | null;
  created_at: string;
  updated_at: string;
  started_at?: string | null;
  finished_at?: string | null;
}

function mapReviewBudgetQueueJobRow(row: ReviewBudgetQueueJobRow): ReviewQueueJobRecord {
  return {
    jobId: row.job_id,
    attemptId: row.attempt_id,
    source: row.source,
    lane: row.lane,
    repo: row.repo,
    org: row.org,
    pullNumber: row.pull_number,
    headSha: row.head_sha,
    ...(row.base_sha ? { baseSha: row.base_sha } : {}),
    ...(row.provider_id ? { providerId: row.provider_id } : {}),
    priority: row.priority,
    state: row.state,
    ...(row.next_eligible_at ? { nextEligibleAt: row.next_eligible_at } : {}),
    ...(row.lease_id ? { leaseId: row.lease_id } : {}),
    ...(row.lease_expires_at ? { leaseExpiresAt: row.lease_expires_at } : {}),
    ...(row.session_id ? { sessionId: row.session_id } : {}),
    ...(row.comment_id !== null && row.comment_id !== undefined ? { commentId: row.comment_id } : {}),
    ...(row.review_url ? { reviewUrl: row.review_url } : {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {})
  };
}
