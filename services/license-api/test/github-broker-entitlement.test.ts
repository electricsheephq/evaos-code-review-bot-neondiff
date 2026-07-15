import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EntitlementResolutionContext, EntitlementSnapshot } from "../src/github-broker/index.ts";
import {
  bearer,
  connectInstallation,
  fakeGitHubClient,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type FakeInstallation
} from "./github-broker-support.ts";

/**
 * Call-order and zero-egress coverage for the #614 entitlement binding at the
 * single mint path (the broker's one caller of the issuance seam). Every private
 * request must have its entitlement decided BEFORE any usable installation token
 * is minted, and every denied path must produce zero token mints (no content
 * egress). The entitlement authority is fixture-injected; the public/free tier
 * must never touch it.
 */

const INSTALL: FakeInstallation = {
  id: 7001,
  account_login: "octo",
  repositories: [
    { id: 81, full_name: "octo/site", visibility: "public" },
    { id: 82, full_name: "octo/private", visibility: "private" },
    { id: 83, full_name: "octo/internal", visibility: "internal" }
  ]
};

const ACTIVE_PRIVATE: EntitlementSnapshot = {
  status: "active",
  coveredPrivateRepositories: ["octo/private", "octo/internal"]
};

interface RecordingResolver {
  resolveEntitlement: (context: EntitlementResolutionContext) => EntitlementSnapshot;
  contexts: EntitlementResolutionContext[];
  /** Count of minted installation tokens observed at each resolver invocation. */
  mintCountsAtResolve: number[];
}

/**
 * A resolver returning a fixed snapshot (or throwing to model a license-service
 * outage) that records, at call time, how many installation tokens have already
 * been minted — proving the entitlement decision precedes the mint.
 */
function recordingResolver(
  snapshot: EntitlementSnapshot | "throws",
  calls: { op: string }[]
): RecordingResolver {
  const contexts: EntitlementResolutionContext[] = [];
  const mintCountsAtResolve: number[] = [];
  return {
    contexts,
    mintCountsAtResolve,
    resolveEntitlement(context: EntitlementResolutionContext): EntitlementSnapshot {
      contexts.push(context);
      mintCountsAtResolve.push(calls.filter((call) => call.op === "createInstallationAccessToken").length);
      if (snapshot === "throws") throw new Error("license service unreachable");
      return snapshot;
    }
  };
}

async function boundDevice(url: string) {
  const device = await makeDevice();
  await registerDevice(url, device);
  await connectInstallation(url, device, INSTALL.id);
  return device;
}

describe("github broker entitlement binding at the mint path (#614)", () => {
  it("mints a private token only after an active private-covering entitlement is resolved", async () => {
    const fake = fakeGitHubClient([INSTALL]);
    const resolver = recordingResolver(ACTIVE_PRIVATE, fake.calls);
    const harness = await startBroker({ fake, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await boundDevice(harness.url);
      fake.calls.length = 0; // isolate the issuance sequence
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL.id, repositories: ["octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(response.json.token, harness.mintedToken);

      // Entitlement was resolved for the private repo, before the mint.
      assert.equal(resolver.contexts.length, 1);
      assert.deepEqual(resolver.contexts[0].privateRepositories, ["octo/private"]);
      assert.equal(resolver.contexts[0].accountLogin, "octo");
      assert.deepEqual(resolver.mintCountsAtResolve, [0], "no token minted before entitlement decided");

      const listIndex = fake.calls.findIndex((call) => call.op === "listInstallationRepositories");
      const mintIndex = fake.calls.findIndex((call) => call.op === "createInstallationAccessToken");
      assert.ok(listIndex >= 0 && mintIndex > listIndex, "mint follows the visibility read");
      const mint = fake.calls.find((call) => call.op === "createInstallationAccessToken");
      assert.deepEqual((mint?.params as { repositoryIds?: number[] }).repositoryIds, [82]);
    } finally {
      harness.close();
    }
  });

  it("does NOT consult the entitlement authority for an all-public request (public-free)", async () => {
    const fake = fakeGitHubClient([INSTALL]);
    const resolver = recordingResolver(ACTIVE_PRIVATE, fake.calls);
    const harness = await startBroker({ fake, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await boundDevice(harness.url);
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL.id, repositories: ["octo/site"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(resolver.contexts.length, 0, "public-free issuance never calls the license service");
    } finally {
      harness.close();
    }
  });

  it("resolves entitlement for the mixed public+private set and mints both on allow", async () => {
    const fake = fakeGitHubClient([INSTALL]);
    const resolver = recordingResolver(ACTIVE_PRIVATE, fake.calls);
    const harness = await startBroker({ fake, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await boundDevice(harness.url);
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL.id, repositories: ["octo/site", "octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 200, response.text);
      // Only the non-public repositories are handed to the entitlement authority.
      assert.deepEqual(resolver.contexts[0].privateRepositories, ["octo/private"]);
      const mint = fake.calls.find((call) => call.op === "createInstallationAccessToken");
      assert.deepEqual((mint?.params as { repositoryIds?: number[] }).repositoryIds, [81, 82]);
    } finally {
      harness.close();
    }
  });

  const denyCases: Array<{ name: string; snapshot: EntitlementSnapshot | "throws"; status: number; reason: string }> = [
    { name: "public-only active license", snapshot: { status: "active", coveredPrivateRepositories: [] }, status: 403, reason: "entitlement_scope_insufficient" },
    { name: "expired", snapshot: { status: "expired" }, status: 403, reason: "entitlement_expired" },
    { name: "revoked", snapshot: { status: "revoked" }, status: 403, reason: "entitlement_revoked" },
    { name: "invalid", snapshot: { status: "invalid" }, status: 403, reason: "entitlement_invalid" },
    { name: "over seat", snapshot: { status: "seat_exhausted" }, status: 409, reason: "entitlement_seat_exhausted" },
    { name: "replay conflict", snapshot: { status: "replay_conflict" }, status: 409, reason: "entitlement_replay_conflict" },
    { name: "license service outage (resolver throws)", snapshot: "throws", status: 503, reason: "entitlement_service_unavailable" }
  ];

  for (const testCase of denyCases) {
    it(`fails closed with ${testCase.reason} and zero content egress: ${testCase.name}`, async () => {
      const fake = fakeGitHubClient([INSTALL]);
      const resolver = recordingResolver(testCase.snapshot, fake.calls);
      const harness = await startBroker({ fake, resolveEntitlement: resolver.resolveEntitlement });
      try {
        const device = await boundDevice(harness.url);
        fake.calls.length = 0;
        const response = await post(
          harness.url,
          "/github/token",
          { installationId: INSTALL.id, repositories: ["octo/private"] },
          bearer(await device.sign())
        );
        assert.equal(response.status, testCase.status, response.text);
        assert.equal(response.json.reason, testCase.reason);
        assert.equal(response.json.token, undefined);
        // Zero content egress: no usable installation token minted on a blocked path.
        assert.equal(fake.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
      } finally {
        harness.close();
      }
    });
  }

  it("a provider key never substitutes for entitlement: the default authority denies private as entitlement_missing", async () => {
    // No resolver configured -> the fail-closed default. A device could hold any
    // provider key locally; the broker has no provider-key input, so private stays
    // denied until an active private-covering entitlement is resolved.
    const fake = fakeGitHubClient([INSTALL]);
    const harness = await startBroker({ fake });
    try {
      const device = await boundDevice(harness.url);
      fake.calls.length = 0;
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL.id, repositories: ["octo/internal"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.reason, "entitlement_missing");
      assert.equal(fake.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
    } finally {
      harness.close();
    }
  });
});
