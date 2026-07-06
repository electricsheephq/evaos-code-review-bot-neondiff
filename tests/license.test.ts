import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import { GitHubApi } from "../src/github.js";
import {
  activateLicense,
  evaluateLicenseReviewGate,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { ReviewRunBudget } from "../src/review-budget.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { buildLicenseGateForPull, reviewPull } from "../src/worker.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const tsxCliPath = require.resolve("tsx/cli");

function testLicenseFingerprint(key: string): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 16);
}

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
      "--license-key-env",
      "NEONDIFF_TEST_LICENSE_KEY",
      "--repo",
      "owner/private"
    ], { NEONDIFF_TEST_LICENSE_KEY: key });
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

  it("classifies expired, revoked, invalid, network, server, and hosted admin denial states", async () => {
    const root = mkRoot(roots);
    const expired = await startLicenseServer((_req, res) => writeJson(res, 402, { status: "expired", detail: "expired" }));
    const revoked = await startLicenseServer((_req, res) => writeJson(res, 410, { status: "revoked", detail: "revoked" }));
    const legacyForbidden = await startLicenseServer((_req, res) => writeJson(res, 403, { detail: "legacy forbidden" }));
    const invalid = await startLicenseServer((_req, res) => writeJson(res, 401, { status: "invalid", detail: "bad key" }));
    const server = await startLicenseServer((_req, res) => writeJson(res, 503, { detail: "try later" }));
    const scopeMismatch = await startLicenseServer((_req, res) => writeJson(res, 403, { status: "scope_mismatch", detail: "repo not covered" }));
    const statusPrecedence = await startLicenseServer((_req, res) => writeJson(res, 401, { status: "clock_skew", detail: "body status wins" }));
    const rateLimited = await startLicenseServer((_req, res) => writeJson(res, 429, { detail: "try later" }));
    const unsupportedClient = await startLicenseServer((_req, res) => writeJson(res, 426, { status: "unsupported_client", detail: "upgrade required" }));
    const clockSkew = await startLicenseServer((_req, res) => writeJson(res, 400, { status: "clock_skew", detail: "clock skew too large" }));
    servers.push(expired, revoked, legacyForbidden, invalid, server, scopeMismatch, statusPrecedence, rateLimited, unsupportedClient, clockSkew);

    await expectStatus(licenseConfig(root, expired.url), "expired");
    await expectStatus(licenseConfig(root, revoked.url), "revoked");
    await expectStatus(licenseConfig(root, legacyForbidden.url), "revoked");
    await expectStatus(licenseConfig(root, invalid.url), "invalid");
    await expectStatus(licenseConfig(root, server.url), "server");
    await expectStatus(licenseConfig(root, scopeMismatch.url), "scope_mismatch");
    await expectStatus(licenseConfig(root, statusPrecedence.url), "clock_skew");
    await expectStatus(licenseConfig(root, rateLimited.url), "rate_limited");
    await expectStatus(licenseConfig(root, unsupportedClient.url), "unsupported_client");
    await expectStatus(licenseConfig(root, clockSkew.url), "clock_skew");
    const network = await activateLicense({
      config: licenseConfig(root, "http://127.0.0.1:9"),
      licenseKey: "LIC-network-test-123456"
    });
    expect(network).toMatchObject({ ok: false, status: "network", classification: "network" });
  });

  it("preserves entitlement metadata from hosted admin status responses in the cache", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        privateRepoAllowed: true,
        updateEntitlement: true,
        offlineGraceMs: 60_000,
        graceUntil: "2026-07-04T00:15:00.000Z",
        plan: "supporter"
      });
    });
    servers.push(server);

    const activated = await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: "LIC-admin-metadata-test-123456",
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(activated.entitlement).toMatchObject({
      status: "active",
      repoVisibilityScope: "private",
      privateRepoAllowed: true,
      updateEntitlement: true,
      offlineGraceMs: 60_000,
      graceUntil: "2026-07-04T00:15:00.000Z",
      plan: "supporter"
    });

    const cached = await getLicenseStatus({
      config: licenseConfig(root, server.url),
      now: new Date("2026-07-04T00:01:00.000Z")
    });
    expect(cached.entitlement).toMatchObject({
      privateRepoAllowed: true,
      offlineGraceMs: 60_000,
      graceUntil: "2026-07-04T00:15:00.000Z"
    });
  });

  it("treats a non-active body status on a 2xx response as authoritative and fail-closed", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "scope_mismatch",
        repoVisibilityScope: "private",
        updateEntitlement: false
      });
    });
    servers.push(server);

    const result = await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: "LIC-2xx-denial-test-123456",
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: false,
      status: "scope_mismatch",
      classification: "scope_mismatch",
      entitlement: {
        status: "scope_mismatch",
        repoVisibilityScope: "private"
      }
    });
    expect(existsSync(join(root, "entitlement.json"))).toBe(false);
  });

  it("redacts revocation reason metadata before returning or caching it", async () => {
    const root = mkRoot(roots);
    const key = "LIC-revocation-reason-test-123456";
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "active",
        repoVisibilityScope: "private",
        updateEntitlement: true,
        revocationReason: `manual disable for ${key}`
      });
    });
    servers.push(server);

    const activated = await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: key,
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    const cacheText = readFileSync(join(root, "entitlement.json"), "utf8");

    expect(activated.entitlement?.revocationReason).toBe("manual disable for [REDACTED_LICENSE_KEY]");
    expect(cacheText).toContain("[REDACTED_LICENSE_KEY]");
    expect(JSON.stringify(activated)).not.toContain(key);
    expect(cacheText).not.toContain(key);
  });

  it("rejects keychain activation before contacting the API", async () => {
    const root = mkRoot(roots);
    let requests = 0;
    const server = await startLicenseServer((_req, res) => {
      requests += 1;
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true
      });
    });
    servers.push(server);
    const config = licenseConfig(root, server.url);
    config.storageBackend = "keychain";
    config.keyPath = undefined;

    const result = await activateLicense({
      config,
      licenseKey: "LIC-keychain-disabled-test-123456",
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(result).toMatchObject({
      ok: false,
      status: "invalid",
      source: "none",
      detail: expect.stringContaining("Keychain license activation is disabled")
    });
    expect(requests).toBe(0);
  });

  it("preserves configured license API base paths when building request URLs", async () => {
    const root = mkRoot(roots);
    const urls: string[] = [];

    const result = await activateLicense({
      config: licenseConfig(root, "https://license.example.invalid/api"),
      licenseKey: "LIC-path-prefix-test-123456",
      fetchImpl: (async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          status: "active",
          expiresAt: "2026-08-01T00:00:00.000Z",
          repoVisibilityScope: "private",
          updateEntitlement: true
        }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }) as typeof fetch
    });

    expect(result.ok).toBe(true);
    expect(urls).toEqual(["https://license.example.invalid/api/v1/license/activate"]);
  });

  it("keeps local license proof and fails when API deactivation notification fails", async () => {
    const root = mkRoot(roots);
    const key = "LIC-deactivate-notify-test-123456";
    const server = await startLicenseServer((req, res) => {
      if (req.url === "/v1/license/deactivate") {
        writeJson(res, 503, { detail: "try later" });
        return;
      }
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true
      });
    });
    servers.push(server);
    const configPath = join(root, "config.json");
    writeConfig(configPath, root, server.url);
    await runCli([
      "license",
      "activate",
      "--config",
      configPath,
      "--license-key-env",
      "NEONDIFF_TEST_LICENSE_KEY"
    ], { NEONDIFF_TEST_LICENSE_KEY: key });

    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "deactivate",
      "--config",
      configPath,
      "--notify-api",
      "true"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stdout: expect.stringContaining("\"ok\": false")
    });
    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "deactivate",
      "--config",
      configPath,
      "--notify-api",
      "true"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stdout: expect.stringContaining("\"status\": \"deactivation_failed\"")
    });
    expect(existsSync(join(root, "license.key"))).toBe(true);
    expect(existsSync(join(root, "entitlement.json"))).toBe(true);
  });

  it("does not echo API failure detail bodies that can contain license keys", async () => {
    const root = mkRoot(roots);
    const key = "plain-key-that-does-not-match-generic-pattern";
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 401, { status: "invalid", detail: `license ${key} is invalid` });
    });
    servers.push(server);

    const result = await activateLicense({ config: licenseConfig(root, server.url), licenseKey: key });

    expect(result.ok).toBe(false);
    expect(result.detail).toBe("license API returned 401: invalid");
    expect(JSON.stringify(result)).not.toContain(key);
  });

  it("rolls back server activation when local entitlement persistence fails", async () => {
    const root = mkRoot(roots);
    const blockedParent = join(root, "not-a-directory");
    writeFileSync(blockedParent, "blocks cache directory creation");
    const config = licenseConfig(root, undefined);
    config.apiBaseUrl = undefined;
    config.cachePath = join(blockedParent, "entitlement.json");
    const seenUrls: string[] = [];
    const server = await startLicenseServer((req, res) => {
      seenUrls.push(req.url ?? "");
      if (req.url === "/v1/license/deactivate") {
        writeJson(res, 200, {});
        return;
      }
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true
      });
    });
    servers.push(server);
    config.apiBaseUrl = server.url;

    await expect(activateLicense({
      config,
      licenseKey: "LIC-rollback-persistence-test-123456",
      repo: "owner/private"
    })).rejects.toThrow();

    expect(seenUrls).toEqual(["/v1/license/activate", "/v1/license/deactivate"]);
    expect(existsSync(join(root, "license.key"))).toBe(false);
    expect(existsSync(config.cachePath)).toBe(false);
  });

  it("derives cache path from statePath and rejects license artifacts inside the checkout", () => {
    const root = mkRoot(roots);
    const config = loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state", "reviews.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        apiBaseUrl: "https://license.example.invalid"
      }
    });

    expect(config.license?.cachePath).toBe(join(root, "state", "license", "entitlement-cache.json"));
    const otherRoot = mkRoot(roots);
    const otherConfig = loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(otherRoot, "runtime"),
      statePath: join(otherRoot, "state", "reviews.sqlite"),
      evidenceDir: join(otherRoot, "evidence"),
      license: {
        enabled: true,
        apiBaseUrl: "https://license.example.invalid"
      }
    });
    expect(otherConfig.license?.cachePath).toBe(join(otherRoot, "state", "license", "entitlement-cache.json"));

    expect(() => loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        apiBaseUrl: "https://license.example.invalid",
        cachePath: join(process.cwd(), "license-cache.json")
      }
    })).toThrow(/config\.license\.cachePath must be outside protected checkout root/);

    expect(() => loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        apiBaseUrl: "http://license.example.invalid",
        cachePath: join(root, "entitlement.json"),
        storageBackend: "file",
        keyPath: join(root, "license.key")
      }
    })).toThrow(/config\.license\.apiBaseUrl must use https/);
  });

  it("requires an API base URL when license enforcement is enabled", () => {
    const root = mkRoot(roots);

    expect(() => loadConfigFromObject({
      pilotRepos: ["owner/repo"],
      workRoot: join(root, "runtime"),
      statePath: join(root, "state.sqlite"),
      evidenceDir: join(root, "evidence"),
      license: {
        enabled: true,
        cachePath: join(root, "entitlement.json"),
        storageBackend: "file",
        keyPath: join(root, "license.key")
      }
    })).toThrow(/config\.license\.apiBaseUrl is required when config\.license\.enabled=true/);
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

  it("stamps API entitlement checkedAt locally instead of trusting server time", async () => {
    const root = mkRoot(roots);
    const now = new Date("2026-07-04T00:00:00.000Z");
    const server = await startLicenseServer((_req, res) => {
      writeJson(res, 200, {
        status: "active",
        checkedAt: "2099-01-01T00:00:00.000Z",
        expiresAt: "2099-02-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true
      });
    });
    servers.push(server);

    const result = await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: "LIC-local-checked-at-test-123456",
      now
    });

    expect(result.entitlement?.checkedAt).toBe(now.toISOString());
    expect(JSON.parse(readFileSync(join(root, "entitlement.json"), "utf8")).checkedAt).toBe(now.toISOString());
  });

  it("refreshes stale private gate cache when the API is healthy", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => writeJson(res, 200, {
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2999-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    }));
    servers.push(server);
    const config = licenseConfig(root, server.url);
    writeFileSync(join(root, "license.key"), "LIC-refresh-gate-test-123456\n", { mode: 0o600 });
    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });

    const gate = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      now: new Date("2026-07-04T00:00:00.000Z")
    });

    expect(gate).toMatchObject({ ok: true, status: "active" });
  });

  it("clears cached active entitlement after terminal API denial", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => writeJson(res, 410, { status: "revoked", detail: "revoked" }));
    servers.push(server);
    const config = licenseConfig(root, server.url);
    const licenseKey = "LIC-revoked-cache-test-123456";
    writeFileSync(join(root, "license.key"), `${licenseKey}\n`, { mode: 0o600 });
    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true,
      licenseFingerprint: testLicenseFingerprint(licenseKey)
    })}\n`, { mode: 0o600 });

    const status = await getLicenseStatus({
      config,
      refresh: true,
      now: new Date("2026-07-04T00:00:30.000Z")
    });

    expect(status).toMatchObject({ ok: false, status: "revoked", source: "api" });
    expect(existsSync(join(root, "entitlement.json"))).toBe(false);
  });

  it("keeps cached entitlement for a different stored key after terminal API denial", async () => {
    const root = mkRoot(roots);
    const server = await startLicenseServer((_req, res) => writeJson(res, 401, { status: "invalid", detail: "bad key" }));
    servers.push(server);
    const config = licenseConfig(root, server.url);
    writeFileSync(join(root, "license.key"), "LIC-current-key-123456\n", { mode: 0o600 });
    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true,
      licenseFingerprint: testLicenseFingerprint("LIC-other-key-123456")
    })}\n`, { mode: 0o600 });

    const status = await getLicenseStatus({
      config,
      refresh: true,
      now: new Date("2026-07-04T00:00:30.000Z")
    });

    expect(status).toMatchObject({ ok: false, status: "invalid", source: "api" });
    expect(existsSync(join(root, "entitlement.json"))).toBe(true);
  });

  it("proves public/private repo entitlement outcomes at the license gate", async () => {
    const now = new Date("2026-07-04T00:00:30.000Z");
    const rows: Array<{
      name: string;
      visibility: "public" | "private" | "unknown";
      publicReposFree?: boolean;
      entitlement?: "active-public" | "active-private" | "expired-private" | "revoked-private" | "revoked-expired-private";
      expected: {
        ok: boolean;
        status: string;
        reason: string | RegExp;
      };
    }> = [
      {
        name: "public repo, no license",
        visibility: "public",
        expected: { ok: true, status: "active", reason: "public repo path is free" }
      },
      {
        name: "public repo, commercial entitlement mode, no license",
        visibility: "public",
        publicReposFree: false,
        expected: { ok: false, status: "missing", reason: /public repo review requires active entitlement/ }
      },
      {
        name: "public repo, commercial entitlement mode, active public entitlement",
        visibility: "public",
        publicReposFree: false,
        entitlement: "active-public",
        expected: { ok: true, status: "active", reason: "active entitlement covers public repo review" }
      },
      {
        name: "public repo, commercial entitlement mode, active private entitlement",
        visibility: "public",
        publicReposFree: false,
        entitlement: "active-private",
        expected: { ok: true, status: "active", reason: "active entitlement covers public repo review" }
      },
      {
        name: "private repo, no license",
        visibility: "private",
        expected: { ok: false, status: "missing", reason: /private repo review requires active entitlement/ }
      },
      {
        name: "private repo, active private entitlement",
        visibility: "private",
        entitlement: "active-private",
        expected: { ok: true, status: "active", reason: "active entitlement covers private repo review" }
      },
      {
        name: "private repo, expired entitlement",
        visibility: "private",
        entitlement: "expired-private",
        expected: { ok: false, status: "expired", reason: /private repo review requires active entitlement/ }
      },
      {
        name: "private repo, revoked entitlement",
        visibility: "private",
        entitlement: "revoked-private",
        expected: { ok: false, status: "revoked", reason: /private repo review requires active entitlement/ }
      },
      {
        name: "private repo, revoked and expired entitlement",
        visibility: "private",
        entitlement: "revoked-expired-private",
        expected: { ok: false, status: "revoked", reason: /private repo review requires active entitlement/ }
      },
      {
        name: "unknown visibility, active private entitlement",
        visibility: "unknown",
        entitlement: "active-private",
        expected: { ok: false, status: "network", reason: /repo visibility is unknown/ }
      }
    ];

    for (const row of rows) {
      const root = mkRoot(roots);
      const config = licenseConfig(root, undefined);
      config.publicReposFree = row.publicReposFree ?? true;
      if (row.entitlement) writeEntitlementFixture(root, row.entitlement);

      const result = await evaluateLicenseReviewGate({
        config,
        repo: `owner/${row.visibility}-matrix`,
        visibility: row.visibility,
        now
      });

      expect(result, row.name).toMatchObject({
        ok: row.expected.ok,
        status: row.expected.status
      });
      if (typeof row.expected.reason === "string") {
        expect(result.reason, row.name).toBe(row.expected.reason);
      } else {
        expect(result.reason, row.name).toMatch(row.expected.reason);
      }
    }
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

    const paidPublicRoot = mkRoot(roots);
    const paidPublicConfig = licenseConfig(paidPublicRoot, undefined);
    paidPublicConfig.publicReposFree = false;
    const paidPublic = await evaluateLicenseReviewGate({
      config: paidPublicConfig,
      repo: "owner/public",
      visibility: "public",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(paidPublic).toMatchObject({
      ok: false,
      status: "missing",
      reason: expect.stringContaining("public repo review requires active entitlement")
    });

    writeFileSync(join(paidPublicRoot, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-04T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    const paidPublicWithPrivateScope = await evaluateLicenseReviewGate({
      config: paidPublicConfig,
      repo: "owner/public",
      visibility: "public",
      now: new Date("2026-07-04T00:00:00.000Z")
    });
    expect(paidPublicWithPrivateScope).toMatchObject({
      ok: true,
      reason: "active entitlement covers public repo review"
    });
  });

  it("rejects malformed API success responses and reports missing env vars clearly", async () => {
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
    expect(activated).toMatchObject({
      ok: false,
      status: "invalid",
      classification: "invalid"
    });

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

    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "activate",
      "--config",
      configPath,
      "--license-key",
      "LIC-argv-secret-test-123456"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("argv can expose secrets")
    });

    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "status",
      "--config",
      configPath,
      "--license-cache-path",
      join(process.cwd(), "license-cache.json")
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("config.license.cachePath must be outside protected checkout root")
    });

    await expect(execFileAsync(process.execPath, [
      tsxCliPath,
      "src/cli.ts",
      "license",
      "status",
      "--config",
      configPath,
      "--refresh",
      "yes"
    ], {
      cwd: process.cwd(),
      env: { ...process.env, NODE_OPTIONS: "--experimental-sqlite" }
    })).rejects.toMatchObject({
      stderr: expect.stringContaining("--refresh must be true or false")
    });
  });

  it("tightens existing file backend key permissions on activation", async () => {
    const root = mkRoot(roots);
    const keyPath = join(root, "license.key");
    const server = await startLicenseServer((_req, res) => writeJson(res, 200, {
      status: "active",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    }));
    servers.push(server);
    writeFileSync(keyPath, "old-key\n", { mode: 0o644 });
    await activateLicense({
      config: licenseConfig(root, server.url),
      licenseKey: "LIC-permission-test-123456"
    });

    expect(statSync(keyPath).mode & 0o777).toBe(0o600);
  });

  it("blocks provider-configured private repo worker reviews before checkout, provider, or posting when entitlement is missing", async () => {
    const root = mkRoot(roots);
    const state = new ReviewStateStore(join(root, "state.sqlite"));
    const config = minimalConfig(root);
    config.zcode.providerId = "local-provider";
    config.providers = {
      defaultProviderId: "local-provider",
      providers: {
        "local-provider": {
          enabled: true,
          adapter: "openai-compatible",
          displayName: "Local provider configured for license-gate ordering proof",
          baseUrl: "http://127.0.0.1:11434/v1",
          model: "qwen2.5-coder:7b",
          authMode: "none",
          capabilities: {
            review: true,
            jsonOutput: true,
            local: true,
            streaming: false
          }
        }
      }
    };
    const pull = pullSummary(7, "private-head");
    const github = new GitHubApi({});
    github.getRepo = async () => ({ full_name: "owner/private", private: true as const, visibility: "private" as const });
    github.listPullFiles = async () => {
      throw new Error("license gate should block before checkout/file listing/provider work");
    };
    github.createReview = async () => {
      throw new Error("license gate should block before GitHub review posting");
    };

    const status = await reviewPull({
      config,
      github,
      state,
      repo: "owner/private",
      pull,
      dryRun: false,
      useZCode: true,
      budget: new ReviewRunBudget(1)
    });

    expect(status).toBe("skipped_license_gate");
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

  it("enforces private entitlement proof for dry-run reviews", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    const github = new GitHubApi({});
    github.getRepo = async () => {
      throw new Error("getRepo should not run");
    };

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/private",
      pull: privatePullSummary(8, "dry-run-head"),
      dryRun: true
    })).resolves.toMatchObject({
      ok: false,
      status: "missing",
      reason: expect.stringContaining("private repo review requires active entitlement")
    });
  });

  it("uses cache-only license freshness for dry-run private review gates", async () => {
    const root = mkRoot(roots);
    let requests = 0;
    const server = await startLicenseServer((_req, res) => {
      requests += 1;
      writeJson(res, 200, {
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        updateEntitlement: true
      });
    });
    servers.push(server);
    const config = minimalConfig(root);
    config.license = licenseConfig(root, server.url);
    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: new Date().toISOString(),
      expiresAt: "2999-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    const github = new GitHubApi({});
    github.getRepo = async () => ({ full_name: "owner/private", private: true as const, visibility: "private" as const });

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/private",
      pull: privatePullSummary(15, "dry-run-cache-head"),
      dryRun: true
    })).resolves.toMatchObject({
      ok: true,
      reason: "active entitlement covers private repo review"
    });
    expect(requests).toBe(0);

    writeFileSync(join(root, "entitlement.json"), `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-01T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "private",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/private",
      pull: privatePullSummary(16, "dry-run-stale-cache-head"),
      dryRun: true
    })).resolves.toMatchObject({
      ok: false,
      reason: expect.stringContaining("fresh entitlement cache")
    });
    expect(requests).toBe(0);
  });

  it("skips live metadata for public repo license gate paths", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    const github = new GitHubApi({});
    github.getRepo = async () => {
      throw new Error("getRepo should not run");
    };

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/public",
      pull: publicPullSummary(9, "public-head"),
      dryRun: false
    })).resolves.toMatchObject({
      ok: true,
      visibility: "public",
      reason: "public repo path is free"
    });

    const publicWithoutVisibility = publicPullSummary(17, "public-private-flag-head");
    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/public",
      pull: {
        ...publicWithoutVisibility,
        base: {
          ...publicWithoutVisibility.base,
          repo: { full_name: "owner/public", private: false }
        }
      },
      dryRun: false
    })).resolves.toMatchObject({
      ok: true,
      visibility: "public",
      reason: "public repo path is free"
    });
  });

  it("does not fetch repo metadata when unknown visibility is configured to avoid private entitlement", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    config.license!.privateReposRequireEntitlement = false;
    const github = new GitHubApi({});
    github.getRepo = async () => {
      throw new Error("getRepo should not run");
    };

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/unknown",
      pull: pullSummary(10, "unknown-head"),
      dryRun: false
    })).resolves.toMatchObject({
      ok: true,
      visibility: "unknown",
      reason: "repo visibility does not require entitlement"
    });
  });

  it("does not fetch repo metadata for unknown visibility during dry-run license gates", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    const github = new GitHubApi({});
    github.getRepo = async () => {
      throw new Error("getRepo should not run");
    };

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/private",
      pull: pullSummary(18, "dry-run-unknown-visibility"),
      dryRun: true
    })).resolves.toMatchObject({
      ok: false,
      visibility: "unknown",
      reason: "repo visibility is unknown; private repo entitlement gate fails closed"
    });
  });

  it("caches fallback repo visibility metadata during license gate checks", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    let getRepoCalls = 0;
    const github = new GitHubApi({});
    github.getRepo = async () => {
      getRepoCalls += 1;
      return { full_name: "owner/cache-visibility", private: true as const, visibility: "private" as const };
    };

    for (const head of ["head-a", "head-b"]) {
      const pull = pullSummary(11, head);
      await expect(buildLicenseGateForPull({
        config,
        github,
        repo: "owner/cache-visibility",
        pull: {
          ...pull,
          base: { ...pull.base, repo: { full_name: "owner/cache-visibility" } }
        },
        dryRun: false
      })).resolves.toMatchObject({
        ok: false,
        visibility: "private"
      });
    }

    expect(getRepoCalls).toBe(1);
  });

  it("caches fallback public repo visibility metadata during license gate checks", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    let getRepoCalls = 0;
    const github = new GitHubApi({});
    github.getRepo = async () => {
      getRepoCalls += 1;
      return { full_name: "owner/cache-public-visibility", private: false as const, visibility: "public" as const };
    };

    for (const head of ["public-head-a", "public-head-b"]) {
      const pull = pullSummary(13, head);
      await expect(buildLicenseGateForPull({
        config,
        github,
        repo: "owner/cache-public-visibility",
        pull: {
          ...pull,
          base: { ...pull.base, repo: { full_name: "owner/cache-public-visibility" } }
        },
        dryRun: false
      })).resolves.toMatchObject({
        ok: true,
        visibility: "public"
      });
    }

    expect(getRepoCalls).toBe(1);
  });

  it("caches unknown fallback repo visibility metadata during license gate checks", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    let getRepoCalls = 0;
    const github = new GitHubApi({});
    github.getRepo = async () => {
      getRepoCalls += 1;
      return { full_name: "owner/cache-unknown-visibility", private: false };
    };

    for (const head of ["unknown-head-a", "unknown-head-b"]) {
      const pull = pullSummary(14, head);
      await expect(buildLicenseGateForPull({
        config,
        github,
        repo: "owner/cache-unknown-visibility",
        pull: {
          ...pull,
          base: { ...pull.base, repo: { full_name: "owner/cache-unknown-visibility" } }
        },
        dryRun: false
      })).resolves.toMatchObject({
        ok: false,
        visibility: "unknown",
        reason: expect.stringContaining("visibility is unknown")
      });
    }

    expect(getRepoCalls).toBe(1);
  });

  it("does not retry repo metadata lookup inside the license gate fallback", async () => {
    const root = mkRoot(roots);
    const config = minimalConfig(root);
    let getRepoCalls = 0;
    const github = new GitHubApi({});
    github.getRepo = async () => {
      getRepoCalls += 1;
      throw new Error("secondary rate limit");
    };

    await expect(buildLicenseGateForPull({
      config,
      github,
      repo: "owner/rate-limited",
      pull: pullSummary(12, "head-rate-limited"),
      dryRun: false
    })).resolves.toMatchObject({
      ok: false,
      status: "network",
      reason: expect.stringContaining("secondary rate limit")
    });
    expect(getRepoCalls).toBe(1);
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

function writeEntitlementFixture(
  root: string,
  fixture: "active-public" | "active-private" | "expired-private" | "revoked-private" | "revoked-expired-private"
): void {
  const entitlement = {
    status: fixture === "revoked-private" || fixture === "revoked-expired-private" ? "revoked" : "active",
    checkedAt: "2026-07-04T00:00:00.000Z",
    expiresAt: fixture === "expired-private" || fixture === "revoked-expired-private"
      ? "2026-07-03T00:00:00.000Z"
      : "2026-08-01T00:00:00.000Z",
    repoVisibilityScope: fixture === "active-public" ? "public" : "private",
    updateEntitlement: true
  };
  writeFileSync(join(root, "entitlement.json"), `${JSON.stringify(entitlement)}\n`, { mode: 0o600 });
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

async function runCli(args: string[], env: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const { stdout } = await execFileAsync(process.execPath, [tsxCliPath, "src/cli.ts", ...args], {
    cwd: process.cwd(),
    env: { ...process.env, ...env, NODE_OPTIONS: "--experimental-sqlite" },
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

function privatePullSummary(number: number, headSha: string): PullRequestSummary {
  const pull = pullSummary(number, headSha);
  return {
    ...pull,
    base: {
      ...pull.base,
      repo: { full_name: "owner/private", private: true, visibility: "private" }
    }
  };
}

function publicPullSummary(number: number, headSha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    state: "open",
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "owner/public", private: false, visibility: "public" }
    },
    base: {
      sha: "base",
      ref: "main",
      repo: { full_name: "owner/public", private: false, visibility: "public" }
    },
    html_url: `https://github.com/owner/public/pull/${number}`
  };
}

function localDateFolder(now = new Date()): string {
  const year = String(now.getFullYear()).padStart(4, "0");
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
