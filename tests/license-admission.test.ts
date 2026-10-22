import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  authorizeAdmissionForVisibility,
  isAuthenticProductionLicenseAdmission,
  requireActiveDaemonCycleAdmissions,
  requireActiveProductionLicense,
  type ProductionLicenseAdmission
} from "../src/license-admission.js";
import type { LicenseConfig } from "../src/license.js";
import { withRuntimeGitHubCredentials } from "../src/runtime-github-credentials.js";

const roots: string[] = [];
const key = () => ["nd", "live", "admission0123456789abcdef"].join("_");
const brokerDeviceId = "b".repeat(43);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixtureConfig(): LicenseConfig {
  const root = mkdtempSync(join(tmpdir(), "neondiff-license-admission-"));
  roots.push(root);
  const keyPath = join(root, "license.key");
  writeFileSync(keyPath, `${key()}\n`, { mode: 0o600 });
  return {
    enabled: false,
    apiBaseUrl: "https://fake.invalid",
    cachePath: join(root, "entitlement.json"),
    storageBackend: "file",
    keyPath,
    keychainService: "fake.service",
    keychainAccount: "fake",
    requestTimeoutMs: 250,
    offlineGraceMs: 900_000,
    publicReposFree: true,
    privateReposRequireEntitlement: false,
    updateEntitlementRequiresLicense: false
  };
}

