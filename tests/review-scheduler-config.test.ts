import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("review scheduler config", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads disabled-by-default provider-aware queue settings", () => {
    const config = loadConfig(writeConfig({}));

    expect(config.reviewScheduler).toEqual({
      enabled: false,
      maxProviderActive: 2,
      maxOrgActive: 3,
      maxRepoActive: 1,
      maxQueuedPerRepo: 10,
      manualCommandReserve: 1,
      backgroundPriority: 50
    });
    expect(config.providerCooldown).toMatchObject({
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 30_000
    });
  });

  it("rejects scheduler settings that cannot preserve manual reserve capacity", () => {
    expect(() => loadConfig(writeConfig({
      reviewScheduler: {
        maxProviderActive: 1,
        manualCommandReserve: 2
      }
    }))).toThrow("config.reviewScheduler.manualCommandReserve must be <= config.reviewScheduler.maxProviderActive");
  });

  it("loads and validates repo-profile scheduler burst overrides", () => {
    const config = loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "100yenadmin/Lossless-Codex-Orchestrator-LCO": {
            reviewScheduler: {
              maxActiveHeads: 1,
              maxQueuedHeads: 3,
              overflowAction: "defer"
            }
          }
        }
      }
    }));

    expect(config.repoProfiles?.repos?.["100yenadmin/Lossless-Codex-Orchestrator-LCO"]?.reviewScheduler).toEqual({
      maxActiveHeads: 1,
      maxQueuedHeads: 3,
      overflowAction: "defer"
    });
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              maxQueuedHeads: 0
            }
          }
        }
      }
    }))).toThrow("repoProfiles.repos.owner/repo.reviewScheduler.maxQueuedHeads must be a positive integer");
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              maxActiveHeads: 0
            }
          }
        }
      }
    }))).toThrow("repoProfiles.repos.owner/repo.reviewScheduler.maxActiveHeads must be a positive integer");
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              overflowAction: "park"
            }
          }
        }
      }
    }))).toThrow('repoProfiles.repos.owner/repo.reviewScheduler.overflowAction must be "defer" or "skip"');
  });

  it("validates provider overload backoff settings", () => {
    expect(() => loadConfig(writeConfig({
      providerCooldown: {
        overloadBackoffMaxDurationMs: 0
      }
    }))).toThrow("config.providerCooldown.overloadBackoffMaxDurationMs must be a positive integer");
    expect(() => loadConfig(writeConfig({
      providerCooldown: {
        overloadBackoffJitterMs: -1
      }
    }))).toThrow("config.providerCooldown.overloadBackoffJitterMs must be a non-negative integer");
  });

  it("validates optional GitHub API client settings", () => {
    expect(loadConfig(writeConfig({
      github: {
        apiBaseUrl: "https://api.github.test",
        botLogin: "evaos-code-review-bot[bot]",
        requestTimeoutMs: 1_000
      }
    })).github).toMatchObject({
      apiBaseUrl: "https://api.github.test",
      botLogin: "evaos-code-review-bot[bot]",
      requestTimeoutMs: 1_000
    });

    expect(() => loadConfig(writeConfig({ github: { apiBaseUrl: 42 } }))).toThrow(/config\.github\.apiBaseUrl/);
    expect(() => loadConfig(writeConfig({ github: { botLogin: 42 } }))).toThrow(/config\.github\.botLogin/);
    expect(() => loadConfig(writeConfig({ github: { requestTimeoutMs: 0 } }))).toThrow(/config\.github\.requestTimeoutMs/);
  });

  it("prefers NeonDiff GitHub App environment aliases over config-file values", () => {
    const oldPrimaryAppId = process.env.NEONDIFF_GITHUB_APP_ID;
    const oldPrimaryPrivateKeyPath = process.env.NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH;
    const oldLegacyAppId = process.env.EVAOS_REVIEW_BOT_APP_ID;
    const oldLegacyPrivateKeyPath = process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH;
    process.env.NEONDIFF_GITHUB_APP_ID = "primary-app-id";
    process.env.NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH = "/safe/neondiff.private-key.pem";
    delete process.env.EVAOS_REVIEW_BOT_APP_ID;
    delete process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH;

    try {
      const config = loadConfig(writeConfig({
        github: {
          appId: "from-config",
          privateKeyPath: "/safe/from-config.pem"
        }
      }));

      expect(config.github.appId).toBe("primary-app-id");
      expect(config.github.privateKeyPath).toBe("/safe/neondiff.private-key.pem");
    } finally {
      restoreEnv("NEONDIFF_GITHUB_APP_ID", oldPrimaryAppId);
      restoreEnv("NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH", oldPrimaryPrivateKeyPath);
      restoreEnv("EVAOS_REVIEW_BOT_APP_ID", oldLegacyAppId);
      restoreEnv("EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH", oldLegacyPrivateKeyPath);
    }
  });

  it("keeps legacy evaOS GitHub App environment aliases as fallback", () => {
    const oldPrimaryAppId = process.env.NEONDIFF_GITHUB_APP_ID;
    const oldPrimaryPrivateKeyPath = process.env.NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH;
    const oldLegacyAppId = process.env.EVAOS_REVIEW_BOT_APP_ID;
    const oldLegacyPrivateKeyPath = process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH;
    delete process.env.NEONDIFF_GITHUB_APP_ID;
    delete process.env.NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH;
    process.env.EVAOS_REVIEW_BOT_APP_ID = "legacy-app-id";
    process.env.EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH = "/safe/legacy.private-key.pem";

    try {
      const config = loadConfig(writeConfig({}));

      expect(config.github.appId).toBe("legacy-app-id");
      expect(config.github.privateKeyPath).toBe("/safe/legacy.private-key.pem");
    } finally {
      restoreEnv("NEONDIFF_GITHUB_APP_ID", oldPrimaryAppId);
      restoreEnv("NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH", oldPrimaryPrivateKeyPath);
      restoreEnv("EVAOS_REVIEW_BOT_APP_ID", oldLegacyAppId);
      restoreEnv("EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH", oldLegacyPrivateKeyPath);
    }
  });

  it("rejects conflicting NeonDiff and legacy GitHub App environment aliases", () => {
    const oldPrimaryAppId = process.env.NEONDIFF_GITHUB_APP_ID;
    const oldLegacyAppId = process.env.EVAOS_REVIEW_BOT_APP_ID;
    process.env.NEONDIFF_GITHUB_APP_ID = "primary-app-id";
    process.env.EVAOS_REVIEW_BOT_APP_ID = "legacy-app-id";

    try {
      expect(() => loadConfig(writeConfig({}))).toThrow(
        /NEONDIFF_GITHUB_APP_ID and EVAOS_REVIEW_BOT_APP_ID are both set with different values/
      );
    } finally {
      restoreEnv("NEONDIFF_GITHUB_APP_ID", oldPrimaryAppId);
      restoreEnv("EVAOS_REVIEW_BOT_APP_ID", oldLegacyAppId);
    }
  });

  it("rejects a review workRoot inside the live repository checkout", () => {
    expect(() => loadConfig(writeConfig({
      workRoot: join(process.cwd(), "runtime")
    }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
  });

  it("rejects a review workRoot symlinked into the live repository checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-runtime-"));
    roots.push(root);
    const link = join(root, "runtime-link");
    symlinkSync(process.cwd(), link, "dir");

    expect(() => loadConfig(writeConfig({
      workRoot: link
    }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
  });

  it("rejects a review workRoot inside an explicit protected checkout root", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-protected-"));
    roots.push(root);
    const protectedRoot = join(root, "operator-checkout");
    const oldProtectedRoot = process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;
    process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT = protectedRoot;

    try {
      expect(() => loadConfig(writeConfig({
        workRoot: join(protectedRoot, "runtime")
      }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
    } finally {
      if (oldProtectedRoot === undefined) {
        delete process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;
      } else {
        process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT = oldProtectedRoot;
      }
    }
  });

  it("supports NeonDiff protected checkout root environment alias", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-review-scheduler-protected-"));
    roots.push(root);
    const protectedRoot = join(root, "operator-checkout");
    const oldPrimaryProtectedRoot = process.env.NEONDIFF_PROTECTED_CHECKOUT_ROOT;
    const oldLegacyProtectedRoot = process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;
    process.env.NEONDIFF_PROTECTED_CHECKOUT_ROOT = protectedRoot;
    delete process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;

    try {
      expect(() => loadConfig(writeConfig({
        workRoot: join(protectedRoot, "runtime")
      }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
    } finally {
      restoreEnv("NEONDIFF_PROTECTED_CHECKOUT_ROOT", oldPrimaryProtectedRoot);
      restoreEnv("EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT", oldLegacyProtectedRoot);
    }
  });

  it("allows reviews when workRoot is outside the live repository checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-runtime-"));
    roots.push(root);

    const config = loadConfig(writeConfig({
      workRoot: join(root, "runtime")
    }));

    expect(config.workRoot).toBe(join(root, "runtime"));
  });

  function writeConfig(overlay: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify(overlay)}\n`);
    return path;
  }

  function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
      delete process.env[name];
      return;
    }
    process.env[name] = value;
  }
});
