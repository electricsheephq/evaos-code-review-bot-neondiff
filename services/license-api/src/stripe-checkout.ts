import { createHash } from "node:crypto";
import Stripe from "stripe";
import {
  CHECKOUT_LOOKUP_KEYS,
  type CheckoutLookupKey
} from "./checkout-policy.js";
import { deriveCheckoutLicenseKey } from "./issuance.js";
import {
  LifecycleRequestError,
  parseSubscriptionLifecycleRequest
} from "./subscription-lifecycle.js";
import {
  CheckoutIssuanceConflictError,
  CheckoutIssuancePolicyError,
  CheckoutIssuanceTransientError,
  CheckoutRedemptionConsumedError,
  CheckoutRedemptionExpiredError,
  CheckoutRedemptionInvalidError,
  CheckoutRedemptionNotFoundError,
  CheckoutRedemptionTransientError,
  SubscriptionLifecycleConflictError,
  SubscriptionLifecycleNotFoundError,
  SubscriptionLifecyclePolicyError,
  SubscriptionLifecycleTerminalError,
  SubscriptionLifecycleTransientError,
  SubscriptionLifecycleUnsupportedCommandError,
  type LicenseRecord,
  type LicenseStore
} from "./store.js";

const DEFAULT_REDEMPTION_TTL_MS = 30 * 60 * 1_000;
const MAX_REDEMPTION_TTL_MS = 24 * 60 * 60 * 1_000;
const STRIPE_ID_PATTERN = /^(?:acct|cs_(?:live|test)|cus|evt|in|price|prod|sub)_[A-Za-z0-9_]+$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;
const STRIPE_LIFECYCLE_EVENT_TYPES = new Set([
  "invoice.paid",
  "invoice.payment_succeeded",
  "invoice.payment_failed",
  "customer.subscription.updated",
  "customer.subscription.deleted"
]);

export interface AllowedStripePrice {
  priceId: string;
  productId: string;
}

export interface StripeCheckoutGateway {
  verifyEvent(rawBody: string, signature: string, signingSecret: string): unknown;
  retrieveAccount(accountId: string): Promise<unknown>;
  retrieveCheckoutSession(sessionId: string): Promise<unknown>;
  retrieveSubscription(subscriptionId: string): Promise<unknown>;
}

export interface StripeCheckoutRuntime {
  webhookSecret: string;
  expectedAccountId: string;
  mode: "test" | "live";
  allowedOrigin: string;
  licenseDerivationSecret: string;
  allowedPrices: Partial<Record<CheckoutLookupKey, AllowedStripePrice>>;
  redemptionTtlMs?: number;
  gateway: StripeCheckoutGateway;
}

export interface StripeCheckoutFulfillmentResult {
  status: "fulfilled";
  replayed: boolean;
}

export interface StripeCheckoutLifecycleResult {
  status:
    | "updated"
    | "replayed"
    | "ignored_stale"
    | "payment_attention"
    | "terminally_revoked";
  replayed: boolean;
}

export type StripeCheckoutWebhookResult =
  | StripeCheckoutFulfillmentResult
  | StripeCheckoutLifecycleResult;

export interface StripeCheckoutRedemptionResult {
  status: "redeemed";
  licenseKey: string;
  entitlement: {
    status: "active";
    plan: string;
    seats: number;
    expiresAt?: string;
    updateEntitlement: boolean;
  };
}

export class StripeCheckoutInvalidError extends Error {}
export class StripeCheckoutConflictError extends Error {}
export class StripeCheckoutUnavailableError extends Error {}

export function createStripeCheckoutGateway(apiKey: string): StripeCheckoutGateway {
  const stripe = new Stripe(apiKey, {
    apiVersion: "2026-06-24.dahlia",
    maxNetworkRetries: 2,
    timeout: 10_000
  });
  return {
    verifyEvent(rawBody, signature, signingSecret) {
      return stripe.webhooks.constructEvent(rawBody, signature, signingSecret);
    },
    async retrieveAccount() {
      return stripe.accounts.retrieveCurrent();
    },
    async retrieveCheckoutSession(sessionId) {
      return stripe.checkout.sessions.retrieve(sessionId, {
        expand: ["line_items.data.price.product"]
      });
    },
    async retrieveSubscription(subscriptionId) {
      return stripe.subscriptions.retrieve(subscriptionId, {
        expand: ["items.data.price.product"]
      });
    }
  };
}

