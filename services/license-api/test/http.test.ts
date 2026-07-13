import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { LicenseStore } from "../src/store.ts";
import { startLicenseServer } from "../src/http.ts";
import { RateLimiter } from "../src/service.ts";

const fakeKey = (tag: string): string => ["nd", "live", `${tag}${"x".repeat(24 - tag.length)}`].join("_");

function checkoutBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    idempotencyKey: "checkout-session:http-default",
    checkoutLookupKey: "neondiff_monthly",
    provider: "stripe",
    providerAccountId: "acct_http_live",
    providerMode: "live",
    externalSubscriptionId: "sub_http_default",
    externalCheckoutId: "cs_http_default",
    ...overrides
  };
}

async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {} };
}

describe("license http transport", () => {
  let store: LicenseStore;
  let server: Server;
  let url: string;
  let issuedKey: string;

  before(async () => {
    store = new LicenseStore(":memory:");
    issuedKey = store.issueLicense({ plan: "yearly", repoVisibilityScope: "private" }).rawKey;
    const started = await startLicenseServer({
      store,
      rateLimiter: new RateLimiter({ maxPerWindow: 3, windowMs: 60_000 })
    });
    server = started.server;
    url = started.url;
  });

  after(() => {
    server.close();
    store.close();
  });

  it("serves a health endpoint", async () => {
    const res = await fetch(`${url}/healthz`);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { status: "ok" });
  });

  it("rejects a malformed body → 400", async () => {
    const res = await post(url, "/v1/license/activate", "{not json");
    assert.equal(res.status, 400);
  });

  it("rejects a missing machineId → 400", async () => {
    const res = await post(url, "/v1/license/activate", { licenseKey: issuedKey });
    assert.equal(res.status, 400);
  });

  it("activates over HTTP and echoes no raw key", async () => {
    const res = await post(url, "/v1/license/activate", { licenseKey: issuedKey, machineId: "m1" });
    assert.equal(res.status, 200);
    assert.equal(res.json.entitlement.status, "active");
    assert.ok(!JSON.stringify(res.json).includes(issuedKey));
  });

  it("throttles once the per-key budget is exhausted → 429", async () => {
    const key = fakeKey("rl");
    store.issueLicense; // no-op guard so lint keeps the import
    // Unknown key still counts against the limiter (per-key), so exhaust the budget.
    await post(url, "/v1/license/validate", { licenseKey: key, machineId: "m" });
    await post(url, "/v1/license/validate", { licenseKey: key, machineId: "m" });
    await post(url, "/v1/license/validate", { licenseKey: key, machineId: "m" });
    const throttled = await post(url, "/v1/license/validate", { licenseKey: key, machineId: "m" });
    assert.equal(throttled.status, 429);
    assert.equal(throttled.json.status, "rate_limited");
  });

  it("indexes rate limiting by a one-way key digest", async () => {
    class CapturingRateLimiter extends RateLimiter {
      readonly keys: string[] = [];
      override allow(key: string, now: number): boolean {
        this.keys.push(key);
        return super.allow(key, now);
      }
    }
    const isolatedStore = new LicenseStore(":memory:");
    const limiter = new CapturingRateLimiter({ maxPerWindow: 3, windowMs: 60_000 });
    const started = await startLicenseServer({ store: isolatedStore, rateLimiter: limiter });
    const rawKey = fakeKey("digest");
    try {
      await post(started.url, "/v1/license/validate", { licenseKey: rawKey, machineId: "m" });
      assert.equal(limiter.keys.length, 1);
      assert.notEqual(limiter.keys[0], rawKey);
      assert.match(limiter.keys[0], /^[a-f0-9]{64}$/);
    } finally {
      started.server.close();
      isolatedStore.close();
    }
  });
});

