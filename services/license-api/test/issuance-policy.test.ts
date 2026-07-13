import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { checkoutPolicyFor } from "../src/checkout-policy.ts";
import {
  issueCheckoutLicense,
  parseIssuanceRequest,
  type LicenseIssuanceRequest
} from "../src/issuance.ts";
import { CheckoutIssuancePolicyError, LicenseStore } from "../src/store.ts";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const ISSUANCE_SECRET = "test-only-checkout-issuance-secret";

function request(overrides: Partial<LicenseIssuanceRequest> = {}): LicenseIssuanceRequest {
  return {
    idempotencyKey: "checkout-session:policy-test",
    checkoutLookupKey: "neondiff_monthly",
    provider: "stripe",
    providerAccountId: "acct_live_product",
    providerMode: "live",
    externalSubscriptionId: "sub_policy_test",
    externalCheckoutId: "cs_policy_test",
    ...overrides
  };
}

function derivedKey(idempotencyKey: string): string {
  const digest = createHmac("sha256", ISSUANCE_SECRET)
    .update(`checkout-license:${idempotencyKey}`)
    .digest();
  return ["nd", "live", digest.subarray(0, 24).toString("base64url")].join("_");
}

function directBoundInput(
  req: LicenseIssuanceRequest,
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    idempotencyKey: req.idempotencyKey,
    checkoutLookupKey: req.checkoutLookupKey,
    binding: {
      provider: req.provider,
      providerAccountId: req.providerAccountId,
      providerMode: req.providerMode,
      externalSubscriptionId: req.externalSubscriptionId,
      externalCheckoutId: req.externalCheckoutId
    },
    ...overrides
  };
}

describe("server-owned checkout policy", () => {
  it("defines the authoritative plan, trial, renewal cap, currency, and seat policy", () => {
    assert.deepEqual(checkoutPolicyFor("neondiff_monthly"), {
      plan: "monthly_support",
      trialDays: 7,
      maximumPeriodDays: 62,
      currency: "usd",
      seats: 1,
      repoVisibilityScope: "private",
      privateRepoAllowed: true,
      updateEntitlement: true
    });
    assert.deepEqual(checkoutPolicyFor("neondiff_yearly"), {
      plan: "yearly_support",
      trialDays: 7,
      maximumPeriodDays: 400,
      currency: "usd",
      seats: 1,
      repoVisibilityScope: "private",
      privateRepoAllowed: true,
      updateEntitlement: true
    });
    assert.deepEqual(checkoutPolicyFor("neondiff_org_yearly"), {
      plan: "org_yearly_support",
      trialDays: 30,
      maximumPeriodDays: 400,
      currency: "usd",
      seats: 1,
      repoVisibilityScope: "private",
      privateRepoAllowed: true,
      updateEntitlement: true
    });
  });

  it("cannot be mutated by an importer to change future issuance authority", () => {
    const policy = checkoutPolicyFor("neondiff_monthly") as { plan: string };
    const originalPlan = policy.plan;
    try {
      try {
        policy.plan = "caller_controlled_plan";
      } catch (error) {
        assert.ok(error instanceof TypeError);
      }

      const store = new LicenseStore(":memory:", { now: () => NOW });
      try {
        const result = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
        assert.equal(result.httpStatus, 200);
        assert.equal(result.body.entitlement.plan, "monthly_support");
        assert.equal(checkoutPolicyFor("neondiff_monthly").plan, "monthly_support");
      } finally {
        store.close();
      }
    } finally {
      if (policy.plan !== originalPlan) policy.plan = originalPlan;
    }
  });
});

