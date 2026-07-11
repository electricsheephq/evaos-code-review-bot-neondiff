import type { ProductionLicenseAdmission } from "../../src/license-admission.js";

export const testLicenseAdmission: ProductionLicenseAdmission = Object.freeze({
  kind: "production-license-admission",
  operation: "review_discovery",
  checkedAt: "2026-07-11T00:00:00.000Z",
  fingerprint: "fixture-fingerprint",
  repoVisibilityScope: "all",
  privateRepoAllowed: true,
  updateEntitlement: true
});
