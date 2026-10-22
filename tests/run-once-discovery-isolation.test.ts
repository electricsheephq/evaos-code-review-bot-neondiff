import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GitHubApi } from "../src/github.js";
import { runOnce } from "../src/worker.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function writeConfig(root: string, repos: string[]): string {
  const path = join(root, "config.json");
  writeFileSync(path, `${JSON.stringify({
    pilotRepos: repos,
    statePath: join(root, "reviews.sqlite"),
    repoProfiles: { repos: Object.fromEntries(repos.map((repo) => [repo, { displayName: repo }])) }
  }, null, 2)}\n`);
  return path;
}

describe("runOnce repository discovery", () => {
  it("skips a repository whose pull listing fails and still scans the ones after it", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-once-discovery-"));
    roots.push(root);
    const configPath = writeConfig(root, ["org/broken", "org/healthy"]);
    const listed: string[] = [];
    vi.spyOn(GitHubApi.prototype, "listOpenPulls").mockImplementation(async (repo: string) => {
      listed.push(repo);
      if (repo === "org/broken") throw new Error("installation removed: token ghs_fixture0123456789abcdefghij");
      return [];
    });

    const result = await runOnce({ configPath, dryRun: true, useZCode: false, licenseAdmission: testLicenseAdmission });

    expect(listed).toEqual(["org/broken", "org/healthy"]);
    expect(result.reposScanned).toBe(2);
    expect(result.repositoryScanErrors).toHaveLength(1);
    expect(result.repositoryScanErrors![0]!.repo).toBe("org/broken");
    expect(result.repositoryScanErrors![0]!.error).not.toContain("ghs_fixture0123456789abcdefghij");
  });

  it("keeps an explicit repository scope fail-fast", async () => {
    const root = mkdtempSync(join(tmpdir(), "run-once-discovery-scoped-"));
    roots.push(root);
    const configPath = writeConfig(root, ["org/broken"]);
    vi.spyOn(GitHubApi.prototype, "listOpenPulls").mockRejectedValue(new Error("installation removed"));

    await expect(runOnce({ configPath, dryRun: true, useZCode: false, repo: "org/broken", licenseAdmission: testLicenseAdmission }))
      .rejects.toThrow(/installation removed/);
  });
});
