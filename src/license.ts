import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { hostname, platform } from "node:os";
import { dirname } from "node:path";
import { redactSecrets } from "./secrets.js";
import { buildApiUrl, normalizeHttpApiBaseUrl } from "./url-safety.js";
import type { LicenseSecretReader } from "./license-secret-store.js";

const MAXIMUM_LICENSE_API_RESPONSE_BYTES = 64 * 1024;

export type LicenseStorageBackend = "keychain" | "file";
export type LicenseStatus =
  | "active"
  | "expired"
  | "revoked"
  | "invalid"
  | "missing"
  | "network"
  | "server"
  | "scope_mismatch"
  | "rate_limited"
  | "unsupported_client"
  | "clock_skew";
type LicenseApiBodyStatus = Exclude<LicenseStatus, "missing" | "network" | "server">;
type NonActiveLicenseApiBodyStatus = Exclude<LicenseApiBodyStatus, "active">;
type LicenseApiErrorStatus = Exclude<LicenseStatus, "active" | "missing" | "network">;
type LicenseFailureClassification = Exclude<LicenseStatus, "active">;
export type RepoVisibilityScope = "public" | "private" | "all";
const MAX_REVOCATION_REASON_LENGTH = 240;

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
  productionPolicy?: LicenseProductionPolicyMetadata;
}

export interface LicensePolicyDiagnostic {
  field:
    | "enabled"
    | "apiBaseUrl"
    | "offlineGraceMs"
    | "publicReposFree"
    | "privateReposRequireEntitlement"
    | "updateEntitlementRequiresLicense"
    | "keychainService"
    | "keychainAccount";
  configured: string;
  effective: string;
  reason: string;
}

export interface LicenseProductionPolicyMetadata {
  mode: "mandatory_online";
  diagnostics: LicensePolicyDiagnostic[];
}

export interface LicenseEntitlement {
  status: LicenseApiBodyStatus;
  checkedAt: string;
  expiresAt?: string;
  repoVisibilityScope: RepoVisibilityScope;
  privateRepoAllowed?: boolean;
  updateEntitlement: boolean;
  offlineGraceMs?: number;
  graceUntil?: string;
  revocationReason?: string;
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
  classification?: LicenseFailureClassification;
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
  /**
   * Persist the raw key plus redacted entitlement cache for the headless CLI.
   * Native callers keep the only raw copy in Keychain and set this false.
   */
  persistLocalState?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<LicenseStatusResult> {
  const now = input.now ?? new Date();
  const persistLocalState = input.persistLocalState ?? true;
  if (!persistLocalState && input.config.storageBackend !== "keychain") {
    return {
      ok: false,
      status: "invalid",
      source: "none",
      checkedAt: now.toISOString(),
      classification: "invalid",
      detail: "no-local-state activation requires storageBackend=keychain"
    };
  }
  if (input.config.storageBackend === "keychain" && persistLocalState) {
    return {
      ok: false,
      status: "invalid",
      source: "none",
      checkedAt: now.toISOString(),
      classification: "invalid",
      detail: "Keychain license activation is disabled in headless CLI until native no-argv secret storage is available; use storageBackend=file"
    };
  }
  const licenseKey = input.licenseKey.trim();
  if (!licenseKey) return missingResult(now, "license key is empty");
  if (!input.config.apiBaseUrl) return serverResult(now, "license API base URL is not configured");

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
  if (!persistLocalState) {
    return {
      ...response,
      entitlement,
      detail: "license activated without local key or cache persistence"
    };
  }
  try {
    writeLicenseKey(input.config, licenseKey);
    writeLicenseCache(input.config.cachePath, entitlement);
  } catch (error) {
    await callLicenseApi({
      config: input.config,
      path: "/v1/license/deactivate",
      licenseKey,
      repo: input.repo,
      now,
      fetchImpl: input.fetchImpl
    });
    deleteLicenseKey(input.config);
    deleteLicenseCache(input.config.cachePath);
    throw error;
  }
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
  licenseSecretReader?: LicenseSecretReader;
}): Promise<LicenseStatusResult> {
  const now = input.now ?? new Date();
  const cached = readLicenseCache(input.config.cachePath, () => readCacheRedactionLicenseKey(input.config));
  if (!input.refresh) return statusFromCache(cached, now);

  const productionRead = input.licenseSecretReader !== undefined;
  let licenseKey: string | undefined;
  try {
    licenseKey = input.licenseSecretReader
      ? input.licenseSecretReader.read(input.config)
      : readLicenseKey(input.config);
  } catch (error) {
    return invalidApiResult(now, error instanceof Error ? error.message : "license secret could not be read safely");
  }
  if (!licenseKey) return productionRead
    ? missingResult(now, "no license key is stored")
    : cached ? statusFromCache(cached, now) : missingResult(now, "no license key is stored");
  if (!input.config.apiBaseUrl) return productionRead
    ? serverResult(now, "license API base URL is not configured")
    : cached ? statusFromCache(cached, now) : serverResult(now, "license API base URL is not configured");

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
    !productionRead &&
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

  if (shouldDeleteLicenseCacheForStatus(response.status) && cachedEntitlementMatchesLicenseKey(cached, licenseKey)) {
    deleteLicenseCache(input.config.cachePath);
  }
  return response;
}

