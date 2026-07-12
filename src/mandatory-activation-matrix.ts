import { createHash } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { requireActiveProductionLicense } from "./license-admission.js";
import { OFFICIAL_LICENSE_API_BASE_URL } from "./license-production-policy.js";
import type { LicenseConfig } from "./license.js";

export interface MandatoryActivationScenarioRecord {
  id: string;
  visibility: "public" | "private" | "unknown" | "not_applicable";
  expected: "allowed" | "denied";
  actual: "allowed" | "denied";
  licenseApiCalls: number;
}

export interface MandatoryActivationMatrixResult {
  ok: boolean;
  bypassAllowedCases: number;
  records: MandatoryActivationScenarioRecord[];
}

type Scenario = {
  id: string;
  visibility: MandatoryActivationScenarioRecord["visibility"];
  expected: MandatoryActivationScenarioRecord["expected"];
  key: "present" | "missing";
  config?: Partial<LicenseConfig>;
  cache?: "forged" | "mismatched";
  response: "active_all" | "active_public" | "invalid" | "offline" | "timeout" | "rate_limited" | "server" | "malformed" | "revoked" | "expired";
  operation?: "review_cycle" | "provider_verify";
  assertCanonicalUrl?: boolean;
};

const SCENARIOS: Scenario[] = [
  { id: "public_active", visibility: "public", expected: "allowed", key: "present", response: "active_all" },
  { id: "private_active", visibility: "private", expected: "allowed", key: "present", response: "active_all" },
  { id: "unknown_repo", visibility: "unknown", expected: "denied", key: "present", response: "active_all" },
  { id: "public_denied", visibility: "public", expected: "denied", key: "present", response: "invalid" },
  { id: "private_denied", visibility: "private", expected: "denied", key: "present", response: "active_public" },
  { id: "missing_key", visibility: "not_applicable", expected: "denied", key: "missing", response: "active_all", operation: "provider_verify" },
  { id: "missing_api_url", visibility: "not_applicable", expected: "denied", key: "present", config: { apiBaseUrl: undefined }, response: "server", operation: "provider_verify", assertCanonicalUrl: true },
  { id: "offline", visibility: "not_applicable", expected: "denied", key: "present", response: "offline", operation: "provider_verify" },
  { id: "timeout", visibility: "not_applicable", expected: "denied", key: "present", response: "timeout", operation: "provider_verify" },
  { id: "forged_cache", visibility: "not_applicable", expected: "denied", key: "missing", cache: "forged", response: "offline", operation: "provider_verify" },
  { id: "mismatched_cache", visibility: "not_applicable", expected: "denied", key: "present", cache: "mismatched", response: "offline", operation: "provider_verify" },
  { id: "disabled_policy_attempt", visibility: "public", expected: "denied", key: "missing", config: { enabled: false, publicReposFree: true }, response: "active_all" },
  { id: "fake_api", visibility: "not_applicable", expected: "denied", key: "present", config: { apiBaseUrl: "https://fake-license.invalid" }, response: "server", operation: "provider_verify", assertCanonicalUrl: true },
  { id: "rate_limited", visibility: "not_applicable", expected: "denied", key: "present", response: "rate_limited", operation: "provider_verify" },
  { id: "server_error", visibility: "not_applicable", expected: "denied", key: "present", response: "server", operation: "provider_verify" },
  { id: "malformed_response", visibility: "not_applicable", expected: "denied", key: "present", response: "malformed", operation: "provider_verify" },
  { id: "revoked", visibility: "not_applicable", expected: "denied", key: "present", response: "revoked", operation: "provider_verify" },
  { id: "expired", visibility: "not_applicable", expected: "denied", key: "present", response: "expired", operation: "provider_verify" },
  { id: "dashboard_provider_pre_activation", visibility: "not_applicable", expected: "denied", key: "missing", response: "active_all", operation: "provider_verify" }
];