describe("checkout issuance request authority", () => {
  it("requires the issuance reference and complete immutable provider correlation", () => {
    for (const field of [
      "idempotencyKey",
      "checkoutLookupKey",
      "provider",
      "providerAccountId",
      "providerMode",
      "externalSubscriptionId",
      "externalCheckoutId"
    ] as const) {
      const body = { ...request() } as Record<string, unknown>;
      delete body[field];
      assert.throws(() => parseIssuanceRequest(JSON.stringify(body)), new RegExp(`${field} is required`));
    }
  });

  it("rejects caller-controlled expiry, plan, scope, ownership, and unknown fields", () => {
    for (const field of [
      "expiresAt",
      "plan",
      "repoVisibilityScope",
      "privateRepoAllowed",
      "updateEntitlement",
      "customerEmail",
      "externalCustomerId",
      "ownerId",
      "unexpected"
    ]) {
      assert.throws(
        () => parseIssuanceRequest(JSON.stringify({ ...request(), [field]: "caller-value" })),
        new RegExp(`unknown field: ${field}`)
      );
    }
  });

  it("accepts deprecated seats only when it is exactly one", () => {
    assert.equal(parseIssuanceRequest(JSON.stringify({ ...request(), seats: 1 })).seats, 1);
    for (const seats of [0, 2, 1.5, "1", null]) {
      assert.throws(
        () => parseIssuanceRequest(JSON.stringify({ ...request(), seats })),
        /seats is deprecated and must be exactly 1/
      );
    }
  });

  it("accepts only the initial Stripe provider and separated test/live modes", () => {
    assert.throws(
      () => parseIssuanceRequest(JSON.stringify(request({ provider: "caller-provider" }))),
      /provider must be stripe/
    );
    assert.throws(
      () => parseIssuanceRequest(JSON.stringify(request({ providerMode: "production" }))),
      /providerMode must be test or live/
    );
  });
});

