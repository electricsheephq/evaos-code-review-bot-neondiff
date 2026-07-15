import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RateLimiter } from "../src/service.ts";
import { GitHubBrokerStore } from "../src/github-broker/index.ts";
import {
  bearer,
  connectInstallation,
  fakeGitHubClient,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type FakeGitHubCall
} from "./github-broker-support.ts";

const PUBLIC_INSTALL = {
  id: 5001,
  account_login: "octo",
  repositories: [
    { id: 21, full_name: "octo/site", visibility: "public" as const },
    { id: 22, full_name: "octo/private", visibility: "private" as const }
  ]
};

/**
 * A bespoke installation client for scenarios the default fake cannot express
 * (toggle installed/suspended after connect, throw a client error). Records call
 * order so the seam ordering invariant can be asserted.
 */
function mutableFake(config: {
  installationId: number;
  repositories?: Array<{ id: number; full_name: string; visibility: "public" | "private" | "internal" | "unknown" }>;
  installed?: boolean;
  suspended?: boolean;
  listThrows?: { brokerClientErrorClass: string };
}): { client: Record<string, unknown>; calls: FakeGitHubCall[]; state: { installed: boolean; suspended: boolean } } {
  const calls: FakeGitHubCall[] = [];
  const state = { installed: config.installed ?? true, suspended: config.suspended ?? false };
  const client = {
    async getInstallation(installationId: number) {
      calls.push({ op: "getInstallation", installationId });
      if (!state.installed) return null;
      return { id: installationId, account_login: "octo", suspended: state.suspended };
    },
    async listInstallationRepositories(installationId: number) {
      calls.push({ op: "listInstallationRepositories", installationId });
      if (config.listThrows) throw Object.assign(new Error("client error"), config.listThrows);
      return (config.repositories ?? []).map((repository) => ({ ...repository }));
    },
    async createInstallationAccessToken(installationId: number, params: unknown) {
      calls.push({ op: "createInstallationAccessToken", installationId, params });
      return { token: "broker-test-mutable-token", expires_at: new Date(Date.now() + 3_600_000).toISOString() };
    }
  };
  return { client, calls, state };
}

