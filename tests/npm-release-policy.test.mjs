import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots = [];
const policy = resolve("scripts/npm-release-policy.mjs");
const marker = "NeonDiff-Release-Class: desktop-only";

afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));

function taggedRepo(tag) {
  const root = mkdtempSync(join(tmpdir(), "neondiff-semver-"));
  roots.push(root);
  execFileSync("git", ["init", "-q", "-b", "main", root]);
  for (const [key, value] of [["user.email", "release-policy@example.invalid"], ["user.name", "Release Policy Test"]]) {
    execFileSync("git", ["-C", root, "config", key, value]);
  }
  writeFileSync(join(root, "release.txt"), "release\n");
  execFileSync("git", ["-C", root, "add", "release.txt"]);
  execFileSync("git", ["-C", root, "commit", "-q", "-m", "release"]);
  execFileSync("git", ["-C", root, "tag", "-a", tag, "-m", marker]);
  return root;
}

function classify(root, tag) {
  return spawnSync(process.execPath, [policy, "classify", "--event-name", "release", "--release-prerelease", "true", "--tag", tag, "--package-version", "1.0.4", "--release-level", "stable", "--skipped-versions-json", "[]"], { cwd: root, encoding: "utf8" });
}

describe("canonical Desktop-only RC identities", () => {
  it.each(["v1.1.0-rc.01", "v01.1.0-rc.1", "v1.01.0-rc.1", "v1.1.01-rc.1", "v1.1.0-rc.0"])("fails closed for %s", (tag) => {
    const result = classify(taggedRepo(tag), tag);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("stable npm packages require a non-prerelease GitHub Release");
  });

  it.each(["v0.0.0-rc.1", "v1.0.0-rc.1", "v1.1.0-rc.1"])("keeps canonical %s as a Desktop-only no-op", (tag) => {
    const result = classify(taggedRepo(tag), tag);
    expect(JSON.parse(result.stdout)).toEqual({ shouldPublish: false, npmTag: "latest", releaseKind: "desktop-only" });
  });
});
