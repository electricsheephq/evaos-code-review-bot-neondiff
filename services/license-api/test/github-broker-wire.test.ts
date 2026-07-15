import assert from "node:assert/strict";
import type { Server } from "node:http";
import { describe, it } from "node:test";
import { LicenseStore } from "../src/store.ts";
import { startLicenseServer } from "../src/http.ts";
import { MINIMAL_REVIEW_PERMISSIONS } from "../src/github-broker/index.ts";
import {
  bearer,
  connectInstallation,
  makeDevice,
  post,
  registerDevice,
  startBroker
} from "./github-broker-support.ts";

const INSTALL = {
  id: 6001,
  account_login: "octo",
  repositories: [
    { id: 71, full_name: "octo/site", visibility: "public" as const },
    { id: 72, full_name: "octo/docs", visibility: "public" as const }
  ]
};

async function issue(url: string, device: Awaited<ReturnType<typeof makeDevice>>, body: Record<string, unknown>) {
  return post(url, "/github/token", { installationId: INSTALL.id, ...body }, bearer(await device.sign()));
}

describe("github broker token wire contract", () => {
  it("mints with repository_ids, not owner/name full names", async () => {
    const harness = await startBroker({ installations: [INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL.id);
      const response = await issue(harness.url, device, { repositories: ["octo/site", "octo/docs"] });
      assert.equal(response.status, 200, response.text);
      const mint = harness.calls.find((call) => call.op === "createInstallationAccessToken");
      const params = mint?.params as { repositoryIds?: number[]; repositories?: unknown };
      assert.deepEqual(params.repositoryIds, [71, 72]);
      assert.equal(params.repositories, undefined, "wire uses repository_ids, never full names");
    } finally {
      harness.close();
    }
  });

  it("mints with the server-defined minimal review permissions when the device omits them", async () => {
    const harness = await startBroker({ installations: [INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL.id);
      const response = await issue(harness.url, device, { repositories: ["octo/site"] });
      assert.equal(response.status, 200, response.text);
      const mint = harness.calls.find((call) => call.op === "createInstallationAccessToken");
      const params = mint?.params as { permissions?: Record<string, string> };
      assert.deepEqual(params.permissions, MINIMAL_REVIEW_PERMISSIONS);
      assert.deepEqual(response.json.permissions, MINIMAL_REVIEW_PERMISSIONS);
    } finally {
      harness.close();
    }
  });

  it("allows a subset of the minimal permissions", async () => {
    const harness = await startBroker({ installations: [INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL.id);
      const response = await issue(harness.url, device, {
        repositories: ["octo/site"],
        permissions: { contents: "read", pull_requests: "read" }
      });
      assert.equal(response.status, 200, response.text);
      const mint = harness.calls.find((call) => call.op === "createInstallationAccessToken");
      assert.deepEqual((mint?.params as { permissions?: Record<string, string> }).permissions, {
        contents: "read",
        pull_requests: "read"
      });
    } finally {
      harness.close();
    }
  });

  it("refuses a permission outside the minimal review allowlist", async () => {
    const harness = await startBroker({ installations: [INSTALL] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, INSTALL.id);
      const overScope = await issue(harness.url, device, {
        repositories: ["octo/site"],
        permissions: { contents: "write" }
      });
      assert.equal(overScope.status, 400, overScope.text);
      assert.equal(overScope.json.reason, "invalid_request");
      const unknown = await issue(harness.url, device, {
        repositories: ["octo/site"],
        permissions: { administration: "read" }
      });
      assert.equal(unknown.status, 400, unknown.text);
      assert.equal(unknown.json.reason, "invalid_request");
      // Fail closed: neither over-privileged request minted a token.
      assert.equal(harness.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
    } finally {
      harness.close();
    }
  });

  it("expires a stale connect poll instead of pending forever", async () => {
    let clockMs = Date.parse("2026-07-15T00:00:00.000Z");
    const harness = await startBroker({ installations: [INSTALL], clock: () => new Date(clockMs) });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign({ now: new Date(clockMs) })));
      const state = start.json.state as string;
      clockMs += 11 * 60 * 1_000; // past the 10-minute TTL, callback never consumed
      const complete = await post(
        harness.url,
        "/github/connect/complete",
        { state },
        bearer(await device.sign({ now: new Date(clockMs) }))
      );
      assert.equal(complete.status, 409, complete.text);
      assert.equal(complete.json.reason, "state_expired");
    } finally {
      harness.close();
    }
  });

  it("returns a typed broker_unavailable when the broker is not configured", async () => {
    const store = new LicenseStore(":memory:");
    let server: Server | undefined;
    try {
      const started = await startLicenseServer({ store });
      server = started.server;
      const response = await post(started.url, "/github/token", { installationId: 1, repositories: ["octo/site"] });
      assert.equal(response.status, 503, response.text);
      assert.equal(response.json.reason, "broker_unavailable");
    } finally {
      server?.close();
      store.close();
    }
  });
});
