import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, platform } from "node:os";
import { dirname } from "node:path";
import { redactSecrets } from "./secrets.js";

export type LicenseStorageBackend = "keychain" | "file";
export type LicenseStatus = "active" | "expired" | "revoked" | "invalid" | "missing" | "network" | "server";
export type RepoVisibilityScope = "public" | "private" | "all";

export interface LicenseConfig {
  enabled: boolean;
  apiBaseUrl?: string;
  cachePath: string;
  storageBackend: LicenseStorageBackend;
  keyPath?: string;
  keychainService: string;
  keychainAccount: string;
  requestTimeoutMs: number;
  offlineGraceMs: number;
  publicReposFree: boolean;
  privateReposRequireEntitlement: boolean;
  updateEntitlementRequiresLicense: boolean;
}

export interface LicenseEntitlement {
  status: Exclude<LicenseStatus, "missing" | "network" | "server">;
  checkedAt: string;
  expiresAt?: string;
  repoVisibilityScope: RepoVisibilityScope;
  updateEntitlement: boolean;
  plan?: string;
  seats?: number;
  licenseFingerprint?: string;
}

export interface LicenseStatusResult {
  ok: boolean;
  status: LicenseStatus;
  source: "cache" | "api" | "none";
  checkedAt: string;
  entitlement?: LicenseEntitlement;
  stale?: boolean;
  classification?: "missing" | "expired" | "revoked" | "invalid" | "network" | "server";
  detail: string;
}

export interface LicenseReviewGateResult {
  ok: boolean;
  repo: string;
  visibility: "public" | "private" | "unknown";
  status: LicenseStatus;
  reason: string;
  entitlement?: LicenseEntitlement;
}

