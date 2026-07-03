import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadConfig, loadConfigFromObject, type RepoProfileConfig } from "./config.js";
import { containsSecretLikeText, redactSecrets } from "./secrets.js";

const SECRET_KEY_PATTERN = /(?:token|secret|password|cookie|license|api[_-]?key|privateKey)/i;
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

const EXACT_PATCH_PATHS = new Set([
  "pilotRepos",
  "skipDrafts",
  "canaryPulls",
  "zcode.cliPath",
  "zcode.appConfigPath",
  "zcode.model",
  "zcode.providerId",
  "zcode.timeoutMs",
  "github.appId",
  "github.apiBaseUrl",
  "github.botLogin",
  "github.requestTimeoutMs",
  "desktop.openAICompatibleEndpoint",
  "desktop.updateChannel"
]);

const REPO_PROFILE_FIELD_PATTERN =
  new RegExp(`^repoProfiles\\.(?:repos\\.[A-Za-z0-9_.-]+\\/[A-Za-z0-9_.-]+|orgFallbacks\\.[A-Za-z0-9_.-]+)\\.(?:${REPO_PROFILE_DESKTOP_SAFE_FIELD_PATTERN})$`);

const REPO_PROFILE_NESTED_PATTERN =
  /^repoProfiles\.repos\.[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\.(?:autoReview\.(?:baseBranches|labels)|preMergeChecks\.(?:title|description|linkedIssue|testEvidence|docs|docstrings)\.(?:mode|instructions|threshold)|finishingTouches\.(?:docs|docstrings|unitTests|simplifySuggestion|changelogDraft|riskExplanation|reviewReady|stackedPr)\.(?:enabled|instructions))$/;

export interface ConfigInspectResult {
  ok: true;
  command: "config inspect";
  configPath?: string;
  exists: boolean;
  source: "file" | "defaults";
  editablePaths: string[];
  config: unknown;
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
  config?: unknown;
  error?: string;
}

interface FlattenedPatch {
  path: string[];
  value: unknown;
}

export function inspectConfigForDesktop(configPath?: string): ConfigInspectResult {
  const resolvedConfigPath = configPath ? resolve(configPath) : undefined;
  const config = loadConfig(resolvedConfigPath);
  return {
    ok: true,
    command: "config inspect",
    ...(resolvedConfigPath ? { configPath: resolvedConfigPath } : {}),
    exists: resolvedConfigPath ? existsSync(resolvedConfigPath) : false,
    source: resolvedConfigPath && existsSync(resolvedConfigPath) ? "file" : "defaults",
    editablePaths: editablePatchPaths(),
    config: redactConfigObject(config)
  };
}

export function patchConfigForDesktop(input: {
  configPath: string;
  inputPath: string;
  dryRun: boolean;
  confirm: boolean;
}): ConfigPatchResult {
  const configPath = resolve(input.configPath);
  const inputPath = resolve(input.inputPath);
  if (!existsSync(configPath)) {
    return failedPatch(input, configPath, inputPath, "config file does not exist");
  }
  if (!existsSync(inputPath)) {
    return failedPatch(input, configPath, inputPath, "patch input file does not exist");
  }
  if (!input.dryRun && !input.confirm) {
    return failedPatch(input, configPath, inputPath, "config patch with --dry-run false requires --confirm true");
  }

  let current: unknown;
  let patch: unknown;
  try {
    current = JSON.parse(readFileSync(configPath, "utf8"));
    patch = JSON.parse(readFileSync(inputPath, "utf8"));
  } catch (error) {
    return failedPatch(input, configPath, inputPath, `invalid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(current)) {
    return failedPatch(input, configPath, inputPath, "config file must contain a JSON object");
  }
  if (!isRecord(patch)) {
    return failedPatch(input, configPath, inputPath, "patch input must contain a JSON object");
  }
  const patchText = JSON.stringify(patch);
  if (containsSecretLikeText(patchText)) {
    return failedPatch(input, configPath, inputPath, "patch input contains secret-like text; store provider and license keys in Keychain instead");
  }

  const flattened = flattenPatch(patch);
  if (flattened.length === 0) {
    return failedPatch(input, configPath, inputPath, "patch input did not contain any leaf settings");
  }
  const disallowed = flattened.map((entry) => entry.path.join(".")).filter((path) => !isPatchPathAllowed(path));
  if (disallowed.length > 0) {
    return failedPatch(input, configPath, inputPath, `patch contains non-desktop-safe path(s): ${disallowed.join(", ")}`);
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

  const validationError = validateCandidateConfig(next);
  if (validationError) return failedPatch(input, configPath, inputPath, validationError);

  if (!input.dryRun && changedPaths.length > 0) {
    writeConfigAtomic(configPath, next);
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
    output[key] = SECRET_KEY_PATTERN.test(key) ? redactSecretValue(entry) : redactConfigObject(entry);
  }
  return output;
}

export function editablePatchPaths(): string[] {
  return [
    ...EXACT_PATCH_PATHS,
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
  return EXACT_PATCH_PATHS.has(path) || REPO_PROFILE_FIELD_PATTERN.test(path) || REPO_PROFILE_NESTED_PATTERN.test(path);
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
  return JSON.stringify(left) === JSON.stringify(right);
}

function validateCandidateConfig(candidate: unknown): string | undefined {
  try {
    loadConfigFromObject(candidate);
    return undefined;
  } catch (error) {
    return `candidate config failed validation: ${error instanceof Error ? error.message : String(error)}`;
  }
}

function writeConfigAtomic(configPath: string, value: unknown): void {
  mkdirSync(dirname(configPath), { recursive: true });
  const mode = existsSync(configPath) ? statSync(configPath).mode & 0o777 : 0o600;
  const tempPath = `${configPath}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, { mode });
  chmodSync(tempPath, mode);
  renameSync(tempPath, configPath);
}

function redactSecretValue(value: unknown): unknown {
  if (value === undefined || value === null || value === "") return value;
  if (Array.isArray(value)) return value.map((entry) => redactSecretValue(entry));
  if (isRecord(value)) {
    return Object.fromEntries(Object.keys(value).map((key) => [key, "[redacted-secret]"]));
  }
  return "[redacted-secret]";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
