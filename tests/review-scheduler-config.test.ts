import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";

describe("review scheduler config", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("loads disabled-by-default provider-aware queue settings", () => {
    const config = loadConfig(writeConfig({}));

    expect(config.reviewScheduler).toEqual({
      enabled: false,
      maxProviderActive: 2,
      maxOrgActive: 3,
      maxRepoActive: 1,
      maxQueuedPerRepo: 10,
      manualCommandReserve: 1,
      backgroundPriority: 50
    });
    expect(config.providerCooldown).toMatchObject({
      overloadBackoffMaxDurationMs: 10 * 60_000,
      overloadBackoffJitterMs: 30_000
    });
    expect(config.reviewModes).toMatchObject({
      enabled: false,
      defaultMode: "fast",
      modes: {
        fast: {
          targetMinutes: 5,
          wholeRunDeadlineMs: 10 * 60_000,
          maxProviderAttempts: 1,
          allowedContextSources: ["patch"],
          escalation: {
            allowDepthEscalation: false,
            allowDepthEscalationWhileProviderBacklog: false
          }
        },
        deep: {
          targetMinutes: 25,
          wholeRunDeadlineMs: 35 * 60_000,
          queueWeight: 90
        },
        research: {
          maxPatchBytes: 0,
          allowedContextSources: ["repo_memory", "gitnexus", "github_related", "skill_packs"]
        }
      }
    });
  });

  it("loads explicit review mode budget and escalation policy overrides", () => {
    const config = loadConfig(writeConfig({
      reviewModes: {
        enabled: true,
        modes: {
          deep: {
            targetMinutes: 22,
            wholeRunDeadlineMs: 33 * 60_000,
            perAttemptTimeoutMs: 11 * 60_000,
            maxPatchBytes: 90_000,
            maxContextBytes: 50_000,
            maxProviderAttempts: 3,
            allowedContextSources: ["patch", "repo_memory"],
            queueWeight: 80,
            leaseTtlMs: 50 * 60_000,
            heartbeatMs: 60_000,
            escalation: {
              allowDepthEscalation: true,
              allowDepthEscalationWhileProviderBacklog: false,
              allowManualCommand: true,
              allowRequestChanges: true
            }
          }
        }
      }
    }));

    expect(config.reviewModes).toMatchObject({
      enabled: true,
      modes: {
        deep: {
          targetMinutes: 22,
          wholeRunDeadlineMs: 33 * 60_000,
          perAttemptTimeoutMs: 11 * 60_000,
          maxProviderAttempts: 3,
          allowedContextSources: ["patch", "repo_memory"]
        }
      }
    });
  });

  it("rejects review mode configs that allow depth escalation while provider backlog exists", () => {
    expect(() => loadConfig(writeConfig({
      reviewModes: {
        modes: {
          standard: {
            escalation: {
              allowDepthEscalationWhileProviderBacklog: true
            }
          }
        }
      }
    }))).toThrow("config.reviewModes.modes.standard.escalation.allowDepthEscalationWhileProviderBacklog must remain false during beta");
  });

  it("rejects scheduler settings that cannot preserve manual reserve capacity", () => {
    expect(() => loadConfig(writeConfig({
      reviewScheduler: {
        maxProviderActive: 1,
        manualCommandReserve: 2
      }
    }))).toThrow("config.reviewScheduler.manualCommandReserve must be <= config.reviewScheduler.maxProviderActive");
  });

  it("loads and validates repo-profile scheduler burst overrides", () => {
    const config = loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "100yenadmin/Lossless-Codex-Orchestrator-LCO": {
            reviewScheduler: {
              maxActiveHeads: 1,
              maxQueuedHeads: 3,
              overflowAction: "defer"
            }
          }
        }
      }
    }));

    expect(config.repoProfiles?.repos?.["100yenadmin/Lossless-Codex-Orchestrator-LCO"]?.reviewScheduler).toEqual({
      maxActiveHeads: 1,
      maxQueuedHeads: 3,
      overflowAction: "defer"
    });
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              maxQueuedHeads: 0
            }
          }
        }
      }
    }))).toThrow("repoProfiles.repos.owner/repo.reviewScheduler.maxQueuedHeads must be a positive integer");
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              maxActiveHeads: 0
            }
          }
        }
      }
    }))).toThrow("repoProfiles.repos.owner/repo.reviewScheduler.maxActiveHeads must be a positive integer");
    expect(() => loadConfig(writeConfig({
      repoProfiles: {
        repos: {
          "owner/repo": {
            reviewScheduler: {
              overflowAction: "park"
            }
          }
        }
      }
    }))).toThrow('repoProfiles.repos.owner/repo.reviewScheduler.overflowAction must be "defer" or "skip"');
  });

  it("validates provider overload backoff settings", () => {
    expect(() => loadConfig(writeConfig({
      providerCooldown: {
        overloadBackoffMaxDurationMs: 0
      }
    }))).toThrow("config.providerCooldown.overloadBackoffMaxDurationMs must be a positive integer");
    expect(() => loadConfig(writeConfig({
      providerCooldown: {
        overloadBackoffJitterMs: -1
      }
    }))).toThrow("config.providerCooldown.overloadBackoffJitterMs must be a non-negative integer");
  });

  it("validates optional GitHub API client settings", () => {
    expect(loadConfig(writeConfig({
      github: {
        apiBaseUrl: "https://api.github.test",
        botLogin: "evaos-code-review-bot[bot]",
        requestTimeoutMs: 1_000
      }
    })).github).toMatchObject({
      apiBaseUrl: "https://api.github.test",
      botLogin: "evaos-code-review-bot[bot]",
      requestTimeoutMs: 1_000
    });

    expect(() => loadConfig(writeConfig({ github: { apiBaseUrl: 42 } }))).toThrow(/config\.github\.apiBaseUrl/);
    expect(() => loadConfig(writeConfig({ github: { botLogin: 42 } }))).toThrow(/config\.github\.botLogin/);
    expect(() => loadConfig(writeConfig({ github: { requestTimeoutMs: 0 } }))).toThrow(/config\.github\.requestTimeoutMs/);
  });

  it("rejects a review workRoot inside the live repository checkout", () => {
    expect(() => loadConfig(writeConfig({
      workRoot: join(process.cwd(), "runtime")
    }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
  });

  it("rejects a review workRoot symlinked into the live repository checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-runtime-"));
    roots.push(root);
    const link = join(root, "runtime-link");
    symlinkSync(process.cwd(), link, "dir");

    expect(() => loadConfig(writeConfig({
      workRoot: link
    }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
  });

  it("rejects a review workRoot inside an explicit protected checkout root", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-protected-"));
    roots.push(root);
    const protectedRoot = join(root, "operator-checkout");
    const oldProtectedRoot = process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;
    process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT = protectedRoot;

    try {
      expect(() => loadConfig(writeConfig({
        workRoot: join(protectedRoot, "runtime")
      }))).toThrow(/config\.workRoot must be outside the current repository checkout/);
    } finally {
      if (oldProtectedRoot === undefined) {
        delete process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT;
      } else {
        process.env.EVAOS_REVIEW_BOT_PROTECTED_CHECKOUT_ROOT = oldProtectedRoot;
      }
    }
  });

  it("allows reviews when workRoot is outside the live repository checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-runtime-"));
    roots.push(root);

    const config = loadConfig(writeConfig({
      workRoot: join(root, "runtime")
    }));

    expect(config.workRoot).toBe(join(root, "runtime"));
  });

  function writeConfig(overlay: Record<string, unknown>): string {
    const root = mkdtempSync(join(tmpdir(), "evaos-review-scheduler-config-"));
    roots.push(root);
    const path = join(root, "config.json");
    writeFileSync(path, `${JSON.stringify(overlay)}\n`);
    return path;
  }
});
