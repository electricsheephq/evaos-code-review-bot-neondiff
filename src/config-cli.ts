import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { loadConfig, loadConfigFromObject, type RepoProfileConfig } from "./config.js";
import { isApiKeyEnvName } from "./providers.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const SECRET_KEY_PATTERN = /(?:token|secret|password|cookie|license|api[_-]?key(?!env)|privateKey)/i;
const REPO_PROFILE_DESKTOP_SAFE_FIELDS = [
  "enabled",
  "displayName",
  "defaultBranch",
  "reviewProfile",
  "promptNote",
  "pathFilters",
  "riskyPaths",
  "proofExpectations",
  "validationHints",
  "readinessHints",
  "suggestedLabels",
  "suggestedReviewers"
] as const satisfies readonly (keyof RepoProfileConfig)[];

const REPO_PROFILE_DESKTOP_SAFE_FIELD_PATTERN = REPO_PROFILE_DESKTOP_SAFE_FIELDS.join("|");
const CONFIG_NAME_SEGMENT_PATTERN = "[A-Za-z0-9_.-]+";
const CONFIG_REVISION_PATTERN = /^[a-f0-9]{64}$/;

const EXACT_PATCH_PATHS = new Set([
  "pilotRepos",
  "pollIntervalMs",
  "skipDrafts",
  "canaryPulls",
  "reviewConcurrency.maxActiveRuns",
  "reviewConcurrency.leaseTtlMs",
  "reviewGate.maxInlineComments",
  "issueEnrichment.enabled",
  "issueEnrichment.postIssueComment",
  "issueEnrichment.allowlist",
  "issueEnrichment.maxIssuesPerCycle",
  "issueEnrichment.maxCommentsPerCycle",
  "issueEnrichment.globalMaxIssuesPerCycle",
  "issueEnrichment.globalMaxCommentsPerCycle",
  "issueEnrichment.maxActiveRuns",
  "issueEnrichment.leaseTtlMs",
  "issueEnrichment.cooldownMs",
  "issueEnrichment.burstWindowMs",
  "issueEnrichment.maxIssuesPerBurst",
  "issueEnrichment.lookbackMs",
  "issueEnrichment.processExistingOpenIssuesOnActivation",
  "zcode.cliPath",
  "zcode.appConfigPath",
  "zcode.model",
  "zcode.providerId",
  "zcode.timeoutMs",
  "github.appId",
  "github.clientId",
  "github.botLogin",
  "github.requestTimeoutMs",
  "desktop.openAICompatibleEndpoint",
  "desktop.updateChannel",
  "providers.defaultProviderId"
]);

const REPO_PROFILE_FIELD_PATTERN =
  new RegExp(`^repoProfiles\\.(?:repos\\.(${CONFIG_NAME_SEGMENT_PATTERN}\\/${CONFIG_NAME_SEGMENT_PATTERN})|orgFallbacks\\.(${CONFIG_NAME_SEGMENT_PATTERN}))\\.(?:${REPO_PROFILE_DESKTOP_SAFE_FIELD_PATTERN})$`);

const REPO_PROFILE_NESTED_PATTERN =
  new RegExp(`^repoProfiles\\.repos\\.(${CONFIG_NAME_SEGMENT_PATTERN}\\/${CONFIG_NAME_SEGMENT_PATTERN})\\.(?:autoReview\\.(?:baseBranches|labels)|preMergeChecks\\.(?:title|description|linkedIssue|testEvidence|docs|docstrings)\\.(?:mode|instructions|threshold)|finishingTouches\\.(?:docs|docstrings|unitTests|simplifySuggestion|changelogDraft|riskExplanation|reviewReady|stackedPr)\\.(?:enabled|instructions))$`);

