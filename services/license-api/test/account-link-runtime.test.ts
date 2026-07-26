import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSupabaseAccountAuthority,
  loadAccountLinkRuntimeConfig
} from "../src/account-link/runtime-config.ts";

const BASE_ENV = {
  ACCOUNT_LINK_ENABLED: "true",
  ACCOUNT_LINK_DB_PATH: "/data/account-link.sqlite",
  ACCOUNT_LINK_CONNECT_ORIGIN: "https://www.neondiff.com/desktop/connect",
  ACCOUNT_LINK_SUPABASE_URL: "https://project.supabase.co",
  ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY: "sb_secret_fixture"
} as const;

describe("account-link runtime configuration", () => {
  test("is independently disabled without affecting the managed GitHub broker", () => {
    assert.deepEqual(loadAccountLinkRuntimeConfig({}, "/data/license.sqlite"), {
      status: "disabled"
    });
  });

  test("an enabled missing setting fails closed without returning submitted values", () => {
    const result = loadAccountLinkRuntimeConfig(
      { ...BASE_ENV, ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY: undefined },
      "/data/license.sqlite"
    );
    assert.deepEqual(result, {
      status: "invalid",
      setting: "ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY",
      reason: "missing"
    });
    assert.doesNotMatch(JSON.stringify(result), /sb_publishable_fixture/);
  });

  test("ready configuration is separate from the license database", () => {
    const same = loadAccountLinkRuntimeConfig(
      { ...BASE_ENV, ACCOUNT_LINK_DB_PATH: "/data/license.sqlite" },
      "/data/license.sqlite"
    );
    assert.deepEqual(same, {
      status: "invalid",
      setting: "ACCOUNT_LINK_DB_PATH",
      reason: "must_differ_from_license_db"
    });

    const dir = mkdtempSync(join(tmpdir(), "account-link-config-"));
    try {
      const ready = loadAccountLinkRuntimeConfig(
        { ...BASE_ENV, ACCOUNT_LINK_DB_PATH: join(dir, "account-link.sqlite") },
        join(dir, "license.sqlite")
      );
      assert.equal(ready.status, "ready");
      if (ready.status === "ready") ready.deps.store?.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("Supabase account authority", () => {
  test("verifies the transient user token, then returns only allowed snapshot fields", async () => {
    const requests: Array<{ url: string; headers: Headers }> = [];
    const authority = createSupabaseAccountAuthority({
      connectOrigin: BASE_ENV.ACCOUNT_LINK_CONNECT_ORIGIN,
      supabaseUrl: BASE_ENV.ACCOUNT_LINK_SUPABASE_URL,
      publishableKey: BASE_ENV.ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY,
      serviceRoleKey: BASE_ENV.ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY,
      now: () => new Date("2026-07-26T06:00:00.000Z"),
      fetchImpl: async (input, init) => {
        const url = String(input);
        const headers = new Headers(init?.headers);
        requests.push({ url, headers });
        if (url.endsWith("/auth/v1/user")) {
          return Response.json({ id: "11111111-1111-4111-8111-111111111111", email: "never-return@example.com" });
        }
        if (url.includes("/account_memberships")) {
          return Response.json([
            { account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "admin" }
          ]);
        }
        if (url.includes("/accounts")) {
          return Response.json([
            {
              id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              kind: "organization",
              name: "ElectricSheep"
            }
          ]);
        }
        if (url.includes("/bot_installations")) {
          return Response.json([
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
              account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              app_id: 4_184_532,
              app_slug: "evaos-code-review-bot",
              mode: "byo",
              github_installation_id: null,
              github_account_login: "electricsheephq",
              status: "pending"
            }
          ]);
        }
        if (url.includes("/account_entitlement_grants")) {
          return Response.json([
            {
              account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
              grant_kind: "internal_admin",
              status: "active",
              expires_at: null
            }
          ]);
        }
        return new Response("not found", { status: 404 });
      }
    });

    assert.equal(
      await authority.verifyAccessToken("transient-user-token"),
      "11111111-1111-4111-8111-111111111111"
    );
    const snapshot = await authority.loadWorkspaceSnapshot(
      "11111111-1111-4111-8111-111111111111"
    );
    assert.deepEqual(snapshot, {
      accounts: [
        {
          id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          kind: "organization",
          name: "ElectricSheep",
          role: "admin",
          entitlement: "internal_admin",
          bots: [
            {
              id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
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
    });
    assert.doesNotMatch(JSON.stringify(snapshot), /email|transient-user-token/);
    assert.equal(requests[0]?.headers.get("Authorization"), "Bearer transient-user-token");
    assert.equal(requests[1]?.headers.get("Authorization"), null);
    assert.equal(requests[1]?.headers.get("apikey"), "sb_secret_fixture");
  });

  test("malformed verified bot state fails closed", async () => {
    const authority = createSupabaseAccountAuthority({
      connectOrigin: BASE_ENV.ACCOUNT_LINK_CONNECT_ORIGIN,
      supabaseUrl: BASE_ENV.ACCOUNT_LINK_SUPABASE_URL,
      publishableKey: BASE_ENV.ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY,
      serviceRoleKey: BASE_ENV.ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY,
      fetchImpl: async (input) => {
        const url = String(input);
        if (url.includes("/account_memberships")) {
          return Response.json([{ account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", role: "admin" }]);
        }
        if (url.includes("/accounts")) {
          return Response.json([{ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", kind: "organization", name: "ElectricSheep" }]);
        }
        if (url.includes("/bot_installations")) {
          return Response.json([{
            id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
            account_id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            app_id: 4_184_532,
            app_slug: "evaos-code-review-bot",
            mode: "byo",
            github_installation_id: null,
            github_account_login: "electricsheephq",
            status: "verified"
          }]);
        }
        if (url.includes("/account_entitlement_grants")) return Response.json([]);
        return Response.json({ id: "11111111-1111-4111-8111-111111111111" });
      }
    });
    await assert.rejects(
      authority.loadWorkspaceSnapshot("11111111-1111-4111-8111-111111111111")
    );
  });
});
