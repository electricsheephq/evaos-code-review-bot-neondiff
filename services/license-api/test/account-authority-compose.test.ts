import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  bearer,
  makeDevice,
  post,
  startBroker,
  type BrokerHarness
} from "./github-broker-support.ts";
import {
  createComposedAccountAuthority,
  loadAccountLinkRuntimeConfig
} from "../src/account-link/runtime-config.ts";

const USER_ID = "11111111-1111-4111-8111-111111111111";
const ACCOUNT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BOT_ID = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const DEVICE_AUTHORIZATION = "Bearer device-jwt-fixture";
const CONNECT_ORIGIN = "https://www.neondiff.com/desktop/connect";
const AUTHORITY_URL = "https://www.neondiff.com/api/internal/desktop/workspaces";

const workspaceSnapshot = {
  accounts: [{
    id: ACCOUNT_ID,
    kind: "organization" as const,
    name: "ElectricSheep",
    role: "admin" as const,
    entitlement: "internal_admin" as const,
    bots: [{
      id: BOT_ID,
      appId: 4_184_532,
      appSlug: "evaos-code-review-bot",
      mode: "byo" as const,
      githubInstallationId: null,
      githubAccountLogin: "electricsheephq",
      status: "pending" as const
    }]
  }]
};

describe("composed Lovable account authority", () => {
  test("runtime configuration requires only public Supabase verification and the pinned Lovable bridge", () => {
    const directory = mkdtempSync(join(tmpdir(), "account-compose-"));
    try {
      const brokerPath = join(directory, "github-broker.sqlite");
      const result = loadAccountLinkRuntimeConfig({
        ACCOUNT_LINK_ENABLED: "true",
        ACCOUNT_LINK_DB_PATH: brokerPath,
        GITHUB_BROKER_DB_PATH: brokerPath,
        ACCOUNT_LINK_CONNECT_ORIGIN: CONNECT_ORIGIN,
        ACCOUNT_LINK_SUPABASE_URL: "https://project.supabase.co",
        ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
        ACCOUNT_LINK_AUTHORITY_URL: AUTHORITY_URL
      }, join(directory, "license.sqlite"));

      assert.equal(result.status, "ready");
      if (result.status === "ready") result.deps.store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("transient browser identity and device workspace authority use separate bounded requests", async () => {
    const requests: Array<{
      url: string;
      authorization: string | null;
      contentType: string | null;
      redirect: RequestRedirect | undefined;
    }> = [];
    const authority = createComposedAccountAuthority({
      connectOrigin: CONNECT_ORIGIN,
      supabaseUrl: "https://project.supabase.co",
      publishableKey: "sb_publishable_fixture",
      authorityUrl: AUTHORITY_URL,
      fetchImpl: async (input, init) => {
        const url = String(input);
        requests.push({
          url,
          authorization: new Headers(init?.headers).get("authorization"),
          contentType: new Headers(init?.headers).get("content-type"),
          redirect: init?.redirect
        });
        if (url.endsWith("/auth/v1/user")) {
          return Response.json({ id: USER_ID, email: "never-return@example.com" });
        }
        return Response.json({ status: "ready", userId: USER_ID, ...workspaceSnapshot });
      }
    });

    assert.equal(await authority.verifyAccessToken("transient-browser-token"), USER_ID);
    assert.deepEqual(
      await authority.loadWorkspaceSnapshot(USER_ID, DEVICE_AUTHORIZATION),
      workspaceSnapshot
    );
    assert.deepEqual(requests, [
      {
        url: "https://project.supabase.co/auth/v1/user",
        authorization: "Bearer transient-browser-token",
        contentType: null,
        redirect: "manual"
      },
      {
        url: AUTHORITY_URL,
        authorization: DEVICE_AUTHORIZATION,
        contentType: null,
        redirect: "manual"
      }
    ]);
  });

  test("workspace authority rejects a user mismatch, redirects, and oversized responses", async () => {
    for (const response of [
      Response.json({ status: "ready", userId: "22222222-2222-4222-8222-222222222222", ...workspaceSnapshot }),
      new Response(null, { status: 302, headers: { location: "https://evil.example" } }),
      new Response(JSON.stringify({ status: "ready", userId: USER_ID, ...workspaceSnapshot }), {
        headers: { "content-length": String(300 * 1024), "content-type": "application/json" }
      })
    ]) {
      const authority = createComposedAccountAuthority({
        connectOrigin: CONNECT_ORIGIN,
        supabaseUrl: "https://project.supabase.co",
        publishableKey: "sb_publishable_fixture",
        authorityUrl: AUTHORITY_URL,
        fetchImpl: async () => response
      });
      await assert.rejects(
        authority.loadWorkspaceSnapshot(USER_ID, DEVICE_AUTHORIZATION)
      );
    }
  });
});

describe("device introspection", () => {
  const harnesses: BrokerHarness[] = [];

  afterEach(() => {
    while (harnesses.length > 0) harnesses.pop()?.close();
  });

  test("returns only the bound user UUID after device authentication", async () => {
    const harness = await startBroker({
      accountAuthority: {
        connectOrigin: CONNECT_ORIGIN,
        async verifyAccessToken() {
          return USER_ID;
        },
        async loadWorkspaceSnapshot() {
          return workspaceSnapshot;
        }
      }
    });
    harnesses.push(harness);
    const device = await makeDevice();
    await post(harness.url, "/account/device/register", { publicKeyJwk: device.publicJwk });

    const before = await post(
      harness.url,
      "/account/device/introspect",
      {},
      bearer(await device.sign())
    );
    assert.equal(before.status, 403);
    assert.equal(before.json.reason, "account_link_required");

    const start = await post(
      harness.url,
      "/account/connect/start",
      {},
      bearer(await device.sign())
    );
    await post(
      harness.url,
      "/account/connect/complete",
      { state: start.json.state },
      bearer("lovable-user-token")
    );
    const bound = await post(
      harness.url,
      "/account/device/introspect",
      {},
      bearer(await device.sign())
    );

    assert.equal(bound.status, 200);
    assert.deepEqual(bound.json, { status: "account_device_bound", userId: USER_ID });
  });
});
