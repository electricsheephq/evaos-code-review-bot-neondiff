import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, it } from "node:test";
import { createGitHubInstallationClient } from "../src/github-broker/index.ts";

/**
 * Wire-contract test for the PRODUCTION GitHub client. It proves the two live
 * invariants the fake cannot: (1) listing an installation's repositories mints a
 * metadata-read-only token — never a broad all-permissions token before the
 * issuance seam decides; (2) the returned token is minted with `repository_ids`
 * and a permissions object (never `owner/name` full names). `fetch` is stubbed;
 * no network call runs.
 */
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPrivateKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();

interface CapturedRequest {
  url: string;
  method: string;
  body: unknown;
}

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

function stubFetch(handler: (request: CapturedRequest) => { status?: number; json: unknown }): CapturedRequest[] {
  const captured: CapturedRequest[] = [];
  globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: init?.body ? JSON.parse(String(init.body)) : undefined
    };
    captured.push(request);
    const { status = 200, json } = handler(request);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return captured;
}

describe("production github installation client wire contract", () => {
  it("lists installation repositories using a metadata-read-only token", async () => {
    const captured = stubFetch((request) => {
      if (request.url.includes("/access_tokens")) return { json: { token: "t", expires_at: new Date().toISOString() } };
      return { json: { repositories: [{ id: 71, full_name: "octo/site", visibility: "public" }] } };
    });
    const client = createGitHubInstallationClient({ appId: "123", privateKey: appPrivateKey });
    const repositories = await client.listInstallationRepositories(6001);
    assert.deepEqual(repositories, [{ id: 71, full_name: "octo/site", visibility: "public" }]);
    const tokenMint = captured.find((request) => request.url.includes("/access_tokens"));
    // The listing token is scoped to metadata:read only — not a broad token.
    assert.deepEqual(tokenMint?.body, { permissions: { metadata: "read" } });
  });

  it("mints the returned token with repository_ids and a permissions object", async () => {
    const captured = stubFetch(() => ({ json: { token: "t", expires_at: new Date().toISOString() } }));
    const client = createGitHubInstallationClient({ appId: "123", privateKey: appPrivateKey });
    await client.createInstallationAccessToken(6001, {
      repositoryIds: [71, 72],
      permissions: { contents: "read", pull_requests: "write" }
    });
    const mint = captured.find((request) => request.url.includes("/access_tokens"));
    assert.equal(mint?.method, "POST");
    assert.deepEqual(mint?.body, {
      repository_ids: [71, 72],
      permissions: { contents: "read", pull_requests: "write" }
    });
  });
});
