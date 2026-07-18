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

  it("(c) refuses issuance for a private repo without entitlement (entitlement_missing)", async () => {
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
    // No entitlement resolver is configured here, so the fail-closed default
    // denies the private request as entitlement_missing (never as public).
    assert.equal(response.json.reason, "entitlement_missing");
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
      `${harness.url}/github/connect/callback?installation_id=4001&state=${encodeURIComponent(state)}&code=oauth-code-4001`,
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

  it("(e) paginates only the bound user's current installation repositories without review-token minting", async () => {
    const repositories = Array.from({ length: 53 }, (_, index) => ({
      id: 1_000 + index,
      full_name: `octo-page/repo-${String(index).padStart(2, "0")}`,
      visibility: index % 2 === 0 ? ("public" as const) : ("private" as const)
    }));
    repositories.push({ id: 9_999, full_name: "octo-page/not-authorized", visibility: "private" });
    const pagedHarness = await startBroker({
      installations: [{
        id: 4002,
        account_login: "octo-page",
        repositories,
        userRepositories: repositories
          .map((repository) => repository.full_name)
          .filter((fullName) => fullName !== "octo-page/not-authorized")
      }]
    });
    try {
      const fresh = await makeDevice();
      await registerDevice(pagedHarness.url, fresh);

      const unbound = await post(
        pagedHarness.url,
        "/github/repositories",
        { installationId: 4002, page: 1 },
        bearer(await fresh.sign())
      );
      assert.equal(unbound.status, 404, unbound.text);
      assert.equal(unbound.json.reason, "binding_not_found");

      await connectInstallation(pagedHarness.url, fresh, 4002);
      const first = await post(
        pagedHarness.url,
        "/github/repositories",
        { installationId: 4002, page: 1 },
        bearer(await fresh.sign())
      );
      assert.equal(first.status, 200, first.text);
      assert.equal(first.json.status, "listed");
      assert.equal(first.json.installationId, 4002);
      assert.equal(first.json.page, 1);
      assert.equal(first.json.repositories.length, 50);
      assert.equal(first.json.nextPage, 2);
      assert.equal(first.text.includes("octo-page/not-authorized"), false);

      const second = await post(
        pagedHarness.url,
        "/github/repositories",
        { installationId: 4002, page: 2 },
        bearer(await fresh.sign())
      );
      assert.equal(second.status, 200, second.text);
      assert.equal(second.json.page, 2);
      assert.equal(second.json.repositories.length, 3);
      assert.equal(second.json.nextPage, null);
      assert.equal(
        pagedHarness.calls.some((call) => call.op === "createInstallationAccessToken"),
        false,
        "repository discovery never calls the returned review-token mint seam"
      );
      assert.doesNotMatch(`${first.text}${second.text}`, /-----BEGIN [A-Z ]*PRIVATE KEY-----/);
      assert.doesNotMatch(`${first.text}${second.text}`, /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
    } finally {
      pagedHarness.close();
    }
  });

  it("(f) rejects malformed pages and suspended installations before repository metadata egress", async () => {
    const suspendedHarness = await startBroker({
      installations: [{
        id: 4003,
        account_login: "octo-suspended",
        suspended: true,
        repositories: [
          { id: 20_001, full_name: "octo-suspended/site", visibility: "public" }
        ]
      }]
    });
    try {
      const fresh = await makeDevice();
      await registerDevice(suspendedHarness.url, fresh);
      await connectInstallation(suspendedHarness.url, fresh, 4003);

      const invalidPage = await post(
        suspendedHarness.url,
        "/github/repositories",
        { installationId: 4003, page: 0 },
        bearer(await fresh.sign())
      );
      assert.equal(invalidPage.status, 400, invalidPage.text);
      assert.equal(invalidPage.json.reason, "invalid_request");

      const suspended = await post(
        suspendedHarness.url,
        "/github/repositories",
        { installationId: 4003, page: 1 },
        bearer(await fresh.sign())
      );
      assert.equal(suspended.status, 409, suspended.text);
      assert.equal(suspended.json.reason, "installation_suspended");
      assert.equal(
        suspendedHarness.calls.some((call) => call.op === "listInstallationRepositories"),
        false,
        "suspended installation is refused before listing repository metadata"
      );
    } finally {
      suspendedHarness.close();
    }
  });
});
