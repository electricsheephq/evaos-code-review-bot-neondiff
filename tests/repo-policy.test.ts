import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildRepoPolicySnapshot,
  buildRepoProfilePromptSection,
  filterPullFilesForProfile,
  listReposToScan,
  resolveRepoProfile
} from "../src/repo-policy.js";
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

  it("matches repo profiles case-insensitively while preserving configured repo names", () => {
    const config = loadConfig(
      writeConfig({
        pilotRepos: ["electricsheephq/worldOS", "ElectricSheepHQ/WorldOS"],
        repoProfiles: {
          repos: {
            "electricsheephq/WorldOS": {
              displayName: "WorldOS Unity",
              reviewProfile: "assertive"
            }
          }
        }
      })
    );

    expect(listReposToScan(config)).toEqual(["electricsheephq/worldOS"]);
    expect(resolveRepoProfile(config, "electricsheephq/worldOS")).toMatchObject({
      allowed: true,
      profile: {
        repo: "electricsheephq/WorldOS",
        canonicalRepo: "electricsheephq/worldos",
        source: "explicit",
        displayName: "WorldOS Unity"
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

  it("rejects invalid repo policy config before runtime use", () => {
    expect(() =>
      loadConfig(
        writeConfig({
          pilotRepos: ["not-a-repo"],
          repoProfiles: {
            repos: {
              "not-a-repo": {
                reviewProfile: "loud"
              }
            }
          }
        })
      )
    ).toThrow(/owner\/repo/);

    expect(() =>
      loadConfig(
        writeConfig({
          canaryPulls: ["electricsheephq/WorldOS#abc"]
        })
      )
    ).toThrow(/owner\/repo#number/);

    expect(() =>
      loadConfig(
        writeConfig({
          repoProfiles: {
            repos: {
              "electricsheephq/WorldOS": {
                preMergeChecks: {
                  testEvidence: { mode: "block" }
                }
              }
            }
          }
        })
      )
    ).toThrow(/preMergeChecks\.testEvidence\.mode/);

    expect(() =>
      loadConfig(
        writeConfig({
          repoProfiles: {
            repos: {
              "electricsheephq/WorldOS": {
                finishingTouches: {
                  unitTests: { enabled: "yes" }
                }
              }
            }
          }
        })
      )
    ).toThrow(/finishingTouches\.unitTests\.enabled/);
  });

  it("renders repo policy checks and finishing-touch declarations as prompt-only guidance", () => {
    const resolved = resolveRepoProfile(
      loadConfig(
        writeConfig({
          pilotRepos: ["electricsheephq/evaos-code-review-bot"],
          repoProfiles: {
            repos: {
              "electricsheephq/evaos-code-review-bot": {
                autoReview: {
                  baseBranches: ["main", "release/.*"],
                  labels: ["!wip", "ready-for-review"]
                },
                pathInstructions: {
                  "src/github.ts": ["Treat App-authored identity regressions as high risk."],
                  "src/state.ts": ["Check duplicate-suppression invariants."]
                },
                preMergeChecks: {
                  title: { mode: "warning", instructions: "Title should name the safety behavior." },
                  testEvidence: { mode: "error", instructions: "Require focused tests and release-status proof." },
                  docstrings: { mode: "off", threshold: 80 }
                },
                finishingTouches: {
                  docstrings: { enabled: false, instructions: "Design only; do not execute during review." },
                  unitTests: { enabled: false }
                },
                suggestedLabels: ["bot", "regression-hardening"],
                suggestedReviewers: ["100yenadmin"]
              }
            }
          }
        })
      ),
      "electricsheephq/evaos-code-review-bot"
    );
    const profile = expectAllowed(resolved);
    const prompt = buildRepoProfilePromptSection(profile);

    expect(prompt).toContain("Auto-review base branches: main; release/.*");
    expect(prompt).toContain("src/github.ts: Treat App-authored identity regressions as high risk.");
    expect(prompt).toContain("Pre-merge checks (advisory; do not invent CI status)");
    expect(prompt).toContain("testEvidence: mode=error; Require focused tests and release-status proof.");
    expect(prompt).toContain("Finishing-touch commands (declarations only");
    expect(prompt).toContain("unitTests: enabled=false");
    expect(prompt).toContain("Allowed label suggestions: bot; regression-hardening");
    expect(prompt).toContain("Allowed reviewer suggestions: 100yenadmin");
  });

  it("builds compact policy snapshots for doctor and release evidence", () => {
    const config = loadConfig(
      writeConfig({
        pilotRepos: ["electricsheephq/evaos-code-review-bot", "electricsheephq/unknown"],
        repoProfiles: {
          repos: {
            "electricsheephq/evaos-code-review-bot": {
              displayName: "Review bot",
              pathFilters: ["src/**"],
              preMergeChecks: {
                testEvidence: { mode: "error", instructions: "Require focused test proof." }
              },
              finishingTouches: {
                unitTests: { enabled: false }
              }
            }
          }
        }
      })
    );

    expect(buildRepoPolicySnapshot(config, "electricsheephq/evaos-code-review-bot")).toMatchObject({
      repo: "electricsheephq/evaos-code-review-bot",
      canonicalRepo: "electricsheephq/evaos-code-review-bot",
      allowed: true,
      source: "explicit",
      displayName: "Review bot",
      reviewProfile: "assertive",
      pathFilters: ["src/**"],
      preMergeChecks: {
        testEvidence: { mode: "error", instructions: "Require focused test proof." }
      },
      finishingTouches: {
        unitTests: { enabled: false }
      }
    });
    expect(buildRepoPolicySnapshot(config, "electricsheephq/unknown")).toEqual({
      repo: "electricsheephq/unknown",
      canonicalRepo: "electricsheephq/unknown",
      allowed: false,
      skippedByPolicy: "repo_profile_missing"
    });
  });

  it("keeps the active monitor profile template explicit and non-executing", () => {
    const template = JSON.parse(readFileSync(new URL("../config.active-profiles.example.json", import.meta.url), "utf8"));
    const config = loadConfig(writeConfig(template));
    const repos = listReposToScan(config);

    expect(repos).toEqual(activeMonitorRepos);
    expect(repos).not.toContain("Martian-Engineering/lossless-claw");
    expect(repos).not.toContain("zMartian-Engineering/lossless-claw");
    expect(config.commands.enabled).toBe(false);
    expect(config.repoProfiles?.enableOrgFallbacks).toBe(false);

    for (const repo of activeMonitorRepos) {
      const snapshot = buildRepoPolicySnapshot(config, repo);
      expect(snapshot).toMatchObject({
        repo,
        canonicalRepo: repo.toLowerCase(),
        allowed: true,
        source: "explicit",
        reviewProfile: "assertive"
      });
      expect(snapshot.finishingTouches).toBeDefined();
      for (const touch of Object.values(snapshot.finishingTouches ?? {})) {
        expect(touch?.enabled).toBe(false);
      }
    }
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

const activeMonitorRepos = [
  "electricsheephq/WorldOS",
  "electricsheephq/evaos-code-review-bot",
  "electricsheephq/electric-sheep-website-dashboard-6158a244",
  "electricsheephq/evaos-support-control",
  "electricsheephq/evaos-ws-proxy",
  "electricsheephq/evaos-cortex-plugin",
  "electricsheephq/evaOS-gitnexus",
  "electricsheephq/electric-sheep-eva-marketing-site",
  "electricsheephq/evaos-cortex",
  "electricsheephq/worldOS-marketing-site",
  "electricsheephq/ai-chief-of-staff",
  "electricsheephq/vantage-portfolio-hub",
  "electricsheephq/mission-control-paperclip",
  "electricsheephq/evaos-golden",
  "electricsheephq/eric-wilder",
  "100yenadmin/evaOS-GUI",
  "100yenadmin/Lossless-Codex-Orchestrator-LCO",
  "100yenadmin/worldos-unity",
  "100yenadmin/ai-agent-resource-hog-watcher"
];