const PROVIDER_SAFE_FIELD_PATTERN =
  new RegExp(`^providers\\.providers\\.(${CONFIG_NAME_SEGMENT_PATTERN})\\.(?:enabled|adapter|displayName|baseUrl|model|authMode|apiKeyEnv|contextWindowTokens|timeoutMs|retryMaxRetries|retrySchemaFeedbackMax|structuredOutputMode)$`);

const PROVIDER_CAPABILITY_PATTERN =
  new RegExp(`^providers\\.providers\\.(${CONFIG_NAME_SEGMENT_PATTERN})\\.capabilities\\.(?:review|jsonOutput|local|streaming)$`);

export interface ConfigInspectResult {
  ok: boolean;
  command: "config inspect";
  configPath?: string;
  exists: boolean;
  source: "file" | "defaults";
  revision: string;
  editablePaths: string[];
  config?: unknown;
  error?: string;
}

export interface ConfigPatchResult {
  ok: boolean;
  command: "config patch";
  configPath: string;
  inputPath: string;
  dryRun: boolean;
  wrote: boolean;
  changedPaths: string[];
  noopPaths: string[];
  revisionBefore?: string;
  revisionAfter?: string;
  config?: unknown;
  error?: string;
  warning?: string;
}

interface FlattenedPatch {
  path: string[];
  value: unknown;
}

type ConfigFileOps = {
  chmodSync: typeof chmodSync;
  closeSync: typeof closeSync;
  existsSync: typeof existsSync;
  fstatSync: typeof fstatSync;
  fsyncSync: typeof fsyncSync;
  mkdirSync: typeof mkdirSync;
  openSync: typeof openSync;
  readFileSync: typeof readFileSync;
  realpathSync: typeof realpathSync;
  renameSync: typeof renameSync;
  statSync: typeof statSync;
  unlinkSync: typeof unlinkSync;
  writeFileSync: typeof writeFileSync;
};

const defaultConfigFileOps: ConfigFileOps = {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync
};

export function inspectConfigForDesktop(configPath?: string, fileOps?: Partial<ConfigFileOps>): ConfigInspectResult {
  const ops = { ...defaultConfigFileOps, ...fileOps };
  const requestedConfigPath = configPath ? resolve(configPath) : undefined;
  let resolvedConfigPath = requestedConfigPath;
  let exists = requestedConfigPath ? ops.existsSync(requestedConfigPath) : false;
  try {
    if (requestedConfigPath && exists) resolvedConfigPath = ops.realpathSync(requestedConfigPath);
    exists = resolvedConfigPath ? ops.existsSync(resolvedConfigPath) : false;
    const snapshot = exists && resolvedConfigPath ? readStableConfigSnapshot(resolvedConfigPath, fileOps) : undefined;
    const config = snapshot ? loadConfigFromObject(snapshot.value) : loadConfig();
    return {
      ok: true,
      command: "config inspect",
      ...(resolvedConfigPath ? { configPath: resolvedConfigPath } : {}),
      exists,
      source: exists ? "file" : "defaults",
      revision: snapshot?.revision ?? "",
      editablePaths: editablePatchPaths(),
      config: redactConfigObject(config)
    };
  } catch (error) {
    return {
      ok: false,
      command: "config inspect",
      ...(resolvedConfigPath ? { configPath: resolvedConfigPath } : {}),
      exists,
      source: exists ? "file" : "defaults",
      revision: "",
      editablePaths: editablePatchPaths(),
      error: redactSecrets(error instanceof Error ? error.message : String(error))
    };
  }
}