export async function fulfillStripeCheckoutWebhook(options: {
  store: LicenseStore;
  runtime: StripeCheckoutRuntime;
  rawBody: string;
  signature: string;
  now: Date;
}): Promise<StripeCheckoutWebhookResult> {
  const { store, runtime, rawBody, signature, now } = options;
  if (!Number.isFinite(now.getTime())) {
    throw new StripeCheckoutUnavailableError("checkout clock is unavailable");
  }
  const config = validateRuntime(runtime);
  let verifiedEvent: Record<string, unknown>;
  try {
    verifiedEvent = record(runtime.gateway.verifyEvent(rawBody, signature, config.webhookSecret));
  } catch {
    throw new StripeCheckoutInvalidError("Stripe signature verification failed");
  }

  const eventId = stripeId(verifiedEvent.id, "evt", "event id");
  const eventType = requiredString(verifiedEvent.type, "event type", 80);
  const eventCreatedAt = positiveInteger(verifiedEvent.created, "event created");
  const eventLiveMode = boolean(verifiedEvent.livemode, "event livemode");
  const expectedLiveMode = config.mode === "live";
  if (eventLiveMode !== expectedLiveMode) {
    throw new StripeCheckoutInvalidError("Stripe event mode is invalid");
  }
  const eventAccount = optionalString(verifiedEvent.account);
  if (eventAccount && eventAccount !== config.expectedAccountId) {
    throw new StripeCheckoutInvalidError("Stripe event account is invalid");
  }
  const eventData = record(verifiedEvent.data);
  const eventObject = record(eventData.object);
  if (eventType !== "checkout.session.completed") {
    if (!STRIPE_LIFECYCLE_EVENT_TYPES.has(eventType)) {
      throw new StripeCheckoutInvalidError("Stripe event type is unsupported");
    }
    return fulfillStripeSubscriptionLifecycle({
      store,
      runtime: config,
      eventId,
      eventType,
      eventCreatedAt,
      eventObject,
      now
    });
  }
  const eventSession = eventObject;
  const eventSessionId = stripeId(eventSession.id, "cs_", "checkout session id");
  const eventHash = createHash("sha256").update(rawBody).digest("hex");
  const existing = store.getStripeCheckoutFulfillmentForEvent(eventId);
  if (existing) {
    if (
      existing.eventHash !== eventHash ||
      existing.externalCheckoutId !== eventSessionId
    ) {
      throw new StripeCheckoutConflictError("Stripe checkout event conflicts");
    }
    return { status: "fulfilled", replayed: true };
  }

  let account: Record<string, unknown>;
  let session: Record<string, unknown>;
  let subscription: Record<string, unknown>;
  try {
    account = record(await runtime.gateway.retrieveAccount(config.expectedAccountId));
    session = record(await runtime.gateway.retrieveCheckoutSession(eventSessionId));
    const subscriptionId = stripeId(session.subscription, "sub_", "subscription id");
    subscription = record(await runtime.gateway.retrieveSubscription(subscriptionId));
  } catch (error) {
    if (error instanceof StripeCheckoutInvalidError) throw error;
    throw new StripeCheckoutUnavailableError("Stripe checkout verification is unavailable");
  }

  const accountId = stripeId(account.id, "acct_", "account id");
  if (accountId !== config.expectedAccountId) {
    throw new StripeCheckoutInvalidError("Stripe API account is invalid");
  }

  const normalized = normalizeCheckout({
    eventSessionId,
    session,
    subscription,
    runtime: config
  });
  const idempotencyKey = `checkout-session:${normalized.sessionId}`;
  const rawKey = deriveCheckoutLicenseKey(config.licenseDerivationSecret, idempotencyKey);
  const fulfillmentExpiresAt = new Date(
    now.getTime() + config.redemptionTtlMs
  ).toISOString();

  try {
    const fulfilled = store.fulfillStripeCheckout(rawKey, {
      stripeEventId: eventId,
      eventHash,
      fulfillmentTokenHash: normalized.fulfillmentTokenHash,
      fulfillmentExpiresAt,
      issuance: {
        idempotencyKey,
        checkoutLookupKey: normalized.checkoutLookupKey,
        binding: {
          provider: "stripe",
          providerAccountId: accountId,
          providerMode: config.mode,
          externalSubscriptionId: normalized.subscriptionId,
          externalCheckoutId: normalized.sessionId
        }
      }
    });
    return { status: "fulfilled", replayed: fulfilled.replayed };
  } catch (error) {
    if (error instanceof CheckoutIssuanceConflictError) {
      throw new StripeCheckoutConflictError("Stripe checkout fulfillment conflicts");
    }
    if (error instanceof CheckoutIssuancePolicyError) {
      throw new StripeCheckoutInvalidError("Stripe checkout fulfillment conflicts");
    }
    if (error instanceof CheckoutIssuanceTransientError) {
      throw new StripeCheckoutUnavailableError("Stripe checkout fulfillment is unavailable");
    }
    throw new StripeCheckoutUnavailableError("Stripe checkout fulfillment failed");
  }
}

