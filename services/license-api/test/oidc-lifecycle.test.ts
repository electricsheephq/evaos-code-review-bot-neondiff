import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import type { Server } from "node:http";
import { createServer } from "node:http";
import { generateKeyPairSync } from "node:crypto";
import { exportJWK, SignJWT } from "jose";
import { startLicenseServer } from "../src/http.ts";
import { LicenseStore } from "../src/store.ts";
import { createGitHubActionsOidcVerifier } from "../src/oidc-lifecycle.ts";

const NOW = new Date("2026-07-12T00:00:00.000Z");
const CANDIDATE_HEAD = "a".repeat(40);

const validClaims = {
  iss: "https://token.actions.githubusercontent.com",
  aud: "neondiff-license-lifecycle",
  repository: "electricsheephq/evaos-code-review-bot-neondiff",
  repository_id: "1285247004",
  repository_owner_id: "268512935",
  ref: "refs/heads/main",
  ref_type: "branch",
  ref_protected: "true",
  workflow_ref:
    "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/license-lifecycle-proof.yml@refs/heads/main",
  environment: "license-lifecycle-production",
  sub: "repo:electricsheephq/evaos-code-review-bot-neondiff:environment:license-lifecycle-production",
  event_name: "workflow_dispatch",
  runner_environment: "github-hosted",
  sha: CANDIDATE_HEAD,
  run_id: "123456789",
  iat: Math.floor(NOW.getTime() / 1000),
  nbf: Math.floor(NOW.getTime() / 1000) - 5,
  exp: Math.floor(NOW.getTime() / 1000) + 300
};

const validRequest = {
  releaseVersion: "v1.0.4",
  candidateHead: CANDIDATE_HEAD,
  packShasum: "b".repeat(40),
  packIntegrity: `sha512-${Buffer.alloc(64, 7).toString("base64")}`
};

