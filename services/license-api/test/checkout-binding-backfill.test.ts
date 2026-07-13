import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { LicenseStore } from "../src/store.ts";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function databasePath(): string {
  const directory = mkdtempSync(join(tmpdir(), "neondiff-checkout-backfill-"));
  tempDirectories.push(directory);
  return join(directory, "license.sqlite");
}

function binding(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    issuanceIdempotencyKey: "checkout-session:legacy-backfill",
    provider: "stripe",
    providerAccountId: "acct_product_live",
    providerMode: "live",
    externalSubscriptionId: "sub_legacy_backfill",
    externalCheckoutId: "cs_legacy_backfill",
    ...overrides
  };
}

function issueLegacyCheckout(store: LicenseStore, source = "checkout"): void {
  store.issueIdempotentLicense("nd_live_legacybackfillrawmaterial", {
    idempotencyKey: "checkout-session:legacy-backfill",
    requestHash: "legacy-request-hash",
    source,
    externalRef: "legacy-checkout-reference",
    plan: "monthly_support",
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true,
    seats: 1,
    expiresAt: "2026-08-13T00:00:00.000Z"
  });
}

function bind(store: LicenseStore, input = binding(), dryRun = false): Record<string, unknown> {
  return (
    store as unknown as {
      bindCheckoutSubscription(
        input: Record<string, unknown>,
        options?: { dryRun?: boolean }
      ): Record<string, unknown>;
    }
  ).bindCheckoutSubscription(input, { dryRun });
}

function bindingCount(path: string): number {
  const db = new DatabaseSync(path);
  try {
    return Number(
      (db.prepare("select count(*) as count from checkout_subscription_bindings").get() as {
        count: number;
      }).count
    );
  } finally {
    db.close();
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.constructor.name : "";
}

describe("checkout subscription binding backfill store", () => {
  it("dry-runs an existing checkout issuance with zero writes", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      const result = bind(store, binding(), true);

      assert.equal(result.result, "would_bind");
      assert.match(String(result.issuanceFingerprint), /^iss_[a-f0-9]{32}$/);
      assert.equal(bindingCount(path), 0);
    } finally {
      store.close();
    }
  });

  it("binds once and makes identical replay idempotent across store connections", () => {
    const path = databasePath();
    const first = new LicenseStore(path);
    const second = new LicenseStore(path);
    try {
      issueLegacyCheckout(first);
      const created = bind(first);
      const replayed = bind(second);

      assert.equal(created.result, "bound");
      assert.equal(replayed.result, "already_bound");
      assert.equal(replayed.issuanceFingerprint, created.issuanceFingerprint);
      assert.equal(bindingCount(path), 1);
    } finally {
      second.close();
      first.close();
    }
  });

  it("conflicts when any immutable tuple field differs", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      issueLegacyCheckout(store);
      bind(store);
      for (const changed of [
        { providerAccountId: "acct_other" },
        { providerMode: "test" },
        { externalSubscriptionId: "sub_other" },
        { externalCheckoutId: "cs_other" }
      ]) {
        assert.throws(
          () => bind(store, binding(changed)),
          (error: unknown) => errorName(error) === "CheckoutBindingConflictError"
        );
      }
      assert.equal(bindingCount(path), 1);
    } finally {
      store.close();
    }
  });

  it("classifies missing issuance, wrong source, and missing license separately", () => {
    const path = databasePath();
    const store = new LicenseStore(path);
    try {
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingNotFoundError"
      );
      issueLegacyCheckout(store, "admin");
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingWrongSourceError"
      );
      store.close();

      const db = new DatabaseSync(path);
      db.exec("pragma foreign_keys = off");
      db.prepare("update license_issuance_events set source = 'checkout'").run();
      db.prepare("delete from licenses").run();
      db.close();

      const orphaned = new LicenseStore(path);
      try {
        assert.throws(
          () => bind(orphaned),
          (error: unknown) => errorName(error) === "CheckoutBindingNotFoundError"
        );
      } finally {
        orphaned.close();
      }
    } finally {
      try {
        store.close();
      } catch {}
    }
  });

  it("validates direct-store input and rejects escalation fields", () => {
    const store = new LicenseStore(":memory:");
    try {
      issueLegacyCheckout(store);
      for (const input of [
        binding({ rawKey: "nd_live_forbidden" }),
        binding({ plan: "organization_support" }),
        binding({ expiresAt: "2099-01-01T00:00:00.000Z" }),
        binding({ seats: 99 }),
        binding({ scope: "all" }),
        binding({ ownership: "caller" }),
        binding({ repoVisibilityScope: "all" }),
        binding({ privateRepoAllowed: true }),
        binding({ updateEntitlement: true }),
        binding({ provider: "other" }),
        binding({ providerMode: "staging" })
      ]) {
        assert.throws(
          () => bind(store, input),
          (error: unknown) => errorName(error) === "CheckoutBindingPolicyError"
        );
      }
    } finally {
      store.close();
    }
  });

  it("bounds write-lock contention and persists no binding", () => {
    const path = databasePath();
    const store = new LicenseStore(path, { busyTimeoutMs: 25 });
    const blocker = new DatabaseSync(path);
    try {
      issueLegacyCheckout(store);
      blocker.exec("begin immediate");
      const startedAt = Date.now();
      assert.throws(
        () => bind(store),
        (error: unknown) => errorName(error) === "CheckoutBindingTransientError"
      );
      assert.ok(Date.now() - startedAt < 1_000);
      blocker.exec("rollback");
      assert.equal(bindingCount(path), 0);
    } finally {
      try {
        blocker.exec("rollback");
      } catch {}
      blocker.close();
      store.close();
    }
  });
});