async function fulfillStripeSubscriptionLifecycle(options: {
  store: LicenseStore;
  runtime: ReturnType<typeof validateRuntime>;
  eventId: string;
  eventType: string;
  eventCreatedAt: number;
  eventObject: Record<string, unknown>;
  now: Date;
}): Promise<StripeCheckoutLifecycleResult> {
  const { store, runtime, eventId, eventType, eventCreatedAt, eventObject, now } = options;
  let account: Record<string, unknown>;
  try {
    account = record(await runtime.gateway.retrieveAccount(runtime.expectedAccountId));
  } catch (error) {
    if (error instanceof StripeCheckoutInvalidError) throw error;
    throw new StripeCheckoutUnavailableError("Stripe lifecycle verification is unavailable");
  }
  const accountId = stripeId(account.id, "acct_", "account id");
  if (accountId !== runtime.expectedAccountId) {
    throw new StripeCheckoutInvalidError("Stripe API account is invalid");
  }

  const externalSubscriptionId = lifecycleSubscriptionId(eventType, eventObject);
  const issuanceIdempotencyKey = store.resolveCheckoutIssuanceIdempotencyKey({
    provider: "stripe",
    providerAccountId: accountId,
    providerMode: runtime.mode,
    externalSubscriptionId
  });
  if (!issuanceIdempotencyKey) {
    // Stripe event delivery order is not guaranteed. A retryable response lets
    // checkout.session.completed establish the immutable binding first.
    throw new StripeCheckoutUnavailableError("Stripe lifecycle binding is unavailable");
  }

  let lifecycleBody: Record<string, unknown>;
  try {
    lifecycleBody = await normalizeStripeLifecycleEvent({
      runtime,
      eventId,
      eventType,
      eventCreatedAt,
      eventObject,
      issuanceIdempotencyKey,
      externalSubscriptionId,
      accountId
    });
  } catch (error) {
    if (
      error instanceof StripeCheckoutInvalidError ||
      error instanceof StripeCheckoutUnavailableError
    ) {
      throw error;
    }
    throw new StripeCheckoutUnavailableError("Stripe lifecycle verification is unavailable");
  }

  let request;
  try {
    request = parseSubscriptionLifecycleRequest(JSON.stringify(lifecycleBody), now);
  } catch (error) {
    if (error instanceof LifecycleRequestError) {
      throw new StripeCheckoutInvalidError("Stripe lifecycle event is invalid");
    }
    throw new StripeCheckoutUnavailableError("Stripe lifecycle normalization failed");
  }

  try {
    const applied = store.applyCheckoutSubscriptionLifecycle(request);
    return { status: applied.status, replayed: applied.replayed };
  } catch (error) {
    if (error instanceof SubscriptionLifecycleConflictError) {
      throw new StripeCheckoutConflictError("Stripe lifecycle event conflicts");
    }
    if (error instanceof SubscriptionLifecycleNotFoundError) {
      throw new StripeCheckoutUnavailableError("Stripe lifecycle binding is unavailable");
    }
    if (
      error instanceof SubscriptionLifecyclePolicyError ||
      error instanceof SubscriptionLifecycleTerminalError ||
      error instanceof SubscriptionLifecycleUnsupportedCommandError
    ) {
      throw new StripeCheckoutInvalidError("Stripe lifecycle event is invalid");
    }
    if (error instanceof SubscriptionLifecycleTransientError) {
      throw new StripeCheckoutUnavailableError("Stripe lifecycle storage is unavailable");
    }
    throw new StripeCheckoutUnavailableError("Stripe lifecycle application failed");
  }
}

