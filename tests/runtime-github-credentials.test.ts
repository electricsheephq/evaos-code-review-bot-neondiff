import { generateKeyPairSync } from "node:crypto";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { productionLicenseSecretReader } from "../src/license-secret-store.js";
import { createGitHubRelatedContextReader } from "../src/worker.js";
import {
  resolveRuntimeGitHubCredentials,
  resolveRuntimeCredentialEnvelope,
  readRuntimeLicenseKey,
  withRuntimeGitHubCredentials
} from "../src/runtime-github-credentials.js";

const privateKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" }
}).privateKey;

describe("runtime GitHub credentials", () => {
  it("binds bounded stdin credentials only to raw daemon and review-pr execution", async () => {
    const credentials = await resolveRuntimeGitHubCredentials({
      command: "daemon",
      subcommand: undefined,
      appId: "4184532",
      privateKeyStdin: "true",
      stdin: Readable.from([privateKey])
    });

    await withRuntimeGitHubCredentials(credentials, async () => {
      const config = loadConfigFromObject({
        github: {
          privateKeyPath: "/must/not/be/read.pem",
          token: "must-not-win"
        }
      });
      expect(config.github.appId).toBe("4184532");
      expect(config.github.privateKey).toBe(privateKey.trim());
      expect(config.github.privateKeyPath).toBeUndefined();
      expect(config.github.token).toBeUndefined();
      expect(JSON.stringify(config)).not.toContain(privateKey.trim());
    });

    const reviewCredentials = await resolveRuntimeGitHubCredentials({
      command: "review-pr",
      subcommand: undefined,
      appId: "4184532",
      privateKeyStdin: "true",
      stdin: Readable.from([privateKey])
    });
    expect(reviewCredentials?.appId).toBe("4184532");
  });

  it("rejects daemon controls and invalid App IDs before reading stdin", async () => {
    let reads = 0;
    const stdin = new Readable({
      read() {
        reads += 1;
        this.push(privateKey);
        this.push(null);
      }
    });

    await expect(resolveRuntimeGitHubCredentials({
      command: "daemon",
      subcommand: "start",
      appId: "4184532",
      privateKeyStdin: "true",
      stdin
    })).rejects.toThrow(/raw daemon/i);
    expect(reads).toBe(0);

    await expect(resolveRuntimeGitHubCredentials({
      command: "review-pr",
      subcommand: undefined,
      appId: "not-numeric",
      privateKeyStdin: "true",
      stdin
    })).rejects.toThrow(/positive ASCII numeric/i);
    expect(reads).toBe(0);
  });

  it("rejects inline private keys in config files", () => {
    expect(() => loadConfigFromObject({
      github: { privateKey }
    })).toThrow(/must not contain github\.privateKey/i);
  });

  it("binds the signed-app credential envelope to GitHub and license admission", async () => {
    const credentials = await resolveRuntimeCredentialEnvelope({
      command: "review-pr",
      subcommand: undefined,
      runtimeCredentialsStdin: "true",
      stdin: Readable.from([JSON.stringify({
        schemaVersion: 1,
        githubAppId: "4184532",
        githubPrivateKey: privateKey,
        licenseKey: "nd_live_runtime_fixture_1234"
      })])
    });

    await withRuntimeGitHubCredentials(credentials, async () => {
      const config = loadConfigFromObject({ github: {} });
      expect(config.github.appId).toBe("4184532");
      expect(config.github.privateKey).toBe(privateKey.trim());
      expect(readRuntimeLicenseKey()).toBe("nd_live_runtime_fixture_1234");
      expect(productionLicenseSecretReader.read(config.license!))
        .toBe("nd_live_runtime_fixture_1234");
      expect(JSON.stringify(config)).not.toContain(privateKey.trim());
      expect(JSON.stringify(config)).not.toContain("nd_live_runtime_fixture_1234");
    });
    expect(readRuntimeLicenseKey()).toBeUndefined();
  });

  it("preserves runtime App credentials when related-context options are copied", async () => {
    const credentials = await resolveRuntimeCredentialEnvelope({
      command: "review-pr",
      subcommand: undefined,
      runtimeCredentialsStdin: "true",
      stdin: Readable.from([JSON.stringify({
        schemaVersion: 1,
        githubAppId: "4184532",
        githubPrivateKey: privateKey,
        licenseKey: "nd_live_runtime_fixture_1234"
      })])
    });

    await withRuntimeGitHubCredentials(credentials, async () => {
      const config = loadConfigFromObject({
        github: {},
        githubRelatedContext: {
          enabled: true,
          requestTimeoutMs: 1_000
        }
      });
      const reader = createGitHubRelatedContextReader(config, {
        getIssueOrPull: async () => undefined
      }) as unknown as { canPostAsApp(): boolean };
      expect(reader.canPostAsApp()).toBe(true);
    });
  });
});
