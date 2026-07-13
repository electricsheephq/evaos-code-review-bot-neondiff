import assert from "node:assert/strict";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import { issueCheckoutLicense, type LicenseIssuanceRequest } from "../src/issuance.ts";
import { startLicenseServer } from "../src/http.ts";
import { RateLimiter } from "../src/service.ts";
import {
  LicenseStore,
  SubscriptionLifecycleTransientError
} from "../src/store.ts";

const NOW = new Date("2026-07-13T00:00:00.000Z");
const NOW_SECONDS = Math.floor(NOW.getTime() / 1_000);
const ISSUANCE_SECRET = "test-only-lifecycle-http-secret";
const AUTH = { Authorization: `Bearer ${ISSUANCE_SECRET}` };

function issuanceRequest(
  overrides: Partial<LicenseIssuanceRequest> = {}
): LicenseIssuanceRequest {
  return {
    idempotencyKey: "checkout-session:lifecycle-http",
    checkoutLookupKey: "neondiff_monthly",
    provider: "stripe",
    providerAccountId: "acct_lifecycle_http",
    providerMode: "live",
    externalSubscriptionId: "sub_lifecycle_http",
    externalCheckoutId: "cs_lifecycle_http",
    ...overrides
  };
}

function lifecycleBody(
  command: "renew_paid" | "reconcile" | "cancel_at_period_end" | "payment_attention" | "revoke" = "renew_paid",
  issuance: LicenseIssuanceRequest = issuanceRequest(),
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  const variants = {
    renew_paid: {
      providerEventType: "invoice.paid",
      subscriptionStatus: "active",
      paymentReference: "in_lifecycle_http_secret_reference",
      amountPaidMinor: 100,
      currency: "usd",
      paidOutOfBand: false,
      billingReason: "subscription_cycle",
      currentPeriodEnd: "2026-08-13T00:00:00.000Z",
      cancelAtPeriodEnd: false
    },
    reconcile: {
      providerEventType: "customer.subscription.updated",
      subscriptionStatus: "active",
      cancelAtPeriodEnd: false
    },
    cancel_at_period_end: {
      providerEventType: "customer.subscription.updated",
      subscriptionStatus: "active",
      currentPeriodEnd: "2026-07-20T00:00:00.000Z",
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
      cancelAtPeriodEnd: false,
      reason: "subscription_canceled"
    }
  } as const;
  return {
    schemaVersion: 1,
    issuanceIdempotencyKey: issuance.idempotencyKey,
    eventId: `evt_${command}_lifecycle_http`,
    eventCreatedAt: NOW_SECONDS,
    provider: issuance.provider,
    providerAccountId: issuance.providerAccountId,
    providerMode: issuance.providerMode,
    externalSubscriptionId: issuance.externalSubscriptionId,
    command,
    ...variants[command],
    ...overrides
  };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; headers: Headers; text: string; json: Record<string, any> }> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) as Record<string, any> : {}
  };
}

async function withLifecycleServer(
  run: (context: {
    store: LicenseStore;
    server: Server;
    url: string;
    issuance: LicenseIssuanceRequest;
    rawKey: string;
  }) => Promise<void>,
  options: {
    store?: LicenseStore;
    now?: () => Date;
    subscriptionLifecycleRateLimiter?: RateLimiter;
    lifecycleRateLimiter?: RateLimiter;
    lifecycleOidcVerifier?: { verify(token: string): Promise<any> };
    trustFlyProxyHeaders?: boolean;
  } = {}
): Promise<void> {
  const now = options.now ?? (() => NOW);
  const store = options.store ?? new LicenseStore(":memory:", { now });
  const issuance = issuanceRequest();
  const issued = issueCheckoutLicense(store, issuance, ISSUANCE_SECRET);
  assert.equal(issued.httpStatus, 200);
  const rawKey = String(issued.body.licenseKey);
  const started = await startLicenseServer({
    store,
    issuanceSecret: ISSUANCE_SECRET,
    now,
    rateLimiter: new RateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
    subscriptionLifecycleRateLimiter: options.subscriptionLifecycleRateLimiter,
    lifecycleRateLimiter: options.lifecycleRateLimiter,
    lifecycleOidcVerifier: options.lifecycleOidcVerifier,
    trustFlyProxyHeaders: options.trustFlyProxyHeaders
  });
  try {
    await run({ store, server: started.server, url: started.url, issuance, rawKey });
  } finally {
    started.server.close();
    store.close();
  }
}