async function normalizeStripeLifecycleEvent(options: {
  runtime: ReturnType<typeof validateRuntime>;
  eventId: string;
  eventType: string;
  eventCreatedAt: number;
  eventObject: Record<string, unknown>;
  issuanceIdempotencyKey: string;
  externalSubscriptionId: string;
  accountId: string;
}): Promise<Record<string, unknown>> {
  const {
    runtime,
    eventId,
    eventType,
    eventCreatedAt,
    eventObject,
    issuanceIdempotencyKey,
    externalSubscriptionId,
    accountId
  } = options;
  if (
    boolean(eventObject.livemode, "lifecycle object livemode") !==
    (runtime.mode === "live")
  ) {
    throw new StripeCheckoutInvalidError("Stripe lifecycle object mode is invalid");
  }
  const common = {
    schemaVersion: 1,
    issuanceIdempotencyKey,
    eventId,
    eventCreatedAt,
    provider: "stripe",
    providerAccountId: accountId,
    providerMode: runtime.mode,
    externalSubscriptionId
  };

  if (
    eventType === "invoice.paid" ||
    eventType === "invoice.payment_succeeded" ||
    eventType === "invoice.payment_failed"
  ) {
    const subscription = await retrieveLifecycleSubscription(
      runtime,
      externalSubscriptionId
    );
    if (eventType === "invoice.payment_failed") {
      if (
        !["active", "past_due", "incomplete", "paused"].includes(
          subscription.status
        )
      ) {
        throw new StripeCheckoutInvalidError(
          "Stripe failed-payment subscription state is invalid"
        );
      }
      return {
        ...common,
        providerEventType: eventType,
        command: "payment_attention",
        subscriptionStatus: subscription.status,
        cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
      };
    }
    if (subscription.status !== "active") {
      throw new StripeCheckoutInvalidError(
        "Stripe paid invoice subscription is not active"
      );
    }
    return {
      ...common,
      providerEventType: eventType,
      command: "renew_paid",
      paymentReference: stripeId(eventObject.id, "in_", "invoice id"),
      amountPaidMinor: positiveInteger(eventObject.amount_paid, "invoice amount paid"),
      currency: exactString(eventObject.currency, "usd", "invoice currency"),
      paidOutOfBand: invoicePaidOutOfBand(eventObject),
      billingReason: exactString(
        eventObject.billing_reason,
        "subscription_cycle",
        "invoice billing reason"
      ),
      subscriptionStatus: "active",
      currentPeriodEnd: new Date(
        invoiceSubscriptionPeriodEnd(eventObject, externalSubscriptionId) * 1_000
      ).toISOString(),
      cancelAtPeriodEnd: false
    };
  }

  const subscription = normalizeSubscriptionSnapshot(
    eventObject,
    runtime.mode,
    externalSubscriptionId
  );
  if (eventType === "customer.subscription.deleted") {
    if (!["canceled", "unpaid", "incomplete_expired"].includes(subscription.status)) {
      throw new StripeCheckoutInvalidError("Stripe deleted subscription state is invalid");
    }
    return {
      ...common,
      providerEventType: eventType,
      command: "revoke",
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: false
    };
  }

  if (subscription.status === "canceled" ||
      subscription.status === "unpaid" ||
      subscription.status === "incomplete_expired") {
    return {
      ...common,
      providerEventType: eventType,
      command: "revoke",
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: false
    };
  }
  if (
    (subscription.status === "active" || subscription.status === "trialing") &&
    subscription.cancelAtPeriodEnd
  ) {
    return {
      ...common,
      providerEventType: eventType,
      command: "cancel_at_period_end",
      subscriptionStatus: subscription.status,
      currentPeriodEnd: new Date(
        requiredSubscriptionPeriodEnd(eventObject) * 1_000
      ).toISOString(),
      cancelAtPeriodEnd: true
    };
  }
  if (subscription.status === "active" || subscription.status === "trialing") {
    return {
      ...common,
      providerEventType: eventType,
      command: "reconcile",
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: false
    };
  }
  if (["past_due", "incomplete", "paused"].includes(subscription.status)) {
    return {
      ...common,
      providerEventType: eventType,
      command: "payment_attention",
      subscriptionStatus: subscription.status,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd
    };
  }
  throw new StripeCheckoutInvalidError("Stripe subscription state is unsupported");
}

