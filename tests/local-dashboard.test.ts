import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildLocalDashboardStatus,
  renderLocalDashboardHtml,
  runLocalDashboardPreviewSmoke,
  startLocalDashboardServer,
  verifyProviderApiKey
} from "../src/local-dashboard.js";
import { createTestLicenseAdmission } from "./helpers/license-admission.js";

const providerVerificationAdmission = await createTestLicenseAdmission({ operation: "provider_verify" });
const admittedProviderVerification = async () => ({
  ok: true as const,
  admission: providerVerificationAdmission
});

describe("local HTML dashboard", () => {
  const servers: Server[] = [];

  afterEach(async () => {
    await Promise.all(servers.splice(0).map((server) => closeServer(server)));
  });

  it("builds a redacted first-run status contract for an empty config", async () => {
    const config = loadConfigFromObject({});
    const status = await buildLocalDashboardStatus({
      config,
      configPath: "/Volumes/LEXAR/Codex/neondiff/config.local.json",
      configExists: false,
      now: new Date("2026-07-08T12:00:00.000Z")
    });

    expect(status).toMatchObject({
      ok: false,
      command: "dashboard status",
      schemaVersion: "local-dashboard-status-v0.1",
      config: {
        exists: false,
        source: "defaults"
      },
      items: {
        license: expect.objectContaining({ id: "license", redacted: true }),
        githubApp: expect.objectContaining({
          id: "githubApp",
          state: "not_configured",
          redacted: true,
          metadata: expect.objectContaining({ clientIdConfigured: false })
        }),
        daemon: expect.objectContaining({ id: "daemon", state: "not_configured", redacted: true }),
        provider: expect.objectContaining({ id: "provider", state: "configured_unverified", redacted: true })
      },
      providers: {
        defaultProviderId: "zcode-glm",
        options: expect.arrayContaining([
          expect.objectContaining({ id: "zcode-glm", default: true }),
          expect.objectContaining({ id: "openai-compatible", authMode: "api-key-env" })
        ])
      }
    });

    const html = renderLocalDashboardHtml(status);
    expect(html).toContain("NeonDiff Dashboard");
    expect(html).toContain("Verify API Key");
    expect(html).toContain("License");
    expect(html).toContain("GitHub App");
    expect(html).toContain("Daemon");
    expect(html).toContain("Provider");
    expect(html).toContain("openai-compatible");
  });

  it("reports GitHub App client-id readiness without exposing user tokens", async () => {
    const config = loadConfigFromObject({
      github: {
        appId: "4184532",
        clientId: "Iv1.publicclientid123",
        botLogin: "neondiff-review-bot"
      }
    });
    const status = await buildLocalDashboardStatus({
      config,
      configPath: "/Volumes/LEXAR/Codex/neondiff/config.local.json",
      configExists: true,
      now: new Date("2026-07-08T12:00:00.000Z")
    });

    expect(status.items.githubApp).toMatchObject({
      id: "githubApp",
      state: "configured_unverified",
      redacted: true,
      metadata: {
        appIdConfigured: true,
        clientIdConfigured: true,
        botLogin: "neondiff-review-bot"
      }
    });
    expect(JSON.stringify(status)).not.toMatch(/ghu_|ghr_|github_pat_|ghp_/);
  });

  it("verifies provider API key input without echoing the submitted key", async () => {
    const fakeKey = ["sk", "dashboard-secret-value-1234567890"].join("-");
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model"
          }
        }
      }
    });

    const result = await verifyProviderApiKey({
      config,
      providerId: "openai-compatible",
      apiKey: fakeKey,
      allowRemoteSmoke: false,
      env: {}
    });

    expect(result).toMatchObject({
      ok: false,
      command: "dashboard verify-provider",
      providerId: "openai-compatible",
      state: "configured_unverified",
      mode: "metadata_only",
      redacted: true,
      keySource: "submitted"
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain("dashboard-secret-value");
    expect(serialized).not.toMatch(/Bearer\s+/i);
  });

  it("allows the public CLI discriminator without weakening verification redaction", async () => {
    const fakeKey = "fixture-provider-value";
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model"
          }
        }
      }
    });

    const result = await verifyProviderApiKey({
      command: "providers verify",
      config,
      apiKey: fakeKey,
      allowRemoteSmoke: false,
      env: {}
    });

    expect(result).toMatchObject({
      ok: false,
      command: "providers verify",
      state: "configured_unverified",
      redacted: true,
      keySource: "submitted"
    });
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("performs a real loopback /models smoke check when provider verification is local", async () => {
    const modelServer = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      response.setHeader("Content-Type", "application/json");
      if (request.method === "GET" && url.pathname === "/v1/models") {
        response.end(JSON.stringify({ data: [{ id: "local-review-model" }] }));
        return;
      }
      response.statusCode = 404;
      response.end(JSON.stringify({ message: "not found" }));
    });
    servers.push(modelServer);
    await listen(modelServer);
    const address = modelServer.address() as AddressInfo;
    const fakeKey = ["sk", "local-dashboard-loopback-1234567890"].join("-");
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            model: "local-review-model",
            capabilities: {
              local: true
            }
          }
        }
      }
    });

    const result = await verifyProviderApiKey({
      config,
      providerId: "openai-compatible",
      apiKey: fakeKey,
      env: {}
    });

    expect(result).toMatchObject({
      ok: true,
      state: "healthy",
      mode: "openai_compatible_models",
      check: expect.objectContaining({
        smokeAttempted: true,
        readMode: "openai_compatible_models",
        modelCount: 1
      })
    });
    expect(JSON.stringify(result)).not.toContain(fakeKey);
  });

  it("serves HTML status but blocks provider verification before activation", async () => {
    const fakeKey = ["sk", "dashboard-route-1234567890"].join("-");
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model"
          }
        }
      }
    });
    const handle = await startLocalDashboardServer({
      config,
      configPath: "/Volumes/LEXAR/Codex/neondiff/config.local.json",
      configExists: true,
      openBrowser: false,
      port: 0
    });
    servers.push(handle.server);

    const html = await (await fetch(handle.url)).text();
    expect(html).toContain("Verify API Key");
    expect(html).toContain("dashboard-status");

    const response = await fetch(new URL("/api/provider/verify", handle.url), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        providerId: "openai-compatible",
        apiKey: fakeKey,
        allowRemoteSmoke: false
      })
    });
    const resultText = await response.text();
    expect(response.status).toBe(403);
    expect(resultText).toContain("license missing");
    expect(resultText).not.toContain(fakeKey);
    expect(resultText).not.toContain("dashboard-route");
  });

  it("writes a preview-smoke evidence packet for browser-first dashboard validation", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-dashboard-preview-smoke-"));
    const fakeKey = ["sk", "preview-smoke-route-1234567890"].join("-");
    const screenshotPath = join(outputDir, "dashboard.png");
    const config = loadConfigFromObject({
      providers: {
        defaultProviderId: "openai-compatible",
        providers: {
          "openai-compatible": {
            enabled: true,
            baseUrl: "https://gateway.example.test/v1",
            model: "review-model"
          }
        }
      }
    });

    const smoke = await runLocalDashboardPreviewSmoke({
      config,
      configPath: "/Volumes/LEXAR/Codex/neondiff/config.local.json",
      configExists: true,
      outputDir,
      providerId: "openai-compatible",
      apiKey: fakeKey,
      allowRemoteSmoke: false,
      screenshotPath,
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      requireActiveProductionLicense: admittedProviderVerification
    });

    expect(smoke).toMatchObject({
      ok: true,
      command: "dashboard preview-smoke",
      route: "/",
      sourceSha: "0123456789abcdef0123456789abcdef01234567",
      screenshotPath,
      settledUiState: {
        htmlLoaded: true,
        statusApiLoaded: true,
        providerVerifyRouteLoaded: true,
        controlsRendered: true
      }
    });
    expect(existsSync(smoke.htmlPath)).toBe(true);
    expect(existsSync(smoke.statusPath)).toBe(true);
    expect(existsSync(smoke.providerVerifyPath)).toBe(true);
    expect(existsSync(smoke.packetPath)).toBe(true);
    expect(readFileSync(smoke.htmlPath, "utf8")).toContain("Verify API Key");
    const serialized = JSON.stringify(smoke) + readFileSync(smoke.packetPath, "utf8");
    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain("preview-smoke-route");
  });

  it("treats an activation-blocked provider route as loaded in setup-safe preview smoke", async () => {
    const outputDir = mkdtempSync(join(tmpdir(), "neondiff-dashboard-preview-blocked-"));
    const smoke = await runLocalDashboardPreviewSmoke({
      config: loadConfigFromObject({}),
      configPath: join(outputDir, "config.local.json"),
      configExists: false,
      outputDir
    });

    expect(smoke).toMatchObject({
      ok: true,
      settledUiState: {
        providerVerifyRouteLoaded: true,
        providerVerifyStatus: 403
      }
    });
  });
});

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
}

async function closeServer(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