describe("github broker adversarial and lifecycle coverage", () => {
  it("refuses a token for a suspended installation", async () => {
    const harness = await startBroker({
      installations: [{ ...PUBLIC_INSTALL, suspended: true }]
    });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json.reason, "installation_suspended");
    } finally {
      harness.close();
    }
  });

  it("reports installation_uninstalled when a bound installation disappears", async () => {
    const fake = mutableFake({ installationId: PUBLIC_INSTALL.id, repositories: PUBLIC_INSTALL.repositories });
    const harness = await startBroker({ fake: fake as never });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      fake.state.installed = false; // uninstalled between connect and token
      const response = await post(
        harness.url,
        "/github/token",
        { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] },
        bearer(await device.sign())
      );
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json.reason, "installation_uninstalled");
    } finally {
      harness.close();
    }
  });

  it("throttles token requests past the per-device budget", async () => {
    const harness = await startBroker({
      installations: [PUBLIC_INSTALL],
      tokenRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 })
    });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      const first = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      const second = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      assert.equal(first.status, 200, first.text);
      assert.equal(second.status, 429, second.text);
      assert.equal(second.json.reason, "rate_limited");
    } finally {
      harness.close();
    }
  });

  it("maps a renamed or transferred repository to a typed refusal", async () => {
    const fake = mutableFake({
      installationId: PUBLIC_INSTALL.id,
      repositories: PUBLIC_INSTALL.repositories,
      listThrows: { brokerClientErrorClass: "renamed_or_transferred" }
    });
    // The list call must succeed at connect time; only fail at token time.
    let allowList = true;
    const original = fake.client.listInstallationRepositories as (id: number) => Promise<unknown>;
    fake.client.listInstallationRepositories = async (installationId: number) => {
      if (allowList) return PUBLIC_INSTALL.repositories.map((repository) => ({ ...repository }));
      return original(installationId);
    };
    const harness = await startBroker({ fake: fake as never });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      allowList = false;
      const response = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      assert.equal(response.status, 409, response.text);
      assert.equal(response.json.reason, "repo_renamed_or_transferred");
    } finally {
      harness.close();
    }
  });

  it("refuses a repository outside the installation selection", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      const response = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/not-selected"] }, bearer(await device.sign()));
      assert.equal(response.status, 403, response.text);
      assert.equal(response.json.reason, "repo_outside_installation");
    } finally {
      harness.close();
    }
  });

  it("refuses a token for an installation the device never connected", async () => {
    const harness = await startBroker({
      installations: [PUBLIC_INSTALL, { id: 5002, account_login: "other", repositories: [] }]
    });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      const response = await post(harness.url, "/github/token", { installationId: 5002, repositories: ["octo/site"] }, bearer(await device.sign()));
      assert.equal(response.status, 404, response.text);
      assert.equal(response.json.reason, "binding_not_found");
    } finally {
      harness.close();
    }
  });

  it("renews a token on repeated requests before expiry", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      const first = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      const renewed = await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      assert.equal(first.status, 200, first.text);
      assert.equal(renewed.status, 200, renewed.text);
      assert.equal(renewed.json.token, harness.mintedToken);
    } finally {
      harness.close();
    }
  });

  it("rejects a callback with an unknown state", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const response = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${PUBLIC_INSTALL.id}&state=never-issued`,
        { redirect: "manual" }
      );
      const text = await response.text();
      assert.equal(response.status, 404, text);
      assert.equal(JSON.parse(text).reason, "state_not_found");
    } finally {
      harness.close();
    }
  });

  it("expires a connect state after its 10-minute window", async () => {
    let clockMs = Date.parse("2026-07-15T00:00:00.000Z");
    const harness = await startBroker({ installations: [PUBLIC_INSTALL], clock: () => new Date(clockMs) });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign({ now: new Date(clockMs) })));
      const state = start.json.state as string;
      clockMs += 11 * 60 * 1_000; // advance past the 10-minute TTL
      const callback = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${PUBLIC_INSTALL.id}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" }
      );
      const text = await callback.text();
      assert.equal(callback.status, 409, text);
      assert.equal(JSON.parse(text).reason, "state_expired");
    } finally {
      harness.close();
    }
  });

  it("moves connect/complete from pending to bound across the callback", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign()));
      const state = start.json.state as string;

      const pending = await post(harness.url, "/github/connect/complete", { state }, bearer(await device.sign()));
      assert.equal(pending.json.status, "pending");

      await fetch(`${harness.url}/github/connect/callback?installation_id=${PUBLIC_INSTALL.id}&state=${encodeURIComponent(state)}`, { redirect: "manual" });

      const bound = await post(harness.url, "/github/connect/complete", { state }, bearer(await device.sign()));
      assert.equal(bound.status, 200, bound.text);
      assert.equal(bound.json.status, "bound");
      assert.equal(bound.json.installationId, PUBLIC_INSTALL.id);
    } finally {
      harness.close();
    }
  });

  it("rejects a device credential signed by the wrong key", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const registered = await makeDevice();
      const attacker = await makeDevice();
      await registerDevice(harness.url, registered);
      // Attacker signs with its own key but claims the registered device's id.
      const forged = await attacker.sign({ subject: registered.deviceId });
      const response = await post(harness.url, "/github/connect/start", {}, bearer(forged));
      assert.equal(response.status, 401, response.text);
      assert.equal(response.json.reason, "invalid_device_credential");
    } finally {
      harness.close();
    }
  });

  it("rejects an expired device credential", async () => {
    const harness = await startBroker({ installations: [PUBLIC_INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const stale = await device.sign({ now: new Date(Date.parse("2026-07-14T00:00:00.000Z")), expSeconds: 60 });
      const response = await post(harness.url, "/github/connect/start", {}, bearer(stale));
      assert.equal(response.status, 401, response.text);
      assert.equal(response.json.reason, "invalid_device_credential");
    } finally {
      harness.close();
    }
  });

  it("never mints a token before the issuance seam authorizes (call-order invariant)", async () => {
    const denyFake = fakeGitHubClient([PUBLIC_INSTALL]);
    const denyHarness = await startBroker({ fake: denyFake });
    try {
      const device = await makeDevice();
      await registerDevice(denyHarness.url, device);
      await connectInstallation(denyHarness.url, device, PUBLIC_INSTALL.id);
      const deny = await post(denyHarness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/private"] }, bearer(await device.sign()));
      assert.equal(deny.json.reason, "entitlement_gate_not_implemented");
      // A denied request must never reach the mint call.
      assert.equal(denyFake.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
    } finally {
      denyHarness.close();
    }

    const allowFake = fakeGitHubClient([PUBLIC_INSTALL]);
    const allowHarness = await startBroker({ fake: allowFake });
    try {
      const device = await makeDevice();
      await registerDevice(allowHarness.url, device);
      await connectInstallation(allowHarness.url, device, PUBLIC_INSTALL.id);
      allowFake.calls.length = 0; // isolate the issuance sequence
      const allow = await post(allowHarness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));
      assert.equal(allow.status, 200, allow.text);
      const listIndex = allowFake.calls.findIndex((call) => call.op === "listInstallationRepositories");
      const mintIndex = allowFake.calls.findIndex((call) => call.op === "createInstallationAccessToken");
      assert.ok(listIndex >= 0, "visibility list read happened");
      assert.ok(mintIndex >= 0, "token minted");
      assert.ok(mintIndex > listIndex, "mint happens only after the seam consumed the visibility list");
    } finally {
      allowHarness.close();
    }
  });

  it("records public-safe ledger rows for deny and allow, with no token material", async () => {
    const store = new GitHubBrokerStore(":memory:");
    const harness = await startBroker({ installations: [PUBLIC_INSTALL], store });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, PUBLIC_INSTALL.id);
      await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/private"] }, bearer(await device.sign()));
      await post(harness.url, "/github/token", { installationId: PUBLIC_INSTALL.id, repositories: ["octo/site"] }, bearer(await device.sign()));

      const rows = store.listDecisions(device.deviceId);
      const reasons = rows.map((row) => `${row.decision}:${row.reason_code}`);
      assert.ok(reasons.includes("deny:entitlement_gate_not_implemented"), JSON.stringify(reasons));
      assert.ok(reasons.includes("allow:issued"), JSON.stringify(reasons));
      const serialized = JSON.stringify(rows);
      assert.ok(!serialized.includes(harness.mintedToken), "no minted token in the ledger");
      assert.doesNotMatch(serialized, /-----BEGIN/); // no key material
      for (const row of rows) {
        assert.deepEqual(
          Object.keys(row).sort(),
          ["created_at", "decision", "device_id", "id", "installation_id", "reason_code"]
        );
      }
    } finally {
      harness.close();
      store.close();
    }
  });
});
