import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { LicenseStore } from "../src/store.ts";
import { startLicenseServer } from "../src/http.ts";
import { RateLimiter } from "../src/service.ts";

const fakeKey = (tag: string): string => ["nd", "live", `${tag}${"x".repeat(24 - tag.length)}`].join("_");

async function post(url: string, path: string, body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
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
});
