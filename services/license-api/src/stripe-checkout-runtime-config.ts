import {
  createStripeCheckoutGateway,
  type StripeCheckoutGateway,
  type StripeCheckoutRuntime
} from "./stripe-checkout.js";

export type StripeCheckoutRuntimeConfigResult =
  | { status: "disabled" }
  | { status: "invalid"; setting: string; reason: "missing" | "invalid" }
  | { status: "ready"; runtime: StripeCheckoutRuntime };

const REQUIRED = [
  "STRIPE_RESTRICTED_API_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_ACCOUNT_ID",
  "STRIPE_PROVIDER_MODE",
  "NEONDIFF_STRIPE_REDEMPTION_ORIGIN",
  "NEONDIFF_STRIPE_MONTHLY_PRICE_ID",
  "NEONDIFF_STRIPE_MONTHLY_PRODUCT_ID",
  "NEONDIFF_STRIPE_YEARLY_PRICE_ID",
  "NEONDIFF_STRIPE_YEARLY_PRODUCT_ID",
  "NEONDIFF_STRIPE_ORG_YEARLY_PRICE_ID",
  "NEONDIFF_STRIPE_ORG_YEARLY_PRODUCT_ID",
  "NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET"
] as const;

export function loadStripeCheckoutRuntimeConfig(
  env: NodeJS.ProcessEnv,
  gatewayFactory: (apiKey: string) => StripeCheckoutGateway = createStripeCheckoutGateway
): StripeCheckoutRuntimeConfigResult {
  const enabled = env.NEONDIFF_STRIPE_CHECKOUT_ENABLED?.trim();
  if (!enabled) return { status: "disabled" };
  if (enabled !== "true") {
    return {
      status: "invalid",
      setting: "NEONDIFF_STRIPE_CHECKOUT_ENABLED",
      reason: "invalid"
    };
  }
  for (const setting of REQUIRED) {
    if (!env[setting]?.trim()) return { status: "invalid", setting, reason: "missing" };
    if (env[setting] !== env[setting]?.trim()) {
      return { status: "invalid", setting, reason: "invalid" };
    }
  }

  const mode = env.STRIPE_PROVIDER_MODE;
  if (mode !== "live" && mode !== "test") {
    return { status: "invalid", setting: "STRIPE_PROVIDER_MODE", reason: "invalid" };
  }
  const apiKey = env.STRIPE_RESTRICTED_API_KEY!;
  const expectedKeyPrefix = mode === "live" ? "rk_live_" : "rk_test_";
  if (
    !apiKey.startsWith(expectedKeyPrefix) ||
    apiKey.length < expectedKeyPrefix.length + 16 ||
    !/^rk_(?:live|test)_[A-Za-z0-9]+$/.test(apiKey)
  ) {
    return {
      status: "invalid",
      setting: "STRIPE_RESTRICTED_API_KEY",
      reason: "invalid"
    };
  }
  if (!env.STRIPE_WEBHOOK_SECRET!.startsWith("whsec_")) {
    return { status: "invalid", setting: "STRIPE_WEBHOOK_SECRET", reason: "invalid" };
  }
  if (!/^acct_[A-Za-z0-9_]+$/.test(env.STRIPE_ACCOUNT_ID!)) {
    return { status: "invalid", setting: "STRIPE_ACCOUNT_ID", reason: "invalid" };
  }
  let origin: URL;
  try {
    origin = new URL(env.NEONDIFF_STRIPE_REDEMPTION_ORIGIN!);
  } catch {
    return {
      status: "invalid",
      setting: "NEONDIFF_STRIPE_REDEMPTION_ORIGIN",
      reason: "invalid"
    };
  }
  if (
    origin.protocol !== "https:" ||
    origin.origin !== env.NEONDIFF_STRIPE_REDEMPTION_ORIGIN ||
    origin.pathname !== "/" ||
    origin.search ||
    origin.hash ||
    origin.username ||
    origin.password
  ) {
    return {
      status: "invalid",
      setting: "NEONDIFF_STRIPE_REDEMPTION_ORIGIN",
      reason: "invalid"
    };
  }
  if (env.NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET!.length < 24) {
    return {
      status: "invalid",
      setting: "NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET",
      reason: "invalid"
    };
  }

  const idSettings: Array<[string, string, string]> = [
    ["NEONDIFF_STRIPE_MONTHLY_PRICE_ID", env.NEONDIFF_STRIPE_MONTHLY_PRICE_ID!, "price_"],
    ["NEONDIFF_STRIPE_MONTHLY_PRODUCT_ID", env.NEONDIFF_STRIPE_MONTHLY_PRODUCT_ID!, "prod_"],
    ["NEONDIFF_STRIPE_YEARLY_PRICE_ID", env.NEONDIFF_STRIPE_YEARLY_PRICE_ID!, "price_"],
    ["NEONDIFF_STRIPE_YEARLY_PRODUCT_ID", env.NEONDIFF_STRIPE_YEARLY_PRODUCT_ID!, "prod_"],
    ["NEONDIFF_STRIPE_ORG_YEARLY_PRICE_ID", env.NEONDIFF_STRIPE_ORG_YEARLY_PRICE_ID!, "price_"],
    ["NEONDIFF_STRIPE_ORG_YEARLY_PRODUCT_ID", env.NEONDIFF_STRIPE_ORG_YEARLY_PRODUCT_ID!, "prod_"]
  ];
  for (const [setting, value, prefix] of idSettings) {
    if (!value.startsWith(prefix) || !/^[A-Za-z0-9_]+$/.test(value)) {
      return { status: "invalid", setting, reason: "invalid" };
    }
  }

  return {
    status: "ready",
    runtime: {
      webhookSecret: env.STRIPE_WEBHOOK_SECRET!,
      expectedAccountId: env.STRIPE_ACCOUNT_ID!,
      mode,
      allowedOrigin: env.NEONDIFF_STRIPE_REDEMPTION_ORIGIN!,
      licenseDerivationSecret: env.NEONDIFF_CHECKOUT_LICENSE_DERIVATION_SECRET!,
      allowedPrices: {
        neondiff_monthly: {
          priceId: env.NEONDIFF_STRIPE_MONTHLY_PRICE_ID!,
          productId: env.NEONDIFF_STRIPE_MONTHLY_PRODUCT_ID!
        },
        neondiff_yearly: {
          priceId: env.NEONDIFF_STRIPE_YEARLY_PRICE_ID!,
          productId: env.NEONDIFF_STRIPE_YEARLY_PRODUCT_ID!
        },
        neondiff_org_yearly: {
          priceId: env.NEONDIFF_STRIPE_ORG_YEARLY_PRICE_ID!,
          productId: env.NEONDIFF_STRIPE_ORG_YEARLY_PRODUCT_ID!
        }
      },
      gateway: gatewayFactory(apiKey)
    }
  };
}
