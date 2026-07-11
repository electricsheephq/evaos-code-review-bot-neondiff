import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { resolveProductionLicensePolicy } from "../src/license-production-policy.js";

const canonicalApi = "https://neondiff-license.fly.dev";

describe("official license production policy", () => {
  it("locks empty config to mandatory online activation", () => {
    const config = loadConfigFromObject({
      pilotRepos: [],
      workRoot: "/tmp/neondiff-policy-empty/runtime",
      statePath: "/tmp/neondiff-policy-empty/state/reviews.sqlite",
      evidenceDir: "/tmp/neondiff-policy-empty/evidence"
    });

    expect(config.license).toMatchObject({
      enabled: true,
      apiBaseUrl: canonicalApi,
      offlineGraceMs: 0,
      publicReposFree: false,
      privateReposRequireEntitlement: true,
      updateEntitlementRequiresLicense: true,
      productionPolicy: {
        mode: "mandatory_online",
        diagnostics: []
      }
    });
  });

  it("loads a v1.0.3 config while superseding every weakening field", () => {
    const legacy = JSON.parse(readFileSync("tests/fixtures/config/v1.0.3-legacy-license.json", "utf8"));
    const config = loadConfigFromObject(legacy);

    expect(config.license).toMatchObject({
      enabled: true,
      apiBaseUrl: canonicalApi,
      offlineGraceMs: 0,
      publicReposFree: false,
      privateReposRequireEntitlement: true,
      updateEntitlementRequiresLicense: true,
      cachePath: legacy.license.cachePath,
      keyPath: legacy.license.keyPath,
      productionPolicy: {
        mode: "mandatory_online",
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ field: "enabled" }),
          expect.objectContaining({ field: "apiBaseUrl" }),
          expect.objectContaining({ field: "offlineGraceMs" }),
          expect.objectContaining({ field: "publicReposFree" }),
          expect.objectContaining({ field: "privateReposRequireEntitlement" }),
          expect.objectContaining({ field: "updateEntitlementRequiresLicense" })
        ])
      }
    });
    expect(JSON.stringify(config.license?.productionPolicy)).not.toContain("legacy-license.invalid");
    expect(resolveProductionLicensePolicy(config.license!).productionPolicy?.diagnostics)
      .toEqual(config.license?.productionPolicy?.diagnostics);
  });

  it("locks the Keychain identity used by the supported distribution", () => {
    const config = loadConfigFromObject({
      pilotRepos: [],
      workRoot: "/tmp/neondiff-policy-keychain/runtime",
      statePath: "/tmp/neondiff-policy-keychain/state/reviews.sqlite",
      evidenceDir: "/tmp/neondiff-policy-keychain/evidence",
      license: {
        storageBackend: "keychain",
        keychainService: "attacker.controlled.service",
        keychainAccount: "attacker"
      }
    });

    expect(config.license).toMatchObject({
      keychainService: "com.electricsheephq.NeonDiffDesktop.secrets",
      keychainAccount: "license/default",
      productionPolicy: {
        diagnostics: expect.arrayContaining([
          expect.objectContaining({ field: "keychainService" }),
          expect.objectContaining({ field: "keychainAccount" })
        ])
      }
    });
  });

  it("rejects malformed legacy field types before policy normalization", () => {
    expect(() => loadConfigFromObject({
      pilotRepos: [],
      workRoot: "/tmp/neondiff-policy-invalid/runtime",
      statePath: "/tmp/neondiff-policy-invalid/state/reviews.sqlite",
      evidenceDir: "/tmp/neondiff-policy-invalid/evidence",
      license: { enabled: "false" }
    })).toThrow(/config\.license\.enabled must be a boolean/);
  });
});
