import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import {
  activateLicense,
  evaluateLicenseReviewGate,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { reviewPull } from "../src/worker.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

describe("license activation and entitlement cache", () => {
  const roots: string[] = [];
  const servers: Array<{ close: () => Promise<void> }> = [];

  afterEach(async () => {
    for (const server of servers.splice(0)) await server.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("activates, caches, reports, and deactivates a license without printing the key", async () => {
    const root = mkRoot(roots);
    const key = "LIC-activate-private-test-123456";
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true,
        plan: "supporter"
      });
    });
    servers.push(server);
    const configPath = join(root, "config.json");
    writeConfig(configPath, root, server.url);

    const activated = await runCli([
      "license",
      "activate",
      "--config",
      configPath,
      "--license-key",
      key,
      "--repo",
      "owner/private"
    ]);
    expect(activated.ok).toBe(true);
    expect(activated.status).toBe("active");
    expect(JSON.stringify(activated)).not.toContain(key);
    expect(readFileSync(join(root, "license.key"), "utf8")).toContain(key);
    expect(readFileSync(join(root, "entitlement.json"), "utf8")).not.toContain(key);

    const status = await runCli(["license", "status", "--config", configPath]);
    expect(status).toMatchObject({
      ok: true,
      status: "active",
      source: "cache"
    });
    expect(JSON.stringify(status)).not.toContain(key);

    const deactivated = await runCli(["license", "deactivate", "--config", configPath]);
    expect(deactivated).toMatchObject({ ok: true, status: "deactivated" });
    expect(existsSync(join(root, "license.key"))).toBe(false);
    expect(existsSync(join(root, "entitlement.json"))).toBe(false);
  });

  it("classifies expired, revoked, invalid, network, and server states", async () => {
    const root = mkRoot(roots);
    const expired = await startLicenseServer((_req, res) => writeJson(res, 402, { status: "expired", detail: "expired" }));
    const revoked = await startLicenseServer((_req, res) => writeJson(res, 410, { status: "revoked", detail: "revoked" }));
    const invalid = await startLicenseServer((_req, res) => writeJson(res, 401, { status: "invalid", detail: "bad key" }));
    const server = await startLicenseServer((_req, res) => writeJson(res, 503, { detail: "try later" }));
    servers.push(expired, revoked, invalid, server);

    await expectStatus(licenseConfig(root, expired.url), "expired");
    await expectStatus(licenseConfig(root, revoked.url), "revoked");
    await expectStatus(licenseConfig(root, invalid.url), "invalid");
    await expectStatus(licenseConfig(root, server.url), "server");
    const network = await activateLicense({
      config: licenseConfig(root, "http://127.0.0.1:9"),
      licenseKey: "LIC-network-test-123456"
    });
    expect(network).toMatchObject({ ok: false, status: "network", classification: "network" });
  });

  it("derives cache path from statePath and rejects license artifacts inside the checkout", () => {
    const root = mkRoot(roots);
    const config = loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state", "reviews.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true
      }
    });

    expect(config.license?.cachePath).toBe(join(root, "state", "license", "entitlement-cache.json"));

    expect(() => loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        cachePath: join(process.cwd(), "license-cache.json")
      }
    })).toThrow(/config\.license\.cachePath must be outside protected checkout root/);
  });

  it("uses a still-active cached entitlement during transient API outage", async () => {
    const root = mkRoot(roots);
    const config = licenseConfig(root, "http://127.0.0.1:9");
    writeFileSync(join(root, "license.key"), "LIC-offline-cache-test-123456\n", { mode: 0o600 });
    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-03T23:59:30.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: false,
      plan: "supporter"
    })}\n`, { mode: 0o600 });

    const status = await getLicenseStatus({
      config,
      refresh: true,
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(status).toMatchObject({
      ok: true,
      status: "active",
      source: "cache",
      stale: true,
      classification: "network"
    });
  });

  it("fails private repo review closed without an active private entitlement", async () => {
    const root = mkRoot(roots);
    const config = licenseConfig(root, undefined);

    const missing = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(missing).toMatchObject({
      ok: false,
      status: "missing"
    });

    const unknown = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "unknown",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(unknown).toMatchObject({
      ok: false,
      reason: expect.stringContaining("visibility is unknown")
    });

    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "public",
      updateEntitlement: false
    })}\n`, { mode: 0o600 });
    const wrongScope = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(wrongScope).toMatchObject({
      ok: false,
      reason: expect.stringContaining("does not cover private repos")
    });

    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    const stale = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(stale).toMatchObject({
      ok: false,
      reason: expect.stringContaining("fresh entitlement cache")
    });

    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    const active = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(active).toMatchObject({
      ok: true,
      reason: "active entitlement covers private repo review"
    });
  });

  it("defaults missing API repo scope to public and reports missing env vars clearly", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        updateEntitlement: false
      });
    });
    servers.push(server);
    const activated = await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: "LIC-missing-scope-test-123456"
    });
    expect(activated.entitlement?.repoVisibilityScope).toBe("public");

    const configPath = join(root, "config.json");
    writeConfig(configPath, root, server.url);
    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "activate",
      "--config",
      configPath,
      "--license-key-env",
      "NEONDIFF_LICENSE_KEY_DOES_NOT_EXIST"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("NEONDIFF_LICENSE_KEY_DOES_NOT_EXIST did not resolve")
    });
  });

  it("blocks private repo worker reviews before ZCode or posting when entitlement is missing", async () => {
    const root = mkRoot(roots);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    const pull = pullSummary(7, "private-head");
    const github = {
      getRepo: async () => ({ full_name: "owner/private", private: true as const, visibility: "private" as const })
    };

    const status = await reviewPull({
      config,
      github: github as never,
      state,
      repo: "owner/private",
      pull,
      dryRun: false,
      useZCode: true,
      budget: new ReviewRunBudget(1)
    });

    expect(status).toBe("skipped_policy");
    const readiness = state.getReviewReadiness("owner/private", 7, "private-head");
    expect(readiness).toMatchObject({
      state: "blocked_on_proof",
      reason: expect.stringContaining("private repo review requires active entitlement")
    });
    const gateEvidence = readFileSync(
      join(root, "evidence", localDateFolder(), "owner__private", "pr-7", "private-head", "license-gate.json"),
      "utf8"
    );
    expect(gateEvidence).toContain("private repo review requires active entitlement");
    expect(existsSync(join(root, "work"))).toBe(false);
    state.close();
  });
});

