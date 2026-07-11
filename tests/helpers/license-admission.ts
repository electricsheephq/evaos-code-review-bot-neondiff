import {
  requireActiveProductionLicense,
  type ProductionLicenseAdmission,
  type ProductionLicenseOperation
} from "../../src/license-admission.js";
import type { LicenseConfig, RepoVisibilityScope } from "../../src/license.js";

const fixtureConfig: LicenseConfig = {
  enabled: true,
  apiBaseUrl: "https://neondiff-license.fly.dev",
  cachePath: "/tmp/neondiff-test-entitlement.json",
  storageBackend: "file",
  keyPath: "/tmp/neondiff-test-license.key",
  keychainService: "fixture.service",
  keychainAccount: "fixture",
  requestTimeoutMs: 250,
  offlineGraceMs: 0,
  publicReposFree: false,
  privateReposRequireEntitlement: true,
  updateEntitlementRequiresLicense: true
};

export async function createTestLicenseAdmission(input: {
  operation?: ProductionLicenseOperation;
  scope?: RepoVisibilityScope;
  privateRepoAllowed?: boolean;
} = {}): Promise<ProductionLicenseAdmission> {
  const operation = input.operation ?? "review_discovery";
  const scope = input.scope ?? "all";
  const result = await requireActiveProductionLicense({
    ...(operation === "review_cycle"
      ? { operation, visibility: scope === "public" ? "public" as const : "private" as const }
      : { operation }),
    config: fixtureConfig,
    secretReader: { read: () => ["nd", "live", "fixtureadmission0123456789"].join("_") },
    fetchImpl: (async () => new Response(JSON.stringify({
      status: "active",
      expiresAt: "2999-01-01T00:00:00.000Z",
      repoVisibilityScope: scope,
      privateRepoAllowed: input.privateRepoAllowed ?? scope !== "public",
      updateEntitlement: true
    }), { status: 200, headers: { "content-type": "application/json" } })) as typeof fetch
  });
  if (!result.ok) throw new Error(`failed to mint test admission: ${result.decision.detail}`);
  return result.admission;
}

export const testLicenseAdmission = await createTestLicenseAdmission();