describe("atomic bound checkout issuance", () => {
  for (const [field, value] of [
    ["plan", "caller_plan"],
    ["repoVisibilityScope", "public"],
    ["privateRepoAllowed", false],
    ["updateEntitlement", false],
    ["seats", 50],
    ["expiresAt", "2099-01-01T00:00:00.000Z"],
    ["requestHash", "caller-request-hash"],
    ["externalRef", "caller-external-reference"],
    ["source", "admin"]
  ] as const) {
    it(`rejects direct-store caller authority over ${field}`, () => {
      const store = new LicenseStore(":memory:", { now: () => NOW });
      const req = request({ idempotencyKey: `checkout-session:direct-${field}` });
      try {
        assert.throws(
          () =>
            store.issueBoundCheckoutLicense(
              derivedKey(req.idempotencyKey),
              directBoundInput(req, { [field]: value }) as any
            ),
          new RegExp(`unsupported bound checkout field: ${field}`)
        );
        assert.equal(store.listLicenses().length, 0);
      } finally {
        store.close();
      }
    });
  }

  it("uses only the injected store clock when a direct caller passes a far-future date", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    const req = request({ idempotencyKey: "checkout-session:clock-bypass" });
    try {
      const issueWithBypass = store.issueBoundCheckoutLicense.bind(store) as (
        rawKey: string,
        input: Record<string, unknown>,
        issuedAt: Date
      ) => ReturnType<LicenseStore["issueBoundCheckoutLicense"]>;
      const issued = issueWithBypass(
        derivedKey(req.idempotencyKey),
        directBoundInput(req),
        new Date("2099-01-01T00:00:00.000Z")
      );

      assert.equal(issued.record.expiresAt, "2026-07-20T00:00:00.000Z");
    } finally {
      store.close();
    }
  });

  for (const [name, bindingOverride, expected] of [
    ["provider bypass", { provider: "paypal" }, /provider must be stripe/],
    ["mode bypass", { providerMode: "production" }, /providerMode must be test or live/],
    ["empty provider account", { providerAccountId: "   " }, /providerAccountId is required/],
    ["empty subscription id", { externalSubscriptionId: "" }, /externalSubscriptionId is required/],
    ["empty checkout id", { externalCheckoutId: "\t" }, /externalCheckoutId is required/],
    ["oversized provider account", { providerAccountId: "a".repeat(161) }, /providerAccountId is too long/],
    ["oversized subscription id", { externalSubscriptionId: "s".repeat(161) }, /externalSubscriptionId is too long/],
    ["oversized checkout id", { externalCheckoutId: "c".repeat(161) }, /externalCheckoutId is too long/]
  ] as const) {
    it(`rejects direct-store ${name}`, () => {
      const store = new LicenseStore(":memory:", { now: () => NOW });
      const req = request({ idempotencyKey: `checkout-session:binding-${name.replaceAll(" ", "-")}` });
      const input = directBoundInput(req);
      input.binding = { ...(input.binding as Record<string, unknown>), ...bindingOverride };
      try {
        assert.throws(
          () =>
            store.issueBoundCheckoutLicense(
              derivedKey(req.idempotencyKey),
              input as any
            ),
          expected
        );
        assert.equal(store.listLicenses().length, 0);
      } finally {
        store.close();
      }
    });
  }

  for (const [name, inputOverride, expected] of [
    ["empty issuance reference", { idempotencyKey: "   " }, /idempotencyKey is required/],
    [
      "oversized issuance reference",
      { idempotencyKey: "a".repeat(201) },
      /idempotencyKey is too long/
    ],
    [
      "invalid issuance reference characters",
      { idempotencyKey: "checkout/session" },
      /idempotencyKey contains unsupported characters/
    ],
    ["empty lookup key", { checkoutLookupKey: "" }, /checkoutLookupKey is required/],
    [
      "oversized lookup key",
      { checkoutLookupKey: "x".repeat(81) },
      /checkoutLookupKey is too long/
    ],
    [
      "unknown lookup key",
      { checkoutLookupKey: "neondiff_lifetime" },
      /checkoutLookupKey must be one of/
    ]
  ] as const) {
    it(`rejects direct-store ${name} with a policy error before persistence`, () => {
      const store = new LicenseStore(":memory:", { now: () => NOW });
      const req = request({ idempotencyKey: `checkout-session:direct-${name.replaceAll(" ", "-")}` });
      try {
        assert.throws(
          () =>
            store.issueBoundCheckoutLicense(
              derivedKey(req.idempotencyKey),
              directBoundInput(req, inputOverride) as any
            ),
          (error: unknown) =>
            error instanceof CheckoutIssuancePolicyError && expected.test(error.message)
        );
        assert.equal(store.listLicenses().length, 0);
      } finally {
        store.close();
      }
    });
  }

  it("derives plan, one seat, and initial expiry from policy and the injected clock", () => {
    const cases = [
      ["neondiff_monthly", "monthly_support", "2026-07-20T00:00:00.000Z"],
      ["neondiff_yearly", "yearly_support", "2026-07-20T00:00:00.000Z"],
      ["neondiff_org_yearly", "org_yearly_support", "2026-08-12T00:00:00.000Z"]
    ] as const;

    for (const [checkoutLookupKey, plan, expiresAt] of cases) {
      const store = new LicenseStore(":memory:", { now: () => NOW });
      try {
        const result = issueCheckoutLicense(
          store,
          request({
            idempotencyKey: `checkout-session:${checkoutLookupKey}`,
            checkoutLookupKey,
            externalSubscriptionId: `sub_${checkoutLookupKey}`,
            externalCheckoutId: `cs_${checkoutLookupKey}`
          }),
          ISSUANCE_SECRET
        );
        assert.equal(result.httpStatus, 200);
        const body = result.body as { licenseKey: string; entitlement: Record<string, unknown> };
        assert.equal(body.entitlement.plan, plan);
        assert.equal(body.entitlement.seats, 1);
        assert.equal(body.entitlement.expiresAt, expiresAt);
        const record = store.getLicenseByKey(body.licenseKey);
        assert.ok(record);
        assert.equal(record.plan, plan);
        assert.equal(record.seats, 1);
        assert.equal(record.expiresAt, expiresAt);
      } finally {
        store.close();
      }
    }
  });

  it("replays only an exact bound request without minting a second license", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const first = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      const second = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      assert.equal(first.httpStatus, 200);
      assert.equal(second.httpStatus, 200);
      assert.equal(second.body.replayed, true);
      assert.equal(second.body.licenseKey, first.body.licenseKey);
      assert.equal(store.listLicenses().length, 1);

      const conflict = issueCheckoutLicense(
        store,
        request({ externalCheckoutId: "cs_changed" }),
        ISSUANCE_SECRET
      );
      assert.equal(conflict.httpStatus, 409);
      assert.equal(conflict.body.status, "conflict");
    } finally {
      store.close();
    }
  });

  it("conflicts instead of presenting an admin-revoked checkout key as active", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const first = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      assert.equal(first.httpStatus, 200);
      assert.equal(store.revokeLicense(first.body.licenseKey as string, "owner revoked"), true);

      const replay = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      assert.equal(replay.httpStatus, 409);
      assert.equal(replay.body.status, "conflict");
      assert.ok(!JSON.stringify(replay.body).includes('"status":"active"'));
      assert.equal(store.listLicenses().length, 1);
    } finally {
      store.close();
    }
  });

  it("conflicts instead of presenting an effectively expired checkout key as active", () => {
    let currentTime = NOW;
    const store = new LicenseStore(":memory:", { now: () => currentTime });
    try {
      const first = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      assert.equal(first.httpStatus, 200);
      currentTime = new Date("2026-07-21T00:00:00.000Z");

      const replay = issueCheckoutLicense(store, request(), ISSUANCE_SECRET);
      assert.equal(replay.httpStatus, 409);
      assert.equal(replay.body.status, "conflict");
      assert.ok(!JSON.stringify(replay.body).includes('"status":"active"'));
      assert.equal(store.listLicenses().length, 1);
    } finally {
      store.close();
    }
  });

  it("quarantines an unbound legacy checkout replay", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const idempotencyKey = "checkout-session:legacy-unbound";
      store.issueIdempotentLicense(derivedKey(idempotencyKey), {
        idempotencyKey,
        requestHash: "legacy-request-hash",
        source: "checkout",
        externalRef: "cs_legacy",
        plan: "monthly_support",
        repoVisibilityScope: "private",
        privateRepoAllowed: true,
        updateEntitlement: true,
        seats: 1
      });
      const result = issueCheckoutLicense(
        store,
        request({ idempotencyKey, externalCheckoutId: "cs_legacy" }),
        ISSUANCE_SECRET
      );
      assert.equal(result.httpStatus, 409);
      assert.equal(result.body.status, "conflict");
      assert.ok(!JSON.stringify(result.body).includes(derivedKey(idempotencyKey)));
    } finally {
      store.close();
    }
  });

  it("quarantines a bound multi-seat checkout replay", () => {
    const directory = mkdtempSync(join(tmpdir(), "neondiff-multi-seat-replay-"));
    const databasePath = join(directory, "licenses.sqlite");
    const req = request({ idempotencyKey: "checkout-session:legacy-multi-seat" });
    let store = new LicenseStore(databasePath);
    try {
      const issued = store.issueIdempotentLicense(derivedKey(req.idempotencyKey), {
        idempotencyKey: req.idempotencyKey,
        requestHash: "legacy-multi-seat-hash",
        source: "checkout",
        externalRef: req.externalCheckoutId,
        plan: "org_yearly_support",
        repoVisibilityScope: "private",
        privateRepoAllowed: true,
        updateEntitlement: true,
        seats: 3
      });
      store.close();
      const database = new DatabaseSync(databasePath);
      database
        .prepare(
          `insert into checkout_subscription_bindings (
            issuance_idempotency_key, license_key_hash, provider, provider_account_id,
            provider_mode, external_subscription_id, external_checkout_id
          ) values (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          req.idempotencyKey,
          issued.record.licenseKeyHash,
          req.provider,
          req.providerAccountId,
          req.providerMode,
          req.externalSubscriptionId,
          req.externalCheckoutId
        );
      database.close();
      store = new LicenseStore(databasePath);
      const result = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      assert.equal(result.httpStatus, 409);
      assert.equal(result.body.status, "conflict");
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back license and issuance rows when immutable binding insertion conflicts", () => {
    const store = new LicenseStore(":memory:", { now: () => NOW });
    try {
      const first = issueCheckoutLicense(
        store,
        request({ idempotencyKey: "checkout-session:tuple-owner" }),
        ISSUANCE_SECRET
      );
      assert.equal(first.httpStatus, 200);

      const conflicted = issueCheckoutLicense(
        store,
        request({
          idempotencyKey: "checkout-session:tuple-conflict",
          externalCheckoutId: "cs_tuple_conflict"
        }),
        ISSUANCE_SECRET
      );
      assert.equal(conflicted.httpStatus, 409);
      assert.equal(store.listLicenses().length, 1);

      const recovered = issueCheckoutLicense(
        store,
        request({
          idempotencyKey: "checkout-session:tuple-conflict",
          externalSubscriptionId: "sub_unique_after_rollback",
          externalCheckoutId: "cs_tuple_conflict"
        }),
        ISSUANCE_SECRET
      );
      assert.equal(recovered.httpStatus, 200);
      assert.equal(store.listLicenses().length, 2);
    } finally {
      store.close();
    }
  });
});

describe("bound checkout issuance lock contention", () => {
  it("returns a bounded transient result and then converges on exact replay after lock release", () => {
    const directory = mkdtempSync(join(tmpdir(), "neondiff-checkout-lock-replay-"));
    const databasePath = join(directory, "licenses.sqlite");
    const store = new LicenseStore(databasePath, { busyTimeoutMs: 25, now: () => NOW });
    const blocker = new DatabaseSync(databasePath);
    const req = request({ idempotencyKey: "checkout-session:locked-exact-replay" });
    try {
      blocker.exec("begin immediate");
      const startedAt = Date.now();
      const unavailable = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(unavailable.httpStatus, 503);
      assert.deepEqual(unavailable.body, {
        status: "unavailable",
        detail: "license issuance temporarily unavailable"
      });
      assert.ok(elapsedMs >= 10 && elapsedMs < 1_000, `bounded wait was ${elapsedMs}ms`);
      assert.equal(store.listLicenses().length, 0);

      blocker.exec("rollback");
      const issued = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      const replayed = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      assert.equal(issued.httpStatus, 200);
      assert.equal(replayed.httpStatus, 200);
      assert.equal(replayed.body.replayed, true);
      assert.equal(replayed.body.licenseKey, issued.body.licenseKey);
      assert.equal(store.listLicenses().length, 1);
    } finally {
      try {
        blocker.exec("rollback");
      } catch {}
      blocker.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("returns a bounded transient result and then a deterministic conflict after lock release", () => {
    const directory = mkdtempSync(join(tmpdir(), "neondiff-checkout-lock-conflict-"));
    const databasePath = join(directory, "licenses.sqlite");
    const store = new LicenseStore(databasePath, { busyTimeoutMs: 25, now: () => NOW });
    const blocker = new DatabaseSync(databasePath);
    const req = request({ idempotencyKey: "checkout-session:locked-conflict" });
    try {
      const issued = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      assert.equal(issued.httpStatus, 200);

      blocker.exec("begin immediate");
      const changed = request({
        idempotencyKey: req.idempotencyKey,
        externalCheckoutId: "cs_changed_after_lock"
      });
      const startedAt = Date.now();
      const unavailable = issueCheckoutLicense(store, changed, ISSUANCE_SECRET);
      const elapsedMs = Date.now() - startedAt;
      assert.equal(unavailable.httpStatus, 503);
      assert.ok(elapsedMs >= 10 && elapsedMs < 1_000, `bounded wait was ${elapsedMs}ms`);

      blocker.exec("rollback");
      const conflict = issueCheckoutLicense(store, changed, ISSUANCE_SECRET);
      const replayed = issueCheckoutLicense(store, req, ISSUANCE_SECRET);
      assert.equal(conflict.httpStatus, 409);
      assert.equal(replayed.httpStatus, 200);
      assert.equal(replayed.body.replayed, true);
      assert.equal(store.listLicenses().length, 1);
    } finally {
      try {
        blocker.exec("rollback");
      } catch {}
      blocker.close();
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