export function patchConfigForDesktop(input: {
  configPath: string;
  inputPath: string;
  dryRun: boolean;
  confirm: boolean;
  expectedRevision?: string;
  fileOps?: Partial<ConfigFileOps>;
}): ConfigPatchResult {
  const ops = { ...defaultConfigFileOps, ...input.fileOps };
  const requestedConfigPath = resolve(input.configPath);
  const inputPath = resolve(input.inputPath);
  let configPath = requestedConfigPath;
  try {
    if (ops.existsSync(requestedConfigPath)) configPath = ops.realpathSync(requestedConfigPath);
  } catch (error) {
    return failedPatch(input, requestedConfigPath, inputPath, `failed to resolve config path: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!ops.existsSync(configPath)) {
    return failedPatch(input, configPath, inputPath, "config file does not exist");
  }
  if (!ops.existsSync(inputPath)) {
    return failedPatch(input, configPath, inputPath, "patch input file does not exist");
  }
  if (!input.dryRun && !input.confirm) {
    return failedPatch(input, configPath, inputPath, "config patch with --dry-run false requires --confirm true");
  }
  if (input.expectedRevision !== undefined && !CONFIG_REVISION_PATTERN.test(input.expectedRevision)) {
    return failedPatch(input, configPath, inputPath, "--expected-revision must be a lowercase SHA-256 value");
  }

  if (input.dryRun) return patchConfigForDesktopUnlocked(input, configPath, inputPath);

  let releaseLock: (() => void) | undefined;
  try {
    releaseLock = acquireConfigPatchLock(configPath, input.fileOps);
  } catch (error) {
    return failedPatch(input, configPath, inputPath, error instanceof Error ? error.message : String(error));
  }
  const result = patchConfigForDesktopUnlocked(input, configPath, inputPath);
  try {
    releaseLock();
  } catch (error) {
    const lockPath = `${configPath}.neondiff.lock`;
    const outcome = result.ok && result.wrote ? "config write committed" : "config patch completed";
    return {
      ...result,
      warning: redactSecrets(
        `${outcome}, but failed to release owned lock ${lockPath}: `
        + `${error instanceof Error ? error.message : String(error)}; `
        + "verify no NeonDiff config patch is running, then remove this lock and retry"
      )
    };
  }
  return result;
}

function patchConfigForDesktopUnlocked(
  input: {
    configPath: string;
    inputPath: string;
    dryRun: boolean;
    confirm: boolean;
    expectedRevision?: string;
    fileOps?: Partial<ConfigFileOps>;
  },
  configPath: string,
  inputPath: string
): ConfigPatchResult {

  let current: unknown;
  let patch: unknown;
  let revisionBefore: string;
  try {
    const snapshot = readStableConfigSnapshot(configPath, input.fileOps);
    current = snapshot.value;
    revisionBefore = snapshot.revision;
    patch = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (error) {
    return failedPatch(input, configPath, inputPath, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(current)) {
    return failedPatch(input, configPath, inputPath, "config file must contain a JSON object");
  }
  if (input.expectedRevision !== undefined && input.expectedRevision !== revisionBefore) {
    return failedPatch(input, configPath, inputPath, "config changed since preview; reload and preview again");
  }
  if (!isRecord(patch)) {
    return failedPatch(input, configPath, inputPath, "patch input must contain a JSON object");
  }
  const unsupportedKey = findUnsupportedDottedPatchKey(patch);
  if (unsupportedKey) {
    return failedPatch(input, configPath, inputPath, unsupportedDottedKeyError(unsupportedKey));
  }
  const patchText = JSON.stringify(maskAllowedSecretPointerFields(patch));
  if (containsSecretLikeText(patchText)) {
    return failedPatch(input, configPath, inputPath, "patch input contains secret-like text; store provider and license keys in Keychain instead");
  }

  const flattened = flattenPatch(patch);
  if (flattened.length === 0) {
    return failedPatch(input, configPath, inputPath, "patch input did not contain any leaf settings");
  }
  const disallowed = flattened.map((entry) => entry.path).filter((path) => !isPatchPathAllowed(path.join(".")));
  if (disallowed.length > 0) {
    return failedPatch(input, configPath, inputPath, disallowedPatchPathError(disallowed));
  }

  const next = structuredClone(current) as Record<string, unknown>;
  const changed: FlattenedPatch[] = [];
  const noopPaths: string[] = [];
  for (const entry of flattened) {
    if (deepEqual(getNestedValue(current, entry.path), entry.value)) {
      noopPaths.push(entry.path.join("."));
      continue;
    }
    changed.push(entry);
    setNestedValue(next, entry.path, entry.value);
  }
  const changedPaths = changed.map((entry) => entry.path.join("."));
  let revisionAfter = revisionBefore;

  const validationError = validateCandidateConfig(next);
  if (validationError) return failedPatch(input, configPath, inputPath, validationError);

  if (!input.dryRun && changedPaths.length > 0) {
    try {
      const liveRevision = readStableConfigSnapshot(configPath, input.fileOps).revision;
      if (liveRevision !== revisionBefore) {
        return failedPatch(input, configPath, inputPath, "config changed while applying patch; reload and preview again");
      }
      revisionAfter = writeConfigAtomic(configPath, next, input.fileOps);
    } catch (error) {
      return failedPatch(input, configPath, inputPath, `failed to write config atomically: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    ok: true,
    command: "config patch",
    configPath,
    inputPath,
    dryRun: input.dryRun,
    wrote: !input.dryRun && changedPaths.length > 0,
    changedPaths,
    noopPaths,
    revisionBefore,
    revisionAfter,
    config: redactConfigObject(next)
  };
}

export function redactConfigObject(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => redactConfigObject(entry));
  if (!isRecord(value)) {
    return typeof value === "string" ? redactSecrets(value) : value;
  }
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = key === "apiKeyEnv" && typeof entry === "string"
      ? entry
      : SECRET_KEY_PATTERN.test(key) ? redactSecretValue(entry) : redactConfigObject(entry);
  }
  return output;
}

