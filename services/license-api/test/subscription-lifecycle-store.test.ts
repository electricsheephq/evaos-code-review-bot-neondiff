import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { issueCheckoutLicense, type LicenseIssuanceRequest } from "../src/issuance.ts";
import { activate } from "../src/service.ts";
import type { ParsedSubscriptionLifecycleRequest } from "../src/subscription-lifecycle.ts";
import { parseSubscriptionLifecycleRequest } from "../src/subscription-lifecycle.ts";
import { LicenseStore, hashLicenseKey } from "../src/store.ts";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUANCE_SECRET = "test-only-lifecycle-issuance-secret";
const DAY_MS = 24 * 60 * 60 * 1_000;

type LifecycleResult = {
  status:
    | "updated"
    | "replayed"
    | "ignored_stale"
    | "payment_attention"
    | "terminally_revoked";
  replayed: boolean;
  entitlement: {
    status: "active" | "expired" | "revoked";
    plan: string;
    seats: number;
    expiresAt: string;
  };
};

const tempDirectories = new Set<string>();

afterEach(() => {
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "neondiff-lifecycle-store-"));
  tempDirectories.add(directory);
  return join(directory, "licenses.sqlite");
}

function issuanceRequest(
  overrides: Partial<LicenseIssuanceRequest> = {}
): LicenseIssuanceRequest {
  return {
    idempotencyKey: "checkout-session:lifecycle-store",
    checkoutLookupKey: "neondiff_monthly",
    provider: "stripe",
    providerAccountId: "acct_product_live",
    providerMode: "live",
    externalSubscriptionId: "sub_lifecycle_store",
    externalCheckoutId: "cs_lifecycle_store",
    ...overrides
  };
}

function issueBound(
  store: LicenseStore,
  overrides: Partial<LicenseIssuanceRequest> = {}
): { request: LicenseIssuanceRequest; rawKey: string; licenseKeyHash: string; expiresAt: string } {
  const request = issuanceRequest(overrides);
  const result = issueCheckoutLicense(store, request, ISSUANCE_SECRET);
  assert.equal(result.httpStatus, 200);
  const body = result.body as {
    licenseKey: string;
    licenseKeyHash: string;
    entitlement: { expiresAt: string };
  };
  return {
    request,
    rawKey: body.licenseKey,
    licenseKeyHash: body.licenseKeyHash,
    expiresAt: body.entitlement.expiresAt
  };
}

function renewal(
  issuance: LicenseIssuanceRequest = issuanceRequest(),
  overrides: Record<string, unknown> = {},
  now: Date = NOW
): ParsedSubscriptionLifecycleRequest {
  return parseSubscriptionLifecycleRequest(
    JSON.stringify({
      schemaVersion: 1,
      issuanceIdempotencyKey: issuance.idempotencyKey,
      eventId: "evt_paid_lifecycle_store",
      eventCreatedAt: NOW_SECONDS,
      provider: issuance.provider,
      providerAccountId: issuance.providerAccountId,
      providerMode: issuance.providerMode,
      externalSubscriptionId: issuance.externalSubscriptionId,
      providerEventType: "invoice.paid",
      command: "renew_paid",
      paymentReference: "invoice-reference-lifecycle-store",
      amountPaidMinor: 100,
      currency: "usd",
      paidOutOfBand: false,
      billingReason: "subscription_cycle",
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-08-13T00:00:00.000Z",
      cancelAtPeriodEnd: false,
      ...overrides
    }),
    now
  );
}

function lifecycleRequest(
  command: "reconcile" | "cancel_at_period_end" | "payment_attention" | "revoke",
  issuance: LicenseIssuanceRequest = issuanceRequest(),
  overrides: Record<string, unknown> = {},
  now: Date = NOW
): ParsedSubscriptionLifecycleRequest {
  const variants = {
    reconcile: {
      providerEventType: "customer.subscription.updated",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false
    },
    cancel_at_period_end: {
      providerEventType: "customer.subscription.updated",
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-08-20T00:00:00.000Z",
      cancelAtPeriodEnd: true
    },
    payment_attention: {
      providerEventType: "invoice.payment_failed",
      subscriptionStatus: "past_due",
      cancelAtPeriodEnd: false
    },
    revoke: {
      providerEventType: "customer.subscription.deleted",
      subscriptionStatus: "canceled",
      cancelAtPeriodEnd: false
    }
  } as const;
  return parseSubscriptionLifecycleRequest(
    JSON.stringify({
      schemaVersion: 1,
      issuanceIdempotencyKey: issuance.idempotencyKey,
      eventId: `evt_${command}_lifecycle_store`,
      eventCreatedAt: NOW_SECONDS,
      provider: issuance.provider,
      providerAccountId: issuance.providerAccountId,
      providerMode: issuance.providerMode,
      externalSubscriptionId: issuance.externalSubscriptionId,
      command,
      ...variants[command],
      ...overrides
    }),
    now
  );
}

function applyLifecycle(
  store: LicenseStore,
  request: ParsedSubscriptionLifecycleRequest
): LifecycleResult {
  return (
    store as unknown as {
      applyCheckoutSubscriptionLifecycle(
        input: ParsedSubscriptionLifecycleRequest
      ): LifecycleResult;
    }
  ).applyCheckoutSubscriptionLifecycle(request);
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "";
}

function inspectDatabase<T>(path: string, query: string, ...params: unknown[]): T[] {
  const db = new DatabaseSync(path);
  try {
    return db.prepare(query).all(...params) as T[];
  } finally {
    db.close();
  }
}

