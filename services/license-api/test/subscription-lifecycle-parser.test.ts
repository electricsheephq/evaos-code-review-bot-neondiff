import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  LifecycleRequestError,
  MAX_LIFECYCLE_BODY_BYTES,
  canonicalSubscriptionLifecycleRequestHash,
  parseSubscriptionLifecycleRequest,
  paymentReferenceFingerprint
} from "../src/subscription-lifecycle.js";

const NOW = new Date("2026-07-13T12:00:00.000Z");
const SERVICE_ROOT = fileURLToPath(new URL("..", import.meta.url));

const COMMAND_MATRIX = {
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
} as const;

type MatrixCommand = keyof typeof COMMAND_MATRIX;

const ALL_EVENTS = [
  "invoice.paid",
  "invoice.payment_succeeded",
  "customer.subscription.updated",
  "invoice.payment_failed",
  "customer.subscription.deleted"
] as const;

const ALL_STATUSES = [
  "active",
  "trialing",
  "past_due",
  "incomplete",
  "paused",
  "canceled",
  "unpaid",
  "incomplete_expired"
] as const;

const PAYMENT_FIELDS = [
  "paymentReference",
  "amountPaidMinor",
  "currency",
  "paidOutOfBand",
  "billingReason"
] as const;

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

function lifecycleBody(
  command: MatrixCommand,
  event: string = COMMAND_MATRIX[command].events[0],
  status: string = COMMAND_MATRIX[command].statuses[0]
): Record<string, unknown> {
  const body = validRenewal({
    command,
    providerEventType: event,
    subscriptionStatus: status
  });
  if (command !== "renew_paid") {
    for (const field of PAYMENT_FIELDS) delete body[field];
  }
  if (command === "reconcile" || command === "payment_attention") {
    delete body.currentPeriodEnd;
  }
  if (command === "cancel_at_period_end") body.cancelAtPeriodEnd = true;
  if (command === "revoke") delete body.currentPeriodEnd;
  return body;
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

test("separates diagnostic period ends from authoritative renewal and cancellation periods", () => {
  for (const command of ["reconcile", "payment_attention"] as const) {
    const parsed = parse({
      ...lifecycleBody(command),
      currentPeriodEnd: "2026-08-13T12:00:00.000Z"
    });
    assert.equal(parsed.command, command);
    assert.equal(parsed.diagnosticCurrentPeriodEnd, "2026-08-13T12:00:00.000Z");
    assert.equal("currentPeriodEnd" in parsed, false);
  }

  for (const command of ["renew_paid", "cancel_at_period_end"] as const) {
    const parsed = parse(lifecycleBody(command));
    assert.equal(parsed.command, command);
    assert.equal(parsed.currentPeriodEnd, "2026-08-13T12:00:00.000Z");
    assert.equal("diagnosticCurrentPeriodEnd" in parsed, false);
  }
});

test("compile-time command narrowing prevents diagnostic period authority smuggling", () => {
  assert.doesNotThrow(() =>
    execFileSync(
      process.execPath,
      [
        "node_modules/typescript/bin/tsc",
        "--noEmit",
        "--strict",
        "--target",
        "ES2023",
        "--module",
        "NodeNext",
        "--moduleResolution",
        "NodeNext",
        "--types",
        "node",
        "test/subscription-lifecycle-authority-types.ts"
      ],
      { cwd: SERVICE_ROOT, stdio: "pipe" }
    )
  );
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

test("accepts every valid command, provider-event, status, and optional-period combination", () => {
  let accepted = 0;
  for (const command of Object.keys(COMMAND_MATRIX) as MatrixCommand[]) {
    const rule = COMMAND_MATRIX[command];
    for (const event of rule.events) {
      for (const status of rule.statuses) {
        parse(lifecycleBody(command, event, status));
        accepted += 1;
        if (command === "reconcile" || command === "payment_attention") {
          const parsed = parse({
            ...lifecycleBody(command, event, status),
            currentPeriodEnd: "2026-08-13T12:00:00.000Z"
          });
          assert.equal(parsed.diagnosticCurrentPeriodEnd, "2026-08-13T12:00:00.000Z");
          accepted += 1;
        }
      }
    }
  }
  assert.equal(accepted, 30);
});

test("rejects every cross-command event and status tuple plus unsupported values", () => {
  let rejected = 0;
  for (const command of Object.keys(COMMAND_MATRIX) as MatrixCommand[]) {
    const rule = COMMAND_MATRIX[command];
    for (const event of ALL_EVENTS) {
      for (const status of ALL_STATUSES) {
        const isValid =
          (rule.events as readonly string[]).includes(event) &&
          (rule.statuses as readonly string[]).includes(status);
        if (isValid) continue;
        invalid(lifecycleBody(command, event, status));
        rejected += 1;
      }
    }
    invalid(lifecycleBody(command, "unsupported.event", rule.statuses[0]));
    invalid(lifecycleBody(command, rule.events[0], "unsupported_status"));
    rejected += 2;
  }
  assert.equal(rejected, 190);
  invalid(validRenewal({ command: "extend" }), /command is unsupported/);
});

test("exhaustively enforces shared and command-specific required fields", () => {
  const sharedRequired = [
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
    "subscriptionStatus",
    "cancelAtPeriodEnd"
  ] as const;
  for (const command of Object.keys(COMMAND_MATRIX) as MatrixCommand[]) {
    for (const field of sharedRequired) {
      const body = lifecycleBody(command);
      delete body[field];
      invalid(body);
    }
  }
  for (const field of [...PAYMENT_FIELDS, "currentPeriodEnd"] as const) {
    const body = lifecycleBody("renew_paid");
    delete body[field];
    invalid(body);
  }
  const cancel = lifecycleBody("cancel_at_period_end");
  delete cancel.currentPeriodEnd;
  invalid(cancel, /currentPeriodEnd is required/);
});

test("exhaustively rejects fields forbidden by each command", () => {
  for (const command of [
    "reconcile",
    "cancel_at_period_end",
    "payment_attention",
    "revoke"
  ] as const) {
    for (const field of PAYMENT_FIELDS) {
      invalid({ ...lifecycleBody(command), [field]: validRenewal()[field] }, /payment fields/);
    }
  }
  for (const command of [
    "renew_paid",
    "reconcile",
    "cancel_at_period_end",
    "payment_attention"
  ] as const) {
    invalid({ ...lifecycleBody(command), reason: "not a revocation" }, /reason is only allowed/);
  }
  invalid(
    { ...lifecycleBody("revoke"), currentPeriodEnd: "2026-08-13T12:00:00.000Z" },
    /currentPeriodEnd is forbidden/
  );
  invalid({ ...lifecycleBody("reconcile"), cancelAtPeriodEnd: true }, /must be false/);
  invalid({ ...lifecycleBody("cancel_at_period_end"), cancelAtPeriodEnd: false }, /must be true/);
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

test("requires renew_paid to represent a non-canceling subscription", () => {
  invalid(
    validRenewal({ cancelAtPeriodEnd: true }),
    /cancelAtPeriodEnd must be false for renew_paid/
  );
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
    subscriptionStatus: "unpaid",
    reason: "subscription_unpaid"
  };
  delete revoke.currentPeriodEnd;
  parse(revoke);
  invalid({ ...revoke, currentPeriodEnd: "2026-08-13T12:00:00.000Z" }, /currentPeriodEnd is forbidden/);
  invalid({ ...revoke, currency: "usd" }, /payment fields are forbidden/);
  invalid({ ...revoke, reason: "x".repeat(201) }, /reason/);
  invalid({ ...reconcile, reason: "not revoked" }, /reason is only allowed for revoke/);
});

test("derives a non-secret revoke reason code and rejects arbitrary caller text", () => {
  for (const [subscriptionStatus, expectedReason] of [
    ["canceled", "subscription_canceled"],
    ["unpaid", "subscription_unpaid"],
    ["incomplete_expired", "subscription_incomplete_expired"]
  ] as const) {
    const withoutReason = parse(lifecycleBody("revoke", undefined, subscriptionStatus));
    assert.equal(withoutReason.command, "revoke");
    assert.equal(withoutReason.reason, expectedReason);

    const exactReason = parse({
      ...lifecycleBody("revoke", undefined, subscriptionStatus),
      reason: expectedReason
    });
    assert.equal(exactReason.reason, expectedReason);

    for (const unsafeReason of [
      "buyer@example.com",
      "cus_customer_reference",
      "subscription canceled\r\nforged-admin-line",
      "subscription canceled\u001b[2J"
    ]) {
      invalid(
        { ...lifecycleBody("revoke", undefined, subscriptionStatus), reason: unsafeReason },
        /reason must match the server-derived code/
      );
    }
  }
});

test("preserves schema-v1 omitted-reason replay hashing while deriving a safe stored reason", () => {
  const omitted = parse(lifecycleBody("revoke", undefined, "canceled"));
  assert.equal(omitted.command, "revoke");
  assert.equal(omitted.reason, "subscription_canceled");
  assert.equal(omitted.reasonProvided, false);
  assert.equal(
    omitted.requestHash,
    "f263fb7a07ff32aafed816b368c7adf5bbe1b300ea59f58c54d08b9dd25c42b6"
  );
  assert.equal(canonicalSubscriptionLifecycleRequestHash(omitted), omitted.requestHash);

  const provided = parse({
    ...lifecycleBody("revoke", undefined, "canceled"),
    reason: "subscription_canceled"
  });
  assert.equal(provided.command, "revoke");
  assert.equal(provided.reasonProvided, true);
  assert.notEqual(provided.requestHash, omitted.requestHash);
});

test("validates period ends as strict UTC instants without applying clock freshness", () => {
  for (const value of [
    "not-a-date",
    "2026-08-13",
    1786622400000
  ]) {
    invalid(validRenewal({ currentPeriodEnd: value }), /currentPeriodEnd/);
  }
  for (const value of ["2026-07-13T12:00:00.000Z", "2026-07-13T11:59:59.999Z"]) {
    const parsed = parse(validRenewal({ currentPeriodEnd: value }));
    assert.equal(parsed.command, "renew_paid");
    assert.equal(parsed.currentPeriodEnd, value);
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
