import { getLicenseStatus, type LicenseConfig, type RepoVisibilityScope } from "./license.js";
import { resolveProductionLicensePolicy } from "./license-production-policy.js";
import { productionLicenseSecretReader, type LicenseSecretReader } from "./license-secret-store.js";

export type ProductionLicenseOperation =
  | "review_discovery"
  | "review_cycle"
  | "provider_verify"
  | "provider_smoke"
  | "daemon_cycle"
  | "issue_enrichment"
  | "update_check";

export interface ProductionLicenseAdmission {
  readonly kind: "production-license-admission";
  readonly operation: ProductionLicenseOperation;
  readonly checkedAt: string;
  readonly fingerprint: string;
  readonly repoVisibilityScope: RepoVisibilityScope;
  readonly privateRepoAllowed: boolean;
  readonly updateEntitlement: boolean;
}

export interface RedactedLicenseDecision {
  status: string;
  checkedAt: string;
  classification?: string;
  detail: string;
}

type ProductionLicenseAdmissionInput = {
  config: LicenseConfig;
  repo?: string;
  now?: Date;
  fetchImpl?: typeof fetch;
  secretReader?: LicenseSecretReader;
} & (
  | { operation: "review_cycle"; visibility: "public" | "private" | "unknown" }
  | { operation: Exclude<ProductionLicenseOperation, "review_cycle">; visibility?: never }
);

export function authorizeAdmissionForVisibility(
  admission: ProductionLicenseAdmission,
  visibility: "public" | "private" | "unknown"
): { ok: true } | { ok: false; decision: RedactedLicenseDecision } {
  const covered = visibility === "public"
    ? admission.repoVisibilityScope === "public"
      || admission.repoVisibilityScope === "private"
      || admission.repoVisibilityScope === "all"
    : visibility === "private"
      ? admission.privateRepoAllowed
        && (admission.repoVisibilityScope === "private" || admission.repoVisibilityScope === "all")
      : false;
  if (covered) return { ok: true };
  return {
    ok: false,
    decision: {
      status: visibility === "unknown" ? "network" : "scope_mismatch",
      checkedAt: admission.checkedAt,
      classification: visibility === "unknown" ? "network" : "scope_mismatch",
      detail: visibility === "unknown"
        ? "repository visibility is unknown; production license admission fails closed"
        : `active entitlement does not cover ${visibility} repository work`
    }
  };
}

export async function requireActiveProductionLicense(
  input: ProductionLicenseAdmissionInput
): Promise<{ ok: true; admission: ProductionLicenseAdmission } | { ok: false; decision: RedactedLicenseDecision }> {
  const config = resolveProductionLicensePolicy(input.config);
  const status = await getLicenseStatus({
    config,
    refresh: true,
    ...(input.repo ? { repo: input.repo } : {}),
    ...(input.now ? { now: input.now } : {}),
    ...(input.fetchImpl ? { fetchImpl: input.fetchImpl } : {}),
    licenseSecretReader: input.secretReader ?? productionLicenseSecretReader
  });
  const entitlement = status.entitlement;
  if (!status.ok
    || status.status !== "active"
    || status.source !== "api"
    || !entitlement
    || entitlement.status !== "active"
    || !entitlement.licenseFingerprint) {
    return {
      ok: false,
      decision: {
        status: status.status,
        checkedAt: status.checkedAt,
        ...(status.classification ? { classification: status.classification } : {}),
        detail: status.detail
      }
    };
  }
  const admission: ProductionLicenseAdmission = Object.freeze({
    kind: "production-license-admission",
    operation: input.operation,
    checkedAt: status.checkedAt,
    fingerprint: entitlement.licenseFingerprint,
    repoVisibilityScope: entitlement.repoVisibilityScope,
    privateRepoAllowed: entitlement.privateRepoAllowed !== false
      && (entitlement.repoVisibilityScope === "private" || entitlement.repoVisibilityScope === "all"),
    updateEntitlement: entitlement.updateEntitlement
  });
  if (input.operation === "update_check" && !admission.updateEntitlement) {
    return {
      ok: false,
      decision: {
        status: "scope_mismatch",
        checkedAt: admission.checkedAt,
        classification: "scope_mismatch",
        detail: "active entitlement does not include update access"
      }
    };
  }
  if (input.operation === "issue_enrichment" && admission.repoVisibilityScope !== "all") {
    return {
      ok: false,
      decision: {
        status: "scope_mismatch",
        checkedAt: admission.checkedAt,
        classification: "scope_mismatch",
        detail: "issue enrichment requires an active entitlement covering all repository visibility scopes"
      }
    };
  }
  if (input.operation === "review_cycle") {
    const visibilityDecision = authorizeAdmissionForVisibility(admission, input.visibility);
    if (!visibilityDecision.ok) return visibilityDecision;
  }
  return {
    ok: true,
    admission
  };
}
