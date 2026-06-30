import { describe, expect, it } from "vitest";
import { isCanaryAllowed, localDateFolder } from "../src/worker.js";

describe("canary PR allowlist", () => {
  it("allows all PRs when no canary list is configured", () => {
    expect(isCanaryAllowed({}, "electricsheephq/WorldOS", 1161)).toBe(true);
    expect(isCanaryAllowed({ canaryPulls: [] }, "100yenadmin/evaOS-GUI", 497)).toBe(true);
  });

  it("allows only exact repo and pull-number matches when configured", () => {
    const config = {
      canaryPulls: ["electricsheephq/WorldOS#1161", "100yenadmin/evaOS-GUI#497"]
    };

    expect(isCanaryAllowed(config, "electricsheephq/WorldOS", 1161)).toBe(true);
    expect(isCanaryAllowed(config, "100yenadmin/evaOS-GUI", 497)).toBe(true);
    expect(isCanaryAllowed(config, "electricsheephq/WorldOS", 1185)).toBe(false);
    expect(isCanaryAllowed(config, "100yenadmin/evaOS-GUI", 410)).toBe(false);
  });
});

describe("local evidence date folders", () => {
  it("uses the process local date instead of UTC ISO date folders", () => {
    expect(localDateFolder(new Date(2026, 6, 1, 0, 5, 0))).toBe("2026-07-01");
  });
});