function assertRedactedLifecycleResponse(response: {
  text: string;
  json: Record<string, any>;
}, forbidden: readonly string[] = []): void {
  for (const value of [ISSUANCE_SECRET, ...forbidden]) {
    assert.ok(!response.text.includes(value), `response leaked forbidden value: ${value}`);
  }
  assert.deepEqual(Object.keys(response.json).sort(), ["entitlement", "replayed", "status"]);
  assert.deepEqual(Object.keys(response.json.entitlement).sort(), ["expiresAt", "plan", "seats", "status"]);
}

describe("guarded subscription lifecycle HTTP endpoint", () => {
  it("authenticates before parsing or correlation lookup with one generic 401", async () => {
    await withLifecycleServer(async ({ store, url }) => {
      let applyCalls = 0;
      const original = store.applyCheckoutSubscriptionLifecycle.bind(store);
      store.applyCheckoutSubscriptionLifecycle = ((...args: Parameters<typeof original>) => {
        applyCalls += 1;
        return original(...args);
      }) as typeof store.applyCheckoutSubscriptionLifecycle;
      const secretReference = "checkout-session:does-not-exist-private";
      const malformed = "{not-json-with-private-reference";
      const missing = await post(url, "/v1/admin/licenses/lifecycle", malformed);
      const invalid = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuanceRequest({ idempotencyKey: secretReference })),
        { Authorization: "Bearer wrong-secret-private" }
      );
      assert.equal(missing.status, 401);
      assert.equal(invalid.status, 401);
      assert.deepEqual(missing.json, { status: "unauthorized" });
      assert.deepEqual(invalid.json, missing.json);
      assert.equal(applyCalls, 0);
      assert.ok(!missing.text.includes("not-json"));
      assert.ok(!invalid.text.includes(secretReference));
      assert.ok(!invalid.text.includes("wrong-secret-private"));
    });
  });

  it("accepts an exact 16 KiB body and rejects a larger authenticated body without echo", async () => {
    await withLifecycleServer(async ({ url }) => {
      const base = lifecycleBody("reconcile", issuanceRequest(), { padding: "" });
      const fixedBytes = Buffer.byteLength(JSON.stringify(base));
      const exactBody = JSON.stringify({ ...base, padding: "x".repeat(16 * 1024 - fixedBytes) });
      assert.equal(Buffer.byteLength(exactBody), 16 * 1024);
      const exact = await post(url, "/v1/admin/licenses/lifecycle", exactBody, AUTH);
      assert.equal(exact.status, 400);
      assert.deepEqual(exact.json, { status: "invalid" });

      const marker = "oversized-private-marker";
      const oversized = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        `${exactBody}${marker}`,
        AUTH
      );
      assert.equal(oversized.status, 413);
      assert.deepEqual(oversized.json, { status: "invalid" });
      assert.ok(!oversized.text.includes(marker));
    });
  });

  it("maps applied, replay, stale, attention, cancellation, and revoke results to redacted 200 responses", async () => {
    for (const [command, expectedStatus] of [
      ["renew_paid", "updated"],
      ["reconcile", "updated"],
      ["cancel_at_period_end", "updated"],
      ["payment_attention", "payment_attention"],
      ["revoke", "terminally_revoked"]
    ] as const) {
      await withLifecycleServer(async ({ url, issuance }) => {
        const body = lifecycleBody(command, issuance);
        const response = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
        assert.equal(response.status, 200, command);
        assert.equal(response.json.status, expectedStatus);
        assert.equal(response.json.replayed, false);
        assertRedactedLifecycleResponse(response, [
          body.issuanceIdempotencyKey as string,
          body.eventId as string,
          body.externalSubscriptionId as string,
          "in_lifecycle_http_secret_reference",
          "provider subscription terminated"
        ]);
      });
    }

    await withLifecycleServer(async ({ url, issuance }) => {
      const body = lifecycleBody("renew_paid", issuance);
      assert.equal((await post(url, "/v1/admin/licenses/lifecycle", body, AUTH)).status, 200);
      const replay = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
      assert.equal(replay.status, 200);
      assert.equal(replay.json.status, "replayed");
      assert.equal(replay.json.replayed, true);
      assertRedactedLifecycleResponse(replay, [body.eventId as string]);
    });

    await withLifecycleServer(async ({ url, issuance }) => {
      const newer = lifecycleBody("reconcile", issuance, {
        eventId: "evt_newer_http",
        eventCreatedAt: NOW_SECONDS
      });
      const stale = lifecycleBody("reconcile", issuance, {
        eventId: "evt_stale_http",
        eventCreatedAt: NOW_SECONDS - 1
      });
      assert.equal((await post(url, "/v1/admin/licenses/lifecycle", newer, AUTH)).status, 200);
      const response = await post(url, "/v1/admin/licenses/lifecycle", stale, AUTH);
      assert.equal(response.status, 200);
      assert.equal(response.json.status, "ignored_stale");
      assert.equal(response.json.replayed, false);
      assertRedactedLifecycleResponse(response, [stale.eventId as string]);
    });
  });

  it("maps conflict and terminal outcomes to distinct redacted 409 states", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const first = lifecycleBody("reconcile", issuance, { eventId: "evt_conflict_http" });
      assert.equal((await post(url, "/v1/admin/licenses/lifecycle", first, AUTH)).status, 200);
      const conflict = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        { ...first, subscriptionStatus: "trialing" },
        AUTH
      );
      assert.equal(conflict.status, 409);
      assert.deepEqual(conflict.json, { status: "conflict" });
      assert.ok(!conflict.text.includes("evt_conflict_http"));
    });

    await withLifecycleServer(async ({ url, issuance }) => {
      assert.equal(
        (await post(url, "/v1/admin/licenses/lifecycle", lifecycleBody("revoke", issuance), AUTH)).status,
        200
      );
      const terminal = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance, { eventId: "evt_after_terminal_http" }),
        AUTH
      );
      assert.equal(terminal.status, 409);
      assert.deepEqual(terminal.json, { status: "terminally_revoked" });
      assert.ok(!terminal.text.includes("evt_after_terminal_http"));
    });
  });

  it("replays exact renewals and cancellations after their period ends", async () => {
    for (const command of ["renew_paid", "cancel_at_period_end"] as const) {
      let now = NOW;
      await withLifecycleServer(async ({ url, issuance }) => {
        const body = lifecycleBody(command, issuance, {
          eventId: `evt_delayed_${command}_http`
        });
        assert.equal((await post(url, "/v1/admin/licenses/lifecycle", body, AUTH)).status, 200);

        now = new Date("2026-08-21T00:00:00.000Z");
        const replay = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
        assert.equal(replay.status, 200, command);
        assert.equal(replay.json.status, "replayed", command);
        assert.equal(replay.json.replayed, true, command);
      }, { now: () => now });
    }
  });

  it("preserves conflict detection for changed lifecycle content after expiry", async () => {
    let now = NOW;
    await withLifecycleServer(async ({ url, issuance }) => {
      const original = lifecycleBody("renew_paid", issuance, {
        eventId: "evt_changed_after_expiry_http"
      });
      assert.equal((await post(url, "/v1/admin/licenses/lifecycle", original, AUTH)).status, 200);

      now = new Date("2026-08-21T00:00:00.000Z");
      const conflict = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        { ...original, currentPeriodEnd: "2026-08-14T00:00:00.000Z" },
        AUTH
      );
      assert.equal(conflict.status, 409);
      assert.deepEqual(conflict.json, { status: "conflict" });
    }, { now: () => now });
  });

  it("rejects brand-new elapsed renewals and cancellations without consuming the event ID", async () => {
    for (const command of ["renew_paid", "cancel_at_period_end"] as const) {
      let now = new Date("2026-08-21T00:00:00.000Z");
      await withLifecycleServer(async ({ url, issuance }) => {
        const body = lifecycleBody(command, issuance, {
          eventId: `evt_new_elapsed_${command}_http`
        });
        const rejected = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
        assert.equal(rejected.status, 400, command);
        assert.deepEqual(rejected.json, { status: "invalid" }, command);

        now = NOW;
        const retry = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
        assert.equal(retry.status, 200, command);
        assert.equal(retry.json.status, "updated", command);
        assert.equal(retry.json.replayed, false, command);
      }, { now: () => now });
    }
  });

  it("rejects canceling renewals without consuming the event ID", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const eventId = "evt_canceling_renewal_http";
      const rejected = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance, { eventId, cancelAtPeriodEnd: true }),
        AUTH
      );
      assert.equal(rejected.status, 400);
      assert.deepEqual(rejected.json, { status: "invalid" });

      const retry = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance, { eventId, cancelAtPeriodEnd: false }),
        AUTH
      );
      assert.equal(retry.status, 200);
      assert.equal(retry.json.status, "updated");
      assert.equal(retry.json.replayed, false);
    });
  });

  it("maps unknown, unbound, and provider-correlation mismatches to the same redacted 404", async () => {
    await withLifecycleServer(async ({ store, url, issuance }) => {
      store.issueIdempotentLicense("nd_live_unboundHttpFixture000000", {
        idempotencyKey: "checkout-session:unbound-http",
        requestHash: "unbound",
        source: "checkout",
        externalRef: "cs_unbound_http",
        plan: "monthly_support",
        repoVisibilityScope: "private",
        privateRepoAllowed: true,
        updateEntitlement: true,
        seats: 1,
        expiresAt: "2026-07-20T00:00:00.000Z"
      });
      const cases = [
        lifecycleBody("renew_paid", issuanceRequest({ idempotencyKey: "checkout-session:unknown-http" })),
        lifecycleBody("renew_paid", issuanceRequest({ idempotencyKey: "checkout-session:unbound-http" })),
        lifecycleBody("renew_paid", issuance, { providerAccountId: "acct_wrong_private" }),
        lifecycleBody("renew_paid", issuance, { providerMode: "test" }),
        lifecycleBody("renew_paid", issuance, { externalSubscriptionId: "sub_wrong_private" })
      ];
      for (const body of cases) {
        const response = await post(url, "/v1/admin/licenses/lifecycle", body, AUTH);
        assert.equal(response.status, 404);
        assert.deepEqual(response.json, { status: "not_found" });
        for (const value of Object.values(body)) {
          if (typeof value === "string" && value.length > 8) assert.ok(!response.text.includes(value));
        }
      }
    });
  });

  it("maps parser and store policy failures to the same redacted 400", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const malformed = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        "{invalid-private-json",
        AUTH
      );
      assert.equal(malformed.status, 400);
      assert.deepEqual(malformed.json, { status: "invalid" });
      assert.ok(!malformed.text.includes("invalid-private-json"));

      const policyReference = "policy-private-payment-reference";
      const policy = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance, {
          eventId: "evt_policy_private",
          paymentReference: policyReference,
          currentPeriodEnd: "2027-12-31T00:00:00.000Z"
        }),
        AUTH
      );
      assert.equal(policy.status, 400);
      assert.deepEqual(policy.json, { status: "invalid" });
      assert.ok(!policy.text.includes(policyReference));
      assert.ok(!policy.text.includes("evt_policy_private"));
    });
  });

  it("rejects caller-supplied revoke text and returns only the derived safe reason to license clients", async () => {
    await withLifecycleServer(async ({ url, issuance, rawKey }) => {
      for (const reason of [
        "buyer@example.com",
        "cus_private_customer_reference",
        "canceled\r\nforged-admin-line",
        "canceled\u001b[2J"
      ]) {
        const rejected = await post(
          url,
          "/v1/admin/licenses/lifecycle",
          lifecycleBody("revoke", issuance, { eventId: `evt_reject_${reason.length}`, reason }),
          AUTH
        );
        assert.equal(rejected.status, 400);
        assert.deepEqual(rejected.json, { status: "invalid" });
        assert.ok(!rejected.text.includes(reason));
      }

      const applied = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("revoke", issuance, {
          eventId: "evt_safe_revoke_reason",
          reason: "subscription_canceled"
        }),
        AUTH
      );
      assert.equal(applied.status, 200);

      const revoked = await post(url, "/v1/license/activate", {
        licenseKey: rawKey,
        machineId: "machine-safe-reason"
      });
      assert.equal(revoked.status, 403);
      assert.equal(revoked.json.status, "revoked");
      assert.equal(revoked.json.revocationReason, "subscription_canceled");
      assert.doesNotMatch(revoked.text, /@|cus_|\r|\n|\u001b|forged-admin-line/);
    });
  });

  it("maps bounded storage busy failures to 503 and redacts unexpected exceptions", async () => {
    await withLifecycleServer(async ({ store, url, issuance }) => {
      const secretError = "sqlite busy at private-ref-123";
      store.applyCheckoutSubscriptionLifecycle = (() => {
        throw new SubscriptionLifecycleTransientError(secretError);
      }) as typeof store.applyCheckoutSubscriptionLifecycle;
      const unavailable = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance),
        AUTH
      );
      assert.equal(unavailable.status, 503);
      assert.deepEqual(unavailable.json, { status: "unavailable" });
      assert.ok(!unavailable.text.includes(secretError));
    });

    await withLifecycleServer(async ({ store, url, issuance }) => {
      const secretError = "internal exception private-ref-456";
      store.applyCheckoutSubscriptionLifecycle = (() => {
        throw new Error(secretError);
      }) as typeof store.applyCheckoutSubscriptionLifecycle;
      const failure = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("renew_paid", issuance),
        AUTH
      );
      assert.equal(failure.status, 500);
      assert.deepEqual(failure.json, { status: "server" });
      assert.ok(!failure.text.includes(secretError));
    });
  });

  it("uses a bounded redacted 429 with a dedicated limiter budget", async () => {
    const subscriptionLimiter = new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 });
    const oidcLimiter = new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 });
    let oidcVerifierCalls = 0;
    await withLifecycleServer(async ({ url, issuance }) => {
      const oidcBody = {
        releaseVersion: "v1.0.4",
        candidateHead: "a".repeat(40),
        packShasum: "b".repeat(40),
        packIntegrity: `sha512-${"Y".repeat(86)}==`
      };
      await post(url, "/v1/admin/licenses/issue-lifecycle", oidcBody, {
        Authorization: "Bearer invalid-oidc-one",
        "Fly-Client-IP": "203.0.113.25"
      });
      const oidcLimited = await post(url, "/v1/admin/licenses/issue-lifecycle", oidcBody, {
        Authorization: "Bearer invalid-oidc-two",
        "Fly-Client-IP": "203.0.113.25"
      });
      assert.equal(oidcLimited.status, 429);

      const first = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance),
        { ...AUTH, "Fly-Client-IP": "203.0.113.25" }
      );
      assert.equal(first.status, 200);
      const privateRef = "checkout-session:rate-limit-private";
      const limited = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, {
          issuanceIdempotencyKey: privateRef,
          eventId: "evt_rate_limit_private"
        }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.25" }
      );
      assert.equal(limited.status, 429);
      assert.deepEqual(limited.json, { status: "rate_limited" });
      assert.match(limited.headers.get("retry-after") ?? "", /^\d+$/);
      assert.ok(Number(limited.headers.get("retry-after")) >= 1);
      assert.ok(Number(limited.headers.get("retry-after")) <= 60);
      assert.ok(!limited.text.includes(privateRef));
      assert.ok(!limited.text.includes(ISSUANCE_SECRET));
      assert.equal(oidcVerifierCalls, 1);
    }, {
      subscriptionLifecycleRateLimiter: subscriptionLimiter,
      lifecycleRateLimiter: oidcLimiter,
      lifecycleOidcVerifier: {
        verify: async () => {
          oidcVerifierCalls += 1;
          throw new Error("invalid oidc fixture");
        }
      }
    });
  });

  it("ignores forged Fly client addresses unless the Fly proxy trust boundary is enabled", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const first = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_untrusted_proxy_one" }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.31" }
      );
      const forgedRotation = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_untrusted_proxy_two" }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.32" }
      );
      assert.equal(first.status, 200);
      assert.equal(forgedRotation.status, 429);
    }, {
      subscriptionLifecycleRateLimiter: new RateLimiter({
        maxPerWindow: 1,
        windowMs: 60_000
      })
    });
  });

  it("uses valid Fly client addresses only in explicitly trusted proxy mode", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const first = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_trusted_proxy_one" }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.41" }
      );
      const independent = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_trusted_proxy_two" }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.42" }
      );
      assert.equal(first.status, 200);
      assert.equal(independent.status, 200);
    }, {
      trustFlyProxyHeaders: true,
      subscriptionLifecycleRateLimiter: new RateLimiter({
        maxPerWindow: 1,
        windowMs: 60_000
      })
    });
  });

  it("fails malformed and multi-value Fly client headers safe to the socket budget", async () => {
    await withLifecycleServer(async ({ url, issuance }) => {
      const malformed = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_malformed_proxy" }),
        { ...AUTH, "Fly-Client-IP": "not-an-ip" }
      );
      const multiValue = await post(
        url,
        "/v1/admin/licenses/lifecycle",
        lifecycleBody("reconcile", issuance, { eventId: "evt_multi_proxy" }),
        { ...AUTH, "Fly-Client-IP": "203.0.113.51, 203.0.113.52" }
      );
      assert.equal(malformed.status, 200);
      assert.equal(multiValue.status, 429);
    }, {
      trustFlyProxyHeaders: true,
      subscriptionLifecycleRateLimiter: new RateLimiter({
        maxPerWindow: 1,
        windowMs: 60_000
      })
    });
  });
});