export async function deactivateLicense(input: {
  config: LicenseConfig;
  notifyApi?: boolean;
  now?: Date;
  fetchImpl?: typeof fetch;
}): Promise<{ ok: boolean; status: "deactivated" | "deactivation_failed"; checkedAt: string; apiNotified: boolean; detail: string }> {
  const checkedAt = (input.now ?? new Date()).toISOString();
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
    if (!response.ok) {
      return {
        ok: false,
        status: "deactivation_failed",
        checkedAt,
        apiNotified,
        detail: `license API deactivation failed; local license was kept: ${response.detail}`
      };
    }
  }
  deleteLicenseKey(input.config);
  deleteLicenseCache(input.config.cachePath);
  return {
    ok: true,
    status: "deactivated",
    checkedAt,
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
  refresh?: boolean;
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
    refresh: input.refresh ?? true,
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
  if (
    status.source !== "api" &&
    !entitlementUsableDuringOutage(status.entitlement, input.now ?? new Date(), input.config.offlineGraceMs)
  ) {
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
    const reason = input.visibility === "private" && status.entitlement.privateRepoAllowed === false
      ? "entitlement privateRepoAllowed=false does not allow private repos"
      : `entitlement scope ${status.entitlement.repoVisibilityScope} does not cover ${input.visibility} repos`;
    return {
      ok: false,
      repo: input.repo,
      visibility: input.visibility,
      status: status.status,
      entitlement: status.entitlement,
      reason
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
  if (visibility === "private" && entitlement.privateRepoAllowed === false) return false;
  if (entitlement.repoVisibilityScope === "all") return true;
  if (visibility === "public") return entitlement.repoVisibilityScope === "public" || entitlement.repoVisibilityScope === "private";
  if (visibility === "private") return entitlement.repoVisibilityScope === "private";
  return false;
}

function statusFromCache(entitlement: LicenseEntitlement | undefined, now: Date): LicenseStatusResult {
  if (!entitlement) return missingResult(now, "no entitlement cache exists");
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
    const apiBaseUrl = normalizeHttpApiBaseUrl(input.config.apiBaseUrl, "config.license.apiBaseUrl", "");
    const response = await fetcher(buildApiUrl(apiBaseUrl, input.path, "license API request path"), {
      method: "POST",
      signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        licenseKey: input.licenseKey,
        repo: input.repo,
        machineId: localMachineId()
      })
    });
    const text = await readBoundedResponseText(response);
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
  const bodyStatus = readBodyStatus(body);
  const statusDetail = bodyStatus && bodyStatus !== status ? ` classified=${bodyStatus}` : "";
  return {
    ok: false,
    status,
    source: "api",
    checkedAt: now.toISOString(),
    classification: status,
    detail: redactSubmittedLicenseKey(`license API returned ${statusCode}: ${status}${statusDetail}`, licenseKey)
  };
}

function statusFromApiError(statusCode: number, body: unknown): LicenseApiErrorStatus {
  const bodyStatus = readBodyStatus(body);
  if (bodyStatus && shouldTrustApiBodyStatusForError(statusCode, bodyStatus)) return bodyStatus;
  if (statusCode === 402) return "expired";
  if (statusCode === 429) return "rate_limited";
  if (statusCode === 426) return "unsupported_client";
  if (statusCode === 409) return "scope_mismatch";
  if (statusCode === 403 || statusCode === 410) return "revoked";
  if (statusCode === 401 || statusCode === 404) return "invalid";
  return "server";
}

function normalizeEntitlement(body: unknown, licenseKey: string, now: Date): LicenseEntitlement | undefined {
  const record = isRecord(body) && isRecord(body.entitlement) ? body.entitlement : body;
  const status = readBodyStatus(record);
  const repoVisibilityScope = readRepoVisibilityScope(record);
  if (!status || !repoVisibilityScope) return undefined;
  const expiresAt = readString(record, "expiresAt");
  if (status === "active" && expiresAt) {
    const expiry = Date.parse(expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) return undefined;
  }
  const revocationReason = status === "active" ? undefined : sanitizeRevocationReason(readString(record, "revocationReason"), licenseKey);
  return {
    status,
    checkedAt: now.toISOString(),
    ...(expiresAt ? { expiresAt } : {}),
    repoVisibilityScope,
    ...(readBoolean(record, "privateRepoAllowed") !== undefined ? { privateRepoAllowed: readBoolean(record, "privateRepoAllowed")! } : {}),
    updateEntitlement: readBoolean(record, "updateEntitlement") ?? false,
    ...(readNumber(record, "offlineGraceMs") !== undefined ? { offlineGraceMs: readNumber(record, "offlineGraceMs")! } : {}),
    ...(readString(record, "graceUntil") ? { graceUntil: readString(record, "graceUntil")! } : {}),
    ...(revocationReason ? { revocationReason } : {}),
    ...(readString(record, "plan") ? { plan: readString(record, "plan")! } : {}),
    ...(readNumber(record, "seats") !== undefined ? { seats: readNumber(record, "seats")! } : {}),
    licenseFingerprint: fingerprintLicenseKey(licenseKey)
  };
}

