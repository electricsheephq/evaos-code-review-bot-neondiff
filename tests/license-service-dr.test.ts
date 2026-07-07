import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLicense,
  evaluateLicenseReviewGate,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { createLicenseRequestListener } from "../services/license-api/src/http.js";
import { RateLimiter } from "../services/license-api/src/service.js";
import { LicenseStore } from "../services/license-api/src/store.js";

const repoRoot = process.cwd();
const licenseApiDir = join(repoRoot, "services/license-api");
const dbPath = "/data/license.sqlite";
const litestreamVersion = "0.5.14";
const litestreamLinuxX64Sha = "32083dd2af13840b273c538360b828368d7b82bbaa2c641106052dc7814ed956";
const litestreamLinuxArm64Sha = "b49b3d01fb0a8b4d426ee613c080fba44acae0551587dc43525dcd93eee64b4f";

function readServiceFile(relativePath: string): string {
  return readFileSync(join(licenseApiDir, relativePath), "utf8");
}

function licenseConfig(root: string, apiBaseUrl: string): LicenseConfig {
  return {
    enabled: true,
    apiBaseUrl,
    cachePath: join(root, "entitlement.json"),
    storageBackend: "file",
    keyPath: join(root, "license.key"),
    keychainService: "neondiff-dr-test",
    keychainAccount: "neondiff-dr-test",
    requestTimeoutMs: 5_000,
    offlineGraceMs: 10_000,
    publicReposFree: true,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: false
  };
}

function serviceFetchFor(store: LicenseStore, machineId: string): typeof fetch {
  const listener = createLicenseRequestListener({
    store,
    // This test is about client grace behavior, not service throttling.
    rateLimiter: new RateLimiter({ maxPerWindow: 1000, windowMs: 60_000 })
  });

  return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input.toString();
    const path = new URL(url).pathname;
    const originalBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
    const body = JSON.stringify({ ...originalBody, machineId });

    return await new Promise<Response>((resolve) => {
      const req: any = {
        method: init?.method ?? "POST",
        url: path,
        on(event: string, cb: (arg?: unknown) => void) {
          if (event === "data") cb(Buffer.from(body));
          if (event === "end") cb();
          return req;
        },
        destroy() {}
      };
      let statusCode = 200;
      let headers: Record<string, string> = {};
      const responseChunks: string[] = [];
      const res: any = {
        writeHead(code: number, h: Record<string, string>) {
          statusCode = code;
          headers = h;
          return res;
        },
        end(payload?: string) {
          if (payload) responseChunks.push(payload);
          resolve(new Response(responseChunks.join(""), { status: statusCode, headers }));
        }
      };
      void listener(req, res);
    });
  }) as typeof fetch;
}

const outageFetch = (async (): Promise<Response> => {
  throw new Error("simulated license API outage");
}) as typeof fetch;

