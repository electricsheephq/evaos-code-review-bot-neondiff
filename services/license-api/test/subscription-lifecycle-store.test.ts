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
  status: "updated" | "replayed";
  replayed: boolean;
  entitlement: {
    status: "active";
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
        "select * from license_subscription_lifecycle_events"
      );
      assert.equal(ledger.length, 1);
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

function derivedKey(idempotencyKey: string): string {
  const digest = createHmac("sha256", ISSUANCE_SECRET)
    .update(`checkout-license:${idempotencyKey}`)
    .digest();
  return ["nd", "live", digest.subarray(0, 24).toString("base64url")].join("_");
}
