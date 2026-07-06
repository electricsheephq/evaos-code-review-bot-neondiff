import { describe, expect, it } from "vitest";
import { loadConfigFromObject, type BotConfig } from "../src/config.js";
import { resolveRiskWeightedPriorityOverride, riskWeightedQueuePriority, type SchedulerGitHubApi } from "../src/scheduler.js";
import { buildChangedSurfaceValidationReport } from "../src/validation-selector.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

function pull(): PullRequestSummary {
  return {
    number: 1,
    title: "PR",
    draft: false,
    head: { sha: "head", ref: "feature" },
    base: { sha: "base", ref: "main", repo: { full_name: "owner/repo" } },
    html_url: "https://example.invalid/owner/repo/pull/1"
  };
}

function report(files: PullFilePatch[]) {
  return buildChangedSurfaceValidationReport({ repo: "owner/repo", pull: pull(), files });
}

const AUTH_FILES: PullFilePatch[] = [{ filename: "src/auth/session.ts" }];
const DOCS_FILES: PullFilePatch[] = [{ filename: "docs/guide.md" }];

describe("risk-weighted queue priority (#301)", () => {
  it("keeps flat backgroundPriority for every tier when disabled (byte-identical)", () => {
    const config = loadConfigFromObject({ reviewScheduler: { backgroundPriority: 50 } });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });
    const docs = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(DOCS_FILES) });

    expect(auth.priority).toBe(50);
    expect(docs.priority).toBe(50);
    expect(auth.tier).toBe("default");
    expect(docs.tier).toBe("default");
  });

  it("elevates a required-validation surface above a docs-only surface when enabled", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: 70 }
    });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });
    const docs = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(DOCS_FILES) });

    // Lower number = leased sooner: the required-surface PR must outrank the docs-only PR.
    expect(auth.priority).toBe(20);
    expect(docs.priority).toBe(70);
    expect(auth.priority as number).toBeLessThan(docs.priority as number);
    expect(auth.tier).toBe("elevated");
    expect(docs.tier).toBe("docs_only");
    expect(auth.reason).toMatch(/risk/i);
  });

  it("falls back to backgroundPriority when enabled but no report is available", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: 70 }
    });

    const result = riskWeightedQueuePriority({ config, repo: "owner/repo" });

    expect(result.priority).toBe(50);
    expect(result.tier).toBe("default");
  });

  it("uses backgroundPriority defaults when elevated/docs priorities are unset but enabled", () => {
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true }
    });

    const auth = riskWeightedQueuePriority({ config, repo: "owner/repo", report: report(AUTH_FILES) });

    expect(auth.tier).toBe("elevated");
    expect(auth.priority).toBeLessThanOrEqual(50);
  });
});

describe("risk-weighted queue config (#301)", () => {
  it("defaults to disabled", () => {
    const config: BotConfig = loadConfigFromObject({});
    expect(config.riskWeightedQueue).toEqual({ enabled: false });
  });

  it("accepts explicit priorities", () => {
    const config = loadConfigFromObject({
      riskWeightedQueue: { enabled: true, elevatedPriority: 5, docsOnlyPriority: 80 }
    });
    expect(config.riskWeightedQueue).toEqual({ enabled: true, elevatedPriority: 5, docsOnlyPriority: 80 });
  });

  it("fails closed on a non-boolean enabled flag", () => {
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: "yes" } })).toThrow(
      /riskWeightedQueue\.enabled must be a boolean/
    );
  });

  it("fails closed on a negative or non-integer priority", () => {
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, elevatedPriority: -1 } })).toThrow(
      /riskWeightedQueue\.elevatedPriority must be a non-negative integer/
    );
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, docsOnlyPriority: 2.5 } })).toThrow(
      /riskWeightedQueue\.docsOnlyPriority must be a non-negative integer/
    );
  });

  it("fails closed when explicit priorities would lease docs-only before elevated work", () => {
    expect(() =>
      loadConfigFromObject({
        riskWeightedQueue: { enabled: true, elevatedPriority: 80, docsOnlyPriority: 20 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);
  });

  it("validates explicit priorities against default priority fallbacks", () => {
    expect(() =>
      loadConfigFromObject({
        reviewScheduler: { backgroundPriority: 50 },
        riskWeightedQueue: { enabled: true, elevatedPriority: 80 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);

    expect(() =>
      loadConfigFromObject({
        reviewScheduler: { backgroundPriority: 50 },
        riskWeightedQueue: { enabled: true, docsOnlyPriority: 5 }
      })
    ).toThrow(/riskWeightedQueue\.elevatedPriority must be <= .*docsOnlyPriority/);
  });

  it("defaults aging unset (byte-identical to today) and accepts the recommended aging config (#346)", () => {
    expect(loadConfigFromObject({}).riskWeightedQueue?.aging).toBeUndefined();
    // Recommended #346 config (lower number = leases sooner, so elevated < docsOnly per #301 validator).
    const config = loadConfigFromObject({
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: 50, aging: { enabled: true, maxWaitMinutes: 60 } }
    });
    expect(config.riskWeightedQueue?.aging).toEqual({ enabled: true, maxWaitMinutes: 60 });
  });

  it("fails closed on malformed aging config (#346)", () => {
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, aging: { enabled: "yes", maxWaitMinutes: 60 } } })).toThrow(
      /riskWeightedQueue\.aging\.enabled must be a boolean/
    );
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, aging: { enabled: true, maxWaitMinutes: 0 } } })).toThrow(
      /riskWeightedQueue\.aging\.maxWaitMinutes must be a positive integer/
    );
    expect(() => loadConfigFromObject({ riskWeightedQueue: { enabled: true, aging: { enabled: true, maxWaitMinutes: 60, bogus: 1 } } })).toThrow(
      /riskWeightedQueue\.aging has unknown key "bogus"/
    );
  });
});

