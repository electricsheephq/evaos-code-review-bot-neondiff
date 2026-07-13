import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  CheckoutIssuanceConflictError,
  CheckoutIssuanceTransientError,
  type LicenseRecord,
  type LicenseStore
} from "./store.js";
import {
  CHECKOUT_LOOKUP_KEYS,
  isCheckoutLookupKey,
  type CheckoutLookupKey
} from "./checkout-policy.js";
import { malformedResult, type ServiceResult } from "./service.js";

const ISSUANCE_FIELDS = new Set([
  "idempotencyKey",
  "checkoutLookupKey",
  "provider",
  "providerAccountId",
  "providerMode",
  "externalSubscriptionId",
  "externalCheckoutId",
  "seats"
]);

export interface LicenseIssuanceRequest {
  idempotencyKey: string;
  checkoutLookupKey: CheckoutLookupKey;
  provider: "stripe";
  providerAccountId: string;
  providerMode: "test" | "live";
  externalSubscriptionId: string;
  externalCheckoutId: string;
  seats?: 1;
}

export interface LicenseIssuanceResult {
  rawKey: string;
  record: LicenseRecord;
  replayed: boolean;
}

export function checkoutLookupKeys(): readonly string[] {
  return CHECKOUT_LOOKUP_KEYS;
}

export function parseIssuanceRequest(raw: string): LicenseIssuanceRequest {
  const parsed = raw ? (JSON.parse(raw) as unknown) : {};
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("request body must be a JSON object");
  }
  const body = parsed as Record<string, unknown>;
  for (const key of Object.keys(body)) {
    if (!ISSUANCE_FIELDS.has(key)) throw new Error("request contains an unknown field");
  }

  const idempotencyKey = readBoundedString(body, "idempotencyKey", { required: true, max: 200 });
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new Error("idempotencyKey contains unsupported characters");
  }

  const checkoutLookupKey = readBoundedString(body, "checkoutLookupKey", { required: true, max: 80 });
  if (!isCheckoutLookupKey(checkoutLookupKey)) {
    throw new Error(`checkoutLookupKey must be one of: ${checkoutLookupKeys().join(", ")}`);
  }

  const provider = readBoundedString(body, "provider", { required: true, max: 40 });
  if (provider !== "stripe") throw new Error("provider must be stripe");
  const providerAccountId = readBoundedString(body, "providerAccountId", {
    required: true,
    max: 160
  });
  const providerMode = readBoundedString(body, "providerMode", { required: true, max: 16 });
  if (providerMode !== "test" && providerMode !== "live") {
    throw new Error("providerMode must be test or live");
  }
  const externalSubscriptionId = readBoundedString(body, "externalSubscriptionId", {
    required: true,
    max: 160
  });
  const externalCheckoutId = readBoundedString(body, "externalCheckoutId", {
    required: true,
    max: 160
  });

  const seatsRaw = body.seats;
  if (seatsRaw !== undefined && seatsRaw !== 1) {
    throw new Error("seats is deprecated and must be exactly 1");
  }

  return {
    idempotencyKey,
    checkoutLookupKey,
    provider,
    providerAccountId,
    providerMode,
    externalSubscriptionId,
    externalCheckoutId,
    ...(seatsRaw === 1 ? { seats: 1 as const } : {})
  };
}

export function issueCheckoutLicense(
  store: LicenseStore,
  req: LicenseIssuanceRequest,
  issuanceSecret: string
): ServiceResult {
  const issueInput = {
    idempotencyKey: req.idempotencyKey,
    checkoutLookupKey: req.checkoutLookupKey,
    binding: {
      provider: req.provider,
      providerAccountId: req.providerAccountId,
      providerMode: req.providerMode,
      externalSubscriptionId: req.externalSubscriptionId,
      externalCheckoutId: req.externalCheckoutId
    }
  };
  const rawKey = deriveCheckoutLicenseKey(issuanceSecret, req.idempotencyKey);

  try {
    const issued = store.issueBoundCheckoutLicense(rawKey, issueInput);
    return {
      httpStatus: 200,
      body: {
        status: "issued",
        replayed: issued.replayed,
        idempotencyKey: req.idempotencyKey,
        licenseKey: issued.rawKey,
        licenseKeyHash: issued.record.licenseKeyHash,
        entitlement: entitlementFromRecord(issued.record)
      }
    };
  } catch (error) {
    if (error instanceof CheckoutIssuanceConflictError) {
      return { httpStatus: 409, body: { status: "conflict", detail: error.message } };
    }
    if (error instanceof CheckoutIssuanceTransientError) {
      return {
        httpStatus: 503,
        body: {
          status: "unavailable",
          detail: "license issuance temporarily unavailable"
        }
      };
    }
    return { httpStatus: 500, body: { status: "server", detail: "license issuance failed" } };
  }
}

export function malformedIssuanceResult(detail: string): ServiceResult {
  return malformedResult(detail);
}

export function validateBearerSecret(header: string | string[] | undefined, expected: string): boolean {
  const value = Array.isArray(header) ? header[0] : header;
  const prefix = "Bearer ";
  if (!value?.startsWith(prefix)) return false;
  const supplied = value.slice(prefix.length);
  return timingSafeEqualDigest(supplied, expected);
}

function deriveCheckoutLicenseKey(secret: string, idempotencyKey: string): string {
  const digest = createHmac("sha256", secret).update(`checkout-license:${idempotencyKey}`).digest();
  return ["nd", "live", digest.subarray(0, 24).toString("base64url")].join("_");
}

function entitlementFromRecord(record: LicenseRecord): Record<string, unknown> {
  return {
    status: "active",
    repoVisibilityScope: record.repoVisibilityScope,
    privateRepoAllowed: record.privateRepoAllowed,
    updateEntitlement: record.updateEntitlement,
    plan: record.plan,
    seats: record.seats,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {})
  };
}

function readBoundedString(
  body: Record<string, unknown>,
  key: string,
  options: { required: true; max: number } | { required: false; max: number }
): string {
  const value = body[key];
  if (typeof value !== "string") {
    if (options.required) throw new Error(`${key} is required`);
    return "";
  }
  const trimmed = value.trim();
  if (!trimmed && options.required) throw new Error(`${key} is required`);
  if (trimmed.length > options.max) throw new Error(`${key} is too long`);
  return trimmed;
}

function timingSafeEqualDigest(a: string, b: string): boolean {
  const aDigest = createHash("sha256").update(a).digest();
  const bDigest = createHash("sha256").update(b).digest();
  return timingSafeEqual(aDigest, bDigest);
}
