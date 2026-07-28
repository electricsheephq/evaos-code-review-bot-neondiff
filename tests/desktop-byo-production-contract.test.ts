import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const script = "apps/neondiff-desktop/script/build_and_run.sh";
const signedUpdateBoundary = {
  NEONDIFF_SPARKLE_FEED_URL: "https://www.neondiff.com/appcast-beta.xml",
  NEONDIFF_SPARKLE_PUBLIC_ED_KEY: "CI_ONLY_NOT_A_RELEASE_KEY"
};

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
      NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN: "https://neondiff-license.fly.dev",
      ...signedUpdateBoundary
    });
    expect(managed.status).toBe(0);
    expect(managed.stdout.trim()).toBe("managed");
  });

  it("accepts the exact release-only BYO contract without managed broker fields", () => {
    const result = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
      NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED: "true",
      ...signedUpdateBoundary
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
        NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
        ...signedUpdateBoundary
      },
      {
        NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
        NEONDIFF_DESKTOP_PAID_BETA_CONTRACT: "paid-mac-beta-byo-v1",
        NEONDIFF_DESKTOP_BYO_GITHUB_ENABLED: "true",
        NEONDIFF_DESKTOP_MANAGED_GITHUB_BROKER_ENABLED: "true",
        NEONDIFF_DESKTOP_GITHUB_BROKER_ORIGIN: "https://neondiff-license.fly.dev",
        ...signedUpdateBoundary
      }
    ];

    for (const environment of invalid) {
      const result = checkContract(environment);
      expect(result.status).not.toBe(0);
      expect(result.stdout).toBe("");
    }
  });

  it("requires a nonblank signed update boundary for every Release configuration", () => {
    const missing = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release"
    });
    expect(missing.status).toBe(2);
    expect(missing.stderr).toContain("A signed Sparkle feed is required for this release build");

    const whitespaceKey = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_SPARKLE_FEED_URL: "https://www.neondiff.com/appcast-beta.xml",
      NEONDIFF_SPARKLE_PUBLIC_ED_KEY: "   "
    });
    expect(whitespaceKey.status).toBe(2);
    expect(whitespaceKey.stderr).toContain(
      "Sparkle feed and public key must not contain surrounding whitespace"
    );

    const hostlessFeed = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_SPARKLE_FEED_URL: "https:///appcast.xml",
      NEONDIFF_SPARKLE_PUBLIC_ED_KEY: "CI_ONLY_NOT_A_RELEASE_KEY"
    });
    expect(hostlessFeed.status).toBe(2);
    expect(hostlessFeed.stderr).toContain(
      "NEONDIFF_SPARKLE_FEED_URL must be an absolute https URL with a host"
    );

    const disabled = checkContract({
      NEONDIFF_DESKTOP_BUILD_CONFIGURATION: "release",
      NEONDIFF_SPARKLE_REQUIRED: "0",
      ...signedUpdateBoundary
    });
    expect(disabled.status).toBe(2);
    expect(disabled.stderr).toContain("Release builds require NEONDIFF_SPARKLE_REQUIRED=1");
  });
});
