import { describe, expect, it } from "vitest";
import { runMandatoryActivationMatrix } from "../src/mandatory-activation-matrix.js";

describe("mandatory activation no-bypass matrix", () => {
  it("executes every required allow/deny scenario through the production admission gate", async () => {
    const result = await runMandatoryActivationMatrix();
    expect(result.ok).toBe(true);
    expect(result.bypassAllowedCases).toBe(0);
    expect(result.records).toHaveLength(19);
    expect(new Set(result.records.map((record) => record.id)).size).toBe(19);
    expect(result.records.filter((record) => record.expected === "allowed")).toHaveLength(2);
    expect(result.records.filter((record) => record.expected === "denied")).toHaveLength(17);
    for (const record of result.records) {
      expect(record.actual, record.id).toBe(record.expected);
      expect(record.licenseApiCalls, record.id).toBe(record.expectedLicenseApiCalls);
    }
    expect(Object.fromEntries(result.records.map((record) => [record.id, record.licenseApiCalls]))).toMatchObject({
      missing_key: 0,
      forged_cache: 0,
      disabled_policy_attempt: 0,
      dashboard_provider_pre_activation: 0,
      public_active: 1,
      private_active: 1
    });
    expect(result.records.find((record) => record.id === "disabled_policy_attempt")).toEqual({
      id: "disabled_policy_attempt",
      visibility: "public",
      expected: "denied",
      actual: "denied",
      expectedLicenseApiCalls: 0,
      licenseApiCalls: 0
    });
  });
});
