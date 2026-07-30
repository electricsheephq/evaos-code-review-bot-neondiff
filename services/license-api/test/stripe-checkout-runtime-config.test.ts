import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadStripeCheckoutRuntimeConfig } from "../src/stripe-checkout-runtime-config.ts";

function validEnv(): NodeJS.ProcessEnv {
  return {
    NEONDIFF_STRIPE_CHECKOUT_ENABLED: "true",
    STRIPE_RESTRICTED_API_KEY: `rk_live_${"a".repeat(32)}`,
    STRIPE_WEBHOOK_SECRET: `whsec_${"b".repeat(32)}`,
    STRIPE_ACCOUNT_ID: "acct_neondiff_live",
    STRIPE_PROVIDER_MODE: "live",
    NEONDIFF_STRIPE_REDEMPTION_ORIGIN: "https://www.neondiff.com",
    NEONDIFF_STRIPE_MONTHLY_PRICE_ID: "price_neondiff_monthly",
    NEONDIFF_STRIPE_MONTHLY_PRODUCT_ID: "prod_neondiff",
    NEONDIFF_STRIPE_YEARLY_PRICE_ID: "price_neondiff_yearly",
    NEONDIFF_STRIPE_YEARLY_PRODUCT_ID: "prod_neondiff",
    NEONDIFF_STRIPE_ORG_YEARLY_PRICE_ID: "price_neondiff_org_yearly",
    NEONDIFF_STRIPE_ORG_YEARLY_PRODUCT_ID: "prod_neondiff_org",
    NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET:
      "test-only-license-derivation-secret"
  };
}

describe("Stripe checkout runtime config", () => {
  it("is disabled unless the exact enable marker is present", () => {
    assert.deepEqual(loadStripeCheckoutRuntimeConfig({}, () => ({} as never)), {
      status: "disabled"
    });
  });

  it("returns only a setting name and fixed reason for incomplete config", () => {
    const env = validEnv();
    delete env.STRIPE_WEBHOOK_SECRET;
    assert.deepEqual(loadStripeCheckoutRuntimeConfig(env, () => ({} as never)), {
      status: "invalid",
      setting: "STRIPE_WEBHOOK_SECRET",
      reason: "missing"
    });
  });

  it("rejects a full-access secret key in the restricted-key slot", () => {
    const env = validEnv();
    env.STRIPE_RESTRICTED_API_KEY = `sk_live_${"a".repeat(32)}`;
    assert.deepEqual(loadStripeCheckoutRuntimeConfig(env, () => ({} as never)), {
      status: "invalid",
      setting: "STRIPE_RESTRICTED_API_KEY",
      reason: "invalid"
    });
  });

  it("rejects a malformed restricted key and a shared-secret-shaped derivation value", () => {
    const malformedKey = validEnv();
    malformedKey.STRIPE_RESTRICTED_API_KEY = "rk_live_short";
    assert.deepEqual(
      loadStripeCheckoutRuntimeConfig(malformedKey, () => ({} as never)),
      {
        status: "invalid",
        setting: "STRIPE_RESTRICTED_API_KEY",
        reason: "invalid"
      }
    );

    const malformedDerivation = validEnv();
    malformedDerivation.NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET =
      "too-short";
    assert.deepEqual(
      loadStripeCheckoutRuntimeConfig(malformedDerivation, () => ({} as never)),
      {
        status: "invalid",
        setting: "NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET",
        reason: "invalid"
      }
    );
  });

  it("composes one ready runtime without exposing the key", () => {
    const env = validEnv();
    let receivedKey = "";
    const result = loadStripeCheckoutRuntimeConfig(env, (apiKey) => {
      receivedKey = apiKey;
      return {
        verifyEvent: () => ({}),
        retrieveAccount: async () => ({}),
        retrieveCheckoutSession: async () => ({}),
        retrieveSubscription: async () => ({})
      };
    });
    assert.equal(result.status, "ready");
    assert.equal(receivedKey, env.STRIPE_RESTRICTED_API_KEY);
    if (result.status === "ready") {
      assert.equal(result.runtime.mode, "live");
      assert.equal(
        result.runtime.allowedPrices.neondiff_monthly?.priceId,
        "price_neondiff_monthly"
      );
      assert.ok(!JSON.stringify(result.runtime).includes(receivedKey));
    }
  });
});