export function editablePatchPaths(): string[] {
  return [
    ...EXACT_PATCH_PATHS,
    "providers.providers.<provider-id>.<desktop-safe-provider-field>",
    "providers.providers.<provider-id>.capabilities.<capability>",
    "repoProfiles.repos.<owner/repo>.<desktop-safe-field>",
    "repoProfiles.orgFallbacks.<owner>.<desktop-safe-field>"
  ].sort();
}

function failedPatch(input: { dryRun: boolean }, configPath: string, inputPath: string, error: string): ConfigPatchResult {
  return {
    ok: false,
    command: "config patch",
    configPath,
    inputPath,
    dryRun: input.dryRun,
    wrote: false,
    changedPaths: [],
    noopPaths: [],
    error: redactSecrets(error)
  };
}

function flattenPatch(value: unknown, prefix: string[] = []): FlattenedPatch[] {
  if (prefix.length === 0 && !isRecord(value)) return [];
  if (!isRecord(value)) return [{ path: prefix, value }];
  const entries: FlattenedPatch[] = [];
  for (const [key, entry] of Object.entries(value)) {
    if (Array.isArray(entry) || !isRecord(entry)) {
      entries.push({ path: [...prefix, key], value: entry });
      continue;
    }
    entries.push(...flattenPatch(entry, [...prefix, key]));
  }
  return entries;
}

function isPatchPathAllowed(path: string): boolean {
  if (EXACT_PATCH_PATHS.has(path)) return true;
  const fieldMatch = path.match(REPO_PROFILE_FIELD_PATTERN);
  if (fieldMatch) {
    const repo = fieldMatch[1];
    const owner = fieldMatch[2];
    return repo ? isConfigRepoName(repo) : Boolean(owner && isConfigNameSegment(owner));
  }
  const nestedMatch = path.match(REPO_PROFILE_NESTED_PATTERN);
  if (nestedMatch?.[1] && isConfigRepoName(nestedMatch[1])) return true;
  const providerFieldMatch = path.match(PROVIDER_SAFE_FIELD_PATTERN);
  if (providerFieldMatch?.[1] && isConfigNameSegment(providerFieldMatch[1])) return true;
  const providerCapabilityMatch = path.match(PROVIDER_CAPABILITY_PATTERN);
  return Boolean(providerCapabilityMatch?.[1] && isConfigNameSegment(providerCapabilityMatch[1]));
}

