import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GitHubBrokerStore } from "../src/github-broker/index.ts";
import type {
  EntitlementResolutionContext,
  EntitlementSnapshot
} from "../src/github-broker/index.ts";
import {
  bearer,
  connectInstallation,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type FakeGitHubCall
} from "./github-broker-support.ts";

/**
 * Adversarial fixtures for the #614 authorization boundary (issue "Testing Plan",
 * Adversarial row): the server's GitHub-authoritative visibility must win over any
 * client belief, and no attempt — stale visibility, a modified client asserting
 * public, repo rename/transfer, install swap, entitlement replay, or a
 * binding-skipping direct call — may mint a usable token for a private repo
 * without an active entitlement. Denials that precede the seam must never even
 * consult the entitlement authority.
 */

type Visibility = "public" | "private" | "internal" | "unknown";

/**
 * A mutable installation client whose repository visibility can be flipped
 * between the connect and token phases, and which can be made to throw a
 * rename/transfer client error at token time. Records call order.
 */
function mutableFake(config: {
  installationId: number;
  repositories: Array<{ id: number; full_name: string; visibility: Visibility }>;
}): {
  client: Record<string, unknown>;
  calls: FakeGitHubCall[];
  setVisibility(fullName: string, visibility: Visibility): void;
  failListWith(brokerClientErrorClass: string): void;
} {
  const calls: FakeGitHubCall[] = [];
  const repositories = config.repositories.map((repository) => ({ ...repository }));
  let listFailure: { brokerClientErrorClass: string } | undefined;
  return {
    calls,
    setVisibility(fullName, visibility) {
      const repository = repositories.find((candidate) => candidate.full_name === fullName);
      if (repository) repository.visibility = visibility;
    },
    failListWith(brokerClientErrorClass) {
      listFailure = { brokerClientErrorClass };
    },
    client: {
      async getInstallation(installationId: number) {
        calls.push({ op: "getInstallation", installationId });
        return { id: installationId, account_login: "octo", suspended: false };
      },
      async listInstallationRepositories(installationId: number) {
        calls.push({ op: "listInstallationRepositories", installationId });
        if (listFailure) throw Object.assign(new Error("client error"), listFailure);
        return repositories.map((repository) => ({ ...repository }));
      },
      async createInstallationAccessToken(installationId: number, params: unknown) {
        calls.push({ op: "createInstallationAccessToken", installationId, params });
        return { token: "broker-test-adversarial-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
      }
    }
  };
}

function countingResolver(snapshot: EntitlementSnapshot): {
  resolveEntitlement: (context: EntitlementResolutionContext) => EntitlementSnapshot;
  contexts: EntitlementResolutionContext[];
} {
  const contexts: EntitlementResolutionContext[] = [];
  return {
    contexts,
    resolveEntitlement(context) {
      contexts.push(context);
      return snapshot;
    }
  };
}

const INSTALL_ID = 8001;
const baseRepositories = [
  { id: 91, full_name: "octo/site", visibility: "public" as Visibility },
  { id: 92, full_name: "octo/private", visibility: "private" as Visibility }
];

function mints(calls: FakeGitHubCall[]): number {
  return calls.filter((call) => call.op === "createInstallationAccessToken").length;
}

describe("github broker #614 adversarial entitlement boundary", () => {
  it("stale visibility: a repo public at connect but private at token requires entitlement (server wins)", async () => {
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "none" });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      // The repo the client saw as public is now private on GitHub's side.
      fake.setVisibility("octo/site", "private");
      fake.calls.length = 0;
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/site"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.reason, "entitlement_missing");
      assert.equal(mints(fake.calls), 0, "no token minted on the freshly-private repo");
    } finally {
      harness.close();
    }
  });

  it("modified client asserting public cannot unlock a server-private repo without entitlement", async () => {
    // The token request body carries no visibility field; the broker derives it
    // from GitHub. A tampered client believing octo/private is public gains nothing.
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "none" });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      fake.calls.length = 0;
      const response = await post(
        harness.url,
        "/github/token",
        // A modified client even tries to smuggle a visibility hint; the broker ignores it.
        { installationId: INSTALL_ID, repositories: ["octo/private"], visibility: "public" },
        bearer(await device.sign())
      );
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.reason, "entitlement_missing");
      assert.equal(mints(fake.calls), 0);
    } finally {
      harness.close();
    }
  });

  it("mints for the same server-private repo once an active private-covering entitlement exists", async () => {
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "active", coveredPrivateRepositories: ["octo/private"] });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      fake.calls.length = 0;
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 200, response.text);
      assert.equal(mints(fake.calls), 1);
      assert.deepEqual(resolver.contexts[0].privateRepositories, ["octo/private"]);
    } finally {
      harness.close();
    }
  });

  it("repo rename/transfer at issuance fails typed and never reaches the entitlement authority or a mint", async () => {
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "active", coveredPrivateRepositories: ["octo/private"] });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      fake.calls.length = 0;
      fake.failListWith("renamed_or_transferred");
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json.reason, "repo_renamed_or_transferred");
      assert.equal(resolver.contexts.length, 0, "a pre-seam failure never consults the license authority");
      assert.equal(mints(fake.calls), 0);
    } finally {
      harness.close();
    }
  });

  it("install swap: a private repo outside the installation selection is refused before the seam", async () => {
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "active", coveredPrivateRepositories: ["octo/private"] });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      fake.calls.length = 0;
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/not-in-selection"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.reason, "repo_outside_installation");
      assert.equal(resolver.contexts.length, 0);
      assert.equal(mints(fake.calls), 0);
    } finally {
      harness.close();
    }
  });

  it("direct call skipping the connect/binding flow cannot reach the entitlement seam or a mint", async () => {
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "active", coveredPrivateRepositories: ["octo/private"] });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device); // registered but never connected/bound
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 404, response.text);
      assert.equal(response.json.reason, "binding_not_found");
      assert.equal(resolver.contexts.length, 0);
      assert.equal(mints(fake.calls), 0);
    } finally {
      harness.close();
    }
  });

  it("entitlement replay/event-order conflict fails closed and is recorded in the public-safe ledger", async () => {
    const store = new GitHubBrokerStore(":memory:");
    const fake = mutableFake({ installationId: INSTALL_ID, repositories: baseRepositories });
    const resolver = countingResolver({ status: "replay_conflict" });
    const harness = await startBroker({ fake: { client: fake.client, calls: fake.calls, mintedToken: "x" } as never, store, resolveEntitlement: resolver.resolveEntitlement });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL_ID);
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: INSTALL_ID, repositories: ["octo/private"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json.reason, "entitlement_replay_conflict");

      const rows = store.listDecisions(device.deviceId);
      const reasons = rows.map((row) => `${row.decision}:${row.reason_code}`);
      assert.ok(reasons.includes("deny:entitlement_replay_conflict"), JSON.stringify(reasons));
      // Ledger stays public-safe: fixed columns, no repo names or key material.
      const serialized = JSON.stringify(rows);
      assert.doesNotMatch(serialized, /octo\/private/);
      assert.doesNotMatch(serialized, /-----BEGIN/);
    } finally {
      harness.close();
      store.close();
    }
  });
});