async function post(
  url: string,
  path: string,
  body: unknown,
  authorization?: string
): Promise<{ status: number; json: Record<string, any> }> {
  const response = await fetch(`${url}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(authorization ? { Authorization: authorization } : {})
    },
    body: JSON.stringify(body)
  });
  return { status: response.status, json: (await response.json()) as Record<string, any> };
}

describe("GitHub Actions OIDC lifecycle issuance", () => {
  let store: LicenseStore;
  let server: Server;
  let url: string;

  before(async () => {
    store = new LicenseStore(":memory:");
    const started = await startLicenseServer({
      store,
      issuanceSecret: "server-side-issuance-secret",
      now: () => NOW,
      lifecycleOidcVerifier: {
        verify: async (token: string) => {
          if (token === "valid-actions-token-2") {
            return { ...validClaims, run_id: "123456790" };
          }
          assert.equal(token, "valid-actions-token");
          return validClaims;
        }
      }
    });
    server = started.server;
    url = started.url;
  });

  after(() => {
    server.close();
    store.close();
  });

  it("issues a server-defined short-lived all-scope entitlement after OIDC verification", async () => {
    const response = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      validRequest,
      "Bearer valid-actions-token"
    );

    assert.equal(response.status, 200);
    assert.equal(response.json.status, "issued");
    assert.equal(response.json.replayed, false);
    assert.match(response.json.licenseKey, /^nd_live_[A-Za-z0-9_-]+$/);
    assert.deepEqual(response.json.entitlement, {
      status: "active",
      repoVisibilityScope: "all",
      privateRepoAllowed: true,
      updateEntitlement: true,
      plan: "release_lifecycle",
      seats: 1,
      expiresAt: "2026-07-12T00:15:00.000Z"
    });
    const serialized = JSON.stringify(response.json);
    assert.ok(!serialized.includes("valid-actions-token"));
    assert.ok(!serialized.includes("server-side-issuance-secret"));
    assert.ok(!serialized.includes(validRequest.packIntegrity));
  });

  it("keeps lifecycle OIDC auth separate from checkout shared-secret auth", async () => {
    const missing = await post(url, "/v1/admin/licenses/issue-lifecycle", validRequest);
    assert.equal(missing.status, 401);

    const sharedSecret = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      validRequest,
      "Bearer server-side-issuance-secret"
    );
    assert.equal(sharedSecret.status, 401);

    const oidcOnCheckout = await post(
      url,
      "/v1/admin/licenses/issue",
      { idempotencyKey: "not-checkout-auth", checkoutLookupKey: "neondiff_monthly" },
      "Bearer valid-actions-token"
    );
    assert.equal(oidcOnCheckout.status, 401);
  });

  it("rejects unknown request fields and a candidate head not bound to the token", async () => {
    const unknown = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      { ...validRequest, licensePlan: "lifetime" },
      "Bearer valid-actions-token"
    );
    assert.equal(unknown.status, 400);
    assert.match(String(unknown.json.detail), /unexpected request fields/);

    const mismatch = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      { ...validRequest, candidateHead: "c".repeat(40) },
      "Bearer valid-actions-token"
    );
    assert.equal(mismatch.status, 403);
    assert.equal(mismatch.json.status, "forbidden");
  });

  it("rejects malformed release identity fields without issuing", async () => {
    const invalidRequests = [
      { ...validRequest, releaseVersion: "1.0.4" },
      { ...validRequest, releaseVersion: "v01.0.4" },
      { ...validRequest, candidateHead: CANDIDATE_HEAD.toUpperCase() },
      { ...validRequest, packShasum: "not-a-shasum" },
      { ...validRequest, packIntegrity: "sha256-not-sha512" },
      { ...validRequest, packIntegrity: "sha512-YQ==" },
      { ...validRequest, packIntegrity: validRequest.packIntegrity.replace(/=+$/, "") }
    ];
    for (const body of invalidRequests) {
      const response = await post(
        url,
        "/v1/admin/licenses/issue-lifecycle",
        body,
        "Bearer valid-actions-token"
      );
      assert.equal(response.status, 400);
      assert.equal(response.json.status, "invalid");
    }
  });

  it("replays one workflow run but conflicts when that run changes release data", async () => {
    const first = await post(url, "/v1/admin/licenses/issue-lifecycle", validRequest, "Bearer valid-actions-token");
    const replay = await post(url, "/v1/admin/licenses/issue-lifecycle", validRequest, "Bearer valid-actions-token");
    assert.equal(first.status, 200);
    assert.equal(replay.status, 200);
    assert.equal(replay.json.replayed, true);
    assert.equal(replay.json.licenseKey, first.json.licenseKey);

    const conflict = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      { ...validRequest, releaseVersion: "v1.0.5" },
      "Bearer valid-actions-token"
    );
    assert.equal(conflict.status, 409);
    assert.equal(conflict.json.status, "conflict");
    assert.ok(!JSON.stringify(conflict.json).includes(first.json.licenseKey));

    const distinctRun = await post(
      url,
      "/v1/admin/licenses/issue-lifecycle",
      validRequest,
      "Bearer valid-actions-token-2"
    );
    assert.equal(distinctRun.status, 200);
    assert.equal(distinctRun.json.replayed, false);
    assert.notEqual(distinctRun.json.licenseKey, first.json.licenseKey);
  });

  it("returns generic fail-closed auth and configuration errors without verifier details", async () => {
    const isolatedStore = new LicenseStore(":memory:");
    const broken = await startLicenseServer({
      store: isolatedStore,
      issuanceSecret: "isolated-secret",
      lifecycleOidcVerifier: {
        verify: async () => {
          throw new SyntaxError("JWKS JSON failed while checking raw-sensitive-token");
        }
      }
    });
    try {
      const denied = await post(
        broken.url,
        "/v1/admin/licenses/issue-lifecycle",
        validRequest,
        "Bearer raw-sensitive-token"
      );
      assert.equal(denied.status, 401);
      assert.deepEqual(denied.json, {
        status: "unauthorized",
        detail: "lifecycle issuance authorization failed"
      });
      assert.equal(isolatedStore.listLicenses().length, 0);
    } finally {
      broken.server.close();
      isolatedStore.close();
    }

    const unconfiguredStore = new LicenseStore(":memory:");
    const unconfigured = await startLicenseServer({ store: unconfiguredStore });
    try {
      const denied = await post(
        unconfigured.url,
        "/v1/admin/licenses/issue-lifecycle",
        validRequest,
        "Bearer any-token"
      );
      assert.equal(denied.status, 503);
      assert.equal(denied.json.status, "server");
      assert.equal(unconfiguredStore.listLicenses().length, 0);
    } finally {
      unconfigured.server.close();
      unconfiguredStore.close();
    }
  });
});

describe("GitHub Actions OIDC verifier", () => {
  let jwksServer: Server;
  let jwksUrl: string;
  let keys: Array<Record<string, unknown>> = [];
  let outage = false;
  let requestCount = 0;

  before(async () => {
    jwksServer = createServer((_req, res) => {
      requestCount += 1;
      if (outage) {
        res.writeHead(503, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: "unavailable" }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ keys }));
    });
    await new Promise<void>((resolve) => jwksServer.listen(0, "127.0.0.1", resolve));
    const address = jwksServer.address();
    assert.ok(address && typeof address === "object");
    jwksUrl = `http://127.0.0.1:${address.port}/jwks`;
  });

  after(() => jwksServer.close());

  async function signingMaterial(kid: string) {
    const pair = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const jwk = await exportJWK(pair.publicKey);
    return { privateKey: pair.privateKey, jwk: { ...jwk, kid, alg: "RS256", use: "sig" } };
  }

  async function sign(
    privateKey: Awaited<ReturnType<typeof signingMaterial>>["privateKey"],
    kid: string,
    overrides: Record<string, unknown> = {}
  ): Promise<string> {
    const payload = { ...validClaims, ...overrides };
    return new SignJWT(payload)
      .setProtectedHeader({ alg: "RS256", kid, typ: "JWT" })
      .sign(privateKey);
  }

  it("accepts a correctly signed token with every exact protected-workflow claim", async () => {
    const material = await signingMaterial("key-a");
    keys = [material.jwk];
    const verifier = createGitHubActionsOidcVerifier({ jwksUrl, now: () => NOW, cooldownDuration: 0 });
    const claims = await verifier.verify(await sign(material.privateKey, "key-a"));
    assert.equal(claims.sha, CANDIDATE_HEAD);
    assert.equal(claims.run_id, "123456789");
  });

  it("rejects every mismatched protected-workflow claim and false ref protection", async () => {
    const material = await signingMaterial("key-claims");
    keys = [material.jwk];
    const verifier = createGitHubActionsOidcVerifier({ jwksUrl, now: () => NOW, cooldownDuration: 0 });
    const invalid: Array<[string, unknown]> = [
      ["repository", "someone/fork"],
      ["repository_id", "1"],
      ["repository_owner_id", "1"],
      ["ref", "refs/heads/feature"],
      ["ref_type", "tag"],
      ["ref_protected", "false"],
      ["workflow_ref", "electricsheephq/evaos-code-review-bot-neondiff/.github/workflows/other.yml@refs/heads/main"],
      ["environment", "production"],
      ["sub", "repo:electricsheephq/evaos-code-review-bot-neondiff:ref:refs/heads/main"],
      ["event_name", "push"],
      ["runner_environment", "self-hosted"],
      ["sha", "ABCDEF".padEnd(40, "0")],
      ["run_id", "run-123"]
    ];
    for (const [claim, value] of invalid) {
      await assert.rejects(verifier.verify(await sign(material.privateKey, "key-claims", { [claim]: value })));
    }
    const booleanProtected = await verifier.verify(
      await sign(material.privateKey, "key-claims", { ref_protected: true })
    );
    assert.equal(booleanProtected.ref_protected, true);
    const { repository: _repository, ...missingRepository } = validClaims;
    await assert.rejects(
      verifier.verify(
        await new SignJWT(missingRepository)
          .setProtectedHeader({ alg: "RS256", kid: "key-claims", typ: "JWT" })
          .sign(material.privateKey)
      )
    );
  });

  it("rejects issuer, audience, algorithm, signature, and invalid token times", async () => {
    const material = await signingMaterial("key-security");
    const wrong = await signingMaterial("key-security");
    keys = [material.jwk];
    const verifier = createGitHubActionsOidcVerifier({ jwksUrl, now: () => NOW, cooldownDuration: 0 });
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { iss: "https://evil.example" })));
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { aud: "another-service" })));
    await assert.rejects(verifier.verify(await sign(wrong.privateKey, "key-security")));
    await assert.rejects(
      verifier.verify(
        await new SignJWT(validClaims)
          .setProtectedHeader({ alg: "HS256", typ: "JWT" })
          .sign(Buffer.from("not-an-rsa-key-but-long-enough-for-hs256"))
      )
    );
    const now = Math.floor(NOW.getTime() / 1000);
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { iat: now - 301 })));
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { nbf: now + 10 })));
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { exp: now - 10 })));
    await assert.rejects(verifier.verify(await sign(material.privateKey, "key-security", { exp: now + 601 })));
  });

  it("fails closed during a JWKS outage and refreshes on key rotation", async () => {
    const first = await signingMaterial("rotation-a");
    const second = await signingMaterial("rotation-b");
    keys = [first.jwk];
    outage = false;
    requestCount = 0;
    const verifier = createGitHubActionsOidcVerifier({ jwksUrl, now: () => NOW, cooldownDuration: 0 });
    await verifier.verify(await sign(first.privateKey, "rotation-a"));
    keys = [second.jwk];
    await verifier.verify(await sign(second.privateKey, "rotation-b"));
    assert.ok(requestCount >= 2, "unknown kid should refresh the remote JWKS");

    outage = true;
    const unavailableVerifier = createGitHubActionsOidcVerifier({ jwksUrl, now: () => NOW, cooldownDuration: 0 });
    await assert.rejects(unavailableVerifier.verify(await sign(second.privateKey, "rotation-b")));
    outage = false;
  });
});
