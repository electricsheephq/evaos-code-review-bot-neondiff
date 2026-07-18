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
    const rawBody = init?.body ? String(init.body) : undefined;
    let parsedBody: unknown = rawBody;
    if (rawBody !== undefined) {
      // JSON for App-JWT calls; form-encoded for the OAuth token exchange.
      try {
        parsedBody = JSON.parse(rawBody);
      } catch {
        parsedBody = rawBody;
      }
    }
    const request: CapturedRequest = {
      url: String(input),
      method: init?.method ?? "GET",
      body: parsedBody
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

  it("lists exactly one bounded installation repository page for native discovery", async () => {
    const captured = stubFetch((request) => {
      if (request.url.includes("/access_tokens")) {
        return { json: { token: "t", expires_at: new Date().toISOString() } };
      }
      return {
        json: {
          total_count: 73,
          repositories: [{ id: 72, full_name: "octo/page-two", visibility: "private" }]
        }
      };
    });
    const client = createGitHubInstallationClient({ appId: "123", privateKey: appPrivateKey });
    const result = await client.listInstallationRepositoriesPage(6001, 2, 50);
    assert.deepEqual(result, {
      repositories: [{ id: 72, full_name: "octo/page-two", visibility: "private" }],
      totalCount: 73,
      hasNextPage: false
    });
    const listCalls = captured.filter((request) => request.url.includes("/installation/repositories"));
    assert.equal(listCalls.length, 1);
    assert.equal(new URL(listCalls[0].url).searchParams.get("page"), "2");
    assert.equal(new URL(listCalls[0].url).searchParams.get("per_page"), "50");
    const tokenMint = captured.find((request) => request.url.includes("/access_tokens"));
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

  it("returns unverified (null) with no network call when OAuth-during-install is unconfigured", async () => {
    const captured = stubFetch(() => ({ json: {} }));
    const client = createGitHubInstallationClient({ appId: "123", privateKey: appPrivateKey });
    // No oauthClientId/Secret -> identity is unverified (the callback maps null to
    // installation_authorization_unverified, 403), and no OAuth exchange is attempted.
    assert.equal(await client.verifyInstallationForAuthorizationCode(6001, "any-code"), null);
    assert.equal(captured.length, 0);
  });

  it("verifies ownership and returns the user's accessible repositories for the installation", async () => {
    const captured = stubFetch((request) => {
      if (request.url.includes("/login/oauth/access_token")) return { json: { access_token: "user-tok" } };
      if (request.url.includes("/user/installations/6001/repositories")) {
        return { json: { repositories: [{ full_name: "octo/site" }, { full_name: "octo/private" }] } };
      }
      if (request.url.includes("/user/installations/9999/repositories")) return { status: 404, json: { message: "Not Found" } };
      return { json: {} };
    });
    const client = createGitHubInstallationClient({
      appId: "123",
      privateKey: appPrivateKey,
      oauthClientId: "cid",
      oauthClientSecret: "csec"
    });
    // A proven identity yields the EXACT repos the user can access in the
    // installation (the per-repo authorized set), not mere installation membership.
    assert.deepEqual(await client.verifyInstallationForAuthorizationCode(6001, "good-code"), ["octo/site", "octo/private"]);
    // An installation the OAuth user cannot access returns 404 -> unverified (null).
    assert.equal(await client.verifyInstallationForAuthorizationCode(9999, "good-code"), null);
    const exchange = captured.find((request) => request.url.includes("/login/oauth/access_token"));
    assert.equal(exchange?.method, "POST");
    // GitHub's web flow requires form-encoded parameters, not JSON.
    const params = new URLSearchParams(String(exchange?.body));
    assert.equal(params.get("client_id"), "cid");
    assert.equal(params.get("client_secret"), "csec");
    assert.equal(params.get("code"), "good-code");
    // The endpoint is joined without a double slash.
    assert.ok(!exchange?.url.includes("//login/oauth"), exchange?.url);
  });

  it("paginates /user/installations/{id}/repositories so the authorized set spans every page", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => ({ full_name: `octo/repo-${i}` }));
    const captured = stubFetch((request) => {
      if (request.url.includes("/login/oauth/access_token")) return { json: { access_token: "user-tok" } };
      if (request.url.includes("/user/installations/6001/repositories")) {
        const page = new URL(request.url).searchParams.get("page");
        if (page === "1") return { json: { repositories: page1 } };
        if (page === "2") return { json: { repositories: [{ full_name: "octo/on-page-2" }] } };
        return { json: { repositories: [] } };
      }
      return { json: {} };
    });
    const client = createGitHubInstallationClient({
      appId: "123",
      privateKey: appPrivateKey,
      oauthClientId: "cid",
      oauthClientSecret: "csec"
    });
    const authorized = await client.verifyInstallationForAuthorizationCode(6001, "good-code");
    // A repo on the SECOND page must be in the authorized set — a broken-pagination
    // regression that dropped later pages would silently shrink the set and fail here.
    assert.ok(Array.isArray(authorized) && authorized.includes("octo/on-page-2"), JSON.stringify(authorized));
    assert.equal(authorized.length, 101);
    const listCalls = captured.filter((request) => request.url.includes("/repositories"));
    assert.equal(listCalls.length, 2, "both pages were fetched");
  });

  it("aborts a stalled OAuth exchange as a typed broker outage under the configured timeout", async () => {
    globalThis.fetch = (async (input: string | URL, init?: RequestInit) => {
      if (String(input).includes("/login/oauth/access_token")) {
        // Hang until the timeout controller aborts the request.
        return await new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        });
      }
      return new Response(JSON.stringify({ installations: [{ id: 6001 }] }), { status: 200 });
    }) as typeof fetch;
    const client = createGitHubInstallationClient({
      appId: "123",
      privateKey: appPrivateKey,
      oauthClientId: "cid",
      oauthClientSecret: "csec",
      requestTimeoutMs: 30
    });
    await assert.rejects(
      () => client.verifyInstallationForAuthorizationCode(6001, "good-code"),
      (error: unknown) => error instanceof Error && /OAuth token exchange failed/.test(error.message)
    );
  });
});
