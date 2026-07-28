import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  planWorkerRollback,
  planWorkerUpdate,
  recoverPreviouslyLoadedWorker,
  validateWorkerCandidate
} from "../scripts/lib/b0-worker-installer.mjs";

const candidateHead = "7".repeat(40);
const packageVersion = "1.1.0-beta.27";
const tarball = Buffer.from("exact candidate bytes");
const tarballSHA256 = createHash("sha256").update(tarball).digest("hex");

function candidateManifest() {
  return {
    schemaVersion: 1,
    candidateClass: "b0-access-controlled-cli",
    source: {
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      candidateHead,
      protectedMainVerified: true
    },
    package: {
      name: "neondiff",
      packageVersion,
      filename: `neondiff-${packageVersion}.tgz`,
      sha256: tarballSHA256,
      integrity: "sha512-public-safe-placeholder"
    },
    installedCompatibility: {
      reportedVersion: packageVersion,
      reviewFlags: ["--expected-config-revision", "--zcode"],
      isolatedInstallPassed: true
    },
    distribution: {
      privateBucketTarget: "neondiff-beta-canary",
      publicNpmPublished: false,
      tagCreated: false,
      githubReleaseCreated: false,
      publicDownloadEnabled: false
    }
  };
}

function launchAgent() {
  return {
    Label: "com.electricsheephq.neondiff",
    ProgramArguments: [
      "/opt/homebrew/bin/node",
      "/Users/test/neondiff/node_modules/tsx/dist/cli.mjs",
      "src/cli.ts",
      "daemon",
      "--config",
      "/Users/test/.config/neondiff/config.local.json",
      "--dry-run",
      "true"
    ],
    WorkingDirectory: "/Users/test/neondiff",
    EnvironmentVariables: {
      NEONDIFF_GITHUB_APP_ID: "123456",
      NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH: "/Users/test/.config/neondiff/app.pem"
    }
  };
}