describe("checkout subscription lifecycle binding", () => {
  it("rejects unknown, non-checkout, and unbound checkout issuance references", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      assert.throws(
        () => applyLifecycle(store, renewal()),
        (error: unknown) => errorName(error) === "SubscriptionLifecycleNotFoundError"
      );

      for (const [idempotencyKey, source] of [
        ["admin-issuance:lifecycle", "admin"],
        ["legacy-checkout:lifecycle", "checkout"]
      ] as const) {
        const rawKey = derivedKey(idempotencyKey);
        store.issueIdempotentLicense(rawKey, {
          idempotencyKey,
          requestHash: `request-hash-${source}`,
          source,
          externalRef: `external-ref-${source}`,
          plan: "monthly_support",
          repoVisibilityScope: "private",
          privateRepoAllowed: true,
          updateEntitlement: true,
          seats: 1,
          expiresAt: "2026-07-20T00:00:00.000Z"
        });
        assert.throws(
          () => applyLifecycle(store, renewal(issuanceRequest({ idempotencyKey }))),
          (error: unknown) => errorName(error) === "SubscriptionLifecycleNotFoundError"
        );
      }
    } finally {
      store.close();
    }
  });

  it("requires the exact bound provider, account, mode, and subscription tuple", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const issued = issueBound(store);
      for (const override of [
        { provider: "other-provider" },
        { providerAccountId: "acct_other" },
        { providerMode: "test" },
        { externalSubscriptionId: "sub_other" }
      ]) {
        const request = { ...renewal(issued.request), ...override } as ParsedSubscriptionLifecycleRequest;
        assert.throws(
          () => applyLifecycle(store, request),
          (error: unknown) => errorName(error) === "SubscriptionLifecycleNotFoundError"
        );
      }
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, issued.expiresAt);
    } finally {
      store.close();
    }
  });
});

