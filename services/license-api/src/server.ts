import { LicenseStore } from "./store.js";
import { startLicenseServer } from "./http.js";
import { createGitHubActionsOidcVerifier } from "./oidc-lifecycle.js";
import { RateLimiter } from "./service.js";
import { loadGitHubBrokerRuntimeConfig } from "./github-broker/runtime-config.js";
import { createLicenseStoreEntitlementResolver } from "./github-broker/license-entitlement.js";
import { loadAccountLinkRuntimeConfig } from "./account-link/runtime-config.js";
import { loadStripeCheckoutRuntimeConfig } from "./stripe-checkout-runtime-config.js";

/**
 * Production entrypoint. SQLite lives on a mounted volume in deploy
 * (LICENSE_DB_PATH); PORT/HOST come from the platform. TLS is terminated by
 * fly, so the process serves plain HTTP on the internal port.
 */
async function main(): Promise<void> {
  const dbPath = process.env.LICENSE_DB_PATH ?? "runtime/license.sqlite";
  const port = Number(process.env.PORT ?? 8080);
  const host = process.env.HOST ?? "0.0.0.0";
  // Fly injects FLY_APP_NAME into Machines. Outside that operator-controlled
  // runtime, request-supplied Fly headers are untrusted and ignored.
  const trustFlyProxyHeaders = Boolean(process.env.FLY_APP_NAME?.trim());
  const store = new LicenseStore(dbPath);
  const githubBrokerRuntime = loadGitHubBrokerRuntimeConfig(process.env, dbPath);
  const accountLinkRuntime = loadAccountLinkRuntimeConfig(process.env, dbPath);
  const stripeCheckoutRuntime = loadStripeCheckoutRuntimeConfig(process.env);
  if (githubBrokerRuntime.status === "invalid") {
    // Setting name + fixed reason are public-safe. Never log the submitted value.
    // The license API remains available while every broker route fails closed
    // with the existing typed `broker_unavailable` response.
    // eslint-disable-next-line no-console
    console.error(
      `github broker unavailable: ${githubBrokerRuntime.setting} ${githubBrokerRuntime.reason}`
    );
  }
  if (accountLinkRuntime.status === "invalid") {
    // Setting name + fixed reason only; never log Supabase keys or submitted values.
    // eslint-disable-next-line no-console
    console.error(
      `account link unavailable: ${accountLinkRuntime.setting} ${accountLinkRuntime.reason}`
    );
  }
  if (stripeCheckoutRuntime.status === "invalid") {
    // Setting name + fixed reason only; never log Stripe keys, signing secrets,
    // price IDs, or submitted values.
    // eslint-disable-next-line no-console
    console.error(
      `Stripe checkout unavailable: ${stripeCheckoutRuntime.setting} ${stripeCheckoutRuntime.reason}`
    );
  }
  const { url } = await startLicenseServer({
    store,
    port,
    host,
    issuanceSecret: process.env.LICENSE_ISSUANCE_SECRET,
    trustFlyProxyHeaders,
    subscriptionLifecycleRateLimiter: new RateLimiter({
      maxPerWindow: 60,
      windowMs: 60_000
    }),
    lifecycleOidcVerifier: createGitHubActionsOidcVerifier(),
    ...(accountLinkRuntime.status === "ready"
      ? { accountLink: accountLinkRuntime.deps }
      : {}),
    ...(githubBrokerRuntime.status === "ready"
      ? {
          githubBroker: {
            ...githubBrokerRuntime.deps,
            resolveEntitlement: createLicenseStoreEntitlementResolver(store)
          }
        }
      : {}),
    ...(stripeCheckoutRuntime.status === "ready"
      ? { stripeCheckout: stripeCheckoutRuntime.runtime }
      : {})
  });
  // eslint-disable-next-line no-console
  console.log(`license-api listening on ${url} (db=${dbPath})`);
}

main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error(`license-api failed to start: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
