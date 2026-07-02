import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { isPreActivationExistingPull } from "../src/activation-policy.js";
import { ReviewStateStore } from "../src/state.js";
import type { PullRequestSummary } from "../src/types.js";
import { activateRepoForNewOnlyReview } from "../src/worker.js";

describe("new-only repo activation", () => {
  const roots: string[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("baselines existing open PR heads only on first repo activation", () => {
    const store = createStore(roots);
    const repo = "electricsheephq/WorldOS";
    const pulls = [pull(1161, "old-head"), pull(1185, "old-draft-head", true)];

    const first = activateRepoForNewOnlyReview({
      config: newOnlyConfig(),
      state: store,
      repo,
      pulls,
      now: new Date("2026-07-01T00:00:00.000Z")
    });
    const second = activateRepoForNewOnlyReview({
      config: newOnlyConfig(),
      state: store,
      repo,
      pulls,
      now: new Date("2026-07-01T00:01:00.000Z")
    });

    expect(first).toEqual({ activated: true, baselined: 1 });
    expect(second).toEqual({ activated: false, baselined: 0 });
    expect(store.hasRepoActivation(repo)).toBe(true);
    expect(store.hasProcessed(repo, 1161, "old-head")).toBe(true);
    expect(store.hasProcessed(repo, 1185, "old-draft-head")).toBe(false);
    expect(store.hasProcessed(repo, 1190, "future-head")).toBe(false);
    store.close();
  });

  it("does not baseline canary or explicit PR runs", () => {
    const store = createStore(roots);
    const repo = "100yenadmin/evaOS-GUI";
    const pulls = [pull(497, "canary-head")];

    const canary = activateRepoForNewOnlyReview({
      config: newOnlyConfig({ canaryPulls: [`${repo}#497`] }),
      state: store,
      repo,
      pulls
    });
    const explicit = activateRepoForNewOnlyReview({
      config: newOnlyConfig(),
      state: store,
      repo,
      pulls,
      scopedPullNumber: 497
    });

    expect(canary).toEqual({ activated: false, baselined: 0 });
    expect(explicit).toEqual({ activated: false, baselined: 0 });
    expect(store.hasRepoActivation(repo)).toBe(false);
    expect(store.hasProcessed(repo, 497, "canary-head")).toBe(false);
    store.close();
  });

  it("scopes canary activation bypass to the current repository", () => {
    const store = createStore(roots);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";

    const result = activateRepoForNewOnlyReview({
      config: newOnlyConfig({ canaryPulls: ["electricsheephq/WorldOS#1161"] }),
      state: store,
      repo,
      pulls: [pull(64, "existing-head")]
    });

    expect(result).toEqual({ activated: true, baselined: 1 });
    expect(store.hasRepoActivation(repo)).toBe(true);
    expect(store.hasProcessed(repo, 64, "existing-head")).toBe(true);
    store.close();
  });

  it("does not overwrite existing processed review rows during activation", () => {
    const records: unknown[] = [];
    const result = activateRepoForNewOnlyReview({
      config: newOnlyConfig(),
      state: {
        hasProcessed: (_repo: string, pullNumber: number) => pullNumber === 1161,
        hasRepoActivation: () => false,
        recordProcessed: (record: unknown) => records.push(record),
        recordRepoActivation: () => undefined
      },
      repo: "electricsheephq/WorldOS",
      pulls: [pull(1161, "already-reviewed"), pull(1190, "old-unreviewed")]
    });

    expect(result).toEqual({ activated: true, baselined: 1 });
    expect(records).toEqual([
      expect.objectContaining({
        pullNumber: 1190,
        headSha: "old-unreviewed",
        status: "skipped"
      })
    ]);
  });

  it("can intentionally review existing open PR heads when configured", () => {
    const store = createStore(roots);
    const repo = "100yenadmin/Lossless-Codex-Orchestrator-LCO";

    const result = activateRepoForNewOnlyReview({
      config: newOnlyConfig({ reviewExistingOpenPrsOnActivation: true }),
      state: store,
      repo,
      pulls: [pull(64, "existing-head")]
    });

    expect(result).toEqual({ activated: true, baselined: 0 });
    expect(store.hasRepoActivation(repo)).toBe(true);
    expect(store.hasProcessed(repo, 64, "existing-head")).toBe(false);
    store.close();
  });
});

describe("pre-activation pull detection", () => {
  it("treats reviewExistingOpenPrsOnActivation=true as an explicit override", () => {
    expect(isPreActivationExistingPull({
      config: newOnlyConfig({ reviewExistingOpenPrsOnActivation: true }),
      state: baselinedState("2026-07-02T16:58:09.555Z"),
      repo: "Martian-Engineering/lossless-claw",
      pull: pull(950, "new-head", false, "2026-06-30T05:34:43Z")
    })).toBe(false);
  });

  it("fails open when activation or pull dates are unavailable or invalid", () => {
    const config = newOnlyConfig({ reviewExistingOpenPrsOnActivation: false });
    const repo = "Martian-Engineering/lossless-claw";

    expect(isPreActivationExistingPull({
      config,
      state: { getRepoActivation: () => undefined },
      repo,
      pull: pull(950, "new-head", false, "2026-06-30T05:34:43Z")
    })).toBe(false);
    expect(isPreActivationExistingPull({
      config,
      state: baselinedState("2026-07-02T16:58:09.555Z"),
      repo,
      pull: pull(950, "new-head")
    })).toBe(false);
    expect(isPreActivationExistingPull({
      config,
      state: { getRepoActivation: () => ({ activatedAt: "not-a-date" }) },
      repo,
      pull: pull(950, "new-head", false, "2026-06-30T05:34:43Z")
    })).toBe(false);
    expect(isPreActivationExistingPull({
      config,
      state: baselinedState("2026-07-02T16:58:09.555Z"),
      repo,
      pull: pull(950, "new-head", false, "not-a-date")
    })).toBe(false);
  });

  it("fails open when no activation-baseline row proves the pull existed at activation", () => {
    expect(isPreActivationExistingPull({
      config: newOnlyConfig({ reviewExistingOpenPrsOnActivation: false }),
      state: {
        getRepoActivation: () => ({ activatedAt: "2026-07-02T16:58:09.555Z" }),
        listProcessedReviewsForPull: () => []
      },
      repo: "Martian-Engineering/lossless-claw",
      pull: pull(960, "new-head", false, "2026-07-02T16:58:08.000Z")
    })).toBe(false);
  });

  it("detects PRs created before activation when new-only review is active", () => {
    expect(isPreActivationExistingPull({
      config: newOnlyConfig({ reviewExistingOpenPrsOnActivation: false }),
      state: baselinedState("2026-07-02T16:58:09.555Z"),
      repo: "Martian-Engineering/lossless-claw",
      pull: pull(950, "new-head", false, "2026-06-30T05:34:43Z")
    })).toBe(true);
  });
});

function createStore(roots: string[]): ReviewStateStore {
  const root = mkdtempSync(join(tmpdir(), "evaos-review-activation-"));
  roots.push(root);
  return new ReviewStateStore(join(root, "state.sqlite"));
}

function newOnlyConfig(overrides: {
  canaryPulls?: string[];
  reviewExistingOpenPrsOnActivation?: boolean;
} = {}) {
  return {
    skipDrafts: true,
    canaryPulls: overrides.canaryPulls,
    activation: {
      reviewExistingOpenPrsOnActivation: overrides.reviewExistingOpenPrsOnActivation ?? false
    }
  };
}

function baselinedState(activatedAt: string) {
  return {
    getRepoActivation: () => ({ activatedAt }),
    listProcessedReviewsForPull: () => [
      {
        status: "skipped",
        error: "activation_baseline_existing_head"
      }
    ]
  };
}

function pull(number: number, sha: string, draft = false, createdAt?: string): PullRequestSummary {
  return {
    number,
    title: `PR ${number}`,
    draft,
    ...(createdAt ? { created_at: createdAt } : {}),
    head: {
      sha,
      ref: `pr-${number}`
    },
    base: {
      sha: "base",
      ref: "main",
      repo: {
        full_name: "owner/repo"
      }
    },
    html_url: `https://github.test/owner/repo/pull/${number}`
  };
}
