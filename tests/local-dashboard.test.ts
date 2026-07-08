import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import {
  buildLocalDashboardStatus,
  renderLocalDashboardHtml,
  startLocalDashboardServer,
  verifyProviderApiKey
} from "../src/local-dashboard.js";

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
        githubApp: expect.objectContaining({ id: "githubApp", state: "not_configured", redacted: true }),
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
      keyFingerprint: expect.stringMatching(/^sha256:[a-f0-9]{12}$/)
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(fakeKey);
    expect(serialized).not.toContain("dashboard-secret-value");
    expect(serialized).not.toMatch(/Bearer\s+/i);
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

  it("serves HTML status and redacted provider verification routes", async () => {
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
    expect(response.status).toBe(422);
    expect(resultText).toContain("configured_unverified");
    expect(resultText).not.toContain(fakeKey);
    expect(resultText).not.toContain("dashboard-route");
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
