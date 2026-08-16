import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import Stripe from "stripe";
import { startLicenseServer } from "../src/http.ts";
import { LicenseStore } from "../src/store.ts";
import type {
  StripeCheckoutGateway,
  StripeCheckoutRuntime
} from "../src/stripe-checkout.ts";

const WEBHOOK_SECRET = "whsec_test_neondiff_checkout";
const LICENSE_DERIVATION_SECRET = "test-only-license-derivation-secret";
const ALLOWED_ORIGIN = "https://www.neondiff.com";
const EVENT_ID = "evt_neondiff_checkout_1";
const SESSION_ID = "cs_live_neondiff_checkout_1";
const SUBSCRIPTION_ID = "sub_neondiff_checkout_1";
const CUSTOMER_ID = "cus_neondiff_checkout_1";
const TOKEN = "A".repeat(48);
const TOKEN_HASH = createHash("sha256").update(TOKEN).digest("hex");
const RENEWAL_PERIOD_END = Math.floor(
  Date.parse("2026-08-30T00:00:00.000Z") / 1_000
);
const stripeVerifier = new Stripe("sk_test_not_used_for_network", {
  apiVersion: "2026-06-24.dahlia"
});

function eventPayload(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    id: EVENT_ID,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_785_400_000,
    livemode: true,
    type: "checkout.session.completed",
    data: {
      object: {
        id: SESSION_ID,
        object: "checkout.session",
        livemode: true,
        mode: "subscription",
        status: "complete",
        payment_status: "paid",
        customer: CUSTOMER_ID,
        subscription: SUBSCRIPTION_ID,
        metadata: {
          priceLookupKey: "neondiff_monthly",
          fulfillmentTokenHash: TOKEN_HASH
        }
      }
    },
    ...overrides
  });
}

function signatureFor(payload: string): string {
  return stripeVerifier.webhooks.generateTestHeaderString({
    payload,
    secret: WEBHOOK_SECRET
  });
}

function lifecycleEventPayload(
  type: string,
  object: Record<string, unknown>,
  id: string
): string {
  return JSON.stringify({
    id,
    object: "event",
    api_version: "2026-06-24.dahlia",
    created: 1_785_384_000,
    livemode: true,
    type,
    data: { object }
  });
}

function snapshots(overrides: {
  accountId?: string;
  priceId?: string;
  productId?: string;
  subscriptionStatus?: string;
  cancelAtPeriodEnd?: boolean;
} = {}) {
  const accountId = overrides.accountId ?? "acct_neondiff_live";
  const priceId = overrides.priceId ?? "price_neondiff_monthly";
  const productId = overrides.productId ?? "prod_neondiff";
  return {
    account: { id: accountId },
    session: {
      id: SESSION_ID,
      livemode: true,
      mode: "subscription",
      status: "complete",
      payment_status: "paid",
      customer: CUSTOMER_ID,
      subscription: SUBSCRIPTION_ID,
      metadata: {
        priceLookupKey: "neondiff_monthly",
        fulfillmentTokenHash: TOKEN_HASH
      },
      line_items: {
        data: [
          {
            quantity: 1,
            price: {
              id: priceId,
              lookup_key: "neondiff_monthly",
              currency: "usd",
              type: "recurring",
              product: productId
            }
          }
        ]
      }
    },
    subscription: {
      id: SUBSCRIPTION_ID,
      customer: CUSTOMER_ID,
      livemode: true,
      status: overrides.subscriptionStatus ?? "trialing",
      cancel_at_period_end: overrides.cancelAtPeriodEnd ?? false,
      metadata: {
        priceLookupKey: "neondiff_monthly",
        fulfillmentTokenHash: TOKEN_HASH
      },
      items: {
        data: [
          {
            quantity: 1,
            current_period_end: RENEWAL_PERIOD_END,
            price: {
              id: priceId,
              lookup_key: "neondiff_monthly",
              currency: "usd",
              type: "recurring",
              product: productId
            }
          }
        ]
      }
    }
  };
}

function gatewayFor(overrides: Parameters<typeof snapshots>[0] = {}): StripeCheckoutGateway {
  const fixture = snapshots(overrides);
  return {
    verifyEvent(rawBody, signature, signingSecret) {
      return stripeVerifier.webhooks.constructEvent(rawBody, signature, signingSecret);
    },
    async retrieveAccount() {
      return fixture.account;
    },
    async retrieveCheckoutSession() {
      return fixture.session;
    },
    async retrieveSubscription() {
      return fixture.subscription;
    }
  };
}

