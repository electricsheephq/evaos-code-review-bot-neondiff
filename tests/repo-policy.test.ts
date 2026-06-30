import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { buildRepoProfilePromptSection, filterPullFilesForProfile, resolveRepoProfile } from "../src/repo-policy.js";
import { runOnce } from "../src/worker.js";
import { buildReviewPrompt } from "../src/zcode.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";
import type { RepoProfileResolution, ResolvedRepoProfile } from "../src/repo-policy.js";

describe("repo profile registry", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads explicit repo profile guidance from config", () => {
    const config = loadConfig(
      writeConfig({
        pilotRepos: ["electricsheephq/WorldOS"],
        repoProfiles: {
          repos: {
            "electricsheephq/WorldOS": {
              displayName: "WorldOS Unity",
              defaultBranch: "main",
              reviewProfile: "assertive",
              promptNote: "Prioritize Unity scene, save-state, and gameplay regressions.",
              riskyPaths: ["Assets/**", "ProjectSettings/**"],
              proofExpectations: ["Mention Unity play-mode or editor smoke evidence when relevant."],
              validationHints: ["Prefer current-diff correctness findings over style feedback."],
              readinessHints: ["Release-impacting scene changes require explicit rollback notes."]
            }
          }
        }
      })
    );

    const resolved = resolveRepoProfile(config, "electricsheephq/WorldOS");
    const profile = expectAllowed(resolved);

    expect(resolved.allowed).toBe(true);
    expect(profile).toMatchObject({
      repo: "electricsheephq/WorldOS",
      displayName: "WorldOS Unity",
      reviewProfile: "assertive",
      source: "explicit"
    });
    expect(buildRepoProfilePromptSection(profile)).toContain("Unity scene, save-state");
  });

  it("skips explicitly disabled repos closed", () => {
    const config = loadConfig(
      writeConfig({
        pilotRepos: ["100yenadmin/evaOS-GUI"],
        repoProfiles: {
          repos: {
            "100yenadmin/evaOS-GUI": {
              enabled: false,
              displayName: "Workbench"
            }
          }
        }
      })
    );

    expect(resolveRepoProfile(config, "100yenadmin/evaOS-GUI")).toEqual({
      allowed: false,
      reason: "repo_profile_disabled"
    });
  });

  it("requires explicit opt-in before org fallback profiles can review unknown repos", () => {
    const baseProfileConfig = {
      pilotRepos: ["electricsheephq/evaos-support-control"],
      repoProfiles: {
        orgFallbacks: {
          electricsheephq: {
            displayName: "Electric Sheep fallback",
            promptNote: "Apply conservative TypeScript service review policy."
          }
        }
      }
    };
    const fallbackDisabled = loadConfig(writeConfig(baseProfileConfig));
    const fallbackEnabled = loadConfig(
      writeConfig({
        ...baseProfileConfig,
        repoProfiles: {
          ...baseProfileConfig.repoProfiles,
          enableOrgFallbacks: true
        }
      })
    );

    expect(resolveRepoProfile(fallbackDisabled, "electricsheephq/evaos-support-control")).toEqual({
      allowed: false,
      reason: "repo_profile_missing"
    });
    expect(resolveRepoProfile(fallbackEnabled, "electricsheephq/evaos-support-control")).toMatchObject({
      allowed: true,
      profile: {
        repo: "electricsheephq/evaos-support-control",
        source: "org_fallback",
        displayName: "Electric Sheep fallback"
      }
    });
  });

  it("applies include and exclude path filters before prompt construction", () => {
    const resolved = resolveRepoProfile(
      loadConfig(
        writeConfig({
          repoProfiles: {
            repos: {
              "electricsheephq/evaos-code-review-bot": {
                displayName: "Review bot",
                pathFilters: ["src/**", "README.md", "!src/generated/**"]
              }
            }
          }
        })
      ),
      "electricsheephq/evaos-code-review-bot"
    );
    const profile = expectAllowed(resolved);
    const files: PullFilePatch[] = [
      { filename: "src/worker.ts", status: "modified", additions: 4, deletions: 1, changes: 5, patch: "+worker" },
      { filename: "src/generated/types.ts", status: "modified", additions: 9, deletions: 0, changes: 9, patch: "+generated" },
      { filename: "README.md", status: "modified", additions: 2, deletions: 0, changes: 2, patch: "+docs" },
      { filename: "docs/runbook.md", status: "modified", additions: 3, deletions: 0, changes: 3, patch: "+runbook" }
    ];

    expect(filterPullFilesForProfile(files, profile).map((file) => file.filename)).toEqual([
      "src/worker.ts",
      "README.md"
    ]);
  });

  it("injects repo profile guidance into the ZCode prompt", () => {
    const resolved = resolveRepoProfile(
      loadConfig(
        writeConfig({
          repoProfiles: {
            repos: {
              "electricsheephq/evaos-code-review-bot": {
                displayName: "evaOS review bot",
                reviewProfile: "assertive",
                promptNote: "Focus on duplicate suppression, secret redaction, and GitHub App identity.",
                riskyPaths: ["src/github.ts", "src/state.ts"]
              }
            }
          }
        })
      ),
      "electricsheephq/evaos-code-review-bot"
    );
    const profile = expectAllowed(resolved);

    const prompt = buildReviewPrompt({
      repo: "electricsheephq/evaos-code-review-bot",
      pull,
      files: [{ filename: "src/state.ts", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+dedupe" }],
      repoProfile: profile
    });

    expect(prompt).toContain("Repository profile guidance");
    expect(prompt).toContain("duplicate suppression, secret redaction");
    expect(prompt).toContain("src/state.ts");
  });

  it("lets the worker skip unknown repos before GitHub fetches", async () => {
    const root = mkdtempSync(join(tmpdir(), "repo-profile-state-"));
    roots.push(root);
    const configPath = writeConfig({
      pilotRepos: ["electricsheephq/missing-repo"],
      statePath: join(root, "reviews.sqlite"),
      repoProfiles: {
        repos: {
          "electricsheephq/WorldOS": {
            displayName: "WorldOS"
          }
        }
      }
    });

    await expect(runOnce({ configPath, dryRun: true, useZCode: false })).resolves.toMatchObject({
      reposScanned: 1,
      pullsSeen: 0,
      skippedPolicy: 1,
      policySkips: [{ repo: "electricsheephq/missing-repo", reason: "repo_profile_missing" }]
    });
  });

  function writeConfig(config: unknown): string {
    const root = mkdtempSync(join(tmpdir(), "repo-profile-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`);
    return path;
  }
});

function expectAllowed(resolution: RepoProfileResolution): ResolvedRepoProfile {
  expect(resolution.allowed).toBe(true);
  if (!resolution.allowed) throw new Error(`Expected repo profile to be allowed, got ${resolution.reason}`);
  return resolution.profile;
}

const pull: PullRequestSummary = {
  number: 32,
  title: "Add repo policy registry",
  draft: false,
  body: "Closes #17",
  head: {
    sha: "profile-head",
    ref: "sprint/2-repo-profiles",
    repo: { full_name: "electricsheephq/evaos-code-review-bot" }
  },
  base: {
    sha: "profile-base",
    ref: "main",
    repo: { full_name: "electricsheephq/evaos-code-review-bot" }
  },
  html_url: "https://github.com/electricsheephq/evaos-code-review-bot/pull/32",
  requested_reviewers: []
};