function setNestedValue(target: Record<string, unknown>, path: string[], value: unknown): void {
  let cursor: Record<string, unknown> = target;
  for (const [index, segment] of path.entries()) {
    if (index === path.length - 1) {
      cursor[segment] = value;
      return;
    }
    const existing = cursor[segment];
    if (!isRecord(existing) || Array.isArray(existing)) {
      cursor[segment] = {};
    }
    cursor = cursor[segment] as Record<string, unknown>;
  }
}

function getNestedValue(target: unknown, path: string[]): unknown {
  let cursor = target;
  for (const segment of path) {
    if (!isRecord(cursor)) return undefined;
    cursor = cursor[segment];
  }
  return cursor;
}

function deepEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => deepEqual(entry, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    if (!deepEqual(leftKeys, rightKeys)) return false;
    return leftKeys.every((key) => deepEqual(left[key], right[key]));
  }
  return false;
}

function configMetadataForPath(configPath: string, fileOps?: Partial<ConfigFileOps>): string {
  const ops = { ...defaultConfigFileOps, ...fileOps };
  const stat = ops.statSync(configPath, { bigint: true });
  return [stat.dev, stat.ino, stat.size, stat.mtimeNs, stat.ctimeNs].join(":");
}

function configRevision(text: string): string {
  return createHash("sha256")
    .update(String(Buffer.byteLength(text)))
    .update("\0")
    .update(text)
    .digest("hex");
}

function readStableConfigSnapshot(configPath: string, fileOps?: Partial<ConfigFileOps>): { value: unknown; revision: string } {
  const ops = { ...defaultConfigFileOps, ...fileOps };
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const metadataBefore = configMetadataForPath(configPath, fileOps);
    const text = ops.readFileSync(configPath, "utf8");
    const metadataAfter = configMetadataForPath(configPath, fileOps);
    if (metadataBefore !== metadataAfter) continue;
    const revision = configRevision(text);
    return { value: JSON.parse(text), revision };
  }
  throw new Error("config changed while reading; retry after the other writer finishes");
}