function runtime(gateway = gatewayFor()): StripeCheckoutRuntime {
  return {
    webhookSecret: WEBHOOK_SECRET,
    expectedAccountId: "acct_neondiff_live",
    mode: "live",
    allowedOrigin: ALLOWED_ORIGIN,
    licenseDerivationSecret: LICENSE_DERIVATION_SECRET,
    redemptionTtlMs: 30 * 60 * 1_000,
    allowedPrices: {
      neondiff_monthly: {
        priceId: "price_neondiff_monthly",
        productId: "prod_neondiff"
      },
      neondiff_yearly: {
        priceId: "price_neondiff_yearly",
        productId: "prod_neondiff"
      },
      neondiff_org_yearly: {
        priceId: "price_neondiff_org_yearly",
        productId: "prod_neondiff_org"
      }
    },
    gateway
  };
}

async function postRaw(
  url: string,
  path: string,
  body: string,
  headers: Record<string, string>
) {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers,
    body
  });
  const text = await response.text();
  return {
    status: response.status,
    json: text ? JSON.parse(text) : {},
    headers: response.headers
  };
}

async function withCheckoutServer(
  options: {
    gateway?: StripeCheckoutGateway;
    now?: () => Date;
  },
  run: (context: { store: LicenseStore; url: string }) => Promise<void>
): Promise<void> {
  const now = options.now ?? (() => new Date("2026-07-30T04:00:00.000Z"));
  const isolatedStore = new LicenseStore(":memory:", { now });
  const started = await startLicenseServer({
    store: isolatedStore,
    now,
    stripeCheckout: runtime(options.gateway ?? gatewayFor())
  });
  try {
    await run({ store: isolatedStore, url: started.url });
  } finally {
    await new Promise<void>((resolve, reject) => {
      started.server.close((error) => (error ? reject(error) : resolve()));
    });
    isolatedStore.close();
  }
}

async function postWebhook(url: string, payload = eventPayload()) {
  return postRaw(url, "/v1/webhooks/stripe", payload, {
    "Content-Type": "application/json",
    "Stripe-Signature": signatureFor(payload)
  });
}

async function seedCheckout(url: string): Promise<void> {
  const response = await postWebhook(url);
  assert.equal(response.status, 200, JSON.stringify(response.json));
}

