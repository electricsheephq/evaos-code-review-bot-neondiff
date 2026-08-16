import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { BotConfig } from "../src/config.js";
import type { GitHubApi } from "../src/github.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { testLicenseAdmission } from "./helpers/license-admission.js";

vi.mock("../src/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/git.js")>();
  return {
    ...actual,
    preparePullWorktree: vi.fn((input: { workRoot: string; expectedHeadSha: string }) => {
      const path = join(input.workRoot, "mock-worktree");
      mkdirSync(path, { recursive: true });
      return { path, headSha: input.expectedHeadSha };
    }),
    assertGitClean: vi.fn()
  };
});

const { buildReviewProviderMetadata, localDateFolder, reviewPull: reviewPullImpl } = await import("../src/worker.js");
const reviewPull = (input: Parameters<typeof reviewPullImpl>[0]) => reviewPullImpl({
  ...input,
  pull: {
    ...input.pull,
    base: { ...input.pull.base, repo: { ...input.pull.base.repo, private: false, visibility: "public" } }
  },
  licenseAdmission: input.licenseAdmission ?? testLicenseAdmission
});

describe("worker review settings preview evidence", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("writes review settings preview evidence without threading internal settings into public walkthrough output", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-settings-preview-"));
    roots.push(root);
    const config = minimalConfig(root);
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1410, "a".repeat(40));
    const secretLikeToken = "ghp_fake_token";
    const github = {
      getPull: async () => pull,
      listPullFiles: async () => [
        {
          filename: "src/walkthrough.ts",
          status: "modified",
          additions: 4,
          deletions: 1,
          changes: 5
        }
      ],
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    const result = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false
    });

    expect(result).toBe("reviewed");
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      "pr-1410",
      pull.head.sha
    );
    const preview = JSON.parse(readFileSync(join(evidenceDir, "review-settings-preview.json"), "utf8"));
    const walkthrough = readFileSync(join(evidenceDir, "walkthrough.md"), "utf8");
    const ledger = JSON.parse(readFileSync(join(evidenceDir, "outcome-ledger.json"), "utf8"));

    expect(preview.sections).toContainEqual({
      key: "reviewSummary",
      label: "Review summary",
      enabled: true,
      mode: "inline_review"
    });
    expect(preview.reviewGate).toEqual({
      reviewEventPolicy: { mode: "trusted_command_only" }
    });
    expect(preview).not.toHaveProperty("reviewEventAuthorization");
    expect(preview.pathInstructions).toContainEqual({
      pattern: "src/`templates`/**",
      instructions: ["Do not quote [redacted-secret] in public comments."]
    });
    expect(walkthrough).not.toContain("### Review Settings Preview");
    expect(walkthrough).toContain("Provider: GLM/Z.ai through ZCode (`zcode-glm`, zcode, model `GLM-5.2`).");
    expect(walkthrough).toContain("### Changed Files");
    expect(walkthrough).toContain("### Review Signal");
    expect(walkthrough).toContain("### Maintainer Analysis");
    expect(walkthrough).toContain("### Risk Taxonomy");
    expect(walkthrough).toContain("### Validation and Proof");
    expect(walkthrough).not.toContain("Enabled sections:");
    expect(walkthrough).not.toContain("Path instructions:");
    expect(walkthrough).not.toContain("Label suggestions:");
    expect(walkthrough).not.toContain("Reviewer suggestions:");
    expect(walkthrough).not.toContain("Suggestion behavior:");
    expect(walkthrough).not.toContain("Roadmap-only settings:");
    expect(walkthrough).not.toContain("Repo-specific instruction:");
    expect(walkthrough).not.toContain("reviewRiskLens");
    expect(walkthrough).not.toContain("proofExpectations");
    expect(walkthrough).not.toContain("validationHints");
    expect(walkthrough).not.toContain("readinessHints");
    expect(walkthrough).not.toContain(secretLikeToken);
    expect(ledger.runtime).toMatchObject({
      provider: "zcode-glm",
      model: "GLM-5.2",
      providerAttempts: 0,
      notes: ["ZCode execution disabled for this dry-run; provider latency and token usage were not measured."]
    });
    state.close();
  });

  it("keeps dry-run review-plan evidence when outcome ledger build fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-outcome-ledger-failure-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.walkthrough.enabled = false;
    const state = new ReviewStateStore(config.statePath);
    const pull = pullSummary(1411, "short-head-sha");
    const github = {
      getPull: async () => pull,
      listPullFiles: async () => [
        {
          filename: "src/runtime.ts",
          status: "modified",
          additions: 1,
          deletions: 1,
          changes: 2
        }
      ],
      canPostAsApp: () => false
    } as unknown as GitHubApi;

    const result = await reviewPull({
      config,
      github,
      state,
      repo: "electricsheephq/WorldOS",
      pull,
      dryRun: true,
      useZCode: false
    });

    expect(result).toBe("reviewed");
    const evidenceDir = join(
      root,
      "evidence",
      localDateFolder(),
      "electricsheephq__WorldOS",
      "pr-1411",
      pull.head.sha
    );
    expect(existsSync(join(evidenceDir, "review-plan.json"))).toBe(true);
    expect(existsSync(join(evidenceDir, "outcome-ledger-error.json"))).toBe(true);
    expect(existsSync(join(evidenceDir, "outcome-ledger.json"))).toBe(false);
    expect(state.getProcessedReview("electricsheephq/WorldOS", pull.number, pull.head.sha)).toMatchObject({
      status: "dry_run"
    });
    state.close();
  });

  it("uses the selected registry id for metadata when ZCode has a distinct execution id", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-worker-provider-metadata-"));
    roots.push(root);
    const config = minimalConfig(root);
    config.zcode.providerId = "ghost-provider";
    config.providers = {
      defaultProviderId: "zcode-glm",
      providers: {
        "zcode-glm": {
          enabled: true,
          adapter: "zcode",
          displayName: "GLM/Z.ai through ZCode",
          model: "GLM-5.2",
          authMode: "zcode-app-config",
          capabilities: {
            review: true,
            jsonOutput: true,
            local: false,
            streaming: false
          }
        }
      }
    };

    expect(buildReviewProviderMetadata(config)).toEqual({
      providerId: "zcode-glm",
      adapter: "zcode",
      model: "GLM-5.2",
      displayName: "GLM/Z.ai through ZCode"
    });
  });
});

