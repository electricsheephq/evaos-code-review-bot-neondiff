import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
      backgroundPriority: 50,
      manualPriority: 10,
      providerThrottleBackoff: {
        requestRateLimitBaseMs: 30_000,
        requestRateLimitMaxMs: 180_000,
        overloadBaseMs: 60_000,
        overloadMaxMs: 300_000,
        quotaBaseMs: 30 * 60_000
      }
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

  function writeConfig(overlay: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify(overlay)}\n`);
    return path;
  }
});
