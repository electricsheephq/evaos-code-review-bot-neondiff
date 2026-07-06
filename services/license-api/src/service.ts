import type { LicenseRecord, LicenseStore, RepoVisibilityScope } from "./store.js";

/**
 * The entitlement body the client (`src/license.ts`) parses. `status` and
 * `repoVisibilityScope` are REQUIRED — the client rejects a 2xx success that
 * omits either. The raw license key is NEVER echoed here.
 */
export interface Entitlement {
  status: "active" | "expired" | "revoked" | "invalid" | "scope_mismatch";
  repoVisibilityScope: RepoVisibilityScope;
  privateRepoAllowed?: boolean;
  updateEntitlement: boolean;
  expiresAt?: string;
  plan?: string;
  seats?: number;
  revocationReason?: string;
}

/** A normalized result: HTTP status code + the JSON body to serialize. */
export interface ServiceResult {
  httpStatus: number;
  body: Record<string, unknown>;
}

export interface LicenseRequest {
  licenseKey: string;
  repo?: string;
  machineId: string;
}

export interface RateLimiterOptions {
  /** Max requests per key within the window before 429. */
  maxPerWindow: number;
  windowMs: number;
}

/**
 * Minimal in-memory per-key sliding-window limiter. Appropriate for the
 * "normal, not hardened" bar — a single fly instance with a modest request
 * rate. A per-instance limiter is intentional; distributed limiting is not
 * required for this tier.
 */
export class RateLimiter {
  private readonly hits = new Map<string, number[]>();
  private readonly opts: RateLimiterOptions;

  constructor(opts: RateLimiterOptions) {
    this.opts = opts;
  }

  /** Returns true when the request is allowed; false when it should be throttled. */
  allow(key: string, now: number): boolean {
    const cutoff = now - this.opts.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((t) => t > cutoff);
    if (recent.length >= this.opts.maxPerWindow) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(key, recent);
    return true;
  }
}

function entitlementFrom(record: LicenseRecord, status: Entitlement["status"]): Entitlement {
  return {
    status,
    repoVisibilityScope: record.repoVisibilityScope,
    privateRepoAllowed: record.privateRepoAllowed,
    updateEntitlement: record.updateEntitlement,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    ...(record.plan ? { plan: record.plan } : {}),
    ...(record.seats !== undefined ? { seats: record.seats } : {}),
    ...(status !== "active" && record.revocationReason ? { revocationReason: record.revocationReason } : {})
  };
}

function activeEntitlementBody(record: LicenseRecord): ServiceResult {
  return { httpStatus: 200, body: { entitlement: entitlementFrom(record, "active") as unknown as Record<string, unknown> } };
}

/** 404 invalid — key unknown. Never echoes the submitted key. */
function invalidResult(): ServiceResult {
  return { httpStatus: 404, body: { status: "invalid", detail: "license key is not recognized" } };
}

/** 403 revoked. */
function revokedResult(record: LicenseRecord): ServiceResult {
  return {
    httpStatus: 403,
    body: {
      status: "revoked",
      ...(record.revocationReason ? { revocationReason: record.revocationReason } : {}),
      detail: "license is revoked"
    }
  };
}

/** 402 expired. */
function expiredResult(): ServiceResult {
  return { httpStatus: 402, body: { status: "expired", detail: "license is expired" } };
}

/** 409 scope_mismatch — single-activation seat exhausted by a different machine. */
function seatExhaustedResult(record: LicenseRecord): ServiceResult {
  return {
    httpStatus: 409,
    body: {
      status: "scope_mismatch",
      seats: record.seats,
      detail: "license seats are exhausted; deactivate another machine before activating this one"
    }
  };
}

function isExpired(record: LicenseRecord, now: Date): boolean {
  if (!record.expiresAt) return false;
  const ms = Date.parse(record.expiresAt);
  return Number.isFinite(ms) && ms <= now.getTime();
}

/**
 * Resolve a license record to a terminal denial result, or return the record
 * when it is active and unexpired. Shared by activate/validate.
 */
function resolveActiveLicense(store: LicenseStore, req: LicenseRequest, now: Date): { record: LicenseRecord } | ServiceResult {
  const record = store.getLicenseByKey(req.licenseKey);
  if (!record) return invalidResult();
  if (record.status === "revoked") return revokedResult(record);
  if (record.status === "expired" || isExpired(record, now)) return expiredResult();
  return { record };
}

function isServiceResult(value: { record: LicenseRecord } | ServiceResult): value is ServiceResult {
  return "httpStatus" in value;
}

export function activate(store: LicenseStore, req: LicenseRequest, now: Date): ServiceResult {
  const resolved = resolveActiveLicense(store, req, now);
  if (isServiceResult(resolved)) return resolved;
  const { record } = resolved;
  const nowIso = now.toISOString();

  const existing = store.getActivation(record.licenseKeyHash, req.machineId);
  if (existing) {
    // Same machine re-activating → idempotent active, refresh last_seen_at.
    store.upsertActivation(record.licenseKeyHash, req.machineId, req.repo, nowIso);
    return activeEntitlementBody(record);
  }
  // A different machine wants a seat: allow only if seats remain.
  if (store.countActivations(record.licenseKeyHash) >= record.seats) {
    return seatExhaustedResult(record);
  }
  store.upsertActivation(record.licenseKeyHash, req.machineId, req.repo, nowIso);
  return activeEntitlementBody(record);
}

export function validate(store: LicenseStore, req: LicenseRequest, now: Date): ServiceResult {
  const resolved = resolveActiveLicense(store, req, now);
  if (isServiceResult(resolved)) return resolved;
  const { record } = resolved;

  const activation = store.getActivation(record.licenseKeyHash, req.machineId);
  if (!activation) {
    // Key valid but never activated on this machine → single-activation binding fails.
    return seatExhaustedResult(record);
  }
  store.touchActivation(record.licenseKeyHash, req.machineId, now.toISOString());
  return activeEntitlementBody(record);
}

export function deactivate(store: LicenseStore, req: LicenseRequest, now: Date): ServiceResult {
  const record = store.getLicenseByKey(req.licenseKey);
  if (!record) return invalidResult();
  // Idempotent: removing an absent activation still returns ok. Frees the seat.
  store.removeActivation(record.licenseKeyHash, req.machineId);
  return {
    httpStatus: 200,
    body: {
      status: "active",
      repoVisibilityScope: record.repoVisibilityScope,
      updateEntitlement: record.updateEntitlement,
      detail: "machine deactivated"
    }
  };
}

/** 429 rate_limited. */
export function rateLimitedResult(): ServiceResult {
  return { httpStatus: 429, body: { status: "rate_limited", detail: "too many requests for this license" } };
}

/** 400 malformed request. */
export function malformedResult(detail: string): ServiceResult {
  return { httpStatus: 400, body: { status: "invalid", detail } };
}
