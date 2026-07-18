import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { loadGitHubBrokerRuntimeConfig } from "../src/github-broker/runtime-config.ts";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const appPrivateKey = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
const brokerDbRoot = mkdtempSync(join(tmpdir(), "neondiff-broker-runtime-"));
const brokerDbPath = join(brokerDbRoot, "github-broker.sqlite");

function completeEnvironment(): Record<string, string> {
  return {
    GITHUB_BROKER_ENABLED: "true",
    GITHUB_BROKER_APP_ID: "123456",
    GITHUB_BROKER_PRIVATE_KEY: appPrivateKey,
    GITHUB_BROKER_OAUTH_CLIENT_ID: "Iv1.fixture-client-id",
    GITHUB_BROKER_OAUTH_CLIENT_SECRET: "fixture-oauth-secret",
    GITHUB_BROKER_INSTALL_BASE_URL:
      "https://github.com/apps/neondiff-staging/installations/new",
    GITHUB_BROKER_DB_PATH: brokerDbPath
  };
}

describe("production GitHub broker runtime configuration", () => {
  it("defaults off and remains an explicit kill switch even when credentials stay provisioned", () => {
    const unset = loadGitHubBrokerRuntimeConfig({}, "/data/license.sqlite");
    assert.deepEqual(unset, { status: "disabled" });

    const disabled = loadGitHubBrokerRuntimeConfig(
      { ...completeEnvironment(), GITHUB_BROKER_ENABLED: "false" },
      "/data/license.sqlite"
    );
    assert.deepEqual(disabled, { status: "disabled" });
  });

  it("constructs the existing broker dependencies only from a complete enabled contract", () => {
    const result = loadGitHubBrokerRuntimeConfig(
      completeEnvironment(),
      "/data/license.sqlite"
    );
    assert.equal(result.status, "ready");
    if (result.status !== "ready") return;
    assert.equal(result.deps.dbPath, brokerDbPath);
    assert.equal(
      result.deps.installBaseUrl,
      "https://github.com/apps/neondiff-staging/installations/new"
    );
    assert.equal(typeof result.deps.githubClient.getInstallation, "function");
    const serialized = JSON.stringify(result);
    assert.equal(serialized.includes(appPrivateKey), false);
    assert.equal(serialized.includes("fixture-oauth-secret"), false);
    result.deps.store?.close();
  });

  it("keeps the license API available when broker storage cannot open", () => {
    assert.deepEqual(
      loadGitHubBrokerRuntimeConfig(
        { ...completeEnvironment(), GITHUB_BROKER_DB_PATH: brokerDbRoot },
        "/data/license.sqlite"
      ),
      {
        status: "invalid",
        setting: "GITHUB_BROKER_DB_PATH",
        reason: "open_failed"
      }
    );
  });

  it("fails closed with a public-safe setting name for every missing required value", () => {
    for (const setting of [
      "GITHUB_BROKER_APP_ID",
      "GITHUB_BROKER_PRIVATE_KEY",
      "GITHUB_BROKER_OAUTH_CLIENT_ID",
      "GITHUB_BROKER_OAUTH_CLIENT_SECRET",
      "GITHUB_BROKER_INSTALL_BASE_URL",
      "GITHUB_BROKER_DB_PATH"
    ]) {
      const environment = completeEnvironment();
      delete environment[setting];
      assert.deepEqual(
        loadGitHubBrokerRuntimeConfig(environment, "/data/license.sqlite"),
        { status: "invalid", setting, reason: "missing" }
      );
    }
  });

  it("rejects ambiguous flags, invalid identities, unsafe URLs, and storage collisions", () => {
    const cases: Array<{
      patch: Record<string, string>;
      setting: string;
      reason: string;
      licenseDbPath?: string;
    }> = [
      {
        patch: { GITHUB_BROKER_ENABLED: "1" },
        setting: "GITHUB_BROKER_ENABLED",
        reason: "must_be_true_or_false"
      },
      {
        patch: { GITHUB_BROKER_APP_ID: "not-an-id" },
        setting: "GITHUB_BROKER_APP_ID",
        reason: "invalid"
      },
      {
        patch: { GITHUB_BROKER_PRIVATE_KEY: "not a private key" },
        setting: "GITHUB_BROKER_PRIVATE_KEY",
        reason: "invalid"
      },
      {
        patch: { GITHUB_BROKER_INSTALL_BASE_URL: "https://example.com/install" },
        setting: "GITHUB_BROKER_INSTALL_BASE_URL",
        reason: "invalid"
      },
      {
        patch: { GITHUB_BROKER_API_BASE_URL: "http://api.github.test" },
        setting: "GITHUB_BROKER_API_BASE_URL",
        reason: "invalid"
      },
      {
        patch: { GITHUB_BROKER_OAUTH_BASE_URL: "http://github.test" },
        setting: "GITHUB_BROKER_OAUTH_BASE_URL",
        reason: "invalid"
      },
      {
        patch: { GITHUB_BROKER_DB_PATH: "runtime/github-broker.sqlite" },
        setting: "GITHUB_BROKER_DB_PATH",
        reason: "must_be_absolute"
      },
      {
        patch: { GITHUB_BROKER_DB_PATH: "/data/license.sqlite" },
        setting: "GITHUB_BROKER_DB_PATH",
        reason: "must_differ_from_license_db",
        licenseDbPath: "/data/license.sqlite"
      }
    ];

    for (const testCase of cases) {
      const result = loadGitHubBrokerRuntimeConfig(
        { ...completeEnvironment(), ...testCase.patch },
        testCase.licenseDbPath ?? "/data/license.sqlite"
      );
      assert.deepEqual(result, {
        status: "invalid",
        setting: testCase.setting,
        reason: testCase.reason
      });
    }
  });
});
