import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizationCodeFor,
  bearer,
  connectInstallation,
  makeDevice,
  post,
  registerDevice,
  startBroker,
  type FakeInstallation
} from "./github-broker-support.ts";

/**
 * Install-binding identity coverage (PR #620 AC8, P1). The callback must prove
 * the identity completing the flow is authorized for the installation before it
 * records any (device, installation) binding. Without that proof a valid
 * connect-state alone could bind a device to an arbitrary VICTIM installation id
 * (small enumerable int), then mint a contents:read + pull_requests:write token
 * on the victim's repos. These tests prove the forgery is refused with zero
 * binding, and that a legitimate identity-proving callback still binds.
 */

const VICTIM: FakeInstallation = {
  id: 9002,
  account_login: "victim-org",
  repositories: [{ id: 61, full_name: "victim-org/site", visibility: "public" }]
};
const ATTACKER: FakeInstallation = {
  id: 9001,
  account_login: "attacker",
  repositories: []
};

describe("github broker callback install-binding identity (#620 P1)", () => {
  it("refuses a forged callback that carries a valid state but no installation-ownership proof", async () => {
    const harness = await startBroker({ installations: [VICTIM, ATTACKER] });
    try {
      const attacker = await makeDevice();
      await registerDevice(harness.url, attacker);
      // Attacker gets a legitimate state for their OWN device via connect/start...
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await attacker.sign()));
      const state = start.json.state as string;

      // ...then hits the callback directly with the VICTIM installation id and no
      // OAuth code (no GitHub round-trip proving they own installation 9002).
      const forged = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${VICTIM.id}&state=${encodeURIComponent(state)}`,
        { redirect: "manual" }
      );
      const forgedText = await forged.text();
      assert.equal(forged.status, 403, forgedText);
      assert.equal(JSON.parse(forgedText).reason, "installation_authorization_unverified");

      // No binding was recorded: a token request for the victim installation fails
      // closed with binding_not_found, and nothing was minted.
      const token = await post(
        harness.url,
        "/github/token",
        { installationId: VICTIM.id, repositories: ["victim-org/site"] },
        bearer(await attacker.sign())
      );
      assert.equal(token.status, 404, token.text);
      assert.equal(token.json.reason, "binding_not_found");
      assert.equal(harness.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
    } finally {
      harness.close();
    }
  });

  it("refuses a callback whose OAuth code authorizes a different installation than requested", async () => {
    const harness = await startBroker({ installations: [VICTIM, ATTACKER] });
    try {
      const attacker = await makeDevice();
      await registerDevice(harness.url, attacker);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await attacker.sign()));
      const state = start.json.state as string;

      // The attacker holds a code proving ownership of their OWN installation
      // (9001) but targets the victim's installation (9002).
      const crossed = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${VICTIM.id}&state=${encodeURIComponent(state)}&code=${encodeURIComponent(authorizationCodeFor(ATTACKER.id))}`,
        { redirect: "manual" }
      );
      const crossedText = await crossed.text();
      assert.equal(crossed.status, 403, crossedText);
      assert.equal(JSON.parse(crossedText).reason, "installation_authorization_unverified");
    } finally {
      harness.close();
    }
  });

  it("binds and issues when the callback proves installation ownership (legitimate flow)", async () => {
    const harness = await startBroker({ installations: [VICTIM] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const result = await connectInstallation(harness.url, device, VICTIM.id);
      assert.ok(result.callbackStatus < 400 || result.callbackStatus === 302, `callback ok: ${result.callbackStatus}`);

      const token = await post(
        harness.url,
        "/github/token",
        { installationId: VICTIM.id, repositories: ["victim-org/site"] },
        bearer(await device.sign())
      );
      assert.equal(token.status, 200, token.text);
      assert.equal(token.json.token, harness.mintedToken);
    } finally {
      harness.close();
    }
  });

  it("acknowledges a bare Setup-URL redirect (setup_action, no code) without binding or resolving", async () => {
    const harness = await startBroker({ installations: [VICTIM] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign()));
      const state = start.json.state as string;
      harness.calls.length = 0;
      const setup = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${VICTIM.id}&state=${encodeURIComponent(state)}&setup_action=install`,
        { redirect: "manual" }
      );
      assert.equal(setup.status, 200, await setup.text());
      // A code-less setup redirect never resolves the installation or binds.
      assert.equal(harness.calls.filter((call) => call.op === "getInstallation").length, 0);
      const token = await post(
        harness.url,
        "/github/token",
        { installationId: VICTIM.id, repositories: ["victim-org/site"] },
        bearer(await device.sign())
      );
      assert.equal(token.status, 404, token.text);
      assert.equal(token.json.reason, "binding_not_found");
    } finally {
      harness.close();
    }
  });

  it("rejects a forged OAuth callback BEFORE resolving the installation (no App-JWT probe oracle)", async () => {
    const harness = await startBroker({ installations: [VICTIM, ATTACKER] });
    try {
      const attacker = await makeDevice();
      await registerDevice(harness.url, attacker);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await attacker.sign()));
      const state = start.json.state as string;
      harness.calls.length = 0;
      // A code proving the attacker's OWN installation, aimed at the victim id.
      const forged = await fetch(
        `${harness.url}/github/connect/callback?installation_id=${VICTIM.id}&state=${encodeURIComponent(state)}&code=${encodeURIComponent(authorizationCodeFor(ATTACKER.id))}`,
        { redirect: "manual" }
      );
      assert.equal(forged.status, 403, await forged.text());
      // Identity is verified before resolution, so the supplied victim id is never
      // resolved via an App JWT — no 403-vs-404 existence oracle.
      assert.equal(harness.calls.filter((call) => call.op === "getInstallation").length, 0);
    } finally {
      harness.close();
    }
  });
});
