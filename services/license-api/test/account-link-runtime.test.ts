import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { linkSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAccountLinkRuntimeConfig } from "../src/account-link/runtime-config.ts";

const BASE_ENV = {
  ACCOUNT_LINK_ENABLED: "true",
  ACCOUNT_LINK_DB_PATH: "/data/github-broker.sqlite",
  GITHUB_BROKER_DB_PATH: "/data/github-broker.sqlite",
  ACCOUNT_LINK_CONNECT_ORIGIN: "https://www.neondiff.com/desktop/connect",
  ACCOUNT_LINK_SUPABASE_URL: "https://project.supabase.co",
  ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY: "sb_publishable_fixture",
  ACCOUNT_LINK_AUTHORITY_URL: "https://www.neondiff.com/api/internal/desktop/workspaces"
} as const;

describe("account-link runtime configuration", () => {
  test("is independently disabled without affecting the managed GitHub broker", () => {
    assert.deepEqual(loadAccountLinkRuntimeConfig({}, "/data/license.sqlite"), {
      status: "disabled"
    });
  });

  test("an enabled missing setting fails closed without returning submitted values", () => {
    const result = loadAccountLinkRuntimeConfig(
      { ...BASE_ENV, ACCOUNT_LINK_AUTHORITY_URL: undefined },
      "/data/license.sqlite"
    );
    assert.deepEqual(result, {
      status: "invalid",
      setting: "ACCOUNT_LINK_AUTHORITY_URL",
      reason: "missing"
    });
    assert.doesNotMatch(JSON.stringify(result), /sb_publishable_fixture/);
  });

  test("ready configuration uses the independently replicated GitHub broker database", () => {
    const same = loadAccountLinkRuntimeConfig(
      { ...BASE_ENV, ACCOUNT_LINK_DB_PATH: "/data/license.sqlite" },
      "/data/license.sqlite"
    );
    assert.deepEqual(same, {
      status: "invalid",
      setting: "ACCOUNT_LINK_DB_PATH",
      reason: "must_differ_from_license_db"
    });

    const unreplicated = loadAccountLinkRuntimeConfig(
      { ...BASE_ENV, ACCOUNT_LINK_DB_PATH: "/data/account-link.sqlite" },
      "/data/license.sqlite"
    );
    assert.deepEqual(unreplicated, {
      status: "invalid",
      setting: "ACCOUNT_LINK_DB_PATH",
      reason: "must_match_github_broker_db"
    });

    const directory = mkdtempSync(join(tmpdir(), "account-link-config-"));
    try {
      const brokerPath = join(directory, "github-broker.sqlite");
      const ready = loadAccountLinkRuntimeConfig(
        {
          ...BASE_ENV,
          ACCOUNT_LINK_DB_PATH: brokerPath,
          GITHUB_BROKER_DB_PATH: brokerPath
        },
        join(directory, "license.sqlite")
      );
      assert.equal(ready.status, "ready");
      if (ready.status === "ready") ready.deps.store?.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("pins the Lovable authority route and refuses any foreign or broader endpoint", () => {
    for (const authorityUrl of [
      "https://evil.example/api/internal/desktop/workspaces",
      "https://www.neondiff.com/api/internal/desktop",
      "https://www.neondiff.com/api/internal/desktop/workspaces?debug=true"
    ]) {
      const result = loadAccountLinkRuntimeConfig(
        { ...BASE_ENV, ACCOUNT_LINK_AUTHORITY_URL: authorityUrl },
        "/data/license.sqlite"
      );
      assert.deepEqual(result, {
        status: "invalid",
        setting: "ACCOUNT_LINK_AUTHORITY_URL",
        reason: "invalid"
      });
    }
  });

  test("production entrypoint keeps enabled account-link state on the broker replica", () => {
    const entrypoint = readFileSync(new URL("../docker-entrypoint.sh", import.meta.url), "utf8");
    const litestream = readFileSync(new URL("../litestream-broker.yml", import.meta.url), "utf8");
    const fly = readFileSync(new URL("../fly.toml", import.meta.url), "utf8");

    assert.match(entrypoint, /ACCOUNT_LINK_ENABLED/);
    assert.match(entrypoint, /ACCOUNT_LINK_DB_PATH/);
    assert.match(entrypoint, /GITHUB_BROKER_REPLICA_URL is unset; refusing to enable account linking/);
    assert.match(litestream, /path: \$\{GITHUB_BROKER_DB_PATH\}/);
    assert.match(fly, /ACCOUNT_LINK_DB_PATH = "\/data\/github-broker\.sqlite"/);
  });

  test("rejects symlink and hard-link aliases of the license database", () => {
    const directory = mkdtempSync(join(tmpdir(), "account-link-identity-"));
    try {
      const licensePath = join(directory, "license.sqlite");
      writeFileSync(licensePath, "");
      for (const [label, createAlias] of [
        ["symlink", (path: string) => symlinkSync(licensePath, path)],
        ["hard-link", (path: string) => linkSync(licensePath, path)]
      ] as const) {
        const aliasPath = join(directory, `${label}.sqlite`);
        createAlias(aliasPath);
        const result = loadAccountLinkRuntimeConfig(
          { ...BASE_ENV, ACCOUNT_LINK_DB_PATH: aliasPath },
          licensePath
        );
        if (result.status === "ready") result.deps.store?.close();
        assert.deepEqual(result, {
          status: "invalid",
          setting: "ACCOUNT_LINK_DB_PATH",
          reason: "must_differ_from_license_db"
        });
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