async function retrieveLifecycleSubscription(
  runtime: ReturnType<typeof validateRuntime>,
  expectedSubscriptionId: string
): Promise<{ status: string; cancelAtPeriodEnd: boolean }> {
  let raw: Record<string, unknown>;
  try {
    raw = record(
      await runtime.gateway.retrieveSubscription(expectedSubscriptionId)
    );
  } catch (error) {
    if (error instanceof StripeCheckoutInvalidError) throw error;
    throw new StripeCheckoutUnavailableError(
      "Stripe subscription verification is unavailable"
    );
  }
  const normalized = normalizeSubscriptionSnapshot(
    raw,
    runtime.mode,
    expectedSubscriptionId
  );
  return {
    status: normalized.status,
    cancelAtPeriodEnd: normalized.cancelAtPeriodEnd
  };
}

function normalizeSubscriptionSnapshot(
  value: Record<string, unknown>,
  mode: "test" | "live",
  expectedSubscriptionId: string
): { status: string; cancelAtPeriodEnd: boolean } {
  const subscriptionId = stripeId(value.id, "sub_", "subscription id");
  if (subscriptionId !== expectedSubscriptionId) {
    throw new StripeCheckoutInvalidError("Stripe subscription changed");
  }
  if (
    boolean(value.livemode, "subscription livemode") !==
    (mode === "live")
  ) {
    throw new StripeCheckoutInvalidError("Stripe subscription mode is invalid");
  }
  return {
    status: requiredString(value.status, "subscription status", 40),
    cancelAtPeriodEnd: boolean(
      value.cancel_at_period_end,
      "subscription cancel at period end"
    )
  };
}

function lifecycleSubscriptionId(
  eventType: string,
  eventObject: Record<string, unknown>
): string {
  if (eventType.startsWith("customer.subscription.")) {
    return stripeId(eventObject.id, "sub_", "subscription id");
  }
  const direct = stripeReference(eventObject.subscription);
  if (direct) return stripeId(direct, "sub_", "subscription id");
  const parent = record(eventObject.parent);
  if (parent.type !== "subscription_details") {
    throw new StripeCheckoutInvalidError("Stripe invoice subscription is invalid");
  }
  const details = record(parent.subscription_details);
  return stripeId(
    stripeReference(details.subscription),
    "sub_",
    "subscription id"
  );
}

function invoiceSubscriptionPeriodEnd(
  invoice: Record<string, unknown>,
  externalSubscriptionId: string
): number {
  const lines = record(invoice.lines);
  const data = Array.isArray(lines.data) ? lines.data : [];
  const periodEnds = data.flatMap((entry) => {
    const line = record(entry);
    const subscription = stripeReference(line.subscription);
    if (subscription !== externalSubscriptionId) return [];
    const parent = record(line.parent);
    if (parent.type !== "subscription_item_details") return [];
    return [positiveInteger(record(line.period).end, "invoice service period end")];
  });
  if (periodEnds.length === 0 || new Set(periodEnds).size !== 1) {
    throw new StripeCheckoutInvalidError(
      "Stripe invoice service period is ambiguous"
    );
  }
  return periodEnds[0]!;
}