async function readBoundedResponseText(response: Response): Promise<string> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAXIMUM_LICENSE_API_RESPONSE_BYTES) {
    throw new Error("license API response exceeds the supported byte bound");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAXIMUM_LICENSE_API_RESPONSE_BYTES) {
      await reader.cancel();
      throw new Error("license API response exceeds the supported byte bound");
    }
    chunks.push(value);
  }
  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(combined);
}

function readBodyStatus(body: unknown): LicenseApiBodyStatus | undefined {
  const value = readString(body, "status");
  if (
    value === "active" ||
    value === "expired" ||
    value === "revoked" ||
    value === "invalid" ||
    value === "scope_mismatch" ||
    value === "rate_limited" ||
    value === "unsupported_client" ||
    value === "clock_skew"
  ) {
    return value;
  }
  return undefined;
}

function readRepoVisibilityScope(body: unknown): RepoVisibilityScope | undefined {
  const value = readString(body, "repoVisibilityScope") ?? readString(body, "repoScope");
  if (value === "public" || value === "private" || value === "all") return value;
  return undefined;
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

function readLicenseCache(path: string, readRedactionLicenseKey?: () => string | undefined): LicenseEntitlement | undefined {
  if (!existsSync(path)) return undefined;
  const parsed = safeJsonParse(readFileSync(path, "utf8"));
  if (!isRecord(parsed)) return undefined;
  const status = readBodyStatus(parsed);
  const repoVisibilityScope = readRepoVisibilityScope(parsed);
  const checkedAt = readString(parsed, "checkedAt");
  if (!status || !repoVisibilityScope || !checkedAt) return undefined;
  const rawRevocationReason = readString(parsed, "revocationReason");
  const revocationReason = status === "active" || !rawRevocationReason
    ? undefined
    : sanitizeRevocationReason(rawRevocationReason, readRedactionLicenseKey?.() ?? "");
  return {
    status,
    checkedAt,
    ...(readString(parsed, "expiresAt") ? { expiresAt: readString(parsed, "expiresAt")! } : {}),
    repoVisibilityScope,
    ...(readBoolean(parsed, "privateRepoAllowed") !== undefined ? { privateRepoAllowed: readBoolean(parsed, "privateRepoAllowed")! } : {}),
    updateEntitlement: readBoolean(parsed, "updateEntitlement") ?? false,
    ...(readNumber(parsed, "offlineGraceMs") !== undefined ? { offlineGraceMs: readNumber(parsed, "offlineGraceMs")! } : {}),
    ...(readString(parsed, "graceUntil") ? { graceUntil: readString(parsed, "graceUntil")! } : {}),
    ...(revocationReason ? { revocationReason } : {}),
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
  let fd: number | undefined;
  try {
    fd = openSync(tempPath, "w", 0o600);
    writeFileSync(fd, contents);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    chmodSync(tempPath, 0o600);
    renameSync(tempPath, path);
    chmodSync(path, 0o600);
  } catch (error) {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best effort cleanup before rethrowing the original write error.
      }
    }
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

function readCacheRedactionLicenseKey(config: LicenseConfig): string | undefined {
  try {
    return readLicenseKey(config);
  } catch {
    return undefined;
  }
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
  result.stdout = "";
  result.stderr = "";
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

function cachedEntitlementMatchesLicenseKey(entitlement: LicenseEntitlement | undefined, licenseKey: string): boolean {
  return entitlement?.licenseFingerprint === fingerprintLicenseKey(licenseKey);
}

function shouldDeleteLicenseCacheForStatus(status: LicenseStatus): boolean {
  return (
    status === "expired" ||
    status === "revoked" ||
    status === "invalid" ||
    status === "scope_mismatch" ||
    status === "unsupported_client"
  );
}

function shouldTrustApiBodyStatusForError(statusCode: number, status: LicenseApiBodyStatus): status is NonActiveLicenseApiBodyStatus {
  if (status === "active") return false;
  if (shouldDeleteLicenseCacheForStatus(status)) return true;
  if (status === "rate_limited") return statusCode === 429;
  if (status === "clock_skew") return statusCode === 400;
  return false;
}

function redactSubmittedLicenseKey(text: string, licenseKey: string): string {
  if (!licenseKey) return redactSecrets(text);
  return redactSecrets(text.split(licenseKey).join("[REDACTED_LICENSE_KEY]"));
}

function sanitizeRevocationReason(value: string | undefined, licenseKey = ""): string | undefined {
  if (!value) return undefined;
  const redacted = licenseKey ? redactSubmittedLicenseKey(value, licenseKey) : redactSecrets(value);
  const normalized = redacted
    .replace(/[^\x20-\x7E]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (normalized.length <= MAX_REVOCATION_REASON_LENGTH) return normalized;
  return `${normalized.slice(0, MAX_REVOCATION_REASON_LENGTH - 3)}...`;
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
