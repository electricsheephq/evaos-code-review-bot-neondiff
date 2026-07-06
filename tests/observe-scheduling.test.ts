import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { ReviewStateStore, type ReviewFindingRecord } from "../src/state.js";
import {
  recordPostedReviewFindings
} from "../src/worker.js";
import {
  runScheduledObservePass,
  type ObservedPullOutcome,
  type ScheduledObserveTarget
} from "../src/outcome-observer.js";
import { observeScheduledOutcomes, type SchedulerGitHubApi } from "../src/scheduler.js";
import type { PullRequestSummary, ReviewComment } from "../src/types.js";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function newStore(): { store: ReviewStateStore; root: string } {
  const root = mkdtempSync(join(tmpdir(), "evaos-observe-sched-"));
  roots.push(root);
  return { store: new ReviewStateStore(join(root, "state.sqlite")), root };
}

function baseConfigObject(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    pilotRepos: ["owner/repo"],
    workRoot: "/tmp/runtime",
    statePath: "/tmp/state.sqlite",
    evidenceDir: "/tmp/evidence",
    ...overrides
  };
}

const OBSERVE_SCHEDULE = {
  enabled: true,
  intervalMinutes: 60,
  maxPullsPerCycle: 2,
  perRepoCooldownMinutes: 720,
  lookbackDays: 30
};

const FINDING: ReviewFindingRecord = {
  fingerprint: `finding:${"a".repeat(64)}`,
  repo: "owner/repo",
  pullNumber: 1,
  headSha: "sha1",
  path: "src/save.ts",
  line: 42,
  severity: "P1",
  category: "data_loss",
  confidence: 0.9,
  recordedAt: "2026-07-06T00:00:00.000Z"
};

function fullObserved(overrides: Partial<ObservedPullOutcome>): ObservedPullOutcome {
  return {
    merged: true,
    revertedFlaggedChange: false,
    hotfixLines: new Map(),
    mergedFixLines: new Map(),
    humanThreadResolved: false,
    ...overrides
  };
}

describe("calibrationLoop.observeSchedule config validation (#357)", () => {
  it("is absent by default and validates a fully-specified block", () => {
    expect(loadConfigFromObject(baseConfigObject()).calibrationLoop).toBeUndefined();
    const config = loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } }));
    expect(config.calibrationLoop?.observeSchedule).toMatchObject({ enabled: true, intervalMinutes: 60 });
  });

  it("rejects unknown keys (fail-closed) on both the loop and the schedule", () => {
    expect(() => loadConfigFromObject(baseConfigObject({ calibrationLoop: { promote: true } }))).toThrow(/unknown key "promote"/);
    expect(() =>
      loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, autoPromote: true } } }))
    ).toThrow(/unknown key "autoPromote"/);
  });

  it("rejects a non-boolean enabled and non-positive integers", () => {
    expect(() =>
      loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, enabled: "yes" } } }))
    ).toThrow(/enabled/);
    expect(() =>
      loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, intervalMinutes: 0 } } }))
    ).toThrow(/intervalMinutes/);
    expect(() =>
      loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, lookbackDays: -1 } } }))
    ).toThrow(/lookbackDays/);
  });
});

describe("findings-ledger recording is fail-open (#357)", () => {
  const pull = { number: 1, head: { sha: "sha1" } } as PullRequestSummary;
  const comment: ReviewComment = {
    path: "src/save.ts",
    line: 42,
    side: "RIGHT",
    body: "loses data",
    severity: "P1",
    category: "data_loss",
    confidence: 0.9,
    title: "Data loss on save"
  };

  it("records posted findings into review_findings", () => {
    const { store } = newStore();
    recordPostedReviewFindings({ state: store, repo: "owner/repo", pull, comments: [comment] });
    const rows = store.listReviewFindings({});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ repo: "owner/repo", pullNumber: 1, headSha: "sha1", path: "src/save.ts", line: 42 });
    // Public-safe: no title/body text is persisted (only the fingerprint that encodes them).
    expect(JSON.stringify(rows[0])).not.toContain("Data loss on save");
    expect(JSON.stringify(rows[0])).not.toContain("loses data");
    store.close();
  });

  it("does NOT throw when the store's recordReviewFindings throws (review path is never blocked)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const throwingStore = {
      recordReviewFindings: () => {
        throw new Error("db is locked");
      }
    };
    expect(() =>
      recordPostedReviewFindings({ state: throwingStore, repo: "owner/repo", pull, comments: [comment] })
    ).not.toThrow();
    expect(warn).toHaveBeenCalled();
  });
});

