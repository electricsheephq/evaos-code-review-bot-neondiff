import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import {
  bearer,
  connectInstallation,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type BrokerHarness,
  type TestDevice
} from "./github-broker-support.ts";

/**
 * Contract tests for the token-issuance boundary (#613). These assert the
 * broker's fail-closed refusals and that no App key or JWT material ever leaves
 * the service. Red before the broker exists (routes 404); green once wired.
 */
describe("github broker token-issuance contract", () => {
  let harness: BrokerHarness;
  let device: TestDevice;

  before(async () => {
    device = await makeDevice();
    harness = await startBroker({
      installations: [
        {
          id: 4001,
          account_login: "octo-public",
          repositories: [
            { id: 11, full_name: "octo-public/site", visibility: "public" },
            { id: 12, full_name: "octo-public/secret", visibility: "private" }
          ]
        }
      ]
    });
    await registerDevice(harness.url, device);
  });

  after(() => harness.close());

  it("(a) refuses a token for an unbound (device, installation) with a typed refusal", async () => {
    const response = await post(
      harness.url,
      "/github/token",
      { installationId: 4001, repositories: ["octo-public/site"] },
      bearer(await device.sign())
    );
    assert.equal(response.status, 404);
    assert.equal(response.json.reason, "binding_not_found");
  });

  it("(b) mints a bounded token for a public repo and leaks no key or JWT material", async () => {
    const fresh = await makeDevice();
    await registerDevice(harness.url, fresh);
    await connectInstallation(harness.url, fresh, 4001);

    const response = await post(
      harness.url,
      "/github/token",
      { installationId: 4001, repositories: ["octo-public/site"] },
      bearer(await fresh.sign())
    );
    assert.equal(response.status, 200, response.text);
    assert.equal(response.json.token, harness.mintedToken);
    assert.ok(response.json.expiresAt, "expiry is returned");

    // No App private key PEM and no JWT (three dot-separated base64url segments)
    // may appear anywhere in the response body.
    assert.doesNotMatch(response.text, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
    assert.doesNotMatch(response.text, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
  });

  it("(c) refuses issuance for a private repo with entitlement_gate_not_implemented", async () => {
    const fresh = await makeDevice();
    await registerDevice(harness.url, fresh);
    await connectInstallation(harness.url, fresh, 4001);

    const response = await post(
      harness.url,
      "/github/token",
      { installationId: 4001, repositories: ["octo-public/secret"] },
      bearer(await fresh.sign())
    );
    assert.equal(response.status, 403);
    assert.equal(response.json.reason, "entitlement_gate_not_implemented");
    // Fail closed: no token minted for the denied request.
    assert.equal(response.json.token, undefined);
  });

  it("(d) rejects a replayed connect-state nonce with state_replayed", async () => {
    const fresh = await makeDevice();
    await registerDevice(harness.url, fresh);
    const start = await post(harness.url, "/github/connect/start", {}, bearer(await fresh.sign()));
    const state = start.json.state as string;
    assert.ok(state, "connect start returns a state nonce");

    const first = await fetch(
      `${harness.url}/github/connect/callback?installation_id=4001&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    assert.ok(first.status < 400 || first.status === 302, `first callback consumed: ${first.status}`);

    const replay = await fetch(
      `${harness.url}/github/connect/callback?installation_id=4001&state=${encodeURIComponent(state)}`,
      { redirect: "manual" }
    );
    const replayText = await replay.text();
    assert.equal(replay.status, 409, replayText);
    assert.equal(JSON.parse(replayText).reason, "state_replayed");
  });
});