describe("checkout subscription lifecycle replay", () => {
  it("rejects incompatible stored entitlements before the first lifecycle write", () => {
    for (const [label, mutation] of [
      ["missing expiry", "update licenses set expires_at = null where license_key_hash = ?"],
      ["invalid expiry", "update licenses set expires_at = 'not-a-timestamp' where license_key_hash = ?"],
      ["unsupported plan", "update licenses set plan = 'legacy_lifetime' where license_key_hash = ?"]
    ] as const) {
      const path = databasePath();
      const store = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:invalid-first-${label.replaceAll(" ", "-")}`,
          externalSubscriptionId: `sub_invalid_first_${label.replaceAll(" ", "_")}`,
          externalCheckoutId: `cs_invalid_first_${label.replaceAll(" ", "_")}`
        });
        const db = new DatabaseSync(path);
        db.prepare(mutation).run(issued.licenseKeyHash);
        db.close();

        assert.throws(
          () => applyLifecycle(store, lifecycleRequest("reconcile", issued.request)),
          (error: unknown) => errorName(error) === "SubscriptionLifecyclePolicyError",
          label
        );
        assert.equal(
          inspectDatabase<{ count: number }>(
            path,
            "select count(*) as count from license_subscription_lifecycle_events"
          )[0]?.count,
          0,
          label
        );
        assert.equal(
          inspectDatabase<{ last_non_mutating_event_created_at: number | null }>(
            path,
            `select last_non_mutating_event_created_at
             from checkout_subscription_bindings
             where issuance_idempotency_key = ?`,
            issued.request.idempotencyKey
          )[0]?.last_non_mutating_event_created_at,
          null,
          label
        );
      } finally {
        store.close();
      }
    }
  });

  it("returns the policy error without writing when an exact replay finds an incompatible entitlement", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:invalid-replay",
        externalSubscriptionId: "sub_invalid_replay",
        externalCheckoutId: "cs_invalid_replay"
      });
      const request = lifecycleRequest("reconcile", issued.request);
      applyLifecycle(store, request);
      const before = inspectDatabase<{
        event_count: number;
        watermark: number | null;
      }>(
        path,
        `select
           (select count(*) from license_subscription_lifecycle_events) as event_count,
           last_non_mutating_event_created_at as watermark
         from checkout_subscription_bindings
         where issuance_idempotency_key = ?`,
        issued.request.idempotencyKey
      )[0]!;
      const db = new DatabaseSync(path);
      db.prepare("update licenses set expires_at = null where license_key_hash = ?")
        .run(issued.licenseKeyHash);
      db.close();

      assert.throws(
        () => applyLifecycle(store, request),
        (error: unknown) => errorName(error) === "SubscriptionLifecyclePolicyError"
      );
      assert.deepEqual(
        inspectDatabase<{ event_count: number; watermark: number | null }>(
          path,
          `select
             (select count(*) from license_subscription_lifecycle_events) as event_count,
             last_non_mutating_event_created_at as watermark
           from checkout_subscription_bindings
           where issuance_idempotency_key = ?`,
          issued.request.idempotencyKey
        )[0],
        before
      );
    } finally {
      store.close();
    }
  });

  it("replays the exact event and hash once across two database connections", () => {
    const path = databasePath();
    const firstStore = new LicenseStore(path, { now: () => NOW });
    const secondStore = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(firstStore);
      const request = renewal(issued.request);
      const first = applyLifecycle(firstStore, request);
      const replay = applyLifecycle(secondStore, request);

      assert.deepEqual(first, {
        status: "updated",
        replayed: false,
        entitlement: {
          status: "active",
          plan: "monthly_support",
          seats: 1,
          expiresAt: "2026-08-13T00:00:00.000Z"
        }
      });
      assert.deepEqual(replay, {
        ...first,
        status: "replayed",
        replayed: true
      });
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        1
      );
    } finally {
      secondStore.close();
      firstStore.close();
    }
  });

  it("projects an exact replay as expired after the paid period elapses", () => {
    const path = databasePath();
    let storeNow = NOW;
    const store = new LicenseStore(path, { now: () => storeNow });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:expired-replay-projection",
        externalSubscriptionId: "sub_expired_replay_projection",
        externalCheckoutId: "cs_expired_replay_projection"
      });
      const request = lifecycleRequest("reconcile", issued.request);
      assert.equal(applyLifecycle(store, request).entitlement.status, "active");

      storeNow = new Date("2026-07-21T00:00:00.000Z");
      const replay = applyLifecycle(store, request);

      assert.equal(replay.status, "replayed");
      assert.equal(replay.entitlement.status, "expired");
      assert.equal(
        activate(store, { licenseKey: issued.rawKey, machineId: "expired-replay-machine" }, storeNow)
          .body.status,
        "expired"
      );
    } finally {
      store.close();
    }
  });

  it("conflicts when an event ID is reused with different canonical content", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store);
      const original = renewal(issued.request);
      applyLifecycle(store, original);
      const changed = renewal(issued.request, {
        eventId: original.eventId,
        currentPeriodEnd: "2026-08-14T00:00:00.000Z"
      });
      const forgedHash = { ...changed, requestHash: original.requestHash };

      assert.throws(
        () => applyLifecycle(store, forgedHash),
        (error: unknown) => errorName(error) === "SubscriptionLifecycleConflictError"
      );
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, original.currentPeriodEnd);
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        1
      );
    } finally {
      store.close();
    }
  });

  it("conflicts on reused event IDs before rejecting each changed correlation field", () => {
    for (const [label, override] of [
      ["provider", { provider: "other-provider" }],
      ["provider account", { providerAccountId: "acct_other" }],
      ["provider mode", { providerMode: "test" }],
      ["subscription", { externalSubscriptionId: "sub_other" }]
    ] as const) {
      const path = databasePath();
      const store = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:reused-correlation-${label.replaceAll(" ", "-")}`,
          externalSubscriptionId: `sub_reused_correlation_${label.replaceAll(" ", "_")}`,
          externalCheckoutId: `cs_reused_correlation_${label.replaceAll(" ", "_")}`
        });
        const original = renewal(issued.request, {
          eventId: `evt_reused_correlation_${label.replaceAll(" ", "_")}`
        });
        applyLifecycle(store, original);

        assert.throws(
          () => applyLifecycle(store, { ...original, ...override } as ParsedSubscriptionLifecycleRequest),
          (error: unknown) => errorName(error) === "SubscriptionLifecycleConflictError",
          label
        );
        assert.equal(
          inspectDatabase<{ count: number }>(
            path,
            "select count(*) as count from license_subscription_lifecycle_events"
          )[0]?.count,
          1,
          label
        );
      } finally {
        store.close();
      }
    }
  });

  it("exact-replays before consulting each subsequently changed binding field", () => {
    for (const [label, mutation] of [
      ["provider", "update checkout_subscription_bindings set provider = 'other-provider' where issuance_idempotency_key = ?"],
      ["provider account", "update checkout_subscription_bindings set provider_account_id = 'acct_other' where issuance_idempotency_key = ?"],
      ["provider mode", "update checkout_subscription_bindings set provider_mode = 'test' where issuance_idempotency_key = ?"],
      ["subscription", "update checkout_subscription_bindings set external_subscription_id = 'sub_other' where issuance_idempotency_key = ?"]
    ] as const) {
      const path = databasePath();
      const store = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:replay-binding-${label.replaceAll(" ", "-")}`,
          externalSubscriptionId: `sub_replay_binding_${label.replaceAll(" ", "_")}`,
          externalCheckoutId: `cs_replay_binding_${label.replaceAll(" ", "_")}`
        });
        const request = renewal(issued.request, {
          eventId: `evt_replay_binding_${label.replaceAll(" ", "_")}`
        });
        applyLifecycle(store, request);
        const db = new DatabaseSync(path);
        db.prepare(mutation).run(issued.request.idempotencyKey);
        db.close();

        const replay = applyLifecycle(store, request);
        assert.equal(replay.status, "replayed", label);
        assert.equal(replay.replayed, true, label);
        assert.equal(
          inspectDatabase<{ count: number }>(
            path,
            "select count(*) as count from license_subscription_lifecycle_events"
          )[0]?.count,
          1,
          label
        );
      } finally {
        store.close();
      }
    }
  });
});

describe("checkout subscription lifecycle renewal", () => {
  it("extends monotonically to max(existing, incoming) across two connections", () => {
    for (const order of [
      ["2026-08-20T00:00:00.000Z", "2026-08-10T00:00:00.000Z"],
      ["2026-08-10T00:00:00.000Z", "2026-08-20T00:00:00.000Z"]
    ] as const) {
      const path = databasePath();
      const firstStore = new LicenseStore(path, { now: () => NOW });
      const secondStore = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(firstStore, {
          idempotencyKey: `checkout-session:monotonic-${order[0].slice(8, 10)}`,
          externalSubscriptionId: `sub_monotonic_${order[0].slice(8, 10)}`,
          externalCheckoutId: `cs_monotonic_${order[0].slice(8, 10)}`
        });
        applyLifecycle(firstStore, renewal(issued.request, {
          eventId: `evt_monotonic_${order[0]}`,
          currentPeriodEnd: order[0]
        }));
        applyLifecycle(secondStore, renewal(issued.request, {
          eventId: `evt_monotonic_${order[1]}`,
          currentPeriodEnd: order[1]
        }));
        assert.equal(secondStore.getLicenseByKey(issued.rawKey)?.expiresAt, "2026-08-20T00:00:00.000Z");
      } finally {
        secondStore.close();
        firstStore.close();
      }
    }
  });

  it("enforces a future period and the 62/400-day plan caps from the store clock", () => {
    for (const [checkoutLookupKey, maximumDays] of [
      ["neondiff_monthly", 62],
      ["neondiff_yearly", 400],
      ["neondiff_org_yearly", 400]
    ] as const) {
      const store = new LicenseStore(":memory:", { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:cap-${checkoutLookupKey}`,
          checkoutLookupKey,
          externalSubscriptionId: `sub_cap_${checkoutLookupKey}`,
          externalCheckoutId: `cs_cap_${checkoutLookupKey}`
        });
        const validEnd = new Date(NOW.getTime() + maximumDays * DAY_MS).toISOString();
        const valid = renewal(issued.request, {
          eventId: `evt_cap_valid_${checkoutLookupKey}`,
          currentPeriodEnd: validEnd
        });
        assert.equal(applyLifecycle(store, valid).entitlement.expiresAt, validEnd);

        const tooFar = {
          ...renewal(issued.request, {
            eventId: `evt_cap_invalid_${checkoutLookupKey}`,
            currentPeriodEnd: validEnd
          }),
          currentPeriodEnd: new Date(NOW.getTime() + (maximumDays * DAY_MS) + 1).toISOString()
        } as ParsedSubscriptionLifecycleRequest;
        assert.throws(
          () => applyLifecycle(store, tooFar),
          (error: unknown) => errorName(error) === "SubscriptionLifecyclePolicyError"
        );
        assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, validEnd);
      } finally {
        store.close();
      }
    }

    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:past-period",
        externalSubscriptionId: "sub_past_period",
        externalCheckoutId: "cs_past_period"
      });
      const past = {
        ...renewal(issued.request),
        eventId: "evt_past_period",
        currentPeriodEnd: NOW.toISOString()
      } as ParsedSubscriptionLifecycleRequest;
      assert.throws(
        () => applyLifecycle(store, past),
        (error: unknown) => errorName(error) === "SubscriptionLifecyclePolicyError"
      );
    } finally {
      store.close();
    }
  });

  it("reactivates only expired nonterminal licenses with a valid future paid end", () => {
    for (const storedStatus of ["active", "expired"] as const) {
      const path = databasePath();
      const store = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:reactivate-${storedStatus}`,
          externalSubscriptionId: `sub_reactivate_${storedStatus}`,
          externalCheckoutId: `cs_reactivate_${storedStatus}`
        });
        const db = new DatabaseSync(path);
        db.prepare("update licenses set status = ?, expires_at = ? where license_key_hash = ?")
          .run(storedStatus, "2026-07-12T00:00:00.000Z", issued.licenseKeyHash);
        db.close();

        const result = applyLifecycle(store, renewal(issued.request, {
          eventId: `evt_reactivate_${storedStatus}`
        }));
        assert.equal(result.entitlement.status, "active");
        assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "active");
        assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, "2026-08-13T00:00:00.000Z");
      } finally {
        store.close();
      }
    }

    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:terminal-renewal",
        externalSubscriptionId: "sub_terminal_renewal",
        externalCheckoutId: "cs_terminal_renewal"
      });
      store.revokeLicense(issued.rawKey, "terminal owner action");
      assert.throws(
        () => applyLifecycle(store, renewal(issued.request)),
        (error: unknown) => errorName(error) === "SubscriptionLifecycleTerminalError"
      );
      assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "revoked");
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        0
      );
    } finally {
      store.close();
    }
  });

  it("preserves the license hash and activation rows and redacts raw identifiers", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:preserve-activation",
        externalSubscriptionId: "sub_preserve_activation",
        externalCheckoutId: "cs_preserve_activation"
      });
      const activated = activate(
        store,
        { licenseKey: issued.rawKey, machineId: "machine-preserved", repo: "owner/repo" },
        NOW
      );
      assert.equal(activated.httpStatus, 200);
      const before = store.listActivations(issued.licenseKeyHash);
      const paymentReference = "invoice-reference-never-persist-verbatim";
      const request = renewal(issued.request, { paymentReference });
      const result = applyLifecycle(store, request);

      assert.equal(store.getLicenseByKey(issued.rawKey)?.licenseKeyHash, hashLicenseKey(issued.rawKey));
      assert.deepEqual(store.listActivations(issued.licenseKeyHash), before);
      assert.ok(!JSON.stringify(result).includes(issued.rawKey));
      assert.ok(!JSON.stringify(result).includes(paymentReference));
      const ledger = inspectDatabase<Record<string, unknown>>(
        path,
        `select
          event_id,
          issuance_idempotency_key,
          license_key_hash,
          external_subscription_id,
          request_hash,
          event_created_at,
          provider,
          provider_account_id,
          provider_mode,
          provider_event_type,
          command,
          payment_reference_fingerprint,
          normalized_transition,
          result
        from license_subscription_lifecycle_events`
      );
      assert.equal(ledger.length, 1);
      assert.deepEqual({ ...ledger[0] }, {
        event_id: request.eventId,
        issuance_idempotency_key: issued.request.idempotencyKey,
        license_key_hash: issued.licenseKeyHash,
        external_subscription_id: issued.request.externalSubscriptionId,
        request_hash: request.requestHash,
        event_created_at: request.eventCreatedAt,
        provider: issued.request.provider,
        provider_account_id: issued.request.providerAccountId,
        provider_mode: issued.request.providerMode,
        provider_event_type: request.providerEventType,
        command: request.command,
        payment_reference_fingerprint: request.paymentReferenceFingerprint,
        normalized_transition: "renew_paid",
        result: "updated"
      });
      assert.equal(ledger[0]?.payment_reference_fingerprint, request.paymentReferenceFingerprint);
      assert.ok(!JSON.stringify(ledger).includes(paymentReference));
      const bytes = readFileSync(path);
      assert.equal(bytes.includes(Buffer.from(issued.rawKey)), false);
      assert.equal(bytes.includes(Buffer.from(paymentReference)), false);
    } finally {
      store.close();
    }
  });

  it("rolls back entitlement mutation when the lifecycle ledger insert is constrained", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:rollback",
        externalSubscriptionId: "sub_rollback",
        externalCheckoutId: "cs_rollback"
      });
      const db = new DatabaseSync(path);
      db.exec(`
        create trigger reject_lifecycle_insert
        before insert on license_subscription_lifecycle_events
        begin
          select raise(abort, 'deterministic lifecycle ledger fault');
        end
      `);
      db.close();

      assert.throws(
        () => applyLifecycle(store, renewal(issued.request)),
        /deterministic lifecycle ledger fault/
      );
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, issued.expiresAt);
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        0
      );
    } finally {
      store.close();
    }
  });

  it("bounds BEGIN IMMEDIATE contention and leaves renewal state unchanged", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW, busyTimeoutMs: 25 });
    const blocker = new DatabaseSync(path);
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:contention",
        externalSubscriptionId: "sub_contention",
        externalCheckoutId: "cs_contention"
      });
      blocker.exec("begin immediate");
      const startedAt = Date.now();
      assert.throws(
        () => applyLifecycle(store, renewal(issued.request)),
        (error: unknown) => errorName(error) === "SubscriptionLifecycleTransientError"
      );
      assert.ok(Date.now() - startedAt < 1_000, "contention wait must remain bounded");
      blocker.exec("rollback");
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, issued.expiresAt);
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        0
      );
    } finally {
      try {
        blocker.exec("rollback");
      } catch {}
      blocker.close();
      store.close();
    }
  });
});

describe("checkout subscription lifecycle ordering and terminal dominance", () => {
  it("records reconcile without extending or reactivating the entitlement", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:reconcile-record-only",
        externalSubscriptionId: "sub_reconcile_record_only",
        externalCheckoutId: "cs_reconcile_record_only"
      });
      const db = new DatabaseSync(path);
      db.prepare("update licenses set status = 'expired' where license_key_hash = ?")
        .run(issued.licenseKeyHash);
      db.close();

      const result = applyLifecycle(store, lifecycleRequest("reconcile", issued.request, {
        currentPeriodEnd: "2026-08-20T00:00:00.000Z"
      }));

      assert.deepEqual(result, {
        status: "updated",
        replayed: false,
        entitlement: {
          status: "expired",
          plan: "monthly_support",
          seats: 1,
          expiresAt: issued.expiresAt
        }
      });
      assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "expired");
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, issued.expiresAt);
    } finally {
      store.close();
    }
  });

  it("audits older non-mutating events as ignored_stale without moving the watermark", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:stale-audit",
        externalSubscriptionId: "sub_stale_audit",
        externalCheckoutId: "cs_stale_audit"
      });
      const newest = lifecycleRequest("cancel_at_period_end", issued.request, {
        eventId: "evt_stale_newest",
        eventCreatedAt: NOW_SECONDS
      });
      const stale = lifecycleRequest("payment_attention", issued.request, {
        eventId: "evt_stale_older",
        eventCreatedAt: NOW_SECONDS - 60
      });

      assert.equal(applyLifecycle(store, newest).status, "updated");
      assert.equal(applyLifecycle(store, stale).status, "ignored_stale");
      assert.equal(store.getLicenseByKey(issued.rawKey)?.expiresAt, issued.expiresAt);

      const binding = inspectDatabase<{ last_non_mutating_event_created_at: number }>(
        path,
        `select last_non_mutating_event_created_at
         from checkout_subscription_bindings
         where issuance_idempotency_key = ?`,
        issued.request.idempotencyKey
      )[0];
      assert.equal(binding?.last_non_mutating_event_created_at, NOW_SECONDS);
      assert.deepEqual(
        inspectDatabase<{ event_id: string; result: string; normalized_transition: string }>(
          path,
          `select event_id, result, normalized_transition
           from license_subscription_lifecycle_events
           order by event_id`
        ).map((row) => ({ ...row })),
        [
          {
            event_id: "evt_stale_newest",
            result: "updated",
            normalized_transition: "cancel_at_period_end"
          },
          {
            event_id: "evt_stale_older",
            result: "ignored_stale",
            normalized_transition: "payment_attention"
          }
        ]
      );
    } finally {
      store.close();
    }
  });

  it("preserves expiry exactly for cancellation and grants no time or early revoke for attention", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:cancel-attention",
        externalSubscriptionId: "sub_cancel_attention",
        externalCheckoutId: "cs_cancel_attention"
      });
      const before = store.getLicenseByKey(issued.rawKey);

      const cancellation = applyLifecycle(store, lifecycleRequest("cancel_at_period_end", issued.request, {
        eventId: "evt_cancel_preserve_exact",
        currentPeriodEnd: "2026-08-20T00:00:00.000Z"
      }));
      const attention = applyLifecycle(store, lifecycleRequest("payment_attention", issued.request, {
        eventId: "evt_attention_no_time",
        eventCreatedAt: NOW_SECONDS + 1,
        currentPeriodEnd: "2026-08-21T00:00:00.000Z"
      }));

      assert.equal(cancellation.status, "updated");
      assert.equal(attention.status, "payment_attention");
      assert.deepEqual(store.getLicenseByKey(issued.rawKey), before);
      assert.equal(attention.entitlement.status, "active");
      assert.equal(attention.entitlement.expiresAt, issued.expiresAt);
    } finally {
      store.close();
    }
  });

  it("revokes without a period end, persists the safe reason code, and exact-replays terminal state", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:terminal-revoke",
        externalSubscriptionId: "sub_terminal_revoke",
        externalCheckoutId: "cs_terminal_revoke"
      });
      const request = lifecycleRequest("revoke", issued.request);

      assert.deepEqual(applyLifecycle(store, request), {
        status: "terminally_revoked",
        replayed: false,
        entitlement: {
          status: "revoked",
          plan: "monthly_support",
          seats: 1,
          expiresAt: NOW.toISOString()
        }
      });
      assert.equal(store.getLicenseByKey(issued.rawKey)?.revocationReason,
        "subscription_canceled");
      assert.deepEqual(applyLifecycle(store, request), {
        status: "replayed",
        replayed: true,
        entitlement: {
          status: "revoked",
          plan: "monthly_support",
          seats: 1,
          expiresAt: NOW.toISOString()
        }
      });
      const ledger = inspectDatabase<{ normalized_transition: string; result: string }>(
        path,
        "select normalized_transition, result from license_subscription_lifecycle_events"
      ).map((row) => ({ ...row }));
      assert.deepEqual(ledger, [{
        normalized_transition: "revoke",
        result: "terminally_revoked"
      }]);
    } finally {
      store.close();
    }
  });

  it("cannot resurrect a terminal entitlement with later renew, reconcile, cancel, or attention", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:no-resurrection",
        externalSubscriptionId: "sub_no_resurrection",
        externalCheckoutId: "cs_no_resurrection"
      });
      applyLifecycle(store, lifecycleRequest("revoke", issued.request));
      const later = NOW_SECONDS + 30;
      const requests = [
        renewal(issued.request, { eventId: "evt_terminal_late_renew", eventCreatedAt: later }),
        lifecycleRequest("reconcile", issued.request, {
          eventId: "evt_terminal_late_reconcile", eventCreatedAt: later
        }),
        lifecycleRequest("cancel_at_period_end", issued.request, {
          eventId: "evt_terminal_late_cancel", eventCreatedAt: later
        }),
        lifecycleRequest("payment_attention", issued.request, {
          eventId: "evt_terminal_late_attention", eventCreatedAt: later
        })
      ];
      for (const request of requests) {
        assert.throws(
          () => applyLifecycle(store, request),
          (error: unknown) => errorName(error) === "SubscriptionLifecycleTerminalError"
        );
      }
      assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "revoked");
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        1
      );
    } finally {
      store.close();
    }
  });

  it("replays an earlier successful renewal after revoke and still conflicts on changed reuse", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:terminal-renewal-replay",
        externalSubscriptionId: "sub_terminal_renewal_replay",
        externalCheckoutId: "cs_terminal_renewal_replay"
      });
      const paid = renewal(issued.request, {
        eventId: "evt_terminal_renewal_replay",
        currentPeriodEnd: "2026-08-20T00:00:00.000Z"
      });
      applyLifecycle(store, paid);
      applyLifecycle(store, lifecycleRequest("revoke", issued.request, {
        eventId: "evt_terminal_after_renewal",
        eventCreatedAt: NOW_SECONDS + 1
      }));

      assert.deepEqual(applyLifecycle(store, paid), {
        status: "replayed",
        replayed: true,
        entitlement: {
          status: "revoked",
          plan: "monthly_support",
          seats: 1,
          expiresAt: "2026-07-13T00:00:01.000Z"
        }
      });
      const changed = renewal(issued.request, {
        eventId: paid.eventId,
        currentPeriodEnd: "2026-08-21T00:00:00.000Z"
      });
      assert.throws(
        () => applyLifecycle(store, changed),
        (error: unknown) => errorName(error) === "SubscriptionLifecycleConflictError"
      );
      assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "revoked");
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        2
      );
    } finally {
      store.close();
    }
  });

  it("converges for same-second renewal and update arrival orders with explicit equal-time precedence", () => {
    const projections: Array<Record<string, unknown>> = [];
    for (const updateCommand of ["reconcile", "cancel_at_period_end", "payment_attention"] as const) {
      for (const order of ["renew-first", "update-first"] as const) {
        const path = databasePath();
        const firstStore = new LicenseStore(path, { now: () => NOW });
        const secondStore = new LicenseStore(path, { now: () => NOW });
        try {
          const suffix = `${updateCommand}-${order}`;
          const issued = issueBound(firstStore, {
            idempotencyKey: `checkout-session:same-second-${suffix}`,
            externalSubscriptionId: `sub_same_second_${suffix}`,
            externalCheckoutId: `cs_same_second_${suffix}`
          });
          const paid = renewal(issued.request, {
            eventId: `evt_paid_${suffix}`,
            eventCreatedAt: NOW_SECONDS,
            currentPeriodEnd: "2026-08-20T00:00:00.000Z"
          });
          const update = lifecycleRequest(updateCommand, issued.request, {
            eventId: `evt_update_${suffix}`,
            eventCreatedAt: NOW_SECONDS
          });
          const requests = order === "renew-first" ? [paid, update] : [update, paid];
          const statuses = [
            applyLifecycle(firstStore, requests[0]!).status,
            applyLifecycle(secondStore, requests[1]!).status
          ].sort();
          const license = secondStore.getLicenseByKey(issued.rawKey)!;

          projections.push({
            updateCommand,
            statuses,
            license: {
              status: license.status,
              plan: license.plan,
              seats: license.seats,
              expiresAt: license.expiresAt
            },
            ledger: inspectDatabase<{ command: string; result: string }>(
              path,
              `select command, result
               from license_subscription_lifecycle_events
               order by command`
            )
          });
        } finally {
          secondStore.close();
          firstStore.close();
        }
      }
    }

    for (let index = 0; index < projections.length; index += 2) {
      const first = projections[index]!;
      const second = projections[index + 1]!;
      assert.deepEqual(first.statuses, second.statuses);
      assert.deepEqual(first.license, second.license);
      assert.deepEqual(first.ledger, second.ledger);
      assert.equal((first.license as { expiresAt: string }).expiresAt,
        "2026-08-20T00:00:00.000Z");
    }
  });

  it("normalizes same-second renewal and revoke to one terminal entitlement without rewriting history", () => {
    const entitlements: Array<Record<string, unknown>> = [];
    const histories: Array<Array<Record<string, unknown>>> = [];
    for (const order of ["renew-first", "revoke-first"] as const) {
      const path = databasePath();
      const firstStore = new LicenseStore(path, { now: () => NOW });
      const secondStore = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(firstStore, {
          idempotencyKey: "checkout-session:terminal-order",
          externalSubscriptionId: "sub_terminal_order",
          externalCheckoutId: "cs_terminal_order"
        });
        assert.equal(activate(firstStore, {
          licenseKey: issued.rawKey,
          machineId: "machine-terminal-order",
          repo: "owner/repo"
        }, NOW).httpStatus, 200);
        const activations = firstStore.listActivations(issued.licenseKeyHash);
        const paid = renewal(issued.request, {
          eventId: `evt_terminal_paid_${order}`,
          eventCreatedAt: NOW_SECONDS,
          currentPeriodEnd: "2026-08-20T00:00:00.000Z"
        });
        const revoked = lifecycleRequest("revoke", issued.request, {
          eventId: `evt_terminal_revoke_${order}`,
          eventCreatedAt: NOW_SECONDS
        });
        if (order === "renew-first") {
          assert.equal(applyLifecycle(firstStore, paid).status, "updated");
          assert.equal(applyLifecycle(secondStore, revoked).status, "terminally_revoked");
        } else {
          assert.equal(applyLifecycle(firstStore, revoked).status, "terminally_revoked");
          const beforeRejectedRenewal = firstStore.getLicenseByKey(issued.rawKey);
          assert.throws(
            () => applyLifecycle(secondStore, paid),
            (error: unknown) => errorName(error) === "SubscriptionLifecycleTerminalError"
          );
          assert.deepEqual(secondStore.getLicenseByKey(issued.rawKey), beforeRejectedRenewal);
        }
        const license = secondStore.getLicenseByKey(issued.rawKey)!;
        assert.equal(license.licenseKeyHash, issued.licenseKeyHash);
        assert.deepEqual(secondStore.listActivations(issued.licenseKeyHash), activations);
        entitlements.push({
          status: license.status,
          plan: license.plan,
          seats: license.seats,
          expiresAt: license.expiresAt,
          revocationReason: license.revocationReason,
          licenseKeyHash: license.licenseKeyHash,
          activations: secondStore.listActivations(issued.licenseKeyHash)
        });
        histories.push(
          inspectDatabase<{
            command: string;
            normalized_transition: string;
            result: string;
          }>(
            path,
            `select command, normalized_transition, result
             from license_subscription_lifecycle_events
             order by command`
          ).map((row) => ({ ...row }))
        );
      } finally {
        secondStore.close();
        firstStore.close();
      }
    }

    assert.deepEqual(entitlements[0], entitlements[1]);
    assert.deepEqual(entitlements[0], {
      status: "revoked",
      plan: "monthly_support",
      seats: 1,
      expiresAt: NOW.toISOString(),
      revocationReason: "subscription_canceled",
      licenseKeyHash: (entitlements[0] as { licenseKeyHash: string }).licenseKeyHash,
      activations: (entitlements[0] as { activations: unknown[] }).activations
    });
    assert.deepEqual(histories[0], [
      {
        command: "renew_paid",
        normalized_transition: "renew_paid",
        result: "updated"
      },
      {
        command: "revoke",
        normalized_transition: "revoke",
        result: "terminally_revoked"
      }
    ]);
    assert.deepEqual(histories[1], [
      {
        command: "revoke",
        normalized_transition: "revoke",
        result: "terminally_revoked"
      }
    ]);
    assert.notDeepEqual(histories[0], histories[1]);
  });

  it("normalizes same-second renewal and revoke from an already expired entitlement", () => {
    const projections: Array<Record<string, unknown>> = [];
    const histories: Array<Array<Record<string, unknown>>> = [];
    for (const order of ["renew-first", "revoke-first"] as const) {
      const path = databasePath();
      const firstStore = new LicenseStore(path, { now: () => NOW });
      const secondStore = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(firstStore, {
          idempotencyKey: "checkout-session:expired-terminal-order",
          externalSubscriptionId: "sub_expired_terminal_order",
          externalCheckoutId: "cs_expired_terminal_order"
        });
        assert.equal(activate(firstStore, {
          licenseKey: issued.rawKey,
          machineId: "machine-expired-terminal-order",
          repo: "owner/repo"
        }, NOW).httpStatus, 200);
        const db = new DatabaseSync(path);
        db.prepare(
          "update licenses set status = 'expired', expires_at = ? where license_key_hash = ?"
        ).run("2026-07-12T00:00:00.000Z", issued.licenseKeyHash);
        db.close();
        const activations = firstStore.listActivations(issued.licenseKeyHash);
        const paid = renewal(issued.request, {
          eventId: `evt_expired_terminal_paid_${order}`,
          eventCreatedAt: NOW_SECONDS,
          currentPeriodEnd: "2026-08-20T00:00:00.000Z"
        });
        const revoked = lifecycleRequest("revoke", issued.request, {
          eventId: `evt_expired_terminal_revoke_${order}`,
          eventCreatedAt: NOW_SECONDS
        });

        if (order === "renew-first") {
          assert.equal(applyLifecycle(firstStore, paid).status, "updated");
          assert.equal(applyLifecycle(secondStore, revoked).status, "terminally_revoked");
        } else {
          assert.equal(applyLifecycle(firstStore, revoked).status, "terminally_revoked");
          const terminal = firstStore.getLicenseByKey(issued.rawKey);
          assert.throws(
            () => applyLifecycle(secondStore, paid),
            (error: unknown) => errorName(error) === "SubscriptionLifecycleTerminalError"
          );
          assert.deepEqual(secondStore.getLicenseByKey(issued.rawKey), terminal);
        }

        const license = secondStore.getLicenseByKey(issued.rawKey)!;
        projections.push({
          status: license.status,
          plan: license.plan,
          seats: license.seats,
          expiresAt: license.expiresAt,
          revocationReason: license.revocationReason,
          licenseKeyHash: license.licenseKeyHash,
          activations: secondStore.listActivations(issued.licenseKeyHash)
        });
        assert.deepEqual(secondStore.listActivations(issued.licenseKeyHash), activations);
        histories.push(
          inspectDatabase<{ command: string; result: string }>(
            path,
            `select command, result
             from license_subscription_lifecycle_events
             order by command`
          ).map((row) => ({ ...row }))
        );
      } finally {
        secondStore.close();
        firstStore.close();
      }
    }

    assert.deepEqual(projections[0], projections[1]);
    assert.equal(projections[0]?.status, "revoked");
    assert.equal(projections[0]?.expiresAt, NOW.toISOString());
    assert.deepEqual(histories[0], [
      { command: "renew_paid", result: "updated" },
      { command: "revoke", result: "terminally_revoked" }
    ]);
    assert.deepEqual(histories[1], [
      { command: "revoke", result: "terminally_revoked" }
    ]);
  });

  it("rolls back every non-mutating watermark when its ledger insert fails", () => {
    for (const command of ["reconcile", "cancel_at_period_end", "payment_attention"] as const) {
      const path = databasePath();
      const store = new LicenseStore(path, { now: () => NOW });
      try {
        const issued = issueBound(store, {
          idempotencyKey: `checkout-session:${command}-rollback`,
          externalSubscriptionId: `sub_${command}_rollback`,
          externalCheckoutId: `cs_${command}_rollback`
        });
        const before = store.getLicenseByKey(issued.rawKey);
        const db = new DatabaseSync(path);
        db.exec(`
          create trigger reject_${command}_lifecycle_insert
          before insert on license_subscription_lifecycle_events
          begin
            select raise(abort, 'deterministic ${command} ledger fault');
          end
        `);
        db.close();

        assert.throws(
          () => applyLifecycle(store, lifecycleRequest(command, issued.request)),
          new RegExp(`deterministic ${command} ledger fault`)
        );
        assert.deepEqual(store.getLicenseByKey(issued.rawKey), before);
        assert.equal(
          inspectDatabase<{ last_non_mutating_event_created_at: number | null }>(
            path,
            `select last_non_mutating_event_created_at
             from checkout_subscription_bindings
             where issuance_idempotency_key = ?`,
            issued.request.idempotencyKey
          )[0]?.last_non_mutating_event_created_at,
          null
        );
        assert.equal(
          inspectDatabase<{ count: number }>(
            path,
            "select count(*) as count from license_subscription_lifecycle_events"
          )[0]?.count,
          0
        );
      } finally {
        store.close();
      }
    }
  });

  it("rolls back terminal mutation when its ledger insert fails", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { now: () => NOW });
    try {
      const issued = issueBound(store, {
        idempotencyKey: "checkout-session:terminal-rollback",
        externalSubscriptionId: "sub_terminal_rollback",
        externalCheckoutId: "cs_terminal_rollback"
      });
      const db = new DatabaseSync(path);
      db.exec(`
        create trigger reject_terminal_lifecycle_insert
        before insert on license_subscription_lifecycle_events
        begin
          select raise(abort, 'deterministic terminal ledger fault');
        end
      `);
      db.close();

      assert.throws(
        () => applyLifecycle(store, lifecycleRequest("revoke", issued.request)),
        /deterministic terminal ledger fault/
      );
      assert.equal(store.getLicenseByKey(issued.rawKey)?.status, "active");
      assert.equal(store.getLicenseByKey(issued.rawKey)?.revocationReason, undefined);
      assert.equal(
        inspectDatabase<{ count: number }>(
          path,
          "select count(*) as count from license_subscription_lifecycle_events"
        )[0]?.count,
        0
      );
    } finally {
      store.close();
    }
  });
});

function derivedKey(idempotencyKey: string): string {
  const digest = createHmac("sha256", ISSUANCE_SECRET)
    .update(`checkout-license:${idempotencyKey}`)
    .digest();
  return ["nd", "live", digest.subarray(0, 24).toString("base64url")].join("_");
}