function minimalConfig(root: string): BotConfig {
  return {
    pilotRepos: ["electricsheephq/WorldOS"],
    pollIntervalMs: 60_000,
    skipDrafts: true,
    workRoot: join(root, "work"),
    statePath: join(root, "state.sqlite"),
    evidenceDir: join(root, "evidence"),
    activation: {
      reviewExistingOpenPrsOnActivation: false
    },
    reviewConcurrency: {
      maxActiveRuns: 1,
      leaseTtlMs: 60_000
    },
    providerCooldown: {
      enabled: false,
      durationMs: 15 * 60_000,
      requestRateLimitDurationMs: 90_000,
      overloadDurationMs: 2 * 60_000,
      quotaDurationMs: 30 * 60_000,
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 0,
      transientRetryAttempts: 1,
      transientRetryBaseDelayMs: 1,
      transientRetryMaxDelayMs: 1
    },
    walkthrough: {
      enabled: true,
      postIssueComment: false
    },
    commands: {
      enabled: false,
      botMentions: ["@evaos-code-review-bot"],
      trustedAuthors: [],
      acknowledge: false
    },
    repoProfiles: {
      repos: {
        "electricsheephq/WorldOS": {
          reviewProfile: "assertive",
          pathInstructions: {
            "src/`templates`/**": [`Do not quote ghp_fake_token in public comments.`]
          },
          suggestedLabels: ["review-settings"],
          suggestedReviewers: ["maintainer-one"]
        }
      }
    },
    zcode: {
      providerId: "zcode-glm",
      cliPath: "/unused/zcode.cjs",
      appConfigPath: "/unused/config.json",
      model: "GLM-5.2",
      timeoutMs: 1,
      maxPatchBytes: 1,
      retryMaxRetries: 0
    },
    providers: {
      defaultProviderId: "zcode-glm",
      providers: {
        "zcode-glm": {
          enabled: true,
          adapter: "zcode",
          displayName: "GLM/Z.ai through ZCode",
          model: "GLM-5.2",
          authMode: "zcode-app-config",
          capabilities: {
            review: true,
            jsonOutput: true,
            local: false,
            streaming: false
          }
        }
      }
    },
    github: {}
  };
}

function pullSummary(number: number, headSha: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft: false,
    head: {
      sha: headSha,
      ref: `pr-${number}`,
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    base: {
      sha: "b".repeat(40),
      ref: "main",
      repo: { full_name: "electricsheephq/WorldOS" }
    },
    html_url: `https://github.com/electricsheephq/WorldOS/pull/${number}`
  };
}
