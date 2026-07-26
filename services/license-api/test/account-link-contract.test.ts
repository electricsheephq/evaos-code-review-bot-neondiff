import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import {
  bearer,
  makeDevice,
  post,
  startBroker,
  type BrokerHarness
} from "./github-broker-support.ts";
import { RateLimiter } from "../src/service.ts";

const CONNECT_ORIGIN = "https://www.neondiff.com/desktop/connect";

const workspaceSnapshot = {
  accounts: [
    {
      id: "account-electric-sheep",
      kind: "organization",
      name: "ElectricSheep",
      role: "admin",
      entitlement: "internal_admin",
      bots: [
        {
          id: "bot-evaos-code-review-bot",
          appId: 4_184_532,
          appSlug: "evaos-code-review-bot",
          mode: "byo",
          githubInstallationId: null,
          githubAccountLogin: "electricsheephq",
          status: "pending"
        }
      ]
    }
  ]
} as const;

describe("Lovable account link contract", () => {
  const harnesses: BrokerHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.close();
  });

  test("signed device starts, authenticated browser completes, and that device loads the snapshot", async () => {
    const seenTokens: string[] = [];
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken(token: string) {
          seenTokens.push(token);
          return token === "lovable-user-token" ? "user-owner" : null;
        },
        async loadWorkspaceSnapshot(userId: string) {
          assert.equal(userId, "user-owner");
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    assert.equal((await registerAccountDevice(harness.url, device)).status, 200);

    const start = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign())
    );
    assert.equal(start.status, 200);
    assert.equal(start.json.status, "account_connect_started");
    assert.match(start.json.connectUrl, /^https:\/\/www\.neondiff\.com\/desktop\/connect\?state=/);
    assert.equal(typeof start.json.state, "string");

    const complete = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );
    assert.equal(complete.status, 200);
    assert.deepEqual(complete.json, { status: "account_linked" });

    const snapshot = await post(
      harness.url,
      "/account/workspaces",
      {},
      bearer(await device.sign())
    );
    assert.equal(snapshot.status, 200);
    assert.deepEqual(snapshot.json, { status: "ready", ...workspaceSnapshot });
    assert.deepEqual(seenTokens, ["lovable-user-token"]);
    assert.doesNotMatch(JSON.stringify(snapshot.json), /lovable-user-token/);
  });

  test("a reconnect must consume its exact new state before replacing or reading an old binding", async () => {
    const loadedUserIds: string[] = [];
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken(token: string) {
          if (token === "first-user-token") return "first-user";
          if (token === "second-user-token") return "second-user";
          return null;
        },
        async loadWorkspaceSnapshot(userId: string) {
          loadedUserIds.push(userId);
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);

    const first = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign())
    );
    await post(
      harness.url,
      "/account/connect/complete",
      { state: first.json.state },
      bearer("first-user-token")
    );

    const reconnect = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign())
    );
    const premature = await post(
      harness.url,
      "/account/workspaces",
      { state: reconnect.json.state },
      bearer(await device.sign())
    );
    assert.equal(premature.status, 403);
    assert.equal(premature.json.reason, "account_link_required");
    assert.deepEqual(loadedUserIds, []);

    await post(
      harness.url,
      "/account/connect/complete",
      { state: reconnect.json.state },
      bearer("second-user-token")
    );
    const refreshed = await post(
      harness.url,
      "/account/workspaces",
      { state: reconnect.json.state },
      bearer(await device.sign())
    );
    assert.equal(refreshed.status, 200);
    assert.equal(refreshed.json.status, "ready");
    assert.deepEqual(loadedUserIds, ["second-user"]);
  });

  test("link state is single-use", async () => {
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);
    const start = await post(harness.url, "/account/connect/start", {}, bearer(await device.sign()));

    const first = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );
    const replay = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );

    assert.equal(first.status, 200);
    assert.equal(replay.status, 409);
    assert.equal(replay.json.reason, "state_replayed");
  });

  test("a different device cannot read the linked account", async () => {
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const ownerDevice = await makeDevice();
    const otherDevice = await makeDevice();
    await registerAccountDevice(harness.url, ownerDevice);
    await registerAccountDevice(harness.url, otherDevice);
    const start = await post(harness.url, "/account/connect/start", {}, bearer(await ownerDevice.sign()));
    await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );

    const denied = await post(
      harness.url,
      "/account/workspaces",
      {},
      bearer(await otherDevice.sign())
    );
    assert.equal(denied.status, 403);
    assert.equal(denied.json.reason, "account_link_required");
  });

  test("invalid browser identity and authority outage both fail closed", async () => {
    const invalidHarness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return null;
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(invalidHarness);
    const invalidDevice = await makeDevice();
    await registerAccountDevice(invalidHarness.url, invalidDevice);
    const invalidStart = await post(
      invalidHarness.url,
      "/account/connect/start",
      {},
      bearer(await invalidDevice.sign())
    );
    const invalid = await post(
      invalidHarness.url,
      "/account/connect/complete",
      { state: invalidStart.json.state },
      bearer("bad-token")
    );
    assert.equal(invalid.status, 403);
    assert.equal(invalid.json.reason, "account_identity_unverified");

    const outageHarness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          throw new Error("sensitive upstream detail");
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(outageHarness);
    const outageDevice = await makeDevice();
    await registerAccountDevice(outageHarness.url, outageDevice);
    const outageStart = await post(
      outageHarness.url,
      "/account/connect/start",
      {},
      bearer(await outageDevice.sign())
    );
    const outage = await post(
      outageHarness.url,
      "/account/connect/complete",
      { state: outageStart.json.state },
      bearer("lovable-user-token")
    );
    assert.equal(outage.status, 503);
    assert.equal(outage.json.reason, "account_authority_unavailable");
    assert.doesNotMatch(outage.text, /sensitive upstream detail/);
  });

  test("rate-limits browser completion before calling the Supabase identity seam", async () => {
    let identityCalls = 0;
    const harness = await startBroker({
      accountCompleteRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          identityCalls += 1;
          return null;
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);
    const start = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign())
    );

    const first = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("first-invalid-token")
    );
    const throttled = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("second-invalid-token")
    );

    assert.equal(first.status, 403);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.json.reason, "rate_limited");
    assert.equal(identityCalls, 1);
  });

  test("rate-limits workspace refreshes before calling the Supabase authority", async () => {
    let workspaceCalls = 0;
    const harness = await startBroker({
      accountWorkspaceRateLimiter: new RateLimiter({ maxPerWindow: 1, windowMs: 60_000 }),
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          workspaceCalls += 1;
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);
    const start = await post(harness.url, "/account/connect/start", {}, bearer(await device.sign()));
    await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );

    const first = await post(
      harness.url,
      "/account/workspaces",
      {},
      bearer(await device.sign())
    );
    const throttled = await post(
      harness.url,
      "/account/workspaces",
      {},
      bearer(await device.sign())
    );

    assert.equal(first.status, 200);
    assert.equal(throttled.status, 429);
    assert.equal(throttled.json.reason, "rate_limited");
    assert.equal(workspaceCalls, 1);
  });

  test("permits CORS only for the configured NeonDiff connect origin", async () => {
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);

    const allowed = await fetch(`${harness.url}/account/connect/complete`, {
      method: "OPTIONS",
      headers: {
        Origin: "https://www.neondiff.com",
        "Access-Control-Request-Method": "POST",
        "Access-Control-Request-Headers": "authorization,content-type"
      }
    });
    assert.equal(allowed.status, 204);
    assert.equal(allowed.headers.get("access-control-allow-origin"), "https://www.neondiff.com");
    assert.equal(allowed.headers.get("vary"), "Origin");

    const denied = await fetch(`${harness.url}/account/connect/complete`, {
      method: "POST",
      headers: {
        Origin: "https://attacker.example",
        Authorization: "Bearer never-forwarded",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ state: "a".repeat(43) })
    });
    assert.equal(denied.status, 403);
    assert.equal(denied.headers.get("access-control-allow-origin"), null);
  });

  test("expired state and disabled account runtime return typed safe failures", async () => {
    let clock = new Date("2026-07-26T06:00:00.000Z");
    const harness = await startBroker({
      clock: () => clock,
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);
    const start = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign({ now: clock }))
    );
    clock = new Date(clock.getTime() + 10 * 60 * 1_000 + 1);
    const expired = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );
    assert.equal(expired.status, 409);
    assert.equal(expired.json.reason, "state_expired");

    const disabled = await startBroker();
    harnesses.push(disabled);
    const unavailable = await post(disabled.url, "/account/connect/start", {});
    assert.equal(unavailable.status, 503);
    assert.equal(unavailable.json.reason, "account_authority_unavailable");
  });

  test("state that expires during identity verification is not consumed or bound", async () => {
    let clock = new Date("2026-07-26T06:00:00.000Z");
    const harness = await startBroker({
      clock: () => clock,
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          clock = new Date("2026-07-26T06:10:00.001Z");
          return "user-owner";
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await registerAccountDevice(harness.url, device);
    const start = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign({ now: clock }))
    );

    const expired = await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );
    const workspace = await post(
      harness.url,
      "/account/workspaces",
      {},
      bearer(await device.sign({ now: clock }))
    );

    assert.equal(expired.status, 409);
    assert.equal(expired.json.reason, "state_expired");
    assert.equal(workspace.status, 403);
    assert.equal(workspace.json.reason, "account_link_required");
  });
});

async function registerAccountDevice(url: string, device: Awaited<ReturnType<typeof makeDevice>>) {
  return post(url, "/account/device/register", { publicKeyJwk: device.publicJwk });
}