function acquireConfigPatchLock(configPath: string, fileOps?: Partial<ConfigFileOps>): () => void {
  const ops = { ...defaultConfigFileOps, ...fileOps };
  const lockPath = `${configPath}.neondiff.lock`;
  let fd: number | undefined;
  let createdLock = false;
  let lockInode: number | undefined;
  try {
    fd = ops.openSync(lockPath, "wx", 0o600);
    createdLock = true;
    lockInode = ops.fstatSync(fd).ino;
    ops.writeFileSync(fd, `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    return () => {
      if (ops.existsSync(lockPath) && ops.statSync(lockPath).ino === lockInode) {
        ops.unlinkSync(lockPath);
      }
    };
  } catch (error) {
    if (fd !== undefined) {
      try { ops.closeSync(fd); } catch { /* cleanup below */ }
      fd = undefined;
    }
    if (createdLock && lockInode !== undefined && ops.existsSync(lockPath)
      && ops.statSync(lockPath).ino === lockInode) {
      try { ops.unlinkSync(lockPath); } catch { /* surface the original acquisition failure */ }
    }
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") {
      const ownerPid = readConfigLockOwnerPid(lockPath, ops);
      const owner = ownerPid !== undefined && isProcessAlive(ownerPid)
        ? `owned by live PID ${ownerPid}`
        : "stale, corrupt, or owned by an unavailable process";
      throw new Error(
        `another config patch is running or left lock ${lockPath} (${owner}); `
        + "verify no NeonDiff config patch is running, then remove this lock and retry"
      );
    }
    throw new Error(`failed to acquire config patch lock: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function readConfigLockOwnerPid(lockPath: string, ops: ConfigFileOps): number | undefined {
  try {
    const payload = JSON.parse(ops.readFileSync(lockPath, "utf8")) as { pid?: unknown };
    return typeof payload.pid === "number" && Number.isSafeInteger(payload.pid) && payload.pid > 0
      ? payload.pid
      : undefined;
  } catch {
    return undefined;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function validateCandidateConfig(candidate: unknown): string | undefined {
  try {
    loadConfigFromObject(candidate);
    return undefined;
  } catch (error) {
    return `candidate config failed validation: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function writeConfigAtomic(configPath: string, value: unknown, fileOps?: Partial<ConfigFileOps>): string {
  const ops = { ...defaultConfigFileOps, ...fileOps };
  ops.mkdirSync(dirname(configPath), { recursive: true });
  const mode = ops.existsSync(configPath) ? ops.statSync(configPath).mode & 0o777 : 0o600;
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  const data = `${JSON.stringify(value, null, 2)}\n`;
  let fd: number | undefined;
  try {
    fd = ops.openSync(tempPath, "w", mode);
    ops.writeFileSync(fd, data);
    ops.fsyncSync(fd);
    ops.closeSync(fd);
    fd = undefined;
    ops.chmodSync(tempPath, mode);
    ops.renameSync(tempPath, configPath);
    return configRevision(data);
  } catch (error) {
    if (fd !== undefined) {
      try {
        ops.closeSync(fd);
      } catch {
        // Continue cleanup; preserving no temp config is more important here.
      }
    }
    if (ops.existsSync(tempPath)) ops.unlinkSync(tempPath);
    throw error;
  }
}

function redactSecretValue(value: unknown): unknown {
  if (value === undefined || value === null) return value;
  return "[redacted-secret]";
}

function maskAllowedSecretPointerFields(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => maskAllowedSecretPointerFields(entry));
  if (!isRecord(value)) return value;
  const output: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    output[key] = key === "apiKeyEnv" && typeof entry === "string" && isApiKeyEnvName(entry)
      ? "[env-var-name]"
      : maskAllowedSecretPointerFields(entry);
  }
  return output;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findUnsupportedDottedPatchKey(value: unknown, prefix: string[] = []): string[] | undefined {
  if (!isRecord(value)) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    const keyPath = [...prefix, key];
    if (key.includes(".") && !isProfileIdentifierSegment(prefix)) {
      return keyPath;
    }
    const nested = findUnsupportedDottedPatchKey(entry, keyPath);
    if (nested) return nested;
  }
  return undefined;
}

function isProfileIdentifierSegment(prefix: string[]): boolean {
  return prefix.length === 2 && prefix[0] === "repoProfiles" && (prefix[1] === "repos" || prefix[1] === "orgFallbacks");
}

function unsupportedDottedKeyError(path: string[]): string {
  const rendered = renderPatchPath(path);
  if (containsSecretLikeText(rendered)) {
    return "patch contains unsupported dotted key segment; one or more path names looked sensitive";
  }
  return `patch contains unsupported dotted key segment: ${redactSecrets(rendered)}`;
}

function disallowedPatchPathError(paths: string[][]): string {
  const rendered = paths.map(renderPatchPath);
  if (rendered.some((path) => containsSecretLikeText(path))) {
    return "patch contains non-desktop-safe path(s); one or more path names looked sensitive";
  }
  return `patch contains non-desktop-safe path(s): ${rendered.map(redactSecrets).join(", ")}`;
}

function renderPatchPath(path: string[]): string {
  return path.length === 0 ? "<root>" : path.join(".");
}

function isConfigRepoName(value: string): boolean {
  const [owner, repo, extra] = value.split("/");
  return extra === undefined && Boolean(owner && repo && isConfigNameSegment(owner) && isConfigNameSegment(repo));
}

function isConfigNameSegment(value: string): boolean {
  return value !== "." && value !== ".." && /^[A-Za-z0-9_.-]+$/.test(value);
}