describe("license issuance transport", () => {
  let store: LicenseStore;
  let server: Server;
  let url: string;
  const issuanceSecret = ["test", "issuance", "secret", "0123456789"].join("_");
  const auth = { Authorization: `Bearer ${issuanceSecret}` };

  before(async () => {
    store = new LicenseStore(":memory:", {
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    const started = await startLicenseServer({
      store,
      issuanceSecret,
      rateLimiter: new RateLimiter({ maxPerWindow: 100, windowMs: 60_000 }),
      now: () => new Date("2026-07-08T00:00:00.000Z")
    });
    server = started.server;
    url = started.url;
  });

  after(() => {
    server.close();
    store.close();
  });

  it("rejects issuance without the shared secret", async () => {
    const res = await post(url, "/v1/admin/licenses/issue", {
      idempotencyKey: "checkout-session-unauthorized",
      checkoutLookupKey: "neondiff_monthly"
    });
    assert.equal(res.status, 401);
    assert.equal(store.listLicenses().length, 0);
  });

  it("issues a product-native license key for checkout fulfillment", async () => {
    const issued = await post(
      url,
      "/v1/admin/licenses/issue",
      checkoutBody({
        idempotencyKey: "checkout-session-123",
        checkoutLookupKey: "neondiff_org_yearly",
        externalSubscriptionId: "sub_123",
        externalCheckoutId: "cs_123",
        seats: 1
      }),
      auth
    );
    assert.equal(issued.status, 200);
    assert.equal(issued.json.status, "issued");
    assert.equal(issued.json.replayed, false);
    assert.match(issued.json.licenseKey, /^nd_live_[A-Za-z0-9_-]+$/);
    assert.equal(issued.json.entitlement.plan, "org_yearly_support");
    assert.equal(issued.json.entitlement.repoVisibilityScope, "private");
    assert.equal(issued.json.entitlement.updateEntitlement, true);
    assert.equal(issued.json.entitlement.seats, 1);
    assert.equal(issued.json.entitlement.expiresAt, "2026-08-07T00:00:00.000Z");

    const record = store.getLicenseByKey(issued.json.licenseKey);
    assert.ok(record);
    assert.equal(record.plan, "org_yearly_support");
    assert.equal(record.repoVisibilityScope, "private");
    assert.equal(record.updateEntitlement, true);
    assert.equal(record.seats, 1);
    assert.equal(record.expiresAt, "2026-08-07T00:00:00.000Z");

    const activated = await post(url, "/v1/license/activate", {
      licenseKey: issued.json.licenseKey,
      machineId: "machine-a"
    });
    assert.equal(activated.status, 200);
    assert.equal(activated.json.entitlement.status, "active");
    assert.ok(!JSON.stringify(activated.json).includes(issued.json.licenseKey));
  });

  it("replays the same idempotency key without minting a duplicate license", async () => {
    const body = checkoutBody({
      idempotencyKey: "checkout-session-repeat",
      checkoutLookupKey: "neondiff_yearly",
      externalSubscriptionId: "sub_repeat",
      externalCheckoutId: "cs_repeat"
    });
    const first = await post(url, "/v1/admin/licenses/issue", body, auth);
    const second = await post(url, "/v1/admin/licenses/issue", body, auth);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.replayed, true);
    assert.equal(second.json.licenseKey, first.json.licenseKey);
    assert.equal(
      store.listLicenses().filter((record) => record.plan === "yearly_support").length,
      1
    );
  });

  it("fails closed when an idempotency key is reused with different checkout data", async () => {
    const first = await post(
      url,
      "/v1/admin/licenses/issue",
      checkoutBody({
        idempotencyKey: "checkout-session-conflict",
        externalSubscriptionId: "sub_conflict",
        externalCheckoutId: "cs_conflict"
      }),
      auth
    );
    assert.equal(first.status, 200);
    const conflict = await post(
      url,
      "/v1/admin/licenses/issue",
      checkoutBody({
        idempotencyKey: "checkout-session-conflict",
        checkoutLookupKey: "neondiff_org_yearly",
        externalSubscriptionId: "sub_conflict",
        externalCheckoutId: "cs_conflict"
      }),
      auth
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.status, "conflict");
  });

  it("rejects unsupported checkout lookup keys before issuing", async () => {
    const res = await post(
      url,
      "/v1/admin/licenses/issue",
      checkoutBody({
        idempotencyKey: "checkout-session-bad-plan",
        checkoutLookupKey: "neondiff_lifetime",
        externalSubscriptionId: "sub_bad_plan",
        externalCheckoutId: "cs_bad_plan"
      }),
      auth
    );
    assert.equal(res.status, 400);
    assert.equal(res.json.status, "invalid");
  });

  it("requires the complete checkout correlation tuple", async () => {
    for (const field of [
      "provider",
      "providerAccountId",
      "providerMode",
      "externalSubscriptionId",
      "externalCheckoutId"
    ]) {
      const body = checkoutBody({
        idempotencyKey: `checkout-session:missing-${field}`,
        externalSubscriptionId: `sub_missing_${field}`,
        externalCheckoutId: `cs_missing_${field}`
      });
      delete body[field];
      const response = await post(url, "/v1/admin/licenses/issue", body, auth);
      assert.equal(response.status, 400);
      assert.match(response.json.detail, new RegExp(`${field} is required`));
    }
  });

  it("rejects caller entitlement authority and unknown fields", async () => {
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
      const response = await post(
        url,
        "/v1/admin/licenses/issue",
        checkoutBody({
          idempotencyKey: `checkout-session:authority-${field}`,
          externalSubscriptionId: `sub_authority_${field}`,
          externalCheckoutId: `cs_authority_${field}`,
          [field]: "caller-value"
        }),
        auth
      );
      assert.equal(response.status, 400);
      assert.equal(response.json.detail, `unknown field: ${field}`);
    }
  });

  it("rejects deprecated multi-seat checkout requests", async () => {
    const response = await post(
      url,
      "/v1/admin/licenses/issue",
      checkoutBody({
        idempotencyKey: "checkout-session:multi-seat",
        externalSubscriptionId: "sub_multi_seat",
        externalCheckoutId: "cs_multi_seat",
        seats: 3
      }),
      auth
    );
    assert.equal(response.status, 400);
    assert.match(response.json.detail, /seats is deprecated and must be exactly 1/);
  });
});

