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
  userAccessTokenFor,
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

  it("confines the binding to the user's accessible repos: an unauthorized repo in the SAME installation is refused with zero mint (#620 P1)", async () => {
    // An org installation with two private repos where the connecting OAuth user
    // can access repo-a but NOT repo-b. /user/installations proves installation
    // membership; only /user/installations/{id}/repositories proves per-repo access.
    const ORG: FakeInstallation = {
      id: 9100,
      account_login: "org",
      repositories: [
        { id: 71, full_name: "org/repo-a", visibility: "private" },
        { id: 72, full_name: "org/repo-b", visibility: "private" }
      ],
      userRepositories: ["org/repo-a"]
    };
    // Entitlement COVERS both private repos, isolating the per-repo access gate as
    // the sole reason repo-b is refused (proving it is not merely an entitlement
    // miss). A COUNTING SPY records every resolver call so we can assert the
    // per-repo denial happens BEFORE entitlement resolution.
    let entitlementCalls = 0;
    const harness = await startBroker({
      installations: [ORG],
      resolveEntitlement: () => {
        entitlementCalls += 1;
        return { status: "active", coveredPrivateRepositories: ["org/repo-a", "org/repo-b"] };
      }
    });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      await connectInstallation(harness.url, device, ORG.id);
      harness.calls.length = 0;
      entitlementCalls = 0;

      // repo-b is inside the installation and entitlement-covered, but OUTSIDE the
      // connecting user's authorized set -> refused before the seam, zero mint.
      const denied = await post(
        harness.url,
        "/github/token",
        { installationId: ORG.id, repositories: ["org/repo-b"] },
        bearer(await device.sign())
      );
      assert.equal(denied.status, 403, denied.text);
      assert.equal(denied.json.reason, "repo_outside_authorization");
      assert.equal(harness.calls.filter((call) => call.op === "createInstallationAccessToken").length, 0);
      // Ordering pin: the per-repo denial precedes entitlement resolution, so the
      // license authority is never consulted for an unauthorized repo (a reorder
      // that moved the gate after entitlement resolution would fail here).
      assert.equal(entitlementCalls, 0, "entitlement authority must not be consulted for an unauthorized repo");

      // repo-a (authorized AND covered) still mints normally through the same binding.
      const allowed = await post(
        harness.url,
        "/github/token",
        { installationId: ORG.id, repositories: ["org/repo-a"] },
        bearer(await device.sign())
      );
      assert.equal(allowed.status, 200, allowed.text);
      assert.equal(allowed.json.token, harness.mintedToken);
    } finally {
      harness.close();
    }
  });
});

describe("github broker existing-install device authorization (#613)", () => {
  it("binds an already-installed App only after device and user proofs agree on the installation", async () => {
    const harness = await startBroker({ installations: [VICTIM] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign()));
      const state = start.json.state as string;

      const authorized = await post(
        harness.url,
        "/github/connect/authorize-existing",
        {
          state,
          installationId: VICTIM.id,
          userAccessToken: userAccessTokenFor(VICTIM.id)
        },
        bearer(await device.sign())
      );
      assert.equal(authorized.status, 200, authorized.text);
      assert.deepEqual(authorized.json, { status: "bound", installationId: VICTIM.id });

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

  it("rejects a proof for another installation before resolving the target and never reflects it", async () => {
    const harness = await startBroker({ installations: [VICTIM, ATTACKER] });
    try {
      const device = await makeDevice();
      await registerDevice(harness.url, device);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await device.sign()));
      harness.calls.length = 0;
      const state = start.json.state as string;
      const proof = userAccessTokenFor(ATTACKER.id);

      const refused = await post(
        harness.url,
        "/github/connect/authorize-existing",
        { state, installationId: VICTIM.id, userAccessToken: proof },
        bearer(await device.sign())
      );
      assert.equal(refused.status, 403, refused.text);
      assert.equal(refused.json.reason, "installation_authorization_unverified");
      assert.equal(refused.text.includes(proof), false);
      assert.equal(harness.calls.some((call) => call.op === "getInstallation"), false);
    } finally {
      harness.close();
    }
  });

  it("binds state to the registered device and consumes it exactly once", async () => {
    const harness = await startBroker({ installations: [VICTIM] });
    try {
      const owner = await makeDevice();
      const other = await makeDevice();
      await registerDevice(harness.url, owner);
      await registerDevice(harness.url, other);
      const start = await post(harness.url, "/github/connect/start", {}, bearer(await owner.sign()));
      const state = start.json.state as string;
      const body = {
        state,
        installationId: VICTIM.id,
        userAccessToken: userAccessTokenFor(VICTIM.id)
      };

      const crossed = await post(
        harness.url,
        "/github/connect/authorize-existing",
        body,
        bearer(await other.sign())
      );
      assert.equal(crossed.status, 404, crossed.text);
      assert.equal(crossed.json.reason, "state_not_found");

      const first = await post(
        harness.url,
        "/github/connect/authorize-existing",
        body,
        bearer(await owner.sign())
      );
      assert.equal(first.status, 200, first.text);

      const replay = await post(
        harness.url,
        "/github/connect/authorize-existing",
        body,
        bearer(await owner.sign())
      );
      assert.equal(replay.status, 409, replay.text);
      assert.equal(replay.json.reason, "state_replayed");
    } finally {
      harness.close();
    }
  });
});
