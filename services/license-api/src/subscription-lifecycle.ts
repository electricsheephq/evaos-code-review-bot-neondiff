import { createHash } from "node:crypto";

export const MAX_LIFECYCLE_BODY_BYTES = 16 * 1024;

const MAX_ISSUANCE_KEY_LENGTH = 200;
const MAX_EVENT_ID_LENGTH = 200;
const MAX_PROVIDER_ACCOUNT_ID_LENGTH = 160;
const MAX_SUBSCRIPTION_ID_LENGTH = 160;
const MAX_PAYMENT_REFERENCE_LENGTH = 200;
const MAX_FUTURE_SKEW_SECONDS = 5 * 60;

const REQUEST_FIELDS = new Set([
  "schemaVersion",
  "issuanceIdempotencyKey",
  "eventId",
  "eventCreatedAt",
  "provider",
  "providerAccountId",
  "providerMode",
  "externalSubscriptionId",
  "providerEventType",
  "command",
  "paymentReference",
  "amountPaidMinor",
  "currency",
  "paidOutOfBand",
  "billingReason",
  "subscriptionStatus",
  "currentPeriodEnd",
  "cancelAtPeriodEnd",
  "reason"
]);

const PAYMENT_FIELDS = [
  "paymentReference",
  "amountPaidMinor",
  "currency",
  "paidOutOfBand",
  "billingReason"
] as const;

export type SubscriptionLifecycleCommand =
  | "renew_paid"
  | "reconcile"
  | "cancel_at_period_end"
  | "payment_attention"
  | "revoke";

export type SubscriptionProviderMode = "test" | "live";

interface CommonSubscriptionLifecycleRequest {
  readonly schemaVersion: 1;
  readonly issuanceIdempotencyKey: string;
  readonly eventId: string;
  readonly eventCreatedAt: number;
  readonly provider: "stripe";
  readonly providerAccountId: string;
  readonly providerMode: SubscriptionProviderMode;
  readonly externalSubscriptionId: string;
  readonly cancelAtPeriodEnd: boolean;
}

export interface RenewPaidSubscriptionLifecycleRequest
  extends CommonSubscriptionLifecycleRequest {
  readonly command: "renew_paid";
  readonly providerEventType: "invoice.paid" | "invoice.payment_succeeded";
  readonly subscriptionStatus: "active";
  readonly paymentReferenceFingerprint: string;
  readonly amountPaidMinor: number;
  readonly currency: "usd";
  readonly paidOutOfBand: false;
  readonly billingReason: "subscription_cycle";
  readonly currentPeriodEnd: string;
}

export interface ReconcileSubscriptionLifecycleRequest
  extends CommonSubscriptionLifecycleRequest {
  readonly command: "reconcile";
  readonly providerEventType: "customer.subscription.updated";
  readonly subscriptionStatus: "active" | "trialing";
  readonly cancelAtPeriodEnd: false;
  readonly diagnosticCurrentPeriodEnd?: string;
}

export interface CancelSubscriptionLifecycleRequest
  extends CommonSubscriptionLifecycleRequest {
  readonly command: "cancel_at_period_end";
  readonly providerEventType: "customer.subscription.updated";
  readonly subscriptionStatus: "active" | "trialing";
  readonly cancelAtPeriodEnd: true;
  readonly currentPeriodEnd: string;
}

export interface PaymentAttentionSubscriptionLifecycleRequest
  extends CommonSubscriptionLifecycleRequest {
  readonly command: "payment_attention";
  readonly providerEventType: "invoice.payment_failed" | "customer.subscription.updated";
  readonly subscriptionStatus: "active" | "past_due" | "incomplete" | "paused";
  readonly diagnosticCurrentPeriodEnd?: string;
}

export interface RevokeSubscriptionLifecycleRequest
  extends CommonSubscriptionLifecycleRequest {
  readonly command: "revoke";
  readonly providerEventType:
    | "customer.subscription.deleted"
    | "customer.subscription.updated";
  readonly subscriptionStatus: "canceled" | "unpaid" | "incomplete_expired";
  readonly reason:
    | "subscription_canceled"
    | "subscription_unpaid"
    | "subscription_incomplete_expired";
  /** Preserves schema-v1 replay hashing when the wire payload omitted reason. */
  readonly reasonProvided: boolean;
}

export type SubscriptionLifecycleRequestWithoutHash =
  | RenewPaidSubscriptionLifecycleRequest
  | ReconcileSubscriptionLifecycleRequest
  | CancelSubscriptionLifecycleRequest
  | PaymentAttentionSubscriptionLifecycleRequest
  | RevokeSubscriptionLifecycleRequest;

export type ParsedSubscriptionLifecycleRequest = SubscriptionLifecycleRequestWithoutHash & {
  readonly requestHash: string;
};