describe("direct Stripe checkout fulfillment", () => {
  let store: LicenseStore;
  let server: Server;
  let url: string;

  before(async () => {
    store = new LicenseStore(":memory:", {
      now: () => new Date("2026-07-30T04:00:00.000Z")
    });
    const started = await startLicenseServer({
      store,
      now: () => new Date("2026-07-30T04:00:00.000Z"),
      stripeCheckout: runtime()
    });
    server = started.server;
    url = started.url;
  });

  after(() => {
    server.close();
    store.close();
  });

  it("verifies the raw Stripe event and creates one keyless fulfillment", async () => {
    const payload = eventPayload();
    const response = await postRaw(url, "/v1/webhooks/stripe", payload, {
      "Content-Type": "application/json",
      "Stripe-Signature": signatureFor(payload)
    });

    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.deepEqual(response.json, {
      status: "fulfilled",
      replayed: false
    });
    assert.equal(store.listLicenses().length, 1);
    assert.ok(!JSON.stringify(response.json).includes("nd_live_"));
    assert.ok(!JSON.stringify(response.json).includes(TOKEN));
  });

  it("replays the exact event without a second license", async () => {
    const payload = eventPayload();
    const beforeCount = store.listLicenses().length;
    const response = await postRaw(url, "/v1/webhooks/stripe", payload, {
      "Content-Type": "application/json",
      "Stripe-Signature": signatureFor(payload)
    });

    assert.equal(response.status, 200, JSON.stringify(response.json));
    assert.equal(response.json.replayed, true);
    assert.equal(store.listLicenses().length, beforeCount);
  });

  it("rejects an invalid signature before storage", async () => {
    const payload = eventPayload({ id: "evt_neondiff_invalid_signature" });
    const beforeCount = store.listLicenses().length;
    const response = await postRaw(url, "/v1/webhooks/stripe", payload, {
      "Content-Type": "application/json",
      "Stripe-Signature": "t=1,v1=invalid"
    });

    assert.equal(response.status, 400);
    assert.equal(response.json.status, "invalid");
    assert.equal(store.listLicenses().length, beforeCount);
  });

  it("replays the same deterministic license for an exact redemption retry", async () => {
    const first = await postRaw(
      url,
      "/v1/checkout/redeem",
      JSON.stringify({ sessionId: SESSION_ID, fulfillmentToken: TOKEN }),
      {
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN
      }
    );
    assert.equal(first.status, 200);
    assert.equal(first.json.status, "redeemed");
    assert.match(first.json.licenseKey, /^nd_live_[A-Za-z0-9_-]+$/);
    assert.equal(first.headers.get("cache-control"), "no-store");
    assert.equal(first.headers.get("access-control-allow-origin"), ALLOWED_ORIGIN);

    const replay = await postRaw(
      url,
      "/v1/checkout/redeem",
      JSON.stringify({ sessionId: SESSION_ID, fulfillmentToken: TOKEN }),
      {
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN
      }
    );
    assert.equal(replay.status, 200);
    assert.equal(replay.json.status, "redeemed");
    assert.equal(replay.json.licenseKey, first.json.licenseKey);
    assert.equal(replay.headers.get("cache-control"), "no-store");

    const wrongToken = await postRaw(
      url,
      "/v1/checkout/redeem",
      JSON.stringify({
        sessionId: SESSION_ID,
        fulfillmentToken: "B".repeat(48)
      }),
      {
        "Content-Type": "application/json",
        Origin: ALLOWED_ORIGIN
      }
    );
    assert.equal(wrongToken.status, 404);
    assert.deepEqual(wrongToken.json, { status: "not_found" });
    assert.ok(!JSON.stringify(wrongToken.json).includes(first.json.licenseKey));
  });

  it("maps malformed redemption JSON to a bounded not-found response", async () => {
    const response = await postRaw(url, "/v1/checkout/redeem", "{", {
      "Content-Type": "application/json",
      Origin: ALLOWED_ORIGIN
    });
    assert.equal(response.status, 404);
    assert.deepEqual(response.json, { status: "not_found" });
  });

  it("rejects a non-exact browser origin", async () => {
    const response = await postRaw(
      url,
      "/v1/checkout/redeem",
      JSON.stringify({ sessionId: SESSION_ID, fulfillmentToken: TOKEN }),
      {
        "Content-Type": "application/json",
        Origin: "https://neondiff.com"
      }
    );
    assert.equal(response.status, 403);
    assert.deepEqual(response.json, { status: "forbidden" });
  });
});

