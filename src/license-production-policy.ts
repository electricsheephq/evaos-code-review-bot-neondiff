import type { LicenseConfig, LicensePolicyDiagnostic } from "./license.js";

export const OFFICIAL_LICENSE_API_BASE_URL = "https://neondiff-license.fly.dev" as const;
export const OFFICIAL_LICENSE_KEYCHAIN_SERVICE = "com.electricsheephq.NeonDiffDesktop.secrets" as const;
export const OFFICIAL_LICENSE_KEYCHAIN_ACCOUNT = "license/default" as const;

const officialValues = {
  enabled: true,
  apiBaseUrl: OFFICIAL_LICENSE_API_BASE_URL,
  offlineGraceMs: 0,
  publicReposFree: false,
  privateReposRequireEntitlement: true,
  updateEntitlementRequiresLicense: true,
  keychainService: OFFICIAL_LICENSE_KEYCHAIN_SERVICE,
  keychainAccount: OFFICIAL_LICENSE_KEYCHAIN_ACCOUNT
} as const;

export function resolveProductionLicensePolicy(input: LicenseConfig): LicenseConfig {
  return {
    ...input,
    ...officialValues,
    productionPolicy: {
      mode: "mandatory_online",
      diagnostics: policyDiagnostics(input)
    }
  };
}

function policyDiagnostics(input: LicenseConfig): LicensePolicyDiagnostic[] {
  const diagnostics: LicensePolicyDiagnostic[] = [];
  addDiagnostic(diagnostics, "enabled", input.enabled, officialValues.enabled, "optional enforcement is unsupported");
  addDiagnostic(
    diagnostics,
    "apiBaseUrl",
    input.apiBaseUrl === undefined ? "missing" : input.apiBaseUrl === OFFICIAL_LICENSE_API_BASE_URL ? "canonical" : "noncanonical",
    "canonical",
    "the supported distribution uses the canonical license API"
  );
  addDiagnostic(
    diagnostics,
    "keychainService",
    input.keychainService === OFFICIAL_LICENSE_KEYCHAIN_SERVICE ? "canonical" : "noncanonical",
    "canonical",
    "the supported distribution locks the Keychain service identity"
  );
  addDiagnostic(
    diagnostics,
    "keychainAccount",
    input.keychainAccount === OFFICIAL_LICENSE_KEYCHAIN_ACCOUNT ? "canonical" : "noncanonical",
    "canonical",
    "the supported distribution locks the Keychain account identity"
  );
  addDiagnostic(diagnostics, "offlineGraceMs", input.offlineGraceMs, officialValues.offlineGraceMs, "offline cache authority is disabled in v1.0.4");
  addDiagnostic(diagnostics, "publicReposFree", input.publicReposFree, officialValues.publicReposFree, "all repository work requires activation");
  addDiagnostic(
    diagnostics,
    "privateReposRequireEntitlement",
    input.privateReposRequireEntitlement,
    officialValues.privateReposRequireEntitlement,
    "private and unknown repository work must fail closed"
  );
  addDiagnostic(
    diagnostics,
    "updateEntitlementRequiresLicense",
    input.updateEntitlementRequiresLicense,
    officialValues.updateEntitlementRequiresLicense,
    "updates remain entitlement-gated"
  );
  return diagnostics;
}

function addDiagnostic(
  diagnostics: LicensePolicyDiagnostic[],
  field: LicensePolicyDiagnostic["field"],
  configured: string | number | boolean,
  effective: string | number | boolean,
  reason: string
): void {
  if (configured === effective) return;
  diagnostics.push({
    field,
    configured: describeValue(configured),
    effective: describeValue(effective),
    reason
  });
}

function describeValue(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "enabled" : "disabled";
  if (typeof value === "number") return value === 0 ? "zero" : "nonzero";
  return value;
}