function requiredSubscriptionPeriodEnd(subscription: Record<string, unknown>): number {
  if (subscription.current_period_end !== undefined) {
    return positiveInteger(
      subscription.current_period_end,
      "subscription period end"
    );
  }
  const items = record(subscription.items);
  const data = Array.isArray(items.data) ? items.data : [];
  if (data.length !== 1) {
    throw new StripeCheckoutInvalidError(
      "Stripe subscription must contain exactly one item"
    );
  }
  return positiveInteger(
    record(data[0]).current_period_end,
    "subscription period end"
  );
}

function invoicePaidOutOfBand(invoice: Record<string, unknown>): false {
  if (invoice.amount_paid_off_stripe !== undefined) {
    const paidOffStripe = nonNegativeInteger(
      invoice.amount_paid_off_stripe,
      "invoice amount paid off Stripe"
    );
    if (paidOffStripe !== 0) {
      throw new StripeCheckoutInvalidError(
        "Stripe invoice paid out of band is invalid"
      );
    }
    if (invoice.paid_out_of_band === true) {
      throw new StripeCheckoutInvalidError(
        "Stripe invoice paid out of band is invalid"
      );
    }
    return false;
  }
  if (invoice.paid_out_of_band !== false) {
    throw new StripeCheckoutInvalidError(
      "Stripe invoice paid out of band is invalid"
    );
  }
  return false;
}

function stripeReference(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return optionalString((value as Record<string, unknown>).id);
  }
  return undefined;
}

export function redeemStripeCheckout(options: {
  store: LicenseStore;
  runtime: StripeCheckoutRuntime;
  sessionId: string;
  fulfillmentToken: string;
}): StripeCheckoutRedemptionResult {
  const { store, runtime, sessionId, fulfillmentToken } = options;
  const config = validateRuntime(runtime);
  const canonicalSessionId = stripeId(sessionId, "cs_", "checkout session id");
  const idempotencyKey = `checkout-session:${canonicalSessionId}`;
  const rawKey = deriveCheckoutLicenseKey(config.licenseDerivationSecret, idempotencyKey);
  const redeemed = store.redeemStripeCheckout(rawKey, {
    externalCheckoutId: canonicalSessionId,
    fulfillmentToken
  });
  return {
    status: "redeemed",
    licenseKey: redeemed.rawKey,
    entitlement: entitlement(redeemed.record)
  };
}

export {
  CheckoutRedemptionConsumedError,
  CheckoutRedemptionExpiredError,
  CheckoutRedemptionInvalidError,
  CheckoutRedemptionNotFoundError,
  CheckoutRedemptionTransientError
};

function validateRuntime(runtime: StripeCheckoutRuntime): Required<
  Omit<StripeCheckoutRuntime, "allowedPrices" | "gateway">
> & {
  allowedPrices: Partial<Record<CheckoutLookupKey, AllowedStripePrice>>;
  gateway: StripeCheckoutGateway;
} {
  if (!runtime || typeof runtime !== "object") {
    throw new StripeCheckoutUnavailableError("Stripe checkout is not configured");
  }
  const webhookSecret = requiredString(runtime.webhookSecret, "webhook secret", 256);
  if (!webhookSecret.startsWith("whsec_")) {
    throw new StripeCheckoutUnavailableError("Stripe webhook secret is invalid");
  }
  const expectedAccountId = stripeId(runtime.expectedAccountId, "acct_", "account id");
  if (runtime.mode !== "test" && runtime.mode !== "live") {
    throw new StripeCheckoutUnavailableError("Stripe checkout mode is invalid");
  }
  const allowedOrigin = requiredString(runtime.allowedOrigin, "allowed origin", 300);
  let origin: URL;
  try {
    origin = new URL(allowedOrigin);
  } catch {
    throw new StripeCheckoutUnavailableError("Stripe checkout origin is invalid");
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== allowedOrigin ||
    origin.username ||
    origin.password ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash
  ) {
    throw new StripeCheckoutUnavailableError("Stripe checkout origin is invalid");
  }
  const licenseDerivationSecret = requiredString(
    runtime.licenseDerivationSecret,
    "license derivation secret",
    512
  );
  if (licenseDerivationSecret.length < 24) {
    throw new StripeCheckoutUnavailableError("license derivation secret is invalid");
  }
  const redemptionTtlMs = runtime.redemptionTtlMs ?? DEFAULT_REDEMPTION_TTL_MS;
  if (
    !Number.isInteger(redemptionTtlMs) ||
    redemptionTtlMs < 60_000 ||
    redemptionTtlMs > MAX_REDEMPTION_TTL_MS
  ) {
    throw new StripeCheckoutUnavailableError("redemption TTL is invalid");
  }
  for (const lookupKey of CHECKOUT_LOOKUP_KEYS) {
    const allowed = runtime.allowedPrices[lookupKey];
    if (!allowed) {
      throw new StripeCheckoutUnavailableError(`allowed price ${lookupKey} is missing`);
    }
    stripeId(allowed.priceId, "price_", `${lookupKey} price id`);
    stripeId(allowed.productId, "prod_", `${lookupKey} product id`);
  }
  return {
    webhookSecret,
    expectedAccountId,
    mode: runtime.mode,
    allowedOrigin,
    licenseDerivationSecret,
    redemptionTtlMs,
    allowedPrices: runtime.allowedPrices,
    gateway: runtime.gateway
  };
}

