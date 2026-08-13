import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  planWorkerFirstInstall,
  planWorkerRollback,
  planWorkerUpdate,
  recoverFailedFirstInstall,
  recoverPreviouslyLoadedWorker,
  requireFirstInstallLaunchdUnloaded,
  retryTransientLaunchdBootstrap,
  selectWorkerVersionAction,
  selectStableNodeLaunchPath,
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
      isolatedInstallPassed: true,
      offlineInstallPassed: true,
      bundledProductionDependencies: ["validate-npm-package-license@3.0.4"]
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
  it("classifies strict first-install rejection and legacy update reuse", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-worker-reuse-"));
    const versionsRoot = join(root, "versions");
    const outsideRoot = join(root, "outside");
    const versionID = `${packageVersion}-${candidateHead.slice(0, 12)}`;
    const symlinkVersion = join(versionsRoot, versionID);
    const forgedVersion = join(versionsRoot, `${versionID}-forged`);
    mkdirSync(versionsRoot, { mode: 0o700 });
    mkdirSync(outsideRoot, { mode: 0o700 });
    symlinkSync(outsideRoot, symlinkVersion);
    mkdirSync(forgedVersion, { mode: 0o700 });

    for (const versionRoot of [symlinkVersion, forgedVersion]) {
      expect(() => selectWorkerVersionAction(
        versionRoot,
        { rejectExisting: true }
      )).toThrow("worker version already exists; refusing unverified reuse");
      expect(selectWorkerVersionAction(
        versionRoot,
        { rejectExisting: false }
      )).toBe("reuse");
    }
    expect(selectWorkerVersionAction(
      join(versionsRoot, "missing"),
      { rejectExisting: true }
    )).toBe("install");
  });

  it("requires a definitively unloaded launchd label for first install", () => {
    expect(() => requireFirstInstallLaunchdUnloaded({ loaded: true }))
      .toThrow("first install refuses a loaded LaunchAgent");
    expect(requireFirstInstallLaunchdUnloaded({ loaded: false })).toBe(false);
  });

  it("recovers only the fresh first-install activation after a later failure", () => {
    const removals: string[] = [];
    recoverFailedFirstInstall({
      expectedCurrentTarget: "versions/exact",
      observedCurrentTarget: "versions/exact",
      removeCurrent: () => removals.push("current"),
      removeMarker: () => removals.push("marker"),
      removeVersion: () => removals.push("version")
    });
    expect(removals).toEqual(["current", "marker", "version"]);

    expect(() => recoverFailedFirstInstall({
      expectedCurrentTarget: "versions/exact",
      observedCurrentTarget: "versions/other",
      removeCurrent: () => removals.push("wrong-current"),
      removeMarker: () => removals.push("wrong-marker"),
      removeVersion: () => removals.push("wrong-version")
    })).toThrow("first-install recovery found an unexpected current worker");
    expect(removals).toEqual(["current", "marker", "version"]);
  });

  it("plans a credential-free clean-Mac worker install without a LaunchAgent", () => {
    const plan = planWorkerFirstInstall({
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      workerRoot:
        "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/com.electricsheephq.evaos-code-review-bot",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });

    expect(plan.versionID).toBe(`1.1.0-beta.27-${candidateHead.slice(0, 12)}`);
    expect(plan.nextState).toEqual({
      schemaVersion: 1,
      installationKind: "credential-free-cli",
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });
    expect(JSON.stringify(plan)).not.toMatch(
      /EnvironmentVariables|private.?key|github.?app/i
    );
    expect(() => planWorkerFirstInstall({
      launchdLabel: "com.electricsheephq.evaos-code-review-bot",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/test",
      nodePath: "/tmp/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    })).toThrow(
      "approved stable Node path is required (/opt/homebrew/bin/node or /usr/local/bin/node)"
    );
  });

  it("keeps a stable Node command when it resolves to the running Node binary", () => {
    const resolved = new Map([
      ["/opt/homebrew/Cellar/node/26.5.1/bin/node", "/opt/homebrew/Cellar/node/26.5.1/bin/node"],
      ["/opt/homebrew/bin/node", "/opt/homebrew/Cellar/node/26.5.1/bin/node"],
      ["/usr/local/bin/node", "/usr/local/Cellar/node/24.0.0/bin/node"]
    ]);

    expect(selectStableNodeLaunchPath({
      execPath: "/opt/homebrew/Cellar/node/26.5.1/bin/node",
      stableCandidates: ["/opt/homebrew/bin/node", "/usr/local/bin/node"],
      resolvePath: (path) => resolved.get(path)
    })).toBe("/opt/homebrew/bin/node");

    expect(selectStableNodeLaunchPath({
      execPath: "/opt/homebrew/Cellar/node/26.5.1/bin/node",
      stableCandidates: ["/usr/local/bin/node"],
      resolvePath: (path) => resolved.get(path)
    })).toBe("/opt/homebrew/Cellar/node/26.5.1/bin/node");

    expect(selectStableNodeLaunchPath({
      execPath: "/opt/homebrew/Cellar/node/26.5.1/bin/node",
      stableCandidates: ["/opt/homebrew/bin/node"],
      resolvePath: (path) => {
        if (path === "/opt/homebrew/bin/node") throw new Error("missing stable candidate");
        return resolved.get(path);
      }
    })).toBe("/opt/homebrew/Cellar/node/26.5.1/bin/node");

    expect(selectStableNodeLaunchPath({
      execPath: "/opt/homebrew/Cellar/node/26.5.1/bin/node",
      stableCandidates: ["/opt/homebrew/bin/node"],
      resolvePath: () => {
        throw new Error("cannot resolve process.execPath");
      }
    })).toBe("/opt/homebrew/Cellar/node/26.5.1/bin/node");
  });

  it("exposes an explicit dry-run, confirmed update, and rollback command", () => {
    const scriptPath = "scripts/install-b0-worker-candidate.mjs";
    expect(existsSync(scriptPath)).toBe(true);
    const help = spawnSync(process.execPath, [scriptPath, "--help"], { encoding: "utf8" });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("update");
    expect(help.stdout).toContain("first-install");
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
    expect(script).toContain("assertExactCandidateCheckout");
    expect(script).toContain('BUNDLE_DIR="$(pwd -P)"');
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

    const unboundDependencies = candidateManifest();
    unboundDependencies.installedCompatibility.offlineInstallPassed = false;
    const unboundDependencyBytes = Buffer.from(`${JSON.stringify(unboundDependencies)}\n`);
    expect(() => validateWorkerCandidate({
      manifestBytes: unboundDependencyBytes,
      manifestSHA256: createHash("sha256").update(unboundDependencyBytes).digest("hex"),
      tarballBytes: tarball,
      tarballFilename: `neondiff-${packageVersion}.tgz`
    })).toThrow("candidate manifest package identity is invalid");

    const published = candidateManifest();
    published.distribution.publicNpmPublished = true;
    const publishedBytes = Buffer.from(`${JSON.stringify(published)}\n`);
    expect(() => validateWorkerCandidate({
      manifestBytes: publishedBytes,
      manifestSHA256: createHash("sha256").update(publishedBytes).digest("hex"),
      tarballBytes: tarball,
      tarballFilename: `neondiff-${packageVersion}.tgz`
    })).toThrow("candidate distribution boundary is invalid");

    const traversal = candidateManifest();
    traversal.package.filename = `../neondiff-${packageVersion}.tgz`;
    const traversalBytes = Buffer.from(`${JSON.stringify(traversal)}\n`);
    expect(() => validateWorkerCandidate({
      manifestBytes: traversalBytes,
      manifestSHA256: createHash("sha256").update(traversalBytes).digest("hex"),
      tarballBytes: tarball,
      tarballFilename: `../neondiff-${packageVersion}.tgz`
    })).toThrow("candidate tarball SHA-256 mismatch");
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
    expect(plan.nextLaunchAgent.WorkingDirectory).toBe(launchAgent().WorkingDirectory);
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

  it("fails closed when managed worker state is missing or belongs to another label", () => {
    const managed = launchAgent();
    managed.ProgramArguments = [
      "/opt/homebrew/bin/node",
      "/Users/test/Library/Application Support/NeonDiffDesktop/Workers/current/node_modules/neondiff/dist/src/cli.js",
      "daemon",
      "--config",
      "/Users/test/.config/neondiff/config.local.json"
    ];
    expect(() => planWorkerUpdate({
      launchAgent: managed,
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    })).toThrow("managed worker has no rollback state");

    const first = planWorkerUpdate({
      launchAgent: launchAgent(),
      expectedLabel: "com.electricsheephq.neondiff",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "a".repeat(64)
    });
    const otherLabelLaunchAgent = launchAgent();
    otherLabelLaunchAgent.Label = "com.electricsheephq.neondiff.other";
    expect(() => planWorkerUpdate({
      launchAgent: otherLabelLaunchAgent,
      expectedLabel: "com.electricsheephq.neondiff.other",
      workerRoot: "/Users/test/Library/Application Support/NeonDiffDesktop/Workers",
      nodePath: "/opt/homebrew/bin/node",
      candidateHead,
      packageVersion,
      manifestSHA256: "b".repeat(64),
      previousState: first.nextState
    })).toThrow("worker state label mismatch");
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

  it("retries the bounded launchd bootstrap I/O race before activating the worker", () => {
    let attempts = 0;
    const waits: number[] = [];
    const loadedStates = [true, false];
    const observedAttempts = retryTransientLaunchdBootstrap({
      bootstrap() {
        attempts += 1;
        if (attempts < 3) {
          throw new Error("Bootstrap failed: 5: Input/output error");
        }
      },
      isLoaded() {
        return loadedStates.shift() ?? false;
      },
      wait(milliseconds) {
        waits.push(milliseconds);
      }
    });

    expect(observedAttempts).toBe(3);
    expect(waits).toEqual([250, 750]);

    let unrelatedAttempts = 0;
    expect(() => retryTransientLaunchdBootstrap({
      bootstrap() {
        unrelatedAttempts += 1;
        throw new Error("Bootstrap failed: 1: Operation not permitted");
      },
      isLoaded() {
        throw new Error("must not inspect unrelated failures");
      },
      wait() {
        throw new Error("must not wait on unrelated failures");
      }
    })).toThrow("Operation not permitted");
    expect(unrelatedAttempts).toBe(1);

    let boundedAttempts = 0;
    expect(() => retryTransientLaunchdBootstrap({
      bootstrap() {
        boundedAttempts += 1;
        throw new Error("Bootstrap failed: 5: Input/output error");
      },
      isLoaded() {
        return false;
      },
      wait() {},
      delays: [1]
    })).toThrow("Input/output error");
    expect(boundedAttempts).toBe(2);
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