describe("direct Stripe checkout validation boundaries", () => {
  it("rejects a Stripe API account mismatch before issuance", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ accountId: "acct_other_live" }) },
      async ({ store, url }) => {
        const response = await postWebhook(url);
        assert.equal(response.status, 400);
        assert.equal(response.json.status, "invalid");
        assert.equal(store.listLicenses().length, 0);
      }
    );
  });

  it("rejects an unapproved price before issuance", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ priceId: "price_unapproved" }) },
      async ({ store, url }) => {
        const response = await postWebhook(url);
        assert.equal(response.status, 400);
        assert.equal(response.json.status, "invalid");
        assert.equal(store.listLicenses().length, 0);
      }
    );
  });

  it("rejects an inactive subscription before issuance", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ subscriptionStatus: "canceled" }) },
      async ({ store, url }) => {
        const response = await postWebhook(url);
        assert.equal(response.status, 400);
        assert.equal(response.json.status, "invalid");
        assert.equal(store.listLicenses().length, 0);
      }
    );
  });

  it("rejects a changed replay of the same Stripe event", async () => {
    await withCheckoutServer({}, async ({ store, url }) => {
      const first = await postWebhook(url);
      assert.equal(first.status, 200);
      const changed = eventPayload({ created: 1_785_400_001 });
      const conflict = await postWebhook(url, changed);
      assert.equal(conflict.status, 409);
      assert.deepEqual(conflict.json, { status: "conflict" });
      assert.equal(store.listLicenses().length, 1);
    });
  });

  it("acknowledges an exact stored replay without depending on another Stripe read", async () => {
    const baseGateway = gatewayFor();
    let upstreamAvailable = true;
    const replayGateway: StripeCheckoutGateway = {
      verifyEvent: (...args) => baseGateway.verifyEvent(...args),
      retrieveAccount: async (...args) => {
        if (!upstreamAvailable) throw new Error("unavailable");
        return baseGateway.retrieveAccount(...args);
      },
      retrieveCheckoutSession: async (...args) => {
        if (!upstreamAvailable) throw new Error("unavailable");
        return baseGateway.retrieveCheckoutSession(...args);
      },
      retrieveSubscription: async (...args) => {
        if (!upstreamAvailable) throw new Error("unavailable");
        return baseGateway.retrieveSubscription(...args);
      }
    };
    await withCheckoutServer({ gateway: replayGateway }, async ({ store, url }) => {
      assert.equal((await postWebhook(url)).status, 200);
      upstreamAvailable = false;
      const replay = await postWebhook(url);
      assert.equal(replay.status, 200);
      assert.deepEqual(replay.json, { status: "fulfilled", replayed: true });
      assert.equal(store.listLicenses().length, 1);
    });
  });

  it("does not consume fulfillment after a wrong token", async () => {
    await withCheckoutServer({}, async ({ url }) => {
      assert.equal((await postWebhook(url)).status, 200);
      const wrong = await postRaw(
        url,
        "/v1/checkout/redeem",
        JSON.stringify({
          sessionId: SESSION_ID,
          fulfillmentToken: "B".repeat(48)
        }),
        {
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN
        }
      );
      assert.equal(wrong.status, 404);
      const correct = await postRaw(
        url,
        "/v1/checkout/redeem",
        JSON.stringify({ sessionId: SESSION_ID, fulfillmentToken: TOKEN }),
        {
          "Content-Type": "application/json",
          Origin: ALLOWED_ORIGIN
        }
      );
      assert.equal(correct.status, 200);
      assert.equal(correct.json.status, "redeemed");
    });
  });

  it("fails closed after the short-lived redemption window", async () => {
    let currentTime = new Date("2026-07-30T04:00:00.000Z");
    await withCheckoutServer(
      { now: () => currentTime },
      async ({ url }) => {
        assert.equal((await postWebhook(url)).status, 200);
        currentTime = new Date("2026-07-30T04:31:00.000Z");
        const expired = await postRaw(
          url,
          "/v1/checkout/redeem",
          JSON.stringify({ sessionId: SESSION_ID, fulfillmentToken: TOKEN }),
          {
            "Content-Type": "application/json",
            Origin: ALLOWED_ORIGIN
          }
        );
        assert.equal(expired.status, 410);
        assert.deepEqual(expired.json, { status: "expired" });
      }
    );
  });
});

