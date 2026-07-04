import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import {
  buildPullFileFilterImpact,
  buildRepoPolicySnapshot,
  buildRepoProfilePromptSection,
  buildReviewSettingsPreview,
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

  it("keeps safety-critical root and workflow files visible despite narrow path filters", () => {
    const profile = expectAllowed(
      resolveRepoProfile(
        loadConfig(
          writeConfig({
            repoProfiles: {
              repos: {
                "electricsheephq/WorldOS": {
                  displayName: "WorldOS",
                  pathFilters: ["Assets/**", "ProjectSettings/**", "!ProjectSettings/generated/**"]
                }
              }
            }
          })
        ),
        "electricsheephq/WorldOS"
      )
    );
    const files: PullFilePatch[] = [
      { filename: "Assets/Scene.unity", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+scene" },
      { filename: ".github/workflows/build.yml", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+ci" },
      { filename: "package-lock.json", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+lock" },
      { filename: "tsconfig.json", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+ts" },
      { filename: "ProjectSettings/generated/cache.asset", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+cache" },
      { filename: "docs/notes.md", status: "modified", additions: 1, deletions: 0, changes: 1, patch: "+notes" }
    ];

    const impact = buildPullFileFilterImpact(files, profile);

    expect(filterPullFilesForProfile(files, profile).map((file) => file.filename)).toEqual([
      "Assets/Scene.unity",
      ".github/workflows/build.yml",
      "package-lock.json",
      "tsconfig.json"
    ]);
    expect(impact).toMatchObject({
      originalCount: 6,
      includedCount: 4,
      excludedCount: 2
    });
    expect(impact.included).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filename: "Assets/Scene.unity", reason: "matched_profile_include", pattern: "Assets/**" }),
        expect.objectContaining({ filename: ".github/workflows/build.yml", reason: "matched_safety_include", pattern: ".github/**" }),
        expect.objectContaining({ filename: "package-lock.json", reason: "matched_safety_include", pattern: "package-lock.json" }),
        expect.objectContaining({ filename: "tsconfig.json", reason: "matched_safety_include", pattern: "tsconfig*.json" })
      ])
    );
    expect(impact.excluded).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          filename: "ProjectSettings/generated/cache.asset",
          reason: "excluded_by_profile",
          pattern: "ProjectSettings/generated/**"
        }),
        expect.objectContaining({ filename: "docs/notes.md", reason: "no_matching_include" })
      ])
    );
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

  it("maps CodeRabbit-style repo settings into a preview without enabling auto-apply behavior", () => {
    const config = loadConfig(
      writeConfig({
        walkthrough: {
          enabled: true,
          postIssueComment: true
        },
        reviewStatusComment: {
          enabled: true
        },
        repoProfiles: {
          repos: {
            "electricsheephq/evaos-code-review-bot": {
              displayName: "Review bot",
              reviewProfile: "assertive",
              pathInstructions: {
                "src/**": ["Prioritize runtime correctness and duplicate-posting regressions."]
              },
              suggestedLabels: ["review-settings"],
              suggestedReviewers: ["maintainer-one"]
            }
          }
        }
      })
    );
    const profile = expectAllowed(resolveRepoProfile(config, "electricsheephq/evaos-code-review-bot"));

    expect(buildReviewSettingsPreview(config, profile)).toEqual({
      profile: "assertive",
      sections: [
        { key: "reviewSummary", label: "Review summary", enabled: true, mode: "inline_review" },
        { key: "walkthrough", label: "Walkthrough", enabled: true, mode: "issue_comment" },
        { key: "changedFiles", label: "Changed-files table", enabled: true, mode: "walkthrough" },
        { key: "effortEstimate", label: "Effort estimate", enabled: true, mode: "walkthrough" },
        { key: "relatedContext", label: "Related issues/PRs", enabled: true, mode: "walkthrough" },
        { key: "suggestedLabels", label: "Suggested labels", enabled: true, mode: "suggestion_only" },
        { key: "suggestedReviewers", label: "Suggested reviewers", enabled: true, mode: "suggestion_only" },
        { key: "statusComment", label: "Review status comment", enabled: true, mode: "sticky_status" }
      ],
      pathInstructions: [
        { pattern: "src/**", instructions: ["Prioritize runtime correctness and duplicate-posting regressions."] }
      ],
      suggestions: {
        labels: ["review-settings"],
        reviewers: ["maintainer-one"],
        autoApply: false
      },
      roadmapOnly: ["auto-apply labels", "auto-request reviewers"]
    });
  });

  it("keeps review summary enabled when inline walkthrough carries the review body", () => {
    const config = loadConfig(
      writeConfig({
        walkthrough: {
          enabled: true,
          postIssueComment: false
        },
        repoProfiles: {
          repos: {
            "electricsheephq/evaos-code-review-bot": {
              displayName: "Review bot"
            }
          }
        }
      })
    );
    const profile = expectAllowed(resolveRepoProfile(config, "electricsheephq/evaos-code-review-bot"));

    const preview = buildReviewSettingsPreview(config, profile);

    expect(preview.sections).toContainEqual({
      key: "reviewSummary",
      label: "Review summary",
      enabled: true,
      mode: "inline_review"
    });
    expect(preview.sections).toContainEqual({
      key: "walkthrough",
      label: "Walkthrough",
      enabled: true,
      mode: "inline_review"
    });
  });

  it("preserves chill profile and disabled status comment defaults in settings preview", () => {
    const config = loadConfig(
      writeConfig({
        walkthrough: {
          enabled: true,
          postIssueComment: true
        },
        repoProfiles: {
          repos: {
            "electricsheephq/evaos-code-review-bot": {
              displayName: "Review bot",
              reviewProfile: "chill"
            }
          }
        }
      })
    );
    const profile = expectAllowed(resolveRepoProfile(config, "electricsheephq/evaos-code-review-bot"));

    const preview = buildReviewSettingsPreview(config, profile);

    expect(preview.profile).toBe("chill");
    expect(preview.sections).toContainEqual({
      key: "statusComment",
      label: "Review status comment",
      enabled: false,
      mode: "sticky_status"
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

  it("keeps representative active-profile changed surfaces visible", () => {
    const template = JSON.parse(readFileSync(new URL("../config.active-profiles.example.json", import.meta.url), "utf8"));
    const config = loadConfig(writeConfig(template));
    const cases = [
      {
        repo: "electricsheephq/WorldOS",
        files: [
          "extensions/renderers/shared/room_recipes.json",
          "qa/export_scene_grid.py",
          "qa/seed_gfx_crypt_2room.py",
          "servers/engine/combat_grid.py",
          "servers/engine/server.py",
          "servers/engine/tests/test_grid_los.py"
        ]
      },
      {
        repo: "100yenadmin/Lossless-Codex-Orchestrator-LCO",
        files: [
          "packages/runtime/src/review-runner.ts",
          "packages/runtime/tests/review-runner.test.ts",
          "src/index.ts"
        ]
      },
      {
        repo: "100yenadmin/evaOS-GUI",
        files: [
          ".github/workflows/pr-checks.yml",
          ".github/workflows/public-security-scan.yml",
          ".gitleaks.toml",
          "mobile/eas.json",
          "mobile/scripts/build.js"
        ]
      },
      {
        repo: "electricsheephq/electric-sheep-eva-marketing-site",
        files: ["supabase/functions/create-stripe-checkout/index.ts"]
      },
      {
        repo: "electricsheephq/evaos-cortex",
        files: [
          ".env.example",
          "supabase/config.toml",
          "supabase/functions/_shared/finance_metrics.ts",
          "supabase/functions/finance-metrics-refresh/index.test.ts",
          "supabase/functions/finance-metrics-refresh/index.ts"
        ]
      }
    ];

    for (const testCase of cases) {
      const profile = expectAllowed(resolveRepoProfile(config, testCase.repo));
      const files = testCase.files.map((filename) => patchFile(filename));
      const impact = buildPullFileFilterImpact(files, profile);
      expect(impact.excluded, `${testCase.repo} excluded ${impact.excluded.map((entry) => entry.filename).join(", ")}`).toEqual([]);
      expect(filterPullFilesForProfile(files, profile).map((file) => file.filename)).toEqual(testCase.files);
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

function patchFile(filename: string): PullFilePatch {
  return {
    filename,
    status: "modified",
    additions: 1,
    deletions: 0,
    changes: 1,
    patch: `+${filename}`
  };
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
