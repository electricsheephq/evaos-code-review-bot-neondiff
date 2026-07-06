import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { LicenseStore, hashLicenseKey } from "../src/store.ts";
import {
  activate,
  deactivate,
  RateLimiter,
  validate,
  type Entitlement,
  type LicenseRequest,
  type ServiceResult
} from "../src/service.ts";

const NOW = new Date("2026-07-06T00:00:00.000Z");
// Fake keys constructed, never realistic literals (secret-scan CI).
const fakeKey = (tag: string): string => ["nd", "live", `${tag}${"x".repeat(24 - tag.length)}`].join("_");

function entitlement(result: ServiceResult): Entitlement {
  const body = result.body as { entitlement?: Entitlement };
  assert.ok(body.entitlement, "expected an entitlement body");
  return body.entitlement;
}

describe("license service endpoints", () => {
  let store: LicenseStore;
  after(() => store?.close());
  beforeEach(() => {
    store?.close();
    store = new LicenseStore(":memory:");
  });

  function issue(overrides: Partial<Parameters<LicenseStore["issueLicense"]>[0]> = {}): { key: string } {
    const { rawKey } = store.issueLicense({ plan: "yearly", repoVisibilityScope: "private", ...overrides });
    return { key: rawKey };
  }

  const req = (key: string, machineId: string, repo?: string): LicenseRequest => ({ licenseKey: key, machineId, repo });

  it("activate binds a new machine and returns active with required fields", () => {
    const { key } = issue();
    const result = activate(store, req(key, "machine-a"), NOW);
    assert.equal(result.httpStatus, 200);
    const ent = entitlement(result);
    assert.equal(ent.status, "active");
    assert.equal(ent.repoVisibilityScope, "private");
    assert.equal(typeof ent.updateEntitlement, "boolean");
  });

  it("activate is idempotent for the same machine", () => {
    const { key } = issue();
    activate(store, req(key, "machine-a"), NOW);
    const again = activate(store, req(key, "machine-a"), NOW);
    assert.equal(again.httpStatus, 200);
    assert.equal(store.countActivations(hashLicenseKey(key)), 1);
  });

  it("activate rejects a different machine when seats are exhausted → 409 scope_mismatch", () => {
    const { key } = issue({ seats: 1 });
    activate(store, req(key, "machine-a"), NOW);
    const rejected = activate(store, req(key, "machine-b"), NOW);
    assert.equal(rejected.httpStatus, 409);
    assert.equal((rejected.body as { status: string }).status, "scope_mismatch");
  });

  it("activate allows a second machine when seats remain", () => {
    const { key } = issue({ seats: 2 });
    activate(store, req(key, "machine-a"), NOW);
    const second = activate(store, req(key, "machine-b"), NOW);
    assert.equal(second.httpStatus, 200);
  });

  it("validate returns active for an activated machine", () => {
    const { key } = issue();
    activate(store, req(key, "machine-a"), NOW);
    const result = validate(store, req(key, "machine-a"), NOW);
    assert.equal(result.httpStatus, 200);
    assert.equal(entitlement(result).status, "active");
  });

  it("validate rejects a never-activated machine → 409 scope_mismatch", () => {
    const { key } = issue();
    const result = validate(store, req(key, "machine-a"), NOW);
    assert.equal(result.httpStatus, 409);
  });

  it("validate on a revoked license → 403 revoked", () => {
    const { key } = issue();
    activate(store, req(key, "machine-a"), NOW);
    store.revokeLicense(key, "refund");
    const result = validate(store, req(key, "machine-a"), NOW);
    assert.equal(result.httpStatus, 403);
    assert.equal((result.body as { status: string }).status, "revoked");
  });

  it("validate on an expired license → 402 expired", () => {
    const { key } = issue({ expiresAt: "2020-01-01T00:00:00.000Z" });
    activate(store, req(key, "machine-a"), new Date("2019-06-01T00:00:00.000Z"));
    const result = validate(store, req(key, "machine-a"), NOW);
    assert.equal(result.httpStatus, 402);
    assert.equal((result.body as { status: string }).status, "expired");
  });

  it("unknown key → 404 invalid on activate and validate", () => {
    assert.equal(activate(store, req(fakeKey("nope"), "machine-a"), NOW).httpStatus, 404);
    assert.equal(validate(store, req(fakeKey("nope"), "machine-a"), NOW).httpStatus, 404);
  });

  it("deactivate frees the seat and is idempotent", () => {
    const { key } = issue({ seats: 1 });
    activate(store, req(key, "machine-a"), NOW);
    const deactivated = deactivate(store, req(key, "machine-a"), NOW);
    assert.equal(deactivated.httpStatus, 200);
    assert.equal(store.countActivations(hashLicenseKey(key)), 0);
    // Idempotent second call.
    assert.equal(deactivate(store, req(key, "machine-a"), NOW).httpStatus, 200);
    // Seat is free → a different machine can now activate.
    assert.equal(activate(store, req(key, "machine-b"), NOW).httpStatus, 200);
  });

  it("never stores the raw key — only the sha256 hash", () => {
    const { key } = issue();
    const record = store.getLicenseByKey(key);
    assert.ok(record);
    assert.equal(record.licenseKeyHash, hashLicenseKey(key));
    assert.notEqual(record.licenseKeyHash, key);
    // No response body echoes the raw key.
    const result = activate(store, req(key, "machine-a"), NOW);
    assert.ok(!JSON.stringify(result).includes(key));
  });

  it("rate limiter throttles after the window budget", () => {
    const limiter = new RateLimiter({ maxPerWindow: 2, windowMs: 1000 });
    assert.equal(limiter.allow("k", 0), true);
    assert.equal(limiter.allow("k", 10), true);
    assert.equal(limiter.allow("k", 20), false);
    // A different key is independent.
    assert.equal(limiter.allow("other", 20), true);
    // After the window slides, budget refreshes.
    assert.equal(limiter.allow("k", 2000), true);
  });
});