export async function runMandatoryActivationMatrix(): Promise<MandatoryActivationMatrixResult> {
  const records: MandatoryActivationScenarioRecord[] = [];
  for (const scenario of SCENARIOS) records.push(await runScenario(scenario));
  const bypassAllowedCases = records.filter((record) => record.actual !== record.expected).length;
  return { ok: bypassAllowedCases === 0, bypassAllowedCases, records };
}

async function runScenario(scenario: Scenario): Promise<MandatoryActivationScenarioRecord> {
  const root = mkdtempSync(join(tmpdir(), `neondiff-activation-matrix-${scenario.id}-`));
  const rawKey = ["nd", "live", "matrixfixture123456789"].join("_");
  const config: LicenseConfig = {
    enabled: true,
    apiBaseUrl: OFFICIAL_LICENSE_API_BASE_URL,
    cachePath: join(root, "entitlement-cache.json"),
    storageBackend: "file",
    keyPath: join(root, "license.key"),
    keychainService: "fixture.invalid",
    keychainAccount: "fixture",
    requestTimeoutMs: 250,
    offlineGraceMs: 0,
    publicReposFree: false,
    privateReposRequireEntitlement: true,
    updateEntitlementRequiresLicense: true,
    ...scenario.config
  };
  if (scenario.cache) {
    writeFileSync(config.cachePath, `${JSON.stringify({
      status: "active",
      checkedAt: "2026-07-12T00:00:00.000Z",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: "all",
      privateRepoAllowed: true,
      updateEntitlement: true,
      licenseFingerprint: scenario.cache === "mismatched"
        ? createHash("sha256").update("different-key").digest("hex").slice(0, 16)
        : createHash("sha256").update(rawKey).digest("hex").slice(0, 16)
    })}\n`, { mode: 0o600 });
  }
  const observedUrls: string[] = [];
  try {
    const common = {
      config,
      now: new Date("2026-07-12T00:05:00.000Z"),
      secretReader: { read: () => scenario.key === "present" ? rawKey : undefined },
      fetchImpl: (async (url: string | URL | Request) => {
        observedUrls.push(String(url));
        return scenarioResponse(scenario.response);
      }) as typeof fetch
    };
    const result = scenario.operation === "provider_verify" || scenario.visibility === "not_applicable"
      ? await requireActiveProductionLicense({ ...common, operation: "provider_verify" })
      : await requireActiveProductionLicense({
          ...common,
          operation: "review_cycle",
          visibility: scenario.visibility
        });
    if (scenario.assertCanonicalUrl && observedUrls.some((url) => !url.startsWith(`${OFFICIAL_LICENSE_API_BASE_URL}/`))) {
      throw new Error(`${scenario.id} reached a noncanonical license API`);
    }
    const actual = result.ok ? "allowed" : "denied";
    return {
      id: scenario.id,
      visibility: scenario.visibility,
      expected: scenario.expected,
      actual,
      licenseApiCalls: observedUrls.length
    };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scenarioResponse(kind: Scenario["response"]): Response {
  if (kind === "offline") throw new Error("offline");
  if (kind === "timeout") throw new DOMException("request timed out", "TimeoutError");
  if (kind === "active_all" || kind === "active_public") {
    return jsonResponse(200, {
      status: "active",
      expiresAt: "2026-08-01T00:00:00.000Z",
      repoVisibilityScope: kind === "active_all" ? "all" : "public",
      privateRepoAllowed: kind === "active_all",
      updateEntitlement: true
    });
  }
  if (kind === "invalid") return jsonResponse(404, { status: "invalid", detail: "not recognized" });
  if (kind === "rate_limited") return jsonResponse(429, { status: "rate_limited", detail: "try later" });
  if (kind === "server") return jsonResponse(503, { status: "server", detail: "unavailable" });
  if (kind === "malformed") return jsonResponse(200, { status: "active" });
  if (kind === "revoked") return jsonResponse(403, { status: "revoked", detail: "revoked" });
  return jsonResponse(402, { status: "expired", detail: "expired" });
}

function jsonResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}
