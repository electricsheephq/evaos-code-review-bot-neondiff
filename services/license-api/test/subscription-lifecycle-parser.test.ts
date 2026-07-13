import assert from "node:assert/strict";
import { test } from "node:test";
import {
  LifecycleRequestError,
  MAX_LIFECYCLE_BODY_BYTES,
  canonicalSubscriptionLifecycleRequestHash,
  parseSubscriptionLifecycleRequest,
  paymentReferenceFingerprint
} from "../src/subscription-lifecycle.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");

function validRenewal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    issuanceIdempotencyKey: "checkout-session:cs_live_parser",
    eventId: "evt_live_paid_1",
    eventCreatedAt: Math.floor(NOW.getTime() / 1000),
    provider: "stripe",
    providerAccountId: "acct_live_product",
    providerMode: "live",
    externalSubscriptionId: "sub_live_parser",
    providerEventType: "invoice.paid",
    command: "renew_paid",
    paymentReference: "in_live_secret_reference",
    amountPaidMinor: 100,
    currency: "usd",
    paidOutOfBand: false,
    billingReason: "subscription_cycle",
    subscriptionStatus: "active",
    currentPeriodEnd: "2026-08-13T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    ...overrides
  };
}

function parse(body: Record<string, unknown>) {
  return parseSubscriptionLifecycleRequest(JSON.stringify(body), NOW);
}

function invalid(body: Record<string, unknown>, pattern?: RegExp): void {
  assert.throws(
    () => parse(body),
    (error: unknown) => {
      assert.ok(error instanceof LifecycleRequestError);
      if (pattern) assert.match(error.message, pattern);
      assert.doesNotMatch(error.message, /in_live_secret_reference|sk_live|Bearer/i);
      return true;
    }
  );
}

test("parses a paid renewal without retaining its raw payment reference", () => {
  const parsed = parse(validRenewal());

  assert.equal(parsed.command, "renew_paid");
  assert.equal(parsed.currentPeriodEnd, "2026-08-13T12:00:00.000Z");
  assert.equal(parsed.paymentReferenceFingerprint, paymentReferenceFingerprint("in_live_secret_reference"));
  assert.equal("paymentReference" in parsed, false);
  assert.match(parsed.paymentReferenceFingerprint!, /^[a-f0-9]{64}$/);
  assert.match(parsed.requestHash, /^[a-f0-9]{64}$/);
});

test("rejects a body over the byte limit before JSON parsing", () => {
  const raw = "{" + "x".repeat(MAX_LIFECYCLE_BODY_BYTES) + "}";
  assert.throws(
    () => parseSubscriptionLifecycleRequest(raw, NOW),
    (error: unknown) =>
      error instanceof LifecycleRequestError && error.message === "request body is too large"
  );
});

test("rejects malformed, non-object, unknown-field, and incomplete requests generically", () => {
  assert.throws(() => parseSubscriptionLifecycleRequest("{secret", NOW), /valid JSON/);
  assert.throws(() => parseSubscriptionLifecycleRequest("[]", NOW), /JSON object/);
  invalid(validRenewal({ sk_live_do_not_echo: "secret" }), /unknown field/);
  const missing = validRenewal();
  delete missing.eventId;
  invalid(missing, /eventId is required/);
});

test("enforces bounded shared strings and the immutable Stripe provider tuple", () => {
  for (const [name, overrides, pattern] of [
    ["issuance", { issuanceIdempotencyKey: "x".repeat(201) }, /issuanceIdempotencyKey is too long/],
    ["event", { eventId: "x".repeat(201) }, /eventId is too long/],
    ["account", { providerAccountId: "x".repeat(161) }, /providerAccountId is too long/],
    ["subscription", { externalSubscriptionId: "x".repeat(161) }, /externalSubscriptionId is too long/],
    ["payment", { paymentReference: "x".repeat(201) }, /paymentReference is too long/],
    ["provider", { provider: "adyen" }, /provider must be stripe/],
    ["mode", { providerMode: "production" }, /providerMode must be test or live/],
    ["empty account", { providerAccountId: "  " }, /providerAccountId is required/]
  ] as const) {
    invalid(validRenewal(overrides), pattern);
    assert.ok(name);
  }
});