describe("license service disaster recovery wiring", () => {
  it("pins Litestream install, config, and entrypoint to the mounted license database without secrets", () => {
    const dockerfile = readServiceFile("Dockerfile");
    const litestreamConfig = readServiceFile("litestream.yml");
    const entrypoint = readServiceFile("docker-entrypoint.sh");
    const flyConfig = readServiceFile("fly.toml");

    expect(dockerfile).toContain(`LITESTREAM_VERSION=${litestreamVersion}`);
    expect(dockerfile).toContain(litestreamLinuxX64Sha);
    expect(dockerfile).toContain(litestreamLinuxArm64Sha);
    expect(dockerfile).toContain("COPY services/license-api/litestream.yml /etc/litestream.yml");
    expect(dockerfile).toContain("COPY services/license-api/docker-entrypoint.sh /usr/local/bin/license-api-entrypoint");
    expect(dockerfile).toContain("chown node:node /data");
    expect(dockerfile).toContain('ENTRYPOINT ["license-api-entrypoint"]');

    expect(litestreamConfig).toContain(`path: \${LICENSE_DB_PATH}`);
    expect(litestreamConfig).toContain("url: ${LICENSE_REPLICA_URL}");
    expect(litestreamConfig).not.toContain("replicas:");
    expect(litestreamConfig).not.toMatch(/^\s*url:\s+(?!\$\{LICENSE_REPLICA_URL\}\s*$).+/m);
    expect(litestreamConfig).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S/i);

    expect(entrypoint).toContain(`LICENSE_DB_PATH:=/data/license.sqlite`);
    expect(entrypoint).toContain('if [ ! -f "$LICENSE_DB_PATH" ]');
    expect(entrypoint).toContain('litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$LICENSE_DB_PATH"');
    expect(entrypoint).toContain('exec litestream replicate -config "$LITESTREAM_CONFIG" -exec "node dist/server.js"');
    expect(entrypoint).toContain("LICENSE_LITESTREAM_REQUIRED");
    expect(entrypoint).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S|password\s*=/i);

    expect(flyConfig).toContain(`LICENSE_DB_PATH = "${dbPath}"`);
    expect(flyConfig).toContain('LICENSE_REPLICA_URL');
    expect(flyConfig).not.toMatch(/^\s*LICENSE_REPLICA_URL\s*=/m);
    expect(flyConfig).toContain('LICENSE_LITESTREAM_REQUIRED = "true"');
    expect(flyConfig).toContain('source = "license_data"');
    expect(flyConfig).toContain('destination = "/data"');
    expect(flyConfig).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key|account-key|password\s*=/i);
  });

  it("documents owner-gated DR proof without claiming live replication from this source-only slice", () => {
    const deployRunbook = readServiceFile("docs/deploy.md");
    const adminRunbook = readServiceFile("docs/admin-runbook.md");
    const drRunbook = readServiceFile("docs/disaster-recovery.md");

    expect(deployRunbook).toContain("disaster-recovery.md");
    expect(adminRunbook).toContain("disaster-recovery.md");
    expect(drRunbook).toContain("RPO target: <= 5 minutes");
    expect(drRunbook).toContain("RTO target: <= 30 minutes");
    expect(drRunbook).toContain("Owner-gated");
    expect(drRunbook).toContain("flyctl secrets set");
    expect(drRunbook).toContain("timed staging restore drill");
    expect(drRunbook).toContain("This source-only PR does not prove live replication");
    expect(drRunbook).not.toContain("/Volumes/LEXAR/Codex");
    expect(drRunbook).not.toMatch(/AKIA[0-9A-Z]{16}|ASIA[0-9A-Z]{16}|secret-access-key:\s+\S|account-key:\s+\S/i);
  });
});

describe("license service outage grace", () => {
  const roots: string[] = [];
  const stores: LicenseStore[] = [];

  afterEach(async () => {
    for (const store of stores.splice(0)) store.close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("uses a real local license API activation, then fails closed after offline grace expires", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-license-dr-"));
    roots.push(root);
    const store = new LicenseStore(join(root, "license.sqlite"));
    stores.push(store);
    const issued = store.issueLicense({ plan: "yearly", repoVisibilityScope: "private", seats: 1 });
    const base = new Date("2026-07-08T00:00:00.000Z");
    const config = licenseConfig(root, "http://127.0.0.1:8080");

    const activated = await activateLicense({
      config,
      licenseKey: issued.rawKey,
      repo: "owner/private",
      now: base,
      fetchImpl: serviceFetchFor(store, "machine-a")
    });
    expect(activated).toMatchObject({ ok: true, status: "active", source: "api" });
    expect(existsSync(join(root, "entitlement.json"))).toBe(true);

    const withinGraceStatus = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: new Date(base.getTime() + 5_000),
      fetchImpl: outageFetch
    });
    expect(withinGraceStatus).toMatchObject({
      ok: true,
      status: "active",
      source: "cache",
      stale: true,
      classification: "network"
    });

    const withinGraceGate = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      refresh: true,
      now: new Date(base.getTime() + 5_000),
      fetchImpl: outageFetch
    });
    expect(withinGraceGate).toMatchObject({ ok: true, status: "active" });

    const afterGraceStatus = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      now: new Date(base.getTime() + 11_000),
      fetchImpl: outageFetch
    });
    expect(afterGraceStatus).toMatchObject({
      ok: false,
      status: "network",
      source: "none",
      classification: "network"
    });

    const afterGraceGate = await evaluateLicenseReviewGate({
      config,
      repo: "owner/private",
      visibility: "private",
      refresh: true,
      now: new Date(base.getTime() + 11_000),
      fetchImpl: outageFetch
    });
    expect(afterGraceGate).toMatchObject({ ok: false, status: "network" });
    expect(afterGraceGate.reason).toContain("license API network failure");
    expect(afterGraceGate.reason).toContain("requires active entitlement");
  });
});
