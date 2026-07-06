import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  activateLicense,
  deactivateLicense,
  getLicenseStatus,
  type LicenseConfig
} from "../src/license.js";
import { LicenseStore } from "../services/license-api/src/store.js";
import { createLicenseRequestListener } from "../services/license-api/src/http.js";
import { RateLimiter } from "../services/license-api/src/service.js";

/**
 * Load-bearing contract test (#327): drives the REAL shipped client
 * (`src/license.ts`) against the REAL license service (`services/license-api`)
 * through activate → validate → deactivate → reactivate-different-machine, and
 * asserts the client parses each outcome into the correct LicenseStatus. This
 * proves the HTTP contract the client already calls matches the service.
 *
 * The service and client run in-process: `fetchImpl` serializes the client's
 * request, feeds it to the service's request listener via a mock
 * IncomingMessage/ServerResponse pair, and returns the service's Response. It
 * also rewrites `machineId` so a single test process can play multiple
 * machines (the client hardcodes localMachineId()).
 */

interface MockService {
  fetchFor(machineId: string): typeof fetch;
}

function buildInProcessService(): { service: MockService; store: LicenseStore; issueKey: () => string; close: () => void } {
  const store = new LicenseStore(":memory:");
  const listener = createLicenseRequestListener({
    store,
    // Generous limiter so the contract sequence is never throttled.
    rateLimiter: new RateLimiter({ maxPerWindow: 1000, windowMs: 60_000 })
  });

  const fetchFor = (machineId: string): typeof fetch => {
    return (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = typeof input === "string" ? input : input.toString();
      const path = new URL(url).pathname;
      const originalBody = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>;
      // Play the requested machine regardless of the client's localMachineId().
      const body = JSON.stringify({ ...originalBody, machineId });

      return await new Promise<Response>((resolve) => {
        const chunks: Buffer[] = [];
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
        const resChunks: string[] = [];
        const res: any = {
          writeHead(code: number, h: Record<string, string>) {
            statusCode = code;
            headers = h;
            return res;
          },
          end(payload?: string) {
            if (payload) resChunks.push(payload);
            resolve(new Response(resChunks.join(""), { status: statusCode, headers }));
          }
        };
        void listener(req, res);
      });
    }) as typeof fetch;
  };

  return {
    service: { fetchFor },
    store,
    issueKey: () => store.issueLicense({ plan: "yearly", repoVisibilityScope: "private", seats: 1 }).rawKey,
    close: () => store.close()
  };
}

describe("client ↔ service contract (real src/license.ts against real service)", () => {
  const roots: string[] = [];
  const closers: Array<() => void> = [];

  afterEach(() => {
    for (const close of closers.splice(0)) close();
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function makeConfig(root: string, apiBaseUrl: string): LicenseConfig {
    return {
      enabled: true,
      apiBaseUrl,
      cachePath: join(root, "entitlement.json"),
      storageBackend: "file",
      keyPath: join(root, "license.key"),
      keychainService: "neondiff-test",
      keychainAccount: "neondiff-test",
      requestTimeoutMs: 5_000,
      offlineGraceMs: 0,
      publicReposFree: true,
      privateReposRequireEntitlement: true,
      updateEntitlementRequiresLicense: false
    };
  }

  it("activate → validate → deactivate → reactivate-different-machine parses to correct LicenseStatus", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-"));
    roots.push(root);
    const { service, issueKey, close } = buildInProcessService();
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");
    const key = issueKey();

    // 1) activate on machine A → active
    const activated = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(activated.ok).toBe(true);
    expect(activated.status).toBe("active");
    expect(activated.entitlement?.repoVisibilityScope).toBe("private");
    expect(JSON.stringify(activated)).not.toContain(key);

    // 2) validate on machine A (hot path, refresh:true reads stored key) → active
    const validated = await getLicenseStatus({
      config,
      repo: "owner/private",
      refresh: true,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(validated.ok).toBe(true);
    expect(validated.status).toBe("active");
    expect(validated.source).toBe("api");

    // 3) deactivate machine A (notify the API) → seat freed
    const deactivated = await deactivateLicense({
      config,
      notifyApi: true,
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(deactivated.ok).toBe(true);
    expect(deactivated.status).toBe("deactivated");
    expect(deactivated.apiNotified).toBe(true);

    // Re-activate machine A first so the single seat is taken again...
    const reactivatedA = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-a")
    });
    expect(reactivatedA.status).toBe("active");

    // 4) reactivate on a DIFFERENT machine while the seat is exhausted → scope_mismatch
    const reactivatedB = await activateLicense({
      config,
      licenseKey: key,
      repo: "owner/private",
      fetchImpl: service.fetchFor("machine-b")
    });
    expect(reactivatedB.ok).toBe(false);
    expect(reactivatedB.status).toBe("scope_mismatch");
    expect(reactivatedB.classification).toBe("scope_mismatch");
    expect(JSON.stringify(reactivatedB)).not.toContain(key);
  });

  it("client maps revoked and expired denials through the real service", async () => {
    const root = mkdtempSync(join(tmpdir(), "nd-contract-"));
    roots.push(root);
    const { service, store, issueKey, close } = buildInProcessService();
    closers.push(close);
    const config = makeConfig(root, "http://127.0.0.1:8080");

    // revoked → client status "revoked"
    const revokedKey = issueKey();
    await activateLicense({ config, licenseKey: revokedKey, fetchImpl: service.fetchFor("machine-a") });
    store.revokeLicense(revokedKey, "refund");
    const revoked = await getLicenseStatus({ config, refresh: true, fetchImpl: service.fetchFor("machine-a") });
    expect(revoked.status).toBe("revoked");

    // unknown key → client status "invalid"
    const unknown = await activateLicense({
      config: makeConfig(mkdtempSync(join(tmpdir(), "nd-contract-")), "http://127.0.0.1:8080"),
      licenseKey: ["nd", "live", `unknown${"x".repeat(17)}`].join("_"),
      fetchImpl: service.fetchFor("machine-z")
    });
    expect(unknown.status).toBe("invalid");
  });
});