test("requires an integer epoch event time and permits at most five minutes of future skew", () => {
  for (const value of ["1783944000", 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    invalid(validRenewal({ eventCreatedAt: value }), /eventCreatedAt must be an integer epoch/);
  }
  parse(validRenewal({ eventCreatedAt: Math.floor(NOW.getTime() / 1000) + 300 }));
  invalid(
    validRenewal({ eventCreatedAt: Math.floor(NOW.getTime() / 1000) + 301 }),
    /eventCreatedAt is too far in the future/
  );
});

test("accepts every supported command, provider-event, and status tuple", () => {
  const cases: Record<string, unknown>[] = [
    validRenewal(),
    validRenewal({ providerEventType: "invoice.payment_succeeded" }),
    {
      ...validRenewal({
        providerEventType: "customer.subscription.updated",
        command: "reconcile",
        subscriptionStatus: "trialing"
      }),
      cancelAtPeriodEnd: false
    },
    validRenewal({
      providerEventType: "customer.subscription.updated",
      command: "cancel_at_period_end",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: true
    }),
    validRenewal({
      providerEventType: "invoice.payment_failed",
      command: "payment_attention",
      subscriptionStatus: "past_due"
    }),
    validRenewal({
      providerEventType: "customer.subscription.updated",
      command: "payment_attention",
      subscriptionStatus: "paused"
    }),
    validRenewal({
      providerEventType: "customer.subscription.deleted",
      command: "revoke",
      subscriptionStatus: "canceled",
      reason: "subscription deleted"
    }),
    validRenewal({
      providerEventType: "customer.subscription.updated",
      command: "revoke",
      subscriptionStatus: "incomplete_expired"
    })
  ];

  for (const body of cases) {
    if (body.command !== "renew_paid") {
      delete body.paymentReference;
      delete body.amountPaidMinor;
      delete body.currency;
      delete body.paidOutOfBand;
      delete body.billingReason;
    }
    if (body.command === "reconcile" || body.command === "payment_attention") {
      delete body.currentPeriodEnd;
    }
    if (body.command === "revoke") delete body.currentPeriodEnd;
    parse(body);
  }
});

test("rejects unsupported command, event, and status cross-pairings", () => {
  const cases: Array<[Record<string, unknown>, RegExp]> = [
    [validRenewal({ command: "extend" }), /command is unsupported/],
    [validRenewal({ providerEventType: "customer.subscription.updated" }), /providerEventType is invalid for renew_paid/],
    [validRenewal({ subscriptionStatus: "trialing" }), /subscriptionStatus is invalid for renew_paid/],
    [validRenewal({ command: "reconcile", providerEventType: "invoice.paid" }), /providerEventType is invalid for reconcile/],
    [validRenewal({ command: "reconcile", providerEventType: "customer.subscription.updated", subscriptionStatus: "past_due" }), /subscriptionStatus is invalid for reconcile/],
    [validRenewal({ command: "cancel_at_period_end", providerEventType: "customer.subscription.updated", subscriptionStatus: "past_due" }), /subscriptionStatus is invalid for cancel_at_period_end/],
    [validRenewal({ command: "payment_attention", providerEventType: "invoice.paid", subscriptionStatus: "past_due" }), /providerEventType is invalid for payment_attention/],
    [validRenewal({ command: "payment_attention", providerEventType: "invoice.payment_failed", subscriptionStatus: "trialing" }), /subscriptionStatus is invalid for payment_attention/],
    [validRenewal({ command: "revoke", providerEventType: "invoice.payment_failed", subscriptionStatus: "canceled" }), /providerEventType is invalid for revoke/],
    [validRenewal({ command: "revoke", providerEventType: "customer.subscription.deleted", subscriptionStatus: "active" }), /subscriptionStatus is invalid for revoke/]
  ];
  for (const [body, pattern] of cases) invalid(body, pattern);
});

test("requires paid active subscription-cycle evidence for renew_paid", () => {
  for (const [overrides, pattern] of [
    [{ paymentReference: "" }, /paymentReference is required/],
    [{ amountPaidMinor: 0 }, /amountPaidMinor must be a positive integer/],
    [{ amountPaidMinor: -1 }, /amountPaidMinor must be a positive integer/],
    [{ amountPaidMinor: 1.5 }, /amountPaidMinor must be a positive integer/],
    [{ currency: "USD" }, /currency must be usd/],
    [{ currency: "eur" }, /currency must be usd/],
    [{ paidOutOfBand: true }, /paidOutOfBand must be false/],
    [{ billingReason: "manual" }, /billingReason must be subscription_cycle/],
    [{ billingReason: "subscription_create" }, /billingReason must be subscription_cycle/],
    [{ subscriptionStatus: "trialing" }, /subscriptionStatus is invalid for renew_paid/]
  ] as const) {
    invalid(validRenewal(overrides), pattern);
  }
});

test("enforces command-specific payment, period-end, cancellation, and reason fields", () => {
  const reconcile = validRenewal({
    providerEventType: "customer.subscription.updated",
    command: "reconcile",
    subscriptionStatus: "active",
    cancelAtPeriodEnd: false
  });
  delete reconcile.paymentReference;
  delete reconcile.amountPaidMinor;
  delete reconcile.currency;
  delete reconcile.paidOutOfBand;
  delete reconcile.billingReason;
  parse(reconcile);
  invalid({ ...reconcile, paymentReference: "in_live_secret_reference" }, /payment fields are forbidden/);
  invalid({ ...reconcile, cancelAtPeriodEnd: true }, /cancelAtPeriodEnd must be false/);

  const cancel = { ...reconcile, command: "cancel_at_period_end", cancelAtPeriodEnd: true };
  parse(cancel);
  invalid({ ...cancel, currentPeriodEnd: undefined }, /currentPeriodEnd is required/);
  invalid({ ...cancel, cancelAtPeriodEnd: false }, /cancelAtPeriodEnd must be true/);

  const attention = {
    ...reconcile,
    providerEventType: "invoice.payment_failed",
    command: "payment_attention",
    subscriptionStatus: "incomplete"
  };
  parse(attention);
  invalid({ ...attention, amountPaidMinor: 100 }, /payment fields are forbidden/);

  const revoke = {
    ...reconcile,
    providerEventType: "customer.subscription.deleted",
    command: "revoke",
    subscriptionStatus: "unpaid"
  };
  delete revoke.currentPeriodEnd;
  parse(revoke);
  invalid({ ...revoke, currentPeriodEnd: "2026-08-13T12:00:00.000Z" }, /currentPeriodEnd is forbidden/);
  invalid({ ...revoke, currency: "usd" }, /payment fields are forbidden/);
  invalid({ ...revoke, reason: "x".repeat(201) }, /reason is too long/);
  invalid({ ...reconcile, reason: "not revoked" }, /reason is only allowed for revoke/);
});

test("validates optional or required period ends as strict future instants", () => {
  for (const value of [
    "not-a-date",
    "2026-07-13T12:00:00.000Z",
    "2026-07-13T11:59:59.999Z",
    "2026-08-13",
    1786622400000
  ]) {
    invalid(validRenewal({ currentPeriodEnd: value }), /currentPeriodEnd/);
  }
});

test("uses fixed-order canonical hashing independent of object insertion order", () => {
  const body = validRenewal();
  const reversed = Object.fromEntries(Object.entries(body).reverse());
  const first = parse(body);
  const second = parse(reversed);

  assert.equal(first.requestHash, second.requestHash);
  assert.equal(canonicalSubscriptionLifecycleRequestHash(first), first.requestHash);
  assert.notEqual(
    parse(validRenewal({ eventId: "evt_live_paid_2" })).requestHash,
    first.requestHash
  );
  assert.notEqual(
    parse(validRenewal({ paymentReference: "in_live_other_reference" })).requestHash,
    first.requestHash
  );
});

test("payment fingerprints are deterministic, domain-separated, and never expose the reference", () => {
  const first = paymentReferenceFingerprint("in_live_secret_reference");
  const second = paymentReferenceFingerprint("in_live_secret_reference");
  assert.equal(first, second);
  assert.notEqual(first, paymentReferenceFingerprint("in_live_other_reference"));
  assert.doesNotMatch(first, /in_live_secret_reference/);
});