describe("B0 worker installer", () => {
  it("exposes an explicit dry-run, confirmed update, and rollback command", () => {
    const scriptPath = "scripts/install-b0-worker-candidate.mjs";
    expect(existsSync(scriptPath)).toBe(true);
    const help = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("update");
    expect(help.stdout).toContain("rollback");
    expect(help.stdout).toContain("--manifest-sha256");
    expect(help.stdout).toContain("--dry-run false --confirm true");
  });

  it("provides a private customer bundle builder without public publication commands", () => {
    const scriptPath = "scripts/build-b0-worker-bundle.mjs";
    expect(existsSync(scriptPath)).toBe(true);
    const script = readFileSync(scriptPath, "utf8");
    expect(script).toContain("install-b0-worker-candidate.mjs");
    expect(script).toContain("b0-worker-installer.mjs");
    expect(script).toContain("INSTALL.md");
    expect(script).toContain("bundleSHA256");
    expect(script).toContain("manifestSHA256");
    expect(script).not.toMatch(/npm publish|npm dist-tag|gh release|git tag/);
  });

  it("requires an out-of-band manifest digest and exact review capability", () => {
    const manifestBytes = Buffer.from(`${JSON.stringify(candidateManifest())}\n`);
    const manifestSHA256 = createHash("sha256").update(manifestBytes).digest("hex");
    const result = validateWorkerCandidate({
      manifestBytes,
      manifestSHA256,
      tarballBytes: tarball,
      tarballFilename: `neondiff-${packageVersion}.tgz`
    });

    expect(result).toMatchObject({
      candidateHead,
      packageVersion,
      tarballSHA256,
      reviewFlags: ["--expected-config-revision", "--zcode"]
    });

    expect(() => validateWorkerCandidate({
      manifestBytes,
      manifestSHA256: "0".repeat(64),
      tarballBytes: tarball,
      tarballFilename: `neondiff-${packageVersion}.tgz`
    })).toThrow("manifest SHA-256 mismatch");

    const missingCapability = candidateManifest();
    missingCapability.installedCompatibility.reviewFlags = ["--zcode"];
    const missingCapabilityBytes = Buffer.from(`${JSON.stringify(missingCapability)}\n`);
    expect(() => validateWorkerCandidate({
      manifestBytes: missingCapabilityBytes,
      manifestSHA256: createHash("sha256").update(missingCapabilityBytes).digest("hex"),
      tarballBytes: tarball,
      tarballFilename: `neondiff-${packageVersion}.tgz`
    })).toThrow("missing review capability --expected-config-revision");
  });

  it("plans one state-preserving LaunchAgent migration without copying secrets", () => {
    const plan = planWorkerUpdate({
      launchAgent: launchAgent(),
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });

    expect(plan.versionID).toBe(`1.1.0-beta.27-${candidateHead.slice(0, 12)}`);
    expect(plan.configPath).toBe("/Users/test/.config/neondiff/config.local.json");
    expect(plan.nextLaunchAgent.Label).toBe("com.electricsheephq.neondiff");
    expect(plan.nextLaunchAgent.EnvironmentVariables).toEqual(launchAgent().EnvironmentVariables);
    expect(plan.nextLaunchAgent.ProgramArguments).toEqual([
      "/opt/homebrew/bin/node",
      "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/current/node_modules/neondiff/dist/src/cli.js",
      "daemon",
      "--config",
      "/Users/test/.config/neondiff/config.local.json",
      "--dry-run",
      "true"
    ]);
    expect(JSON.stringify(plan.publicSummary)).not.toContain("app.pem");
    expect(JSON.stringify(plan.publicSummary)).not.toContain("config.local.json");
  });

  it("rejects ambiguous or non-NeonDiff LaunchAgents and plans reversible state", () => {
    const ambiguous = launchAgent();
    ambiguous.ProgramArguments.push("--config", "/tmp/other.json");
    expect(() => planWorkerUpdate({
      launchAgent: ambiguous,
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    })).toThrow("exactly one absolute --config path");

    const update = planWorkerUpdate({
      launchAgent: launchAgent(),
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });
    const rollback = planWorkerRollback({
      state: update.nextState,
      currentLaunchAgent: update.nextLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff"
    });
    expect(rollback.nextLaunchAgent.ProgramArguments).toEqual(launchAgent().ProgramArguments);
    expect(rollback.nextLaunchAgent.WorkingDirectory).toBe(launchAgent().WorkingDirectory);
    expect(rollback.publicSummary).toMatchObject({ action: "rollback", target: "original-worker" });
  });

  it("carries the previous package identity through update and rollback", () => {
    const first = planWorkerUpdate({
      launchAgent: launchAgent(),
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion: "1.1.0-beta.26",
      manifestSHA256: "a".repeat(64)
    });
    const secondHead = "8".repeat(40);
    const second = planWorkerUpdate({
      launchAgent: first.nextLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead: secondHead,
      packageVersion: "1.1.0-beta.27",
      manifestSHA256: "b".repeat(64),
      previousState: first.nextState
    });
    expect(second.nextState.previousVersionID).toBe(first.versionID);
    expect(second.nextState.previousPackageVersion).toBe("1.1.0-beta.26");

    const rollback = planWorkerRollback({
      state: second.nextState,
      currentLaunchAgent: second.nextLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff"
    });
    expect(rollback.nextState.currentVersionID).toBe(first.versionID);
    expect(rollback.nextState.packageVersion).toBe("1.1.0-beta.26");
    expect(rollback.nextState.previousVersionID).toBe(second.versionID);
    expect(rollback.nextState.previousPackageVersion).toBe("1.1.0-beta.27");
  });

  it("boots out a partially activated replacement before restarting the original worker", () => {
    const calls: string[] = [];
    recoverPreviouslyLoadedWorker({
      wasLoaded: true,
      stopReplacement() {
        calls.push("stop-replacement");
      },
      startOriginal() {
        calls.push("start-original");
      }
    });
    expect(calls).toEqual(["stop-replacement", "start-original"]);

    expect(() => recoverPreviouslyLoadedWorker({
      wasLoaded: true,
      stopReplacement() {
        calls.push("stop-again");
      },
      startOriginal() {
        throw new Error("original restart failed");
      }
    })).toThrow("original restart failed");
  });

  it("fails closed when rollback is requested after the original worker is already active", () => {
    const update = planWorkerUpdate({
      launchAgent: launchAgent(),
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });
    const firstRollback = planWorkerRollback({
      state: update.nextState,
      currentLaunchAgent: update.nextLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff"
    });
    expect(() => planWorkerRollback({
      state: firstRollback.nextState,
      currentLaunchAgent: firstRollback.nextLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff"
    })).toThrow("original worker is already active");
  });
});