describe("resolveRiskWeightedPriorityOverride integration (#301 review follow-up)", () => {
  function enabledConfig(): BotConfig {
    return loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 5, docsOnlyPriority: 80 }
    });
  }

  function githubWith(listPullFiles: SchedulerGitHubApi["listPullFiles"]): SchedulerGitHubApi {
    // Only the surface resolveRiskWeightedPriorityOverride touches; cast keeps the stub honest for
    // the rest of the SchedulerGitHubApi contract without implementing unrelated methods.
    return { listPullFiles } as unknown as SchedulerGitHubApi;
  }

  it("fetches changed files and elevates a required-validation PR", async () => {
    const calls: Array<[string, number]> = [];
    const override = await resolveRiskWeightedPriorityOverride({
      config: enabledConfig(),
      github: githubWith(async (repo, pullNumber) => {
        calls.push([repo, pullNumber]);
        return AUTH_FILES;
      }),
      repo: "owner/repo",
      pull: pull()
    });

    expect(calls).toEqual([["owner/repo", 1]]);
    expect(override).toBe(5);
  });

  it("defers a docs-only PR via the configured docsOnlyPriority", async () => {
    const override = await resolveRiskWeightedPriorityOverride({
      config: enabledConfig(),
      github: githubWith(async () => DOCS_FILES),
      repo: "owner/repo",
      pull: pull()
    });

    expect(override).toBe(80);
  });

  it("falls back to flat priority (undefined) when the file fetch fails, without throwing", async () => {
    const override = await resolveRiskWeightedPriorityOverride({
      config: enabledConfig(),
      github: githubWith(async () => {
        // Constructed via join so the repo's own secret scan doesn't trip on a literal token shape.
        throw new Error(`boom: token=${["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_")}`);
      }),
      repo: "owner/repo",
      pull: pull()
    });

    expect(override).toBeUndefined();
  });

  it("never calls listPullFiles when the feature is disabled or the API lacks the method", async () => {
    let called = 0;
    const disabled = await resolveRiskWeightedPriorityOverride({
      config: loadConfigFromObject({ reviewScheduler: { backgroundPriority: 50 } }),
      github: githubWith(async () => {
        called += 1;
        return AUTH_FILES;
      }),
      repo: "owner/repo",
      pull: pull()
    });
    const noMethod = await resolveRiskWeightedPriorityOverride({
      config: enabledConfig(),
      github: {} as unknown as SchedulerGitHubApi,
      repo: "owner/repo",
      pull: pull()
    });

    expect(called).toBe(0);
    expect(disabled).toBeUndefined();
    expect(noMethod).toBeUndefined();
  });

  it("elevates via repo-implied risk through the full fetch->report->tier path", async () => {
    // buildChangedSurfaceValidationReport marks WorldOS-named repos as Unity-runtime risk even
    // without Unity paths in the diff — exercising the resolve->report->tier integration end to
    // end. (The resolved repo profile itself only populates advisory profileHints, which cannot
    // affect tier; its pass-through is covered by the pure report tests.)
    const config = loadConfigFromObject({
      reviewScheduler: { backgroundPriority: 50 },
      riskWeightedQueue: { enabled: true, elevatedPriority: 5 },
      repos: { "electricsheephq/worldos": {} }
    });
    const override = await resolveRiskWeightedPriorityOverride({
      config,
      github: githubWith(async () => [{ filename: "src/engine/turn.ts" }]),
      repo: "electricsheephq/WorldOS",
      pull: pull()
    });

    expect(override).toBe(5);
  });
});