function normalizeCheckout(options: {
  eventSessionId: string;
  session: Record<string, unknown>;
  subscription: Record<string, unknown>;
  runtime: ReturnType<typeof validateRuntime>;
}) {
  const { session, subscription, runtime } = options;
  const expectedLiveMode = runtime.mode === "live";
  const sessionId = stripeId(session.id, "cs_", "checkout session id");
  if (sessionId !== options.eventSessionId) {
    throw new StripeCheckoutInvalidError("Stripe checkout session changed");
  }
  if (boolean(session.livemode, "session livemode") !== expectedLiveMode) {
    throw new StripeCheckoutInvalidError("Stripe checkout session mode is invalid");
  }
  if (session.mode !== "subscription" || session.status !== "complete") {
    throw new StripeCheckoutInvalidError("Stripe checkout session is incomplete");
  }
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") {
    throw new StripeCheckoutInvalidError("Stripe checkout payment is incomplete");
  }
  const sessionCustomerId = stripeId(session.customer, "cus_", "customer id");
  const subscriptionId = stripeId(session.subscription, "sub_", "subscription id");
  const sessionMetadata = record(session.metadata);
  const lookupKey = checkoutLookupKey(sessionMetadata.priceLookupKey);
  const fulfillmentTokenHash = stringMatching(
    sessionMetadata.fulfillmentTokenHash,
    TOKEN_HASH_PATTERN,
    "fulfillment token hash"
  );
  const sessionItem = singleRecurringItem(session.line_items, "checkout session");
  const allowedPrice = runtime.allowedPrices[lookupKey];
  if (
    !allowedPrice ||
    sessionItem.priceId !== allowedPrice.priceId ||
    sessionItem.productId !== allowedPrice.productId ||
    sessionItem.lookupKey !== lookupKey
  ) {
    throw new StripeCheckoutInvalidError("Stripe checkout price is not allowed");
  }

  const retrievedSubscriptionId = stripeId(
    subscription.id,
    "sub_",
    "retrieved subscription id"
  );
  if (retrievedSubscriptionId !== subscriptionId) {
    throw new StripeCheckoutInvalidError("Stripe subscription changed");
  }
  if (boolean(subscription.livemode, "subscription livemode") !== expectedLiveMode) {
    throw new StripeCheckoutInvalidError("Stripe subscription mode is invalid");
  }
  if (subscription.status !== "active" && subscription.status !== "trialing") {
    throw new StripeCheckoutInvalidError("Stripe subscription is not active");
  }
  const subscriptionCustomerId = stripeId(
    subscription.customer,
    "cus_",
    "subscription customer id"
  );
  if (subscriptionCustomerId !== sessionCustomerId) {
    throw new StripeCheckoutInvalidError("Stripe subscription customer changed");
  }
  const subscriptionMetadata = record(subscription.metadata);
  if (
    checkoutLookupKey(subscriptionMetadata.priceLookupKey) !== lookupKey ||
    stringMatching(
      subscriptionMetadata.fulfillmentTokenHash,
      TOKEN_HASH_PATTERN,
      "subscription fulfillment token hash"
    ) !== fulfillmentTokenHash
  ) {
    throw new StripeCheckoutInvalidError("Stripe subscription metadata changed");
  }
  const subscriptionItem = singleRecurringItem(subscription.items, "subscription");
  if (
    subscriptionItem.priceId !== sessionItem.priceId ||
    subscriptionItem.productId !== sessionItem.productId ||
    subscriptionItem.lookupKey !== sessionItem.lookupKey
  ) {
    throw new StripeCheckoutInvalidError("Stripe subscription price changed");
  }

  return {
    sessionId,
    subscriptionId,
    checkoutLookupKey: lookupKey,
    fulfillmentTokenHash
  };
}

