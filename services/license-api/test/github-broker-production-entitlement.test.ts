import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  createLicenseStoreEntitlementResolver
} from "../src/github-broker/license-entitlement.js";
import { activate } from "../src/service.js";
import { LicenseStore } from "../src/store.js";
import {
  bearer,
  connectInstallation,
  fakeGitHubClient,
  FIXED_NOW,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type FakeInstallation
} from "./github-broker-support.ts";

const NOW = new Date("2026-07-18T15:00:00.000Z");
const DEVICE_ID = "broker-device-1";
const PRIVATE_REPO = "octo/private";
const INSTALL: FakeInstallation = {
  id: 7001,
  account_login: "octo",
  repositories: [
    { id: 82, full_name: PRIVATE_REPO, visibility: "private" }
  ]
};

function issuePrivate(store: LicenseStore, expiresAt?: string) {
  return store.issueLicense({
    plan: "yearly",
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    ...(expiresAt ? { expiresAt } : {})
  });
}

function context(activationKey?: string, overrides: Partial<{
  deviceId: string;
  privateRepositories: string[];
}> = {}) {
  return {
    deviceId: overrides.deviceId ?? DEVICE_ID,
    installationId: 7001,
    accountLogin: "octo",
    privateRepositories: overrides.privateRepositories ?? [PRIVATE_REPO],
    ...(activationKey ? { activationKey } : {})
  };
}

describe("production GitHub broker entitlement resolver (#612/#614)", () => {
  it("covers only the exact private repository activated for the authenticated broker device", async () => {
    const store = new LicenseStore(":memory:");
    const issued = issuePrivate(store);
    assert.equal(
      activate(
        store,
        { licenseKey: issued.rawKey, machineId: DEVICE_ID, repo: PRIVATE_REPO },
        NOW
      ).httpStatus,
      200
    );

    const resolve = createLicenseStoreEntitlementResolver(store, () => NOW);
    assert.deepEqual(
      await resolve(context(issued.rawKey)),
      { status: "active", coveredPrivateRepositories: [PRIVATE_REPO] }
    );
    assert.deepEqual(
      await resolve(context(issued.rawKey, { privateRepositories: ["octo/other"] })),
      { status: "active", coveredPrivateRepositories: [] }
    );
  });

  it("fails closed for missing, invalid, wrong-device, revoked, expired, and malformed-expiry credentials", async () => {
    const store = new LicenseStore(":memory:");
    const active = issuePrivate(store);
    const expired = issuePrivate(store, "2026-07-18T14:59:59.000Z");
    const malformedExpiry = issuePrivate(store, "not-a-timestamp");
    assert.equal(
      activate(
        store,
        { licenseKey: active.rawKey, machineId: DEVICE_ID, repo: PRIVATE_REPO },
        NOW
      ).httpStatus,
      200
    );
    assert.equal(
      activate(
        store,
        { licenseKey: malformedExpiry.rawKey, machineId: DEVICE_ID, repo: PRIVATE_REPO },
        NOW
      ).httpStatus,
      200
    );

    const resolve = createLicenseStoreEntitlementResolver(store, () => NOW);
    assert.deepEqual(await resolve(context()), { status: "none" });
    assert.deepEqual(await resolve(context("NDL-NOT-A-REAL-LICENSE")), { status: "invalid" });
    assert.deepEqual(
      await resolve(context(active.rawKey, { deviceId: "different-device" })),
      { status: "replay_conflict" }
    );

    store.revokeLicense(active.rawKey, "cancelled");
    assert.deepEqual(await resolve(context(active.rawKey)), { status: "revoked" });
    assert.deepEqual(await resolve(context(expired.rawKey)), { status: "expired" });
    assert.deepEqual(await resolve(context(malformedExpiry.rawKey)), { status: "expired" });
  });

  it("never treats a public-only or private-disabled license as private coverage", async () => {
    const store = new LicenseStore(":memory:");
    const issued = store.issueLicense({
      plan: "yearly",
      repoVisibilityScope: "public",
      privateRepoAllowed: false
    });
    assert.equal(
      activate(
        store,
        { licenseKey: issued.rawKey, machineId: DEVICE_ID, repo: PRIVATE_REPO },
        NOW
      ).httpStatus,
      200
    );

    const resolve = createLicenseStoreEntitlementResolver(store, () => NOW);
    assert.deepEqual(
      await resolve(context(issued.rawKey)),
      { status: "active", coveredPrivateRepositories: [] }
    );
  });

  it("binds the authenticated HTTPS token request to the same license store activation", async () => {
    const store = new LicenseStore(":memory:");
    const fake = fakeGitHubClient([INSTALL]);
    const resolveEntitlement = createLicenseStoreEntitlementResolver(store, () => NOW);
    const harness = await startBroker({
      fake,
      licenseStore: store,
      resolveEntitlement,
      clock: () => FIXED_NOW
    });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL.id);
      const issued = issuePrivate(store);
      assert.equal(
        activate(
          store,
          { licenseKey: issued.rawKey, machineId: device.deviceId, repo: PRIVATE_REPO },
          NOW
        ).httpStatus,
        200
      );

      const response = await post(
        harness.url,
        "/github/token",
        {
          installationId: INSTALL.id,
          repositories: [PRIVATE_REPO],
          activationKey: issued.rawKey
        },
        bearer(await device.sign())
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.token, harness.mintedToken);
      assert.equal(response.text.includes(issued.rawKey), false);
    } finally {
      harness.close();
    }
  });
});
