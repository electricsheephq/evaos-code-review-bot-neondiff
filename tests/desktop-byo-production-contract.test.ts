import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "apps/neondiff-desktop/script/build_and_run.sh";

function checkContract(overrides: Record<string, string> = {}) {
  return spawnSync(script, ["production-contract-check"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      PATH: process.env.PATH ?? "/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      ...overrides
    }
  });
}

describe("NeonDiff desktop B0 production bundle contract", () => {
  it("preserves the empty quarantined build and exact managed B1 contract", () => {
    const empty = checkContract();
    expect(empty.status).toBe(0);
    expect(empty.stdout.trim()).toBe("none");

    const managed = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-v1",
      NEONDIFF_DESKTOP_MANAGED_GITHUB_BROKER_ENABLED: "true",
      NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN: "https://neondiff-license.fly.dev"
    });
    expect(managed.status).toBe(0);
    expect(managed.stdout.trim()).toBe("managed");
  });

  it("accepts the exact release-only BYO contract without managed broker fields", () => {
    const result = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
      NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED: "true"
    });

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("byo");
    expect(result.stderr).toBe("");
  });

  it("rejects debug, partial, and mixed BYO or managed configuration", () => {
    const invalid = [
      {
        NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "debug",
        NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
        NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED: "true"
      },
      {
        NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
        NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1"
      },
      {
        NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
        NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
        NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED: "true",
        NEONDIFF_DESKTOP_MANAGED_GITHUB_BROKER_ENABLED: "true",
        NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN: "https://neondiff-license.fly.dev"
      }
    ];

    for (const environment of invalid) {
      const result = checkContract(environment);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });
});
