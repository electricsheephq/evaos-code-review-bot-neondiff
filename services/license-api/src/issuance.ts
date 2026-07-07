import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import {
  type IssueLicenseInput,
  type LicenseRecord,
  type LicenseStore,
  type RepoVisibilityScope
} from "./store.js";
import { malformedResult, type ServiceResult } from "./service.js";

const ACTIVE_CHECKOUT_LOOKUP_KEYS = {
  neondiff_monthly: "monthly_support",
  neondiff_yearly: "yearly_support",
  neondiff_org_yearly: "org_yearly_support"
} as const;

type CheckoutLookupKey = keyof typeof ACTIVE_CHECKOUT_LOOKUP_KEYS;

export interface LicenseIssuanceRequest {
  idempotencyKey: string;
  checkoutLookupKey: CheckoutLookupKey;
  customerEmail?: string;
  externalCustomerId?: string;
  externalCheckoutId?: string;
  seats?: number;
  expiresAt?: string;
}

export interface LicenseIssuanceInput extends IssueLicenseInput {
  idempotencyKey: string;
  requestHash: string;
  source?: string;
  externalRef?: string;
}

export interface LicenseIssuanceResult {
  rawKey: string;
  record: LicenseRecord;
  replayed: boolean;
}

export function checkoutLookupKeys(): readonly string[] {
  return Object.keys(ACTIVE_CHECKOUT_LOOKUP_KEYS);
}

export function parseIssuanceRequest(raw: string): LicenseIssuanceRequest {
  const parsed = raw ? (JSON.parse(raw) as unknown) : {};
  if (typeof parsed !== "object" || parsed === null) throw new Error("request body must be a JSON object");
  const body = parsed as Record<string, unknown>;

  const idempotencyKey = readBoundedString(body, "idempotencyKey", { required: true, max: 200 });
  if (!/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    throw new Error("idempotencyKey contains unsupported characters");
  }

  const checkoutLookupKey = readBoundedString(body, "checkoutLookupKey", { required: true, max: 80 });
  if (!isCheckoutLookupKey(checkoutLookupKey)) {
    throw new Error(`checkoutLookupKey must be one of: ${checkoutLookupKeys().join(", ")}`);
  }

  const seatsRaw = body.seats;
  const seats = seatsRaw === undefined ? undefined : Number(seatsRaw);
  if (seats !== undefined && (!Number.isInteger(seats) || seats < 1 || seats > 500)) {
    throw new Error("seats must be a positive integer <= 500");
  }

  const expiresAt = readBoundedString(body, "expiresAt", { required: false, max: 80 });
  if (expiresAt && !Number.isFinite(Date.parse(expiresAt))) {
    throw new Error("expiresAt must be an ISO timestamp");
  }
  const customerEmail = readBoundedString(body, "customerEmail", { required: false, max: 320 });
  const externalCustomerId = readBoundedString(body, "externalCustomerId", { required: false, max: 160 });
  const externalCheckoutId = readBoundedString(body, "externalCheckoutId", { required: false, max: 160 });

  return {
    idempotencyKey,
    checkoutLookupKey,
    ...(customerEmail ? { customerEmail } : {}),
    ...(externalCustomerId ? { externalCustomerId } : {}),
    ...(externalCheckoutId ? { externalCheckoutId } : {}),
    ...(seats !== undefined ? { seats } : {}),
    ...(expiresAt ? { expiresAt } : {})
  };
}

export function issueCheckoutLicense(
  store: LicenseStore,
  req: LicenseIssuanceRequest,
  issuanceSecret: string
): ServiceResult {
  const plan = ACTIVE_CHECKOUT_LOOKUP_KEYS[req.checkoutLookupKey];
  const issueInput: LicenseIssuanceInput = {
    idempotencyKey: req.idempotencyKey,
    requestHash: issuanceRequestHash(req),
    source: "checkout",
    externalRef: req.externalCheckoutId ?? req.externalCustomerId,
    plan,
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true,
    ...(req.seats !== undefined ? { seats: req.seats } : {}),
    ...(req.expiresAt ? { expiresAt: req.expiresAt } : {})
  };
  const rawKey = deriveCheckoutLicenseKey(issuanceSecret, req.idempotencyKey);

  try {
    const issued = store.issueIdempotentLicense(rawKey, issueInput);
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
    const detail = error instanceof Error ? error.message : "license issuance failed";
    if (detail.includes("idempotency key")) {
      return { httpStatus: 409, body: { status: "conflict", detail } };
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

function issuanceRequestHash(req: LicenseIssuanceRequest): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        checkoutLookupKey: req.checkoutLookupKey,
        customerEmail: req.customerEmail ?? null,
        externalCustomerId: req.externalCustomerId ?? null,
        externalCheckoutId: req.externalCheckoutId ?? null,
        seats: req.seats ?? null,
        expiresAt: req.expiresAt ?? null
      })
    )
    .digest("hex");
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

function isCheckoutLookupKey(value: string): value is CheckoutLookupKey {
  return Object.prototype.hasOwnProperty.call(ACTIVE_CHECKOUT_LOOKUP_KEYS, value);
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