export async function activateLicense(input: {
  config: LicenseConfig;
  licenseKey: string;
  repo?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<LicenseStatusResult> {
  const licenseKey = input.licenseKey.trim();
  if (!licenseKey) return missingResult(input.now, "license key is empty");
  if (!input.config.apiBaseUrl) return serverResult(input.now, "license API base URL is not configured");

  const response = await callLicenseApi({
    config: input.config,
    path: "/v1/license/activate",
    licenseKey,
    repo: input.repo,
    now: input.now,
    fetchImpl: input.fetchImpl
  });
  if (!response.ok || !response.entitlement) return response;

  const entitlement = {
    ...response.entitlement,
    licenseFingerprint: fingerprintLicenseKey(licenseKey)
  };
  writeLicenseKey(input.config, licenseKey);
  writeLicenseCache(input.config.cachePath, entitlement);
  return {
    ...response,
    entitlement,
    detail: "license activated and entitlement cache updated"
  };
}

export async function getLicenseStatus(input: {
  config: LicenseConfig;
  repo?: string;
  refresh?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<LicenseStatusResult> {
  const now = input.now ?? new Date();
  const cached = readLicenseCache(input.config.cachePath);
  if (!input.refresh) return statusFromCache(cached, now);

  const licenseKey = readLicenseKey(input.config);
  if (!licenseKey) return cached ? statusFromCache(cached, now) : missingResult(now, "no license key is stored");
  if (!input.config.apiBaseUrl) return cached ? statusFromCache(cached, now) : serverResult(now, "license API base URL is not configured");

  const response = await callLicenseApi({
    config: input.config,
    path: "/v1/license/validate",
    licenseKey,
    repo: input.repo,
    now,
    fetchImpl: input.fetchImpl
  });
  if (response.ok && response.entitlement) {
    const entitlement = {
      ...response.entitlement,
      licenseFingerprint: fingerprintLicenseKey(licenseKey)
    };
    writeLicenseCache(input.config.cachePath, entitlement);
    return { ...response, entitlement };
  }

  if (
    (response.status === "network" || response.status === "server") &&
    cached &&
    entitlementUsableDuringOutage(cached, now, input.config.offlineGraceMs)
  ) {
    return {
      ok: true,
      status: "active",
      source: "cache",
      checkedAt: now.toISOString(),
      entitlement: cached,
      stale: true,
      classification: response.status,
      detail: `using cached entitlement after ${response.status} license API failure`
    };
  }
  if (response.status === "expired" || response.status === "revoked" || response.status === "invalid") {
    deleteLicenseCache(input.config.cachePath);
  }
  return response;
}

export async function deactivateLicense(input: {
  config: LicenseConfig;
  notifyApi?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: "deactivated"; checkedAt: string; apiNotified: boolean; detail: string }> {
  const licenseKey = readLicenseKey(input.config);
  let apiNotified = false;
  if (input.notifyApi && licenseKey && input.config.apiBaseUrl) {
    const response = await callLicenseApi({
      config: input.config,
      path: "/v1/license/deactivate",
      licenseKey,
      now: input.now,
      fetchImpl: input.fetchImpl
    });
    apiNotified = response.ok;
  }
  deleteLicenseKey(input.config);
  deleteLicenseCache(input.config.cachePath);
  return {
    ok: true,
    status: "deactivated",
    checkedAt: (input.now ?? new Date()).toISOString(),
    apiNotified,
    detail: apiNotified ? "license removed and API notified" : "license removed locally"
  };
}

export async function evaluateLicenseReviewGate(input: {
  config: LicenseConfig;
  repo: string;
  visibility: "public" | "private" | "unknown";
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<LicenseReviewGateResult> {
  if (!input.config.enabled) {
    return { ok: true, repo: input.repo, visibility: input.visibility, status: "active", reason: "license enforcement disabled" };
  }
  if (input.visibility === "public" && input.config.publicReposFree) {
    return { ok: true, repo: input.repo, visibility: input.visibility, status: "active", reason: "public repo path is free" };
  }
  if (input.visibility === "unknown" && input.config.privateReposRequireEntitlement) {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: "network",
      reason: "repo visibility is unknown; private repo entitlement gate fails closed"
    };
  }
  if (!repoVisibilityRequiresEntitlement(input.visibility, input.config)) {
    return { ok: true, repo: input.repo, visibility: input.visibility, status: "active", reason: "repo visibility does not require entitlement" };
  }

  const status = await getLicenseStatus({
    config: input.config,
    repo: input.repo,
    refresh: true,
    now: input.now,
    fetchImpl: input.fetchImpl
  });
  if (!status.ok || !status.entitlement || status.entitlement.status !== "active") {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: status.status,
      reason: `${input.visibility} repo review requires active entitlement: ${status.detail}`
    };
  }
  if (!entitlementUsableDuringOutage(status.entitlement, input.now ?? new Date(), input.config.offlineGraceMs)) {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: "expired",
      entitlement: status.entitlement,
      reason: `${input.visibility} repo review requires a fresh entitlement cache within offlineGraceMs=${input.config.offlineGraceMs}`
    };
  }
  if (!entitlementCoversRepoVisibility(status.entitlement, input.visibility)) {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: status.status,
      entitlement: status.entitlement,
      reason: `entitlement scope ${status.entitlement.repoVisibilityScope} does not cover ${input.visibility} repos`
    };
  }
  return {
    ok: true,
    repo: input.repo,
    visibility: input.visibility,
    status: "active",
    entitlement: status.entitlement,
    reason: `active entitlement covers ${input.visibility} repo review`
  };
}

function repoVisibilityRequiresEntitlement(visibility: "public" | "private" | "unknown", config: LicenseConfig): boolean {
  if (visibility === "private") return config.privateReposRequireEntitlement;
  if (visibility === "public") return !config.publicReposFree;
  return config.privateReposRequireEntitlement;
}

function entitlementCoversRepoVisibility(entitlement: LicenseEntitlement, visibility: "public" | "private" | "unknown"): boolean {
  if (entitlement.repoVisibilityScope === "all") return true;
  if (visibility === "public") return entitlement.repoVisibilityScope === "public" || entitlement.repoVisibilityScope === "private";
  if (visibility === "private") return entitlement.repoVisibilityScope === "private";
  return false;
}

function statusFromCache(entitlement: LicenseEntitlement | undefined, now: Date): LicenseStatusResult {
  if (!entitlement) return missingResult(now, "no entitlement cache exists");
  if (!entitlementCurrentlyUsable(entitlement, now)) {
    return {
      ok: false,
      status: "expired",
      source: "cache",
      checkedAt: now.toISOString(),
      entitlement,
      classification: "expired",
      detail: `cached entitlement expired at ${entitlement.expiresAt ?? "unknown"}`
    };
  }
  if (entitlement.status !== "active") {
    return {
      ok: false,
      status: entitlement.status,
      source: "cache",
      checkedAt: now.toISOString(),
      entitlement,
      classification: entitlement.status,
      detail: `cached entitlement status is ${entitlement.status}`
    };
  }
  return {
    ok: true,
    status: "active",
    source: "cache",
    checkedAt: now.toISOString(),
    entitlement,
    detail: "cached entitlement is active"
  };
}

function entitlementCurrentlyUsable(entitlement: LicenseEntitlement, now: Date): boolean {
  if (entitlement.status !== "active") return false;
  if (!entitlement.expiresAt) return true;
  return Date.parse(entitlement.expiresAt) > now.getTime();
}

function entitlementUsableDuringOutage(entitlement: LicenseEntitlement, now: Date, offlineGraceMs: number): boolean {
  if (!entitlementCurrentlyUsable(entitlement, now)) return false;
  const checkedAtMs = Date.parse(entitlement.checkedAt);
  if (!Number.isFinite(checkedAtMs)) return false;
  return checkedAtMs + offlineGraceMs >= now.getTime();
}

async function callLicenseApi(input: {
  config: LicenseConfig;
  path: string;
  licenseKey: string;
  repo?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<LicenseStatusResult> {
  const now = input.now ?? new Date();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("license API request timed out")), input.config.requestTimeoutMs);
  try {
    const fetcher = input.fetchImpl ?? fetch;
    const response = await fetcher(`${input.config.apiBaseUrl}${input.path}`, {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseKey: input.licenseKey,
        repo: input.repo,
        machineId: localMachineId()
      })
    });
    const text = await response.text();
    const body = text ? safeJsonParse(text) : {};
    if (!response.ok) return apiFailureResult(response.status, body, now, input.licenseKey);

    const entitlement = normalizeEntitlement(body, input.licenseKey, now);
    if (!entitlement) return invalidApiResult(now, "license API returned malformed success response");
    return {
      ok: entitlement.status === "active",
      status: entitlement.status,
      source: "api",
      checkedAt: now.toISOString(),
      entitlement,
      ...(entitlement.status === "active" ? {} : { classification: entitlement.status }),
      detail: entitlement.status === "active" ? "license API returned active entitlement" : `license API returned ${entitlement.status}`
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      status: "network",
      source: "none",
      checkedAt: now.toISOString(),
      classification: "network",
      detail: `license API network failure: ${redactSubmittedLicenseKey(message, input.licenseKey)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function apiFailureResult(statusCode: number, body: unknown, now: Date, licenseKey: string): LicenseStatusResult {
  const status = statusCode >= 500 ? "server" : statusFromApiError(statusCode, body);
  return {
    ok: false,
    status,
    source: "api",
    checkedAt: now.toISOString(),
    classification: status,
    detail: `license API returned ${statusCode}: ${redactSubmittedLicenseKey(readApiDetail(body, status), licenseKey)}`
  };
}

function statusFromApiError(statusCode: number, body: unknown): Exclude<LicenseStatus, "active" | "missing"> {
  const bodyStatus = readBodyStatus(body);
  if (bodyStatus === "expired" || bodyStatus === "revoked" || bodyStatus === "invalid") return bodyStatus;
  if (statusCode === 402) return "expired";
  if (statusCode === 403 || statusCode === 410) return "revoked";
  if (statusCode === 401 || statusCode === 404) return "invalid";
  return "server";
}

function normalizeEntitlement(body: unknown, licenseKey: string, now: Date): LicenseEntitlement | undefined {
  const record = isRecord(body) && isRecord(body.entitlement) ? body.entitlement : body;
  const status = readBodyStatus(record);
  const repoVisibilityScope = readRepoVisibilityScope(record);
  if (!status || !repoVisibilityScope) return undefined;
  return {
    status,
    checkedAt: now.toISOString(),
    ...(readString(record, "expiresAt") ? { expiresAt: readString(record, "expiresAt")! } : {}),
    repoVisibilityScope,
    updateEntitlement: readBoolean(record, "updateEntitlement") ?? false,
    ...(readString(record, "plan") ? { plan: readString(record, "plan")! } : {}),
    ...(readNumber(record, "seats") !== undefined ? { seats: readNumber(record, "seats")! } : {}),
    licenseFingerprint: fingerprintLicenseKey(licenseKey)
  };
}

function readBodyStatus(body: unknown): Exclude<LicenseStatus, "missing" | "network" | "server"> | undefined {
  const value = readString(body, "status");
  if (value === "active" || value === "expired" || value === "revoked" || value === "invalid") return value;
  return undefined;
}

function readRepoVisibilityScope(body: unknown): RepoVisibilityScope | undefined {
  const value = readString(body, "repoVisibilityScope") ?? readString(body, "repoScope");
  if (value === "public" || value === "private" || value === "all") return value;
  return undefined;
}

function readApiDetail(body: unknown, fallback: string): string {
  return readString(body, "detail") ?? readString(body, "message") ?? fallback;
}

function missingResult(now = new Date(), detail = "license is missing"): LicenseStatusResult {
  return {
    ok: false,
    status: "missing",
    source: "none",
    checkedAt: now.toISOString(),
    classification: "missing",
    detail
  };
}

function serverResult(now = new Date(), detail = "license API is unavailable"): LicenseStatusResult {
  return {
    ok: false,
    status: "server",
    source: "none",
    checkedAt: now.toISOString(),
    classification: "server",
    detail
  };
}

function invalidApiResult(now: Date, detail: string): LicenseStatusResult {
  return {
    ok: false,
    status: "invalid",
    source: "api",
    checkedAt: now.toISOString(),
    classification: "invalid",
    detail
  };
}

function readLicenseCache(path: string): LicenseEntitlement | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = safeJsonParse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) return undefined;
  const status = readBodyStatus(parsed);
  const repoVisibilityScope = readRepoVisibilityScope(parsed);
  const checkedAt = readString(parsed, "checkedAt");
  if (!status || !repoVisibilityScope || !checkedAt) return undefined;
  return {
    status,
    checkedAt,
    ...(readString(parsed, "expiresAt") ? { expiresAt: readString(parsed, "expiresAt")! } : {}),
    repoVisibilityScope,
    updateEntitlement: readBoolean(parsed, "updateEntitlement") ?? false,
    ...(readString(parsed, "plan") ? { plan: readString(parsed, "plan")! } : {}),
    ...(readNumber(parsed, "seats") !== undefined ? { seats: readNumber(parsed, "seats")! } : {}),
    ...(readString(parsed, "licenseFingerprint") ? { licenseFingerprint: readString(parsed, "licenseFingerprint")! } : {})
  };
}

function writeLicenseCache(path: string, entitlement: LicenseEntitlement): void {
  writeAtomicSecretFile(path, `${JSON.stringify(entitlement, null, 2)}\n`);
}

function readLicenseKey(config: LicenseConfig): string | undefined {
  if (config.storageBackend === "file") return readFileLicenseKey(config.keyPath);
  return readKeychainLicenseKey(config);
}

function writeLicenseKey(config: LicenseConfig, licenseKey: string): void {
  if (config.storageBackend === "file") {
    if (!config.keyPath) throw new Error("license.keyPath is required when storageBackend=file");
    writeAtomicSecretFile(config.keyPath, `${licenseKey}\n`);
    return;
  }
  writeKeychainLicenseKey(config, licenseKey);
}

function deleteLicenseKey(config: LicenseConfig): void {
  if (config.storageBackend === "file") {
    if (config.keyPath) removeExistingFile(config.keyPath);
    return;
  }
  deleteKeychainLicenseKey(config);
}

function deleteLicenseCache(path: string): void {
  removeExistingFile(path);
}

function writeAtomicSecretFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tempPath, contents, { mode: 0o600 });
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    rmSync(tempPath, { force: true });
    throw error;
  }
}

function removeExistingFile(path: string): void {
  if (!existsSync(path)) return;
  try {
    rmSync(path);
  } catch (error) {
    if (isErrno(error) && error.code === "ENOENT") return;
    throw error;
  }
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function readFileLicenseKey(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const key = readFileSync(path, "utf8").trim();
  return key || undefined;
}

function readKeychainLicenseKey(config: LicenseConfig): string | undefined {
  if (platform() !== "darwin") {
    throw new Error("macOS Keychain license storage is only available on darwin; use storageBackend=file for headless Linux/CI");
  }
  const result = spawnSync("security", [
    "find-generic-password",
    "-s",
    config.keychainService,
    "-a",
    config.keychainAccount,
    "-w"
  ], { encoding: "utf8" });
  const key = result.stdout.trim();
  if (result.status !== 0) return undefined;
  return key || undefined;
}

function writeKeychainLicenseKey(_config: LicenseConfig, _licenseKey: string): void {
  throw new Error("Keychain license activation is disabled in headless CLI until native no-argv secret storage is available; use storageBackend=file with 0600 permissions");
}

function deleteKeychainLicenseKey(config: LicenseConfig): void {
  if (platform() !== "darwin") return;
  const result = spawnSync("security", [
    "delete-generic-password",
    "-s",
    config.keychainService,
    "-a",
    config.keychainAccount
  ], { encoding: "utf8" });
  if (result.status !== 0 && !/could not be found|The specified item could not be found/i.test(result.stderr || result.stdout)) {
    throw new Error(`failed to delete license key from Keychain: ${redactSecrets(result.stderr || result.stdout)}`);
  }
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

function fingerprintLicenseKey(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

function redactSubmittedLicenseKey(text: string, licenseKey: string): string {
  const genericRedacted = redactSecrets(text);
  if (!licenseKey) return genericRedacted;
  return genericRedacted.split(licenseKey).join("[REDACTED_LICENSE_KEY]");
}

function localMachineId(): string {
  return createHash("sha256").update(`${platform()}:${hostname()}`).digest("hex").slice(0, 24);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(body: unknown, key: string): string | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function readBoolean(body: unknown, key: string): boolean | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === "boolean" ? value : undefined;
}

function readNumber(body: unknown, key: string): number | undefined {
  if (!isRecord(body)) return undefined;
  const value = body[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