export class LifecycleRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LifecycleRequestError";
  }
}

export function parseSubscriptionLifecycleRequest(
  raw: string,
  now: Date = new Date()
): ParsedSubscriptionLifecycleRequest {
  if (Buffer.byteLength(raw, "utf8") > MAX_LIFECYCLE_BODY_BYTES) {
    throw new LifecycleRequestError("request body is too large");
  }
  if (!Number.isFinite(now.getTime())) {
    throw new LifecycleRequestError("service clock is invalid");
  }

  let parsed: unknown;
  try {
    parsed = raw.length > 0 ? (JSON.parse(raw) as unknown) : {};
  } catch {
    throw new LifecycleRequestError("request body must be valid JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new LifecycleRequestError("request body must be a JSON object");
  }

  const body = parsed as Record<string, unknown>;
  if (Object.keys(body).some((key) => !REQUEST_FIELDS.has(key))) {
    throw new LifecycleRequestError("request contains an unknown field");
  }

  if (body.schemaVersion !== 1) {
    throw new LifecycleRequestError("schemaVersion must be 1");
  }
  const issuanceIdempotencyKey = readRequiredString(
    body,
    "issuanceIdempotencyKey",
    MAX_ISSUANCE_KEY_LENGTH
  );
  const eventId = readRequiredString(body, "eventId", MAX_EVENT_ID_LENGTH);
  const eventCreatedAt = readEventCreatedAt(body.eventCreatedAt, now);
  const provider = readRequiredString(body, "provider", 16);
  if (provider !== "stripe") throw new LifecycleRequestError("provider must be stripe");
  const providerAccountId = readRequiredString(
    body,
    "providerAccountId",
    MAX_PROVIDER_ACCOUNT_ID_LENGTH
  );
  const providerModeValue = readRequiredString(body, "providerMode", 16);
  if (providerModeValue !== "test" && providerModeValue !== "live") {
    throw new LifecycleRequestError("providerMode must be test or live");
  }
  const providerMode: SubscriptionProviderMode = providerModeValue;
  const externalSubscriptionId = readRequiredString(
    body,
    "externalSubscriptionId",
    MAX_SUBSCRIPTION_ID_LENGTH
  );
  const providerEventType = readRequiredString(body, "providerEventType", 80);
  const commandValue = readRequiredString(body, "command", 40);
  if (!isLifecycleCommand(commandValue)) {
    throw new LifecycleRequestError("command is unsupported");
  }
  const command = commandValue;
  const subscriptionStatus = readRequiredString(body, "subscriptionStatus", 40);
  if (typeof body.cancelAtPeriodEnd !== "boolean") {
    throw new LifecycleRequestError("cancelAtPeriodEnd must be a boolean");
  }
  const cancelAtPeriodEnd = body.cancelAtPeriodEnd;

  validateCommandMatrix(command, providerEventType, subscriptionStatus);

  let amountPaidMinor: number | undefined;
  let currency: "usd" | undefined;
  let paidOutOfBand: false | undefined;
  let billingReason: "subscription_cycle" | undefined;
  let paymentFingerprint: string | undefined;

  if (command === "renew_paid") {
    const paymentReference = readRequiredString(
      body,
      "paymentReference",
      MAX_PAYMENT_REFERENCE_LENGTH
    );
    if (!Number.isSafeInteger(body.amountPaidMinor) || (body.amountPaidMinor as number) <= 0) {
      throw new LifecycleRequestError("amountPaidMinor must be a positive integer");
    }
    amountPaidMinor = body.amountPaidMinor as number;
    if (body.currency !== "usd") throw new LifecycleRequestError("currency must be usd");
    currency = "usd";
    if (body.paidOutOfBand !== false) {
      throw new LifecycleRequestError("paidOutOfBand must be false");
    }
    paidOutOfBand = false;
    if (body.billingReason !== "subscription_cycle") {
      throw new LifecycleRequestError("billingReason must be subscription_cycle");
    }
    billingReason = "subscription_cycle";
    paymentFingerprint = paymentReferenceFingerprint(paymentReference);
  } else if (PAYMENT_FIELDS.some((field) => body[field] !== undefined)) {
    throw new LifecycleRequestError("payment fields are forbidden for this command");
  }

  let parsedPeriodEnd: string | undefined;
  if (command === "revoke") {
    if (body.currentPeriodEnd !== undefined) {
      throw new LifecycleRequestError("currentPeriodEnd is forbidden for revoke");
    }
  } else if (command === "renew_paid" || command === "cancel_at_period_end") {
    parsedPeriodEnd = readStrictPeriodEnd(body.currentPeriodEnd, true);
  } else if (body.currentPeriodEnd !== undefined) {
    parsedPeriodEnd = readStrictPeriodEnd(body.currentPeriodEnd, false);
  }

  if (command === "renew_paid" && cancelAtPeriodEnd) {
    throw new LifecycleRequestError("cancelAtPeriodEnd must be false for renew_paid");
  }
  if (command === "reconcile" && cancelAtPeriodEnd) {
    throw new LifecycleRequestError("cancelAtPeriodEnd must be false for reconcile");
  }
  if (command === "cancel_at_period_end" && !cancelAtPeriodEnd) {
    throw new LifecycleRequestError("cancelAtPeriodEnd must be true for cancel_at_period_end");
  }

  let reason: RevokeSubscriptionLifecycleRequest["reason"] | undefined;
  if (command !== "revoke" && body.reason !== undefined) {
    throw new LifecycleRequestError("reason is only allowed for revoke");
  }
  if (command === "revoke") {
    reason = revokeReasonForStatus(subscriptionStatus);
    if (body.reason !== undefined) {
      const suppliedReason = readRequiredString(body, "reason", 40);
      if (suppliedReason !== reason) {
        throw new LifecycleRequestError("reason must match the server-derived code");
      }
    }
  }

  const common: CommonSubscriptionLifecycleRequest = {
    schemaVersion: 1,
    issuanceIdempotencyKey,
    eventId,
    eventCreatedAt,
    provider: "stripe",
    providerAccountId,
    providerMode,
    externalSubscriptionId,
    cancelAtPeriodEnd
  };

  let requestWithoutHash: SubscriptionLifecycleRequestWithoutHash;
  switch (command) {
    case "renew_paid":
      requestWithoutHash = {
        ...common,
        command,
        providerEventType: providerEventType as RenewPaidSubscriptionLifecycleRequest["providerEventType"],
        subscriptionStatus: "active",
        paymentReferenceFingerprint: paymentFingerprint!,
        amountPaidMinor: amountPaidMinor!,
        currency: currency!,
        paidOutOfBand: paidOutOfBand!,
        billingReason: billingReason!,
        currentPeriodEnd: parsedPeriodEnd!
      };
      break;
    case "reconcile":
      requestWithoutHash = {
        ...common,
        command,
        providerEventType: "customer.subscription.updated",
        subscriptionStatus: subscriptionStatus as ReconcileSubscriptionLifecycleRequest["subscriptionStatus"],
        cancelAtPeriodEnd: false,
        ...(parsedPeriodEnd !== undefined
          ? { diagnosticCurrentPeriodEnd: parsedPeriodEnd }
          : {})
      };
      break;
    case "cancel_at_period_end":
      requestWithoutHash = {
        ...common,
        command,
        providerEventType: "customer.subscription.updated",
        subscriptionStatus: subscriptionStatus as CancelSubscriptionLifecycleRequest["subscriptionStatus"],
        cancelAtPeriodEnd: true,
        currentPeriodEnd: parsedPeriodEnd!
      };
      break;
    case "payment_attention":
      requestWithoutHash = {
        ...common,
        command,
        providerEventType: providerEventType as PaymentAttentionSubscriptionLifecycleRequest["providerEventType"],
        subscriptionStatus: subscriptionStatus as PaymentAttentionSubscriptionLifecycleRequest["subscriptionStatus"],
        ...(parsedPeriodEnd !== undefined
          ? { diagnosticCurrentPeriodEnd: parsedPeriodEnd }
          : {})
      };
      break;
    case "revoke":
      requestWithoutHash = {
        ...common,
        command,
        providerEventType: providerEventType as RevokeSubscriptionLifecycleRequest["providerEventType"],
        subscriptionStatus: subscriptionStatus as RevokeSubscriptionLifecycleRequest["subscriptionStatus"],
        reason: reason!,
        reasonProvided: body.reason !== undefined
      };
      break;
  }

  return {
    ...requestWithoutHash,
    requestHash: canonicalSubscriptionLifecycleRequestHash(requestWithoutHash)
  };
}

function revokeReasonForStatus(
  status: string
): RevokeSubscriptionLifecycleRequest["reason"] {
  switch (status) {
    case "canceled":
      return "subscription_canceled";
    case "unpaid":
      return "subscription_unpaid";
    case "incomplete_expired":
      return "subscription_incomplete_expired";
    default:
      throw new LifecycleRequestError("subscriptionStatus is invalid for revoke");
  }
}

export function canonicalSubscriptionLifecycleRequestHash(
  request: SubscriptionLifecycleRequestWithoutHash | ParsedSubscriptionLifecycleRequest
): string {
  const commonFields = [
    request.schemaVersion,
    request.issuanceIdempotencyKey,
    request.eventId,
    request.eventCreatedAt,
    request.provider,
    request.providerAccountId,
    request.providerMode,
    request.externalSubscriptionId,
  ];
  let commandFields: readonly unknown[];
  switch (request.command) {
    case "renew_paid":
      commandFields = [
        request.command,
        request.providerEventType,
        request.subscriptionStatus,
        request.cancelAtPeriodEnd,
        request.paymentReferenceFingerprint,
        request.amountPaidMinor,
        request.currency,
        request.paidOutOfBand,
        request.billingReason,
        request.currentPeriodEnd
      ];
      break;
    case "reconcile":
      commandFields = [
        request.command,
        request.providerEventType,
        request.subscriptionStatus,
        request.cancelAtPeriodEnd,
        request.diagnosticCurrentPeriodEnd ?? null
      ];
      break;
    case "cancel_at_period_end":
      commandFields = [
        request.command,
        request.providerEventType,
        request.subscriptionStatus,
        request.cancelAtPeriodEnd,
        request.currentPeriodEnd
      ];
      break;
    case "payment_attention":
      commandFields = [
        request.command,
        request.providerEventType,
        request.subscriptionStatus,
        request.cancelAtPeriodEnd,
        request.diagnosticCurrentPeriodEnd ?? null
      ];
      break;
    case "revoke":
      commandFields = [
        request.command,
        request.providerEventType,
        request.subscriptionStatus,
        request.cancelAtPeriodEnd,
        request.reasonProvided === false ? null : request.reason ?? null
      ];
      break;
  }
  return createHash("sha256")
    .update("neondiff:subscription-lifecycle-request:v1\n")
    .update(JSON.stringify([...commonFields, ...commandFields]))
    .digest("hex");
}

export function paymentReferenceFingerprint(paymentReference: string): string {
  return createHash("sha256")
    .update("neondiff:subscription-lifecycle-payment-reference:v1\n")
    .update(paymentReference)
    .digest("hex");
}

function validateCommandMatrix(
  command: SubscriptionLifecycleCommand,
  providerEventType: string,
  subscriptionStatus: string
): void {
  const matrix: Readonly<
    Record<
      SubscriptionLifecycleCommand,
      { readonly events: readonly string[]; readonly statuses: readonly string[] }
    >
  > = {
    renew_paid: {
      events: ["invoice.paid", "invoice.payment_succeeded"],
      statuses: ["active"]
    },
    reconcile: {
      events: ["customer.subscription.updated"],
      statuses: ["active", "trialing"]
    },
    cancel_at_period_end: {
      events: ["customer.subscription.updated"],
      statuses: ["active", "trialing"]
    },
    payment_attention: {
      events: ["invoice.payment_failed", "customer.subscription.updated"],
      statuses: ["active", "past_due", "incomplete", "paused"]
    },
    revoke: {
      events: ["customer.subscription.deleted", "customer.subscription.updated"],
      statuses: ["canceled", "unpaid", "incomplete_expired"]
    }
  };
  const rule = matrix[command];
  if (!rule.events.includes(providerEventType)) {
    throw new LifecycleRequestError(`providerEventType is invalid for ${command}`);
  }
  if (!rule.statuses.includes(subscriptionStatus)) {
    throw new LifecycleRequestError(`subscriptionStatus is invalid for ${command}`);
  }
}

function readRequiredString(
  body: Record<string, unknown>,
  field: string,
  maxLength: number
): string {
  const value = body[field];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new LifecycleRequestError(`${field} is required`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new LifecycleRequestError(`${field} is too long`);
  }
  return trimmed;
}

function readEventCreatedAt(value: unknown, now: Date): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new LifecycleRequestError("eventCreatedAt must be an integer epoch");
  }
  const timestamp = value as number;
  if (timestamp > Math.floor(now.getTime() / 1000) + MAX_FUTURE_SKEW_SECONDS) {
    throw new LifecycleRequestError("eventCreatedAt is too far in the future");
  }
  return timestamp;
}

function readStrictPeriodEnd(value: unknown, required: boolean): string {
  if (typeof value !== "string") {
    throw new LifecycleRequestError(
      required ? "currentPeriodEnd is required" : "currentPeriodEnd must be a timestamp"
    );
  }
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) {
    throw new LifecycleRequestError("currentPeriodEnd must be a strict UTC timestamp");
  }
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw new LifecycleRequestError("currentPeriodEnd must be a valid timestamp");
  }
  return value;
}

function isLifecycleCommand(value: string): value is SubscriptionLifecycleCommand {
  return (
    value === "renew_paid" ||
    value === "reconcile" ||
    value === "cancel_at_period_end" ||
    value === "payment_attention" ||
    value === "revoke"
  );
}
