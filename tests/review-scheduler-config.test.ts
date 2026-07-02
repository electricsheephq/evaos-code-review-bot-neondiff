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
  });

  it("rejects scheduler settings that cannot preserve manual reserve capacity", () => {
    expect(() => loadConfig(writeConfig({
      reviewScheduler: {
        maxProviderActive: 1,
        manualCommandReserve: 2
      }
    }))).toThrow("config.reviewScheduler.manualCommandReserve must be <= config.reviewScheduler.maxProviderActive");
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
});