describe("direct Stripe subscription lifecycle", () => {
  it("extends the bound entitlement from a paid renewal without returning identifiers", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ subscriptionStatus: "active" }) },
      async ({ store, url }) => {
        await seedCheckout(url);
        const payload = lifecycleEventPayload(
          "invoice.paid",
          {
            id: "in_neondiff_renewal_1",
            object: "invoice",
            livemode: true,
            subscription: SUBSCRIPTION_ID,
            amount_paid: 100,
            currency: "usd",
            paid_out_of_band: false,
            billing_reason: "subscription_cycle",
            lines: {
              data: [
                {
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: {
                      subscription: SUBSCRIPTION_ID
                    }
                  },
                  period: { end: RENEWAL_PERIOD_END }
                }
              ]
            }
          },
          "evt_neondiff_renewal_1"
        );

        const response = await postWebhook(url, payload);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.deepEqual(response.json, { status: "updated", replayed: false });
        assert.equal(store.listLicenses()[0]?.expiresAt, "2026-08-30T00:00:00.000Z");
        const serialized = JSON.stringify(response.json);
        assert.ok(!serialized.includes("nd_live_"));
        assert.ok(!serialized.includes("in_neondiff"));
        assert.ok(!serialized.includes(SUBSCRIPTION_ID));
        assert.ok(!serialized.includes(CUSTOMER_ID));

        const replay = await postWebhook(url, payload);
        assert.equal(replay.status, 200, JSON.stringify(replay.json));
        assert.deepEqual(replay.json, { status: "replayed", replayed: true });
        assert.equal(store.listLicenses().length, 1);

        const changed = lifecycleEventPayload(
          "invoice.paid",
          {
            id: "in_neondiff_renewal_1",
            object: "invoice",
            livemode: true,
            subscription: SUBSCRIPTION_ID,
            amount_paid: 200,
            currency: "usd",
            paid_out_of_band: false,
            billing_reason: "subscription_cycle",
            lines: {
              data: [
                {
                  parent: {
                    type: "subscription_item_details",
                    subscription_item_details: {
                      subscription: SUBSCRIPTION_ID
                    }
                  },
                  period: { end: RENEWAL_PERIOD_END }
                }
              ]
            }
          },
          "evt_neondiff_renewal_1"
        );
        const conflict = await postWebhook(url, changed);
        assert.equal(conflict.status, 409);
        assert.deepEqual(conflict.json, { status: "conflict" });
      }
    );
  });

  it("records a failed payment without revoking or shortening the entitlement", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ subscriptionStatus: "active" }) },
      async ({ store, url }) => {
        await seedCheckout(url);
        const before = store.listLicenses()[0];
        const payload = lifecycleEventPayload(
          "invoice.payment_failed",
          {
            id: "in_neondiff_failed_1",
            object: "invoice",
            livemode: true,
            subscription: SUBSCRIPTION_ID
          },
          "evt_neondiff_failed_1"
        );

        const response = await postWebhook(url, payload);
        assert.equal(response.status, 200, JSON.stringify(response.json));
        assert.deepEqual(response.json, {
          status: "payment_attention",
          replayed: false
        });
        const after = store.listLicenses()[0];
        assert.equal(after?.status, "active");
        assert.equal(after?.expiresAt, before?.expiresAt);
      }
    );
  });

  it("terminally revokes the bound entitlement from a deleted subscription", async () => {
    await withCheckoutServer({}, async ({ store, url }) => {
      await seedCheckout(url);
      const payload = lifecycleEventPayload(
        "customer.subscription.deleted",
        {
          id: SUBSCRIPTION_ID,
          object: "subscription",
          livemode: true,
          status: "canceled",
          cancel_at_period_end: false,
          items: {
            data: [{ current_period_end: RENEWAL_PERIOD_END }]
          }
        },
        "evt_neondiff_deleted_1"
      );

      const response = await postWebhook(url, payload);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.deepEqual(response.json, {
        status: "terminally_revoked",
        replayed: false
      });
      assert.equal(store.listLicenses()[0]?.status, "revoked");
      assert.equal(
        store.listLicenses()[0]?.revocationReason,
        "subscription_canceled"
      );
    });
  });

  it("records scheduled cancellation without shortening the paid entitlement", async () => {
    await withCheckoutServer({}, async ({ store, url }) => {
      await seedCheckout(url);
      const before = store.listLicenses()[0];
      const payload = lifecycleEventPayload(
        "customer.subscription.updated",
        {
          id: SUBSCRIPTION_ID,
          object: "subscription",
          livemode: true,
          status: "active",
          cancel_at_period_end: true,
          items: {
            data: [{ current_period_end: RENEWAL_PERIOD_END }]
          }
        },
        "evt_neondiff_cancel_scheduled_1"
      );

      const response = await postWebhook(url, payload);
      assert.equal(response.status, 200, JSON.stringify(response.json));
      assert.deepEqual(response.json, { status: "updated", replayed: false });
      const after = store.listLicenses()[0];
      assert.equal(after?.status, "active");
      assert.equal(after?.expiresAt, before?.expiresAt);
    });
  });

  it("does not mutate a license for an unbound subscription", async () => {
    await withCheckoutServer(
      { gateway: gatewayFor({ subscriptionStatus: "active" }) },
      async ({ store, url }) => {
        await seedCheckout(url);
        const before = store.listLicenses()[0];
        const payload = lifecycleEventPayload(
          "customer.subscription.updated",
          {
            id: "sub_neondiff_unbound",
            object: "subscription",
            livemode: true,
            status: "active",
            cancel_at_period_end: false,
            items: {
              data: [{ current_period_end: RENEWAL_PERIOD_END }]
            }
          },
          "evt_neondiff_unbound_1"
        );

        const response = await postWebhook(url, payload);
        assert.notEqual(response.status, 200);
        assert.deepEqual(store.listLicenses()[0], before);
      }
    );
  });
});
