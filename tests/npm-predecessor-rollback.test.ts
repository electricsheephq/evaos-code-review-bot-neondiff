import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const policy = join(process.cwd(), "scripts/npm-release-policy.mjs");

function metadata(version: string, commit: string, withContradictoryGitHead = false, integrityOverride?: string) {
  const integrity = integrityOverride ?? `sha512-${Buffer.alloc(64, version === "1.0.5" ? 0xaa : 0xbb).toString("base64")}`;
  const shasum = version === "1.0.5" ? "a".repeat(40) : "b".repeat(40);
  const value: Record<string, unknown> = {
    name: "neondiff",
    version,
    dist: { integrity, shasum },
    provenance: {
      verified: true,
      package: "neondiff",
      version,
      integrity,
      shasum,
      repository: "electricsheephq/evaos-code-review-bot-neondiff",
      workflow: ".github/workflows/publish-npm.yml",
      tag: `v${version}`,
      commit
    }
  };
  if (withContradictoryGitHead) value.gitHead = commit;
  return value;
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [policy, "verify-predecessor-rollback", ...args], {
    cwd: root,
    encoding: "utf8"
  });
}

function baseArgs(currentPath: string, predecessorPath: string): string[] {
  return [
    "--event-name", "workflow_dispatch",
    "--github-ref", "refs/heads/main",
    "--predecessor-rollback", "true",
    "--provenance-recovery", "false",
    "--latest-version", "1.0.5",
    "--target-version", "1.0.4",
    "--expected-predecessor", "1.0.4",
    "--current-metadata", currentPath,
    "--predecessor-metadata", predecessorPath,
    "--current-tag-commit", "a".repeat(40),
    "--predecessor-tag-commit", "b".repeat(40)
  ];
}

describe("predecessor rollback release policy", () => {
  it("accepts only the bounded protected-main rollback plan", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-rollback-policy-"));
    try {
      const currentPath = join(root, "current.json");
      const predecessorPath = join(root, "predecessor.json");
      writeFileSync(currentPath, JSON.stringify(metadata("1.0.5", "a".repeat(40))));
      writeFileSync(predecessorPath, JSON.stringify(metadata("1.0.4", "b".repeat(40))));
      const result = run(root, ...baseArgs(currentPath, predecessorPath));
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "predecessor_dist_tag_rollback",
        bounded: true,
        command: 'npm dist-tag add "neondiff@1.0.4" latest'
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("accepts a confirmation-only rerun after the predecessor already owns latest", () => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-rollback-confirmation-"));
    try {
      const currentPath = join(root, "current.json");
      const predecessorPath = join(root, "predecessor.json");
      writeFileSync(currentPath, JSON.stringify(metadata("1.0.5", "a".repeat(40))));
      writeFileSync(predecessorPath, JSON.stringify(metadata("1.0.4", "b".repeat(40))));
      const args = baseArgs(currentPath, predecessorPath);
      args.splice(args.indexOf("--latest-version") + 1, 1, "1.0.4");
      args.push("--confirmation-only", "true");
      const result = run(root, ...args);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        action: "confirm_predecessor_dist_tag_rollback",
        latestVersion: "1.0.4",
        mutationRequired: false
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.each([
    ["wrong latest", ["--latest-version", "1.0.4"], "latest=1.0.5"],
    ["simultaneous provenance recovery", ["--provenance-recovery", "true"], "protected-main workflow dispatch"],
    ["unexpected quarantine owner", ["--quarantine-version", "1.0.5"], "release-candidate tag to be absent"],
    ["contradictory source modes", [], "exactly one source identity mode"],
    ["malformed integrity", [], "integrity must be a SHA-512 npm integrity value"]
  ])("rejects %s", (_name, overrides, expectedMessage) => {
    const root = mkdtempSync(join(tmpdir(), "neondiff-rollback-policy-hostile-"));
    try {
      const currentPath = join(root, "current.json");
      const predecessorPath = join(root, "predecessor.json");
      writeFileSync(currentPath, JSON.stringify(metadata("1.0.5", "a".repeat(40), _name === "contradictory source modes", _name === "malformed integrity" ? "sha512-too-short" : undefined)));
      writeFileSync(predecessorPath, JSON.stringify(metadata("1.0.4", "b".repeat(40))));
      const args = baseArgs(currentPath, predecessorPath);
      if (_name === "wrong latest") args.splice(args.indexOf("--latest-version") + 1, 1, "1.0.4");
      if (_name === "simultaneous provenance recovery") args.splice(args.indexOf("--provenance-recovery") + 1, 1, "true");
      if (_name === "unexpected quarantine owner") args.push("--quarantine-version", "1.0.5");
      const result = run(root, ...args);
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(expectedMessage);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
