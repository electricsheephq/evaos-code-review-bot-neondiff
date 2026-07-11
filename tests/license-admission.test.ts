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

const roots: string[] = [];
const key = () => ["nd", "live", "admission0123456789abcdef"].join("_");

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

  it("denies a missing production key file before any API request", async () => {
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

    expect(result).toMatchObject({ ok: false, decision: { status: "missing" } });
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

  it("rejects discovery when the active entitlement cannot cover private repositories", async () => {
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
      expect(result).toMatchObject({ ok: false, decision: { status: "scope_mismatch" } });
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