describe("production useful-work admission", () => {
  it("uses an explicit CI machine identity instead of an ambient native identity", async () => {
    let machineId: unknown;
    const result = await withRuntimeGitHubCredentials({
      appId: "4184532", privateKey: "runtime-private-key-fixture", licenseMachineId: brokerDeviceId
    }, () => requireActiveProductionLicense({
      config: fixtureConfig(), operation: "review_cycle", repo: "owner/repo", visibility: "private",
      machineId: "c".repeat(43), now: new Date("2026-07-11T00:00:00.000Z"),
      fetchImpl: (async (_url, init) => {
        machineId = JSON.parse(String(init?.body)).machineId;
        return new Response(JSON.stringify({ status: "active", repoVisibilityScope: "all", privateRepoAllowed: true }));
      }) as typeof fetch
    }));
    expect(result.ok).toBe(true);
    expect(machineId).toBe("c".repeat(43));
    expect(JSON.stringify(result)).not.toContain(key());
  });

  it("uses the native broker device identity for runtime daemon admission", async () => {
    let requestBody: Record<string, unknown> | undefined;
    const result = await withRuntimeGitHubCredentials({
      appId: "4184532",
      privateKey: "runtime-private-key-fixture",
      licenseKey: key(),
      licenseMachineId: brokerDeviceId
    }, () => requireActiveDaemonCycleAdmissions({
      config: fixtureConfig(),
      fetchImpl: (async (_url, init) => {
        requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(JSON.stringify({
          status: "active",
          expiresAt: "2026-08-01T00:00:00.000Z",
          repoVisibilityScope: "private",
          privateRepoAllowed: true,
          updateEntitlement: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    }));

    expect(result.ok).toBe(true);
    expect(requestBody?.machineId).toBe(brokerDeviceId);
  });

  it("rejects an explicit empty machine identity before network admission", async () => {
    let fetchCalls = 0;

    const result = await requireActiveProductionLicense({
      config: fixtureConfig(),
      operation: "daemon_cycle",
      machineId: "",
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(null, { status: 500 });
      }) as typeof fetch
    });

    expect(result).toMatchObject({
      ok: false,
      decision: {
        status: "invalid",
        detail: "license machine ID must be one RFC 7638 SHA-256 broker device id"
      }
    });
    expect(fetchCalls).toBe(0);
  });

  it("mints the daemon operation bundle from one live API validation", async () => {
    let fetchCalls = 0;
    const result = await requireActiveDaemonCycleAdmissions({
      config: fixtureConfig(),
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response(JSON.stringify({
          status: "active",
          expiresAt: "2026-08-01T00:00:00.000Z",
          repoVisibilityScope: "private",
          privateRepoAllowed: true,
          updateEntitlement: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });

    expect(fetchCalls).toBe(1);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected active daemon admission bundle");
    expect(isAuthenticProductionLicenseAdmission(result.admissions.daemonCycle, "daemon_cycle")).toBe(true);
    expect(isAuthenticProductionLicenseAdmission(result.admissions.reviewDiscovery, "review_discovery")).toBe(true);
    expect(isAuthenticProductionLicenseAdmission(result.admissions.issueEnrichment, "issue_enrichment")).toBe(true);
    expect(JSON.stringify(result)).not.toContain(key());
  });

  it("rejects a structurally forged admission token", () => {
    const forged = Object.freeze({
      kind: "production-license-admission",
      operation: "review_discovery",
      checkedAt: "2026-07-11T00:00:00.000Z",
      fingerprint: "forged",
      repoVisibilityScope: "all",
      privateRepoAllowed: true,
      updateEntitlement: true
    }) as ProductionLicenseAdmission;

    expect(isAuthenticProductionLicenseAdmission(forged)).toBe(false);
    expect(authorizeAdmissionForVisibility(forged, "public")).toMatchObject({
      ok: false,
      decision: { status: "invalid" }
    });
  });

  it("ignores weakening config and creates an opaque admission only from live canonical validation", async () => {
    const urls: string[] = [];
    const result = await requireActiveProductionLicense({
      operation: "review_cycle",
      visibility: "private",
      config: fixtureConfig(),
      fetchImpl: (async (url) => {
        urls.push(String(url));
        return new Response(JSON.stringify({
          status: "active",
          expiresAt: "2026-08-01T00:00:00.000Z",
          repoVisibilityScope: "all",
          privateRepoAllowed: true,
          updateEntitlement: true
        }), { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });

    expect(result.ok).toBe(true);
    expect(urls).toEqual(["https://neondiff-license.fly.dev/v1/license/validate"]);
    if (result.ok) {
      expect(result.admission).toMatchObject({
        kind: "production-license-admission",
        operation: "review_cycle",
        repoVisibilityScope: "all",
        updateEntitlement: true
      });
    }
    expect(JSON.stringify(result)).not.toContain(key());
  });

  it("blocks an API outage even when a fresh active cache exists", async () => {
    const config = fixtureConfig();
    writeFileSync(config.cachePath, `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-11T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "all",
      updateEntitlement: true
    })}\n`, { mode: 0o600 });
    const result = await requireActiveProductionLicense({
      operation: "provider_verify",
      config,
      fetchImpl: (async () => { throw new Error("offline"); }) as typeof fetch,
      now: new Date("2026-07-11T00:00:01.000Z")
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "network" } });
  });

  it("rejects an unsafe secret file before any API request", async () => {
    const config = fixtureConfig();
    chmodSync(config.keyPath!, 0o644);
    let fetchCalls = 0;
    const result = await requireActiveProductionLicense({
      operation: "provider_verify",
      config,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as typeof fetch
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "invalid" } });
    expect(fetchCalls).toBe(0);
  });

  it("admits a missing production key file as public-only before any API request", async () => {
    const config = fixtureConfig();
    rmSync(config.keyPath!);
    let fetchCalls = 0;
    const result = await requireActiveProductionLicense({
      operation: "provider_verify",
      config,
      fetchImpl: (async () => {
        fetchCalls += 1;
        return new Response("{}");
      }) as typeof fetch
    });

    expect(result).toMatchObject({ ok: true, admission: { fingerprint: "public-free", privateRepoAllowed: false } });
    expect(fetchCalls).toBe(0);
  });

  it("authorizes only repository visibilities covered by the opaque admission", async () => {
    const result = await requireActiveProductionLicense({
      operation: "review_cycle",
      visibility: "public",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "public",
        updateEntitlement: false
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected active admission");
    expect(authorizeAdmissionForVisibility(result.admission, "public")).toEqual({ ok: true });
    expect(authorizeAdmissionForVisibility(result.admission, "private")).toMatchObject({
      ok: false,
      decision: { status: "scope_mismatch" }
    });
    expect(authorizeAdmissionForVisibility(result.admission, "unknown")).toMatchObject({
      ok: false,
      decision: { status: "network" }
    });
  });

  it("denies private review inside admission when a public entitlement is returned", async () => {
    const result = await requireActiveProductionLicense({
      operation: "review_cycle",
      visibility: "private",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "public",
        updateEntitlement: true
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "scope_mismatch" } });
  });

  it("denies update checks when the active entitlement lacks update access", async () => {
    const result = await requireActiveProductionLicense({
      operation: "update_check",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "all",
        updateEntitlement: false
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "scope_mismatch" } });
  });

  it("rejects public-only scope for issue enrichment discovery", async () => {
    const result = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "public",
        updateEntitlement: true
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "scope_mismatch" } });
  });

  it("accepts the ordinary paid private scope for issue enrichment discovery", async () => {
    const result = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "private",
        privateRepoAllowed: true,
        updateEntitlement: true
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toMatchObject({ ok: true, admission: { repoVisibilityScope: "private" } });
  });

  it("admits discovery with the active public-only entitlement", async () => {
    for (const operation of ["review_discovery", "daemon_cycle"] as const) {
      const result = await requireActiveProductionLicense({
        operation,
        config: fixtureConfig(),
        fetchImpl: (async () => new Response(JSON.stringify({
          status: "active",
          expiresAt: "2026-08-01T00:00:00.000Z",
          repoVisibilityScope: "public",
          privateRepoAllowed: false,
          updateEntitlement: true
        }), { status: 200 })) as typeof fetch,
        now: new Date("2026-07-11T00:00:00.000Z")
      });
      expect(result).toMatchObject({ ok: true, admission: { repoVisibilityScope: "public", privateRepoAllowed: false } });
    }
  });

  it("rejects issue enrichment when private repository access is explicitly denied", async () => {
    const result = await requireActiveProductionLicense({
      operation: "issue_enrichment",
      config: fixtureConfig(),
      fetchImpl: (async () => new Response(JSON.stringify({
        status: "active",
        expiresAt: "2026-08-01T00:00:00.000Z",
        repoVisibilityScope: "all",
        privateRepoAllowed: false,
        updateEntitlement: true
      }), { status: 200 })) as typeof fetch,
      now: new Date("2026-07-11T00:00:00.000Z")
    });
    expect(result).toMatchObject({ ok: false, decision: { status: "scope_mismatch" } });
  });
});

const workerOperations = ["provider_verify", "provider_smoke", "daemon_cycle", "review_discovery", "issue_enrichment", "update_check"] as const;
describe("self-hosted public-free operation table", () => {
  it.each(workerOperations)("%s: missing key grants only public work, with one existence read", async (operation) => {
    let reads = 0;
    let calls = 0;
    const config = fixtureConfig();
    writeFileSync(config.cachePath, JSON.stringify({ status: "active", repoVisibilityScope: "all", privateRepoAllowed: true }));
    const result = await requireActiveProductionLicense({ config, operation,
      secretReader: { read: () => { reads += 1; return undefined; } },
      fetchImpl: (async () => { calls += 1; throw new Error("must not call API"); }) as typeof fetch });
    expect(reads).toBe(1);
    expect(calls).toBe(0);
    if (operation === "issue_enrichment" || operation === "update_check") {
      expect(result).toMatchObject({ ok: false, decision: { status: "missing" } });
    } else {
      expect(result).toMatchObject({ ok: true, admission: { fingerprint: "public-free", repoVisibilityScope: "public", privateRepoAllowed: false, updateEntitlement: false } });
      if (!result.ok) throw new Error("expected public-only admission");
      for (const visibility of ["public", "private", "unknown"] as const) {
        expect(authorizeAdmissionForVisibility(result.admission, visibility).ok).toBe(visibility === "public");
      }
    }
  });
  it.each(workerOperations)("%s: stored keys never silently downgrade", async (operation) => {
    for (const state of ["active-all", "active-public-only", "revoked", "expired", "offline", "timeout", "rate-limited", "malformed", "forged-cache", "mismatched-cache"] as const) {
      const config = fixtureConfig();
      if (state.endsWith("cache")) writeFileSync(config.cachePath, JSON.stringify({ status: "active", repoVisibilityScope: "all", privateRepoAllowed: true, licenseFingerprint: state }));
      let calls = 0;
      const result = await requireActiveProductionLicense({ config, operation, fetchImpl: (async () => {
        calls += 1;
        if (["offline", "forged-cache", "mismatched-cache"].includes(state)) throw new Error("offline");
        if (state === "timeout") throw new DOMException("timeout", "TimeoutError");
        if (state === "active-all" || state === "active-public-only") return new Response(JSON.stringify({ status: "active", repoVisibilityScope: state === "active-all" ? "all" : "public", privateRepoAllowed: state === "active-all", updateEntitlement: true }));
        return new Response(JSON.stringify({ status: state === "malformed" ? "active" : state }), { status: state === "revoked" ? 403 : state === "expired" ? 402 : state === "rate-limited" ? 429 : 200 });
      }) as typeof fetch });
      expect(calls, state).toBe(1);
      expect(result.ok, state).toBe(state === "active-all" || (state === "active-public-only" && operation !== "issue_enrichment"));
      if (result.ok) {
        expect(result.admission.fingerprint).not.toBe("public-free");
        for (const visibility of ["public", "private", "unknown"] as const) expect(authorizeAdmissionForVisibility(result.admission, visibility).ok).toBe(visibility === "public" || (visibility === "private" && state === "active-all"));
      }
    }
  });
  it("omits enrichment from a keyless daemon bundle", async () => {
    const result = await requireActiveDaemonCycleAdmissions({ config: fixtureConfig(), secretReader: { read: () => undefined } });
    expect(result).toMatchObject({ ok: true, admissions: { daemonCycle: { privateRepoAllowed: false }, reviewDiscovery: { repoVisibilityScope: "public" } } });
    if (result.ok) expect(result.admissions.issueEnrichment).toBeUndefined();
  });
});