async function expectStatus(config: LicenseConfig, status: string): Promise<void> {
  const result = await activateLicense({ config, licenseKey: `LIC-${status}-test-123456` });
  expect(result.status).toBe(status);
  expect(result.ok).toBe(false);
  expect(result.classification).toBe(status);
}

function mkRoot(roots: string[]): string {
  const root = mkdtempSync(join(tmpdir(), "neondiff-license-"));
  roots.push(root);
  return root;
}

function licenseConfig(root: string, apiBaseUrl?: string): LicenseConfig {
  return {
    enabled: true,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    cachePath: join(root, "entitlement.json"),
    storageBackend: "file",
    keyPath: join(root, "license.key"),
    keychainService: "test.neondiff.license",
    keychainAccount: "test",
    requestTimeoutMs: 250,
    offlineGraceMs: 60_000,
    publicReposFree: true,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: true
  };
}

function writeConfig(path: string, root: string, apiBaseUrl: string): void {
  writeFileSync(path, `${JSON.stringify({
    pilotRepos: ["owner/private"],
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    pollIntervalMs: 60_000,
    license: {
      enabled: true,
      apiBaseUrl,
      cachePath: join(root, "entitlement.json"),
      storageBackend: "file",
      keyPath: join(root, "license.key")
    }
  })}\n`);
}

async function runCli(args: string[]): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" },
    maxBuffer: 1024 * 1024
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function startLicenseServer(handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    void handler(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("server did not bind to TCP address");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  };
}

function writeJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function minimalConfig(root: string): BotConfig {
  return {
    pilotRepos: ["owner/private"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: true
    },
    reviewConcurrency: {
      maxActiveRuns: 1,
      leaseTtlMs: 60_000
    },
    providerCooldown: {
      enabled: true,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 90_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
      transientRetryAttempts: 0,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: false,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    license: licenseConfig(root),
    zcode: {
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    github: {}
  };
}

function pullSummary(number: number, headSha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    state: "open",
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "owner/private" }
    },
    base: {
      sha: "base",
      ref: "main",
      repo: { full_name: "owner/private" }
    },
    html_url: `https://github.com/owner/private/pull/${number}`
  };
}

function localDateFolder(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