function singleRecurringItem(value: unknown, owner: string) {
  const container = record(value);
  const data = Array.isArray(container.data) ? container.data : [];
  if (data.length !== 1) {
    throw new StripeCheckoutInvalidError(`${owner} must contain exactly one item`);
  }
  const item = record(data[0]);
  if (item.quantity !== 1) {
    throw new StripeCheckoutInvalidError(`${owner} quantity is invalid`);
  }
  const price = record(item.price);
  if (price.type !== "recurring" || price.currency !== "usd") {
    throw new StripeCheckoutInvalidError(`${owner} price is invalid`);
  }
  const product =
    typeof price.product === "string"
      ? price.product
      : requiredString(record(price.product).id, `${owner} product id`, 160);
  return {
    priceId: stripeId(price.id, "price_", `${owner} price id`),
    productId: stripeId(product, "prod_", `${owner} product id`),
    lookupKey: checkoutLookupKey(price.lookup_key),
    currency: "usd" as const,
    quantity: 1 as const
  };
}

function entitlement(record: LicenseRecord): StripeCheckoutRedemptionResult["entitlement"] {
  return {
    status: "active",
    plan: record.plan,
    seats: record.seats,
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
    updateEntitlement: record.updateEntitlement
  };
}

function checkoutLookupKey(value: unknown): CheckoutLookupKey {
  if (typeof value !== "string" || !CHECKOUT_LOOKUP_KEYS.includes(value as CheckoutLookupKey)) {
    throw new StripeCheckoutInvalidError("Stripe checkout lookup key is invalid");
  }
  return value as CheckoutLookupKey;
}

function stripeId(value: unknown, prefix: string, field: string): string {
  const id = requiredString(value, field, 200);
  if (!id.startsWith(prefix) || !STRIPE_ID_PATTERN.test(id)) {
    throw new StripeCheckoutInvalidError(`${field} is invalid`);
  }
  return id;
}

function requiredString(value: unknown, field: string, max: number): string {
  if (typeof value !== "string" || !value || value !== value.trim() || value.length > max) {
    throw new StripeCheckoutInvalidError(`${field} is invalid`);
  }
  return value;
}

function stringMatching(value: unknown, pattern: RegExp, field: string): string {
  const result = requiredString(value, field, 256);
  if (!pattern.test(result)) throw new StripeCheckoutInvalidError(`${field} is invalid`);
  return result;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return requiredString(value, "optional string", 200);
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) {
    throw new StripeCheckoutInvalidError(`${field} is invalid`);
  }
  return Number(value);
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) {
    throw new StripeCheckoutInvalidError(`${field} is invalid`);
  }
  return Number(value);
}

function exactString(value: unknown, expected: string, field: string): string {
  if (value !== expected) {
    throw new StripeCheckoutInvalidError(`${field} is invalid`);
  }
  return expected;
}

function boolean(value: unknown, field: string): boolean {
  if (typeof value !== "boolean") throw new StripeCheckoutInvalidError(`${field} is invalid`);
  return value;
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new StripeCheckoutInvalidError("Stripe response shape is invalid");
  }
  return value as Record<string, unknown>;
}