describe("lifecycle issuance transport", () => {
  it("shares one pre-verification rate-limit budget across bearer values", async () => {
    const isolatedStore = new LicenseStore(":memory:");
    let verifierCalls = 0;
    const started = await startLicenseServer({
      store: isolatedStore,
      issuanceSecret: "lifecycle-issuance-secret",
      trustFlyProxyHeaders: true,
      lifecycleRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
      lifecycleOidcVerifier: {
        verify: async () => {
          verifierCalls += 1;
          throw new Error("invalid fixture token");
        }
      }
    });
    const body = {
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`
    };
    try {
      const first = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer first.invalid.token",
        "Fly-Client-IP": "203.0.113.10"
      });
      const second = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer second.invalid.token",
        "Fly-Client-IP": "203.0.113.10"
      });
      assert.equal(first.status, 401);
      assert.equal(second.status, 429);
      assert.equal(second.json.status, "rate_limited");
      assert.equal(verifierCalls, 1);
    } finally {
      started.server.close();
      isolatedStore.close();
    }
  });

  it("keeps Fly-provided client IP budgets independent behind the proxy", async () => {
    const isolatedStore = new LicenseStore(":memory:");
    let verifierCalls = 0;
    const started = await startLicenseServer({
      store: isolatedStore,
      issuanceSecret: "lifecycle-issuance-secret",
      trustFlyProxyHeaders: true,
      lifecycleRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
      lifecycleOidcVerifier: {
        verify: async () => {
          verifierCalls += 1;
          throw new Error("invalid fixture token");
        }
      }
    });
    const body = {
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`
    };
    try {
      const first = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer first.invalid.token",
        "Fly-Client-IP": "203.0.113.10"
      });
      const second = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer second.invalid.token",
        "Fly-Client-IP": "203.0.113.11"
      });
      assert.equal(first.status, 401);
      assert.equal(second.status, 401);
      assert.equal(verifierCalls, 2);
    } finally {
      started.server.close();
      isolatedStore.close();
    }
  });

  it("classifies an oversized authenticated lifecycle body as payload-too-large", async () => {
    const isolatedStore = new LicenseStore(":memory:");
    const started = await startLicenseServer({
      store: isolatedStore,
      issuanceSecret: "lifecycle-issuance-secret",
      lifecycleOidcVerifier: { verify: async () => ({}) as any }
    });
    try {
      const response = await post(
        started.url,
        "/v1/admin/licenses/issue-lifecycle",
        "x".repeat(20 * 1024),
        { Authorization: "Bearer syntactically-valid-fixture" }
      );
      assert.equal(response.status, 413);
      assert.equal(response.json.status, "invalid");
    } finally {
      started.server.close();
      isolatedStore.close();
    }
  });

  it("ignores forged Fly client addresses for direct OIDC lifecycle requests", async () => {
    const isolatedStore = new LicenseStore(":memory:");
    let verifierCalls = 0;
    const started = await startLicenseServer({
      store: isolatedStore,
      issuanceSecret: "lifecycle-issuance-secret",
      lifecycleRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
      lifecycleOidcVerifier: {
        verify: async () => {
          verifierCalls += 1;
          throw new Error("invalid fixture token");
        }
      }
    });
    const body = {
      releaseVersion: "v1.0.4",
      candidateHead: "a".repeat(40),
      packShasum: "b".repeat(40),
      packIntegrity: `sha512-${"Y".repeat(86)}==`
    };
    try {
      const first = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer first.invalid.token",
        "Fly-Client-IP": "203.0.113.21"
      });
      const forgedRotation = await post(started.url, "/v1/admin/licenses/issue-lifecycle", body, {
        Authorization: "Bearer second.invalid.token",
        "Fly-Client-IP": "203.0.113.22"
      });
      assert.equal(first.status, 401);
      assert.equal(forgedRotation.status, 429);
      assert.equal(verifierCalls, 1);
    } finally {
      started.server.close();
      isolatedStore.close();
    }
  });
});
