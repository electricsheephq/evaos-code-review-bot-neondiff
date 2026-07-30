import { createHash } from "node:crypto";
import Stripe from "stripe";
import {
  CHECKOUT_LOOKUP_KEYS,
  type CheckoutLookupKey
} from "./checkout-policy.js";
import { deriveCheckoutLicenseKey } from "./issuance.js";
import {
  CheckoutIssuanceConflictError,
  CheckoutIssuancePolicyError,
  CheckoutIssuanceTransientError,
  CheckoutRedemptionConsumedError,
  CheckoutRedemptionExpiredError,
  CheckoutRedemptionInvalidError,
  CheckoutRedemptionNotFoundError,
  CheckoutRedemptionTransientError,
  type LicenseRecord,
  type LicenseStore
} from "./store.js";

const DEFAULT_REDEMPTION_TTL_MS = 30 * 60 * 1_000;
const MAX_REDEMPTION_TTL_MS = 24 * 60 * 60 * 1_000;
const STRIPE_ID_PATTERN = /^(?:acct|cs_(?:live|test)|cus|evt|price|prod|sub)_[A-Za-z0-9_]+$/;
const TOKEN_HASH_PATTERN = /^[a-f0-9]{64}$/;

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
}): Promise<StripeCheckoutFulfillmentResult> {
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
  if (verifiedEvent.type !== "checkout.session.completed") {
    throw new StripeCheckoutInvalidError("Stripe event type is unsupported");
  }
  positiveInteger(verifiedEvent.created, "event created");
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
  const eventSession = record(eventData.object);
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
