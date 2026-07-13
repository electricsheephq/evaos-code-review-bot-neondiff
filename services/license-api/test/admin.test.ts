import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";
import { LicenseStore } from "../src/store.ts";
import { runAdmin } from "../src/admin.ts";
import { issueCheckoutLicense, type LicenseIssuanceRequest } from "../src/issuance.ts";
import { parseSubscriptionLifecycleRequest } from "../src/subscription-lifecycle.ts";

describe("admin issuance CLI", () => {
  let store: LicenseStore;
  let lines: string[];
  const out = (line: string) => lines.push(line);
  after(() => store?.close());
  beforeEach(() => {
    store?.close();
    store = new LicenseStore(":memory:");
    lines = [];
  });

  function issue(args: string[] = ["--plan", "yearly", "--scope", "private"]): string {
    const code = runAdmin(["issue", ...args], store, out);
    assert.equal(code, 0);
    const keyLine = lines.find((l) => l.includes("key:"));
    assert.ok(keyLine, "issue must print the raw key once");
    const key = keyLine.split("key:")[1].trim();
    assert.ok(key.startsWith("nd_live_"));
    return key;
  }

  function issueLegacyCheckout(source = "checkout"): void {
    store.issueIdempotentLicense("nd_live_legacyadminbackfillraw", {
      idempotencyKey: "checkout-session:legacy-admin",
      requestHash: "legacy-admin-request-hash",
      source,
      externalRef: "cs_legacy_admin",
      plan: "monthly_support",
      repoVisibilityScope: "private",
      privateRepoAllowed: true,
      updateEntitlement: true,
      seats: 1,
      expiresAt: "2026-08-13T00:00:00.000Z"
    });
  }

  function bindArgs(extra: string[] = []): string[] {
    return [
      "bind-checkout-subscription",
      "--issuance-idempotency-key", "checkout-session:legacy-admin",
      "--provider", "stripe",
      "--provider-account-id", "acct_admin_live",
      "--provider-mode", "live",
      "--external-subscription-id", "sub_legacy_admin",
      "--external-checkout-id", "cs_legacy_admin",
      ...extra
    ];
  }

  it("issue prints the raw key exactly once and stores only the hash", () => {
    const key = issue();
    // The key appears exactly once across all printed lines.
    const occurrences = lines.filter((l) => l.includes(key)).length;
    assert.equal(occurrences, 1);
    const record = store.getLicenseByKey(key);
    assert.ok(record);
    assert.notEqual(record.licenseKeyHash, key);
  });

  it("issue requires --plan and --scope", () => {
    assert.equal(runAdmin(["issue", "--plan", "yearly"], store, out), 2);
    assert.equal(runAdmin(["issue", "--scope", "private"], store, out), 2);
  });

  it("list never prints raw keys", () => {
    const key = issue();
    lines = [];
    assert.equal(runAdmin(["list"], store, out), 0);
    assert.ok(!lines.join("\n").includes(key));
    assert.ok(lines.join("\n").includes(store.getLicenseByKey(key)!.licenseKeyHash));
  });

  it("revoke marks a license revoked; show reflects it without the raw key", () => {
    const key = issue();
    lines = [];
    assert.equal(runAdmin(["revoke", "--key", key, "--reason", "refund"], store, out), 0);
    assert.equal(store.getLicenseByKey(key)!.status, "revoked");
    lines = [];
    assert.equal(runAdmin(["show", "--key", key], store, out), 0);
    const shown = lines.join("\n");
    assert.ok(shown.includes("status=revoked"));
    assert.ok(shown.includes("refund"));
    assert.ok(!shown.includes(key));
  });

  it("revoke and show fail cleanly on an unknown key", () => {
    assert.equal(runAdmin(["revoke", "--key", "nd_live_unknownxxxxxxxxxxxxxxxxxxx"], store, out), 2);
    assert.equal(runAdmin(["show", "--key", "nd_live_unknownxxxxxxxxxxxxxxxxxxx"], store, out), 2);
  });

  it("renders only the server-derived lifecycle revoke reason code", () => {
    store.close();
    const now = new Date("2026-07-13T00:00:00.000Z");
    store = new LicenseStore(":memory:", { now: () => now });
    const issuance: LicenseIssuanceRequest = {
      idempotencyKey: "checkout-session:admin-safe-reason",
      checkoutLookupKey: "neondiff_monthly",
      provider: "stripe",
      providerAccountId: "acct_admin_safe_reason",
      providerMode: "live",
      externalSubscriptionId: "sub_admin_safe_reason",
      externalCheckoutId: "cs_admin_safe_reason"
    };
    const issued = issueCheckoutLicense(store, issuance, "test-only-admin-safe-reason-secret");
    assert.equal(issued.httpStatus, 200);
    const rawKey = (issued.body as { licenseKey: string }).licenseKey;
    const request = parseSubscriptionLifecycleRequest(JSON.stringify({
      schemaVersion: 1,
      issuanceIdempotencyKey: issuance.idempotencyKey,
      eventId: "evt_admin_safe_reason",
      eventCreatedAt: Math.floor(now.getTime() / 1_000),
      provider: issuance.provider,
      providerAccountId: issuance.providerAccountId,
      providerMode: issuance.providerMode,
      externalSubscriptionId: issuance.externalSubscriptionId,
      providerEventType: "customer.subscription.deleted",
      command: "revoke",
      subscriptionStatus: "canceled",
      cancelAtPeriodEnd: false
    }), now);
    store.applyCheckoutSubscriptionLifecycle(request);

    lines = [];
    assert.equal(runAdmin(["show", "--key", rawKey], store, out), 0);
    const output = lines.join("\n");
    assert.ok(output.includes("revocationReason=subscription_canceled"));
    assert.ok(!output.includes("@"));
    assert.doesNotMatch(output, /\u001b|forged-admin-line|cus_/);
  });

  it("bind-checkout-subscription dry-run writes nothing and emits only result plus fingerprint", () => {
    issueLegacyCheckout();
    lines = [];

    assert.equal(runAdmin(bindArgs(["--dry-run"]), store, out), 0);
    assert.equal(lines.length, 1);
    const output = JSON.parse(lines[0]) as Record<string, unknown>;
    assert.deepEqual(Object.keys(output).sort(), ["issuanceFingerprint", "result"]);
    assert.equal(output.result, "would_bind");
    assert.match(String(output.issuanceFingerprint), /^iss_[a-f0-9]{32}$/);

    lines = [];
    assert.equal(runAdmin(bindArgs(), store, out), 0);
    assert.equal((JSON.parse(lines[0]) as Record<string, unknown>).result, "bound");
  });

  it("bind-checkout-subscription is redacted and identical replay is idempotent", () => {
    issueLegacyCheckout();
    const rawKey = "nd_live_legacyadminbackfillraw";
    const licenseHash = store.getLicenseByKey(rawKey)!.licenseKeyHash;

    assert.equal(runAdmin(bindArgs(), store, out), 0);
    const first = JSON.parse(lines[0]) as Record<string, unknown>;
    lines = [];
    assert.equal(runAdmin(bindArgs(), store, out), 0);
    const replay = JSON.parse(lines[0]) as Record<string, unknown>;

    assert.equal(replay.result, "already_bound");
    assert.equal(replay.issuanceFingerprint, first.issuanceFingerprint);
    const output = JSON.stringify([first, replay]);
    for (const secret of [
      rawKey,
      licenseHash,
      "checkout-session:legacy-admin",
      "acct_admin_live",
      "sub_legacy_admin",
      "cs_legacy_admin"
    ]) {
      assert.ok(!output.includes(secret));
    }
  });

  it("bind-checkout-subscription classifies tuple conflicts, wrong source, and not found", () => {
    issueLegacyCheckout();
    assert.equal(runAdmin(bindArgs(), store, out), 0);

    lines = [];
    const changed = bindArgs();
    changed[changed.indexOf("--external-subscription-id") + 1] = "sub_changed";
    assert.equal(runAdmin(changed, store, out), 1);
    assert.equal((JSON.parse(lines[0]) as Record<string, unknown>).result, "conflict");

    store.close();
    store = new LicenseStore(":memory:");
    lines = [];
    issueLegacyCheckout("admin");
    assert.equal(runAdmin(bindArgs(), store, out), 1);
    assert.equal((JSON.parse(lines[0]) as Record<string, unknown>).result, "wrong_source");

    store.close();
    store = new LicenseStore(":memory:");
    lines = [];
    assert.equal(runAdmin(bindArgs(), store, out), 1);
    assert.equal((JSON.parse(lines[0]) as Record<string, unknown>).result, "not_found");
  });

  it("bind-checkout-subscription rejects missing values, positional args, unknown flags, and escalation", () => {
    issueLegacyCheckout();
    for (const extra of [
      ["--raw-key", "nd_live_forbidden"],
      ["--plan", "organization_support"],
      ["--expires", "2099-01-01T00:00:00.000Z"],
      ["--expiry", "2099-01-01T00:00:00.000Z"],
      ["--seats", "99"],
      ["--scope", "all"],
      ["--ownership", "caller"],
      ["--private-repo-allowed", "true"],
      ["--update-entitlement"],
      ["--unknown", "value"],
      ["positional"],
      ["--dry-run", "true"]
    ]) {
      lines = [];
      assert.equal(runAdmin(bindArgs(extra), store, out), 2);
      assert.deepEqual(JSON.parse(lines[0]), { result: "invalid" });
    }

    lines = [];
    const missingValue = bindArgs();
    missingValue.splice(missingValue.indexOf("--provider-account-id") + 1, 1);
    assert.equal(runAdmin(missingValue, store, out), 2);
    assert.deepEqual(JSON.parse(lines[0]), { result: "invalid" });
  });
});