describe("runScheduledObservePass gating + selection (#357)", () => {
  it("disabled ⇒ byte-identical no-op: never calls the observer, records nothing, writes no evidence", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const fetchOutcome = vi.fn<(target: ScheduledObserveTarget) => ObservedPullOutcome>();

    const result = await runScheduledObservePass({
      state: store,
      config: undefined,
      evidenceDir: join(root, "evidence"),
      fetchOutcome
    });

    expect(result).toMatchObject({ ran: false, reason: "disabled" });
    expect(fetchOutcome).not.toHaveBeenCalled();
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    expect(store.getCalibrationObserveAt("__global__")).toBeUndefined();
    store.close();
  });

  it("not-due ⇒ no observer calls when within the interval", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const now = new Date("2026-07-06T02:00:00.000Z");
    store.recordCalibrationObserveAt("__global__", "2026-07-06T01:30:00.000Z"); // 30 min ago; interval 60
    const fetchOutcome = vi.fn<(target: ScheduledObserveTarget) => ObservedPullOutcome>();

    const result = await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome,
      now
    });

    expect(result).toMatchObject({ ran: false, reason: "not_due" });
    expect(fetchOutcome).not.toHaveBeenCalled();
    store.close();
  });

  it("records outcome labels for a merged candidate and advances schedule state", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const now = new Date("2026-07-06T10:00:00.000Z");

    const result = await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome: () => fullObserved({ merged: true, revertedFlaggedChange: true }),
      now
    });

    expect(result).toMatchObject({ ran: true, reason: "observed", targets: 1, labeled: 1 });
    const labels = store.listFindingOutcomeLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ labelSource: "revert", verdict: "true_positive", fingerprint: FINDING.fingerprint });
    // Schedule bookkeeping updated for both the global interval and the observed repo cooldown.
    expect(store.getCalibrationObserveAt("__global__")).toBe(now.toISOString());
    expect(store.getCalibrationObserveAt("owner/repo")).toBe(now.toISOString());
    const packet = JSON.parse(readFileSync(join(root, "evidence", "calibration-observe.json"), "utf8"));
    expect(packet.observations[0]).toMatchObject({ repo: "owner/repo", pullNumber: 1, postMergeStatus: "reverted" });
    store.close();
  });

  it("caps at maxPullsPerCycle heads", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([
      { ...FINDING, pullNumber: 1, headSha: "sha1", fingerprint: `finding:${"a".repeat(64)}` },
      { ...FINDING, pullNumber: 2, headSha: "sha2", fingerprint: `finding:${"b".repeat(64)}` },
      { ...FINDING, pullNumber: 3, headSha: "sha3", fingerprint: `finding:${"c".repeat(64)}` }
    ]);
    const seen: number[] = [];

    const result = await runScheduledObservePass({
      state: store,
      config: { ...OBSERVE_SCHEDULE, maxPullsPerCycle: 2 },
      evidenceDir: join(root, "evidence"),
      fetchOutcome: (target) => {
        seen.push(target.pullNumber);
        return fullObserved({ merged: false });
      },
      now: new Date("2026-07-06T10:00:00.000Z")
    });

    expect(result.targets).toBe(2);
    expect(seen).toHaveLength(2);
    store.close();
  });

  it("skips a repo within per-repo cooldown", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const now = new Date("2026-07-06T10:00:00.000Z");
    // owner/repo observed 1h ago; cooldown is 720min ⇒ still cooling.
    store.recordCalibrationObserveAt("owner/repo", "2026-07-06T09:00:00.000Z");
    const fetchOutcome = vi.fn(() => fullObserved({ merged: false }));

    const result = await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome,
      now
    });

    expect(result.targets).toBe(0);
    expect(fetchOutcome).not.toHaveBeenCalled();
    store.close();
  });

  it("respects the lookback window (findings older than lookback are excluded)", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([{ ...FINDING, recordedAt: "2026-01-01T00:00:00.000Z" }]);
    const fetchOutcome = vi.fn(() => fullObserved({ merged: false }));

    const result = await runScheduledObservePass({
      state: store,
      config: { ...OBSERVE_SCHEDULE, lookbackDays: 7 },
      evidenceDir: join(root, "evidence"),
      fetchOutcome,
      now: new Date("2026-07-06T10:00:00.000Z")
    });

    expect(result.targets).toBe(0);
    expect(fetchOutcome).not.toHaveBeenCalled();
    store.close();
  });
});

describe("observeScheduledOutcomes scheduler wiring (#357)", () => {
  function stubGithub(): SchedulerGitHubApi & { getPull: ReturnType<typeof vi.fn> } {
    const getPull = vi.fn(async (repo: string, pullNumber: number) => ({
      number: pullNumber,
      head: { sha: `sha${pullNumber}` },
      merged_at: null
    }) as unknown as PullRequestSummary);
    return {
      listOpenPulls: async () => [],
      getPull,
      listIssueComments: async () => []
    };
  }

  it("disabled ⇒ zero GitHub reads (byte-identical daemon cycle)", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const github = stubGithub();
    const config = loadConfigFromObject(baseConfigObject());

    await observeScheduledOutcomes({ config, github, state: store, now: new Date("2026-07-06T10:00:00.000Z") });

    expect(github.getPull).not.toHaveBeenCalled();
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    store.close();
  });

  it("enabled ⇒ reads merge state read-only and records; never aggregates/promotes/writes config", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const github = stubGithub();
    github.getPull.mockResolvedValueOnce({
      number: 1,
      head: { sha: "sha1" },
      merged_at: "2026-07-05T00:00:00.000Z"
    } as unknown as PullRequestSummary);
    const config = loadConfigFromObject(
      baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } })
    );

    await observeScheduledOutcomes({ config, github, state: store, now: new Date("2026-07-06T10:00:00.000Z") });

    expect(github.getPull).toHaveBeenCalledWith("owner/repo", 1);
    // A merged PR with no additional signal derives none_observed (bounded reader).
    expect(store.listFindingOutcomeLabels()).toHaveLength(1);
    expect(store.getCalibrationObserveAt("__global__")).toBeDefined();
    store.close();
  });
});
