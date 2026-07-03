import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  writeLicenseCache(input.config.cachePath, entitlement);
  writeLicenseKey(input.config, licenseKey);
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
  if (existsSync(input.config.cachePath)) rmSync(input.config.cachePath, { force: true });
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
  if (input.visibility !== "private" || !input.config.privateReposRequireEntitlement) {
    return { ok: true, repo: input.repo, visibility: input.visibility, status: "active", reason: "repo visibility does not require entitlement" };
  }

  const status = await getLicenseStatus({
    config: input.config,
    repo: input.repo,
    refresh: false,
    now: input.now,
    fetchImpl: input.fetchImpl
  });
  if (!status.ok || !status.entitlement || status.entitlement.status !== "active") {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: status.status,
      reason: `private repo review requires active entitlement: ${status.detail}`
    };
  }
  if (!entitlementCoversPrivateRepo(status.entitlement)) {
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: status.status,
      entitlement: status.entitlement,
      reason: `entitlement scope ${status.entitlement.repoVisibilityScope} does not cover private repos`
    };
  }
  return {
    ok: true,
    repo: input.repo,
    visibility: input.visibility,
    status: "active",
    entitlement: status.entitlement,
    reason: "active entitlement covers private repo review"
  };
}

function entitlementCoversPrivateRepo(entitlement: LicenseEntitlement): boolean {
  return entitlement.repoVisibilityScope === "private" || entitlement.repoVisibilityScope === "all";
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
    if (!response.ok) return apiFailureResult(response.status, body, now);

    const entitlement = normalizeEntitlement(body, input.licenseKey, now);
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
      detail: `license API network failure: ${redactSecrets(message)}`
    };
  } finally {
    clearTimeout(timeout);
  }
}

function apiFailureResult(statusCode: number, body: unknown, now: Date): LicenseStatusResult {
  const status = statusCode >= 500 ? "server" : statusFromApiError(statusCode, body);
  return {
    ok: false,
    status,
    source: "api",
    checkedAt: now.toISOString(),
    classification: status,
    detail: `license API returned ${statusCode}: ${redactSecrets(readApiDetail(body, status))}`
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

function normalizeEntitlement(body: unknown, licenseKey: string, now: Date): LicenseEntitlement {
  const record = isRecord(body) && isRecord(body.entitlement) ? body.entitlement : body;
  const status = readBodyStatus(record) ?? "active";
  return {
    status,
    checkedAt: readString(record, "checkedAt") ?? now.toISOString(),
    ...(readString(record, "expiresAt") ? { expiresAt: readString(record, "expiresAt")! } : {}),
    repoVisibilityScope: readRepoVisibilityScope(record) ?? "private",
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
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(entitlement, null, 2)}\n`, { mode: 0o600 });
}

function readLicenseKey(config: LicenseConfig): string | undefined {
  if (config.storageBackend === "file") return readFileLicenseKey(config.keyPath);
  return readKeychainLicenseKey(config);
}

function writeLicenseKey(config: LicenseConfig, licenseKey: string): void {
  if (config.storageBackend === "file") {
    if (!config.keyPath) throw new Error("license.keyPath is required when storageBackend=file");
    mkdirSync(dirname(config.keyPath), { recursive: true });
    writeFileSync(config.keyPath, `${licenseKey}\n`, { mode: 0o600 });
    return;
  }
  writeKeychainLicenseKey(config, licenseKey);
}

function deleteLicenseKey(config: LicenseConfig): void {
  if (config.storageBackend === "file") {
    if (config.keyPath && existsSync(config.keyPath)) rmSync(config.keyPath, { force: true });
    return;
  }
  deleteKeychainLicenseKey(config);
}

function readFileLicenseKey(path: string | undefined): string | undefined {
  if (!path || !existsSync(path)) return undefined;
  const key = readFileSync(path, "utf8").trim();
  return key || undefined;
}

function readKeychainLicenseKey(config: LicenseConfig): string | undefined {
  if (platform() !== "darwin") return undefined;
  const result = spawnSync("security", [
    "find-generic-password",
    "-s",
    config.keychainService,
    "-a",
    config.keychainAccount,
    "-w"
  ], { encoding: "utf8" });
  if (result.status !== 0) return undefined;
  const key = result.stdout.trim();
  return key || undefined;
}

function writeKeychainLicenseKey(config: LicenseConfig, licenseKey: string): void {
  if (platform() !== "darwin") throw new Error("macOS Keychain license storage is only available on darwin; use storageBackend=file for tests/dev");
  const result = spawnSync("security", [
    "add-generic-password",
    "-U",
    "-s",
    config.keychainService,
    "-a",
    config.keychainAccount,
    "-w",
    licenseKey
  ], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(`failed to store license key in Keychain: ${redactSecrets(result.stderr || result.stdout)}`);
}

function deleteKeychainLicenseKey(config: LicenseConfig): void {
  if (platform() !== "darwin") return;
  spawnSync("security", [
    "delete-generic-password",
    "-s",
    config.keychainService,
    "-a",
    config.keychainAccount
  ], { encoding: "utf8" });
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
