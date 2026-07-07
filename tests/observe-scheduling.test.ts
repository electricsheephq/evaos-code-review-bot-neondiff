import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromObject } from "../src/config.js";
import { ReviewStateStore, type ReviewFindingRecord } from "../src/state.js";
import {
  localDateFolder,
  recordPostedReviewFindings
} from "../src/worker.js";
import {
  buildObservedPullOutcome,
  runOutcomeObserverFromInput,
  runScheduledObservePass,
  type ObservedFinding,
  type ObservedPullOutcome,
  type ScheduledObserveTarget
} from "../src/outcome-observer.js";
import { observeScheduledOutcomes, type SchedulerGitHubApi } from "../src/scheduler.js";
import { applyDeterministicReviewGate, buildFindingFingerprint } from "../src/review-gate.js";
import type { Finding, PullFilePatch, PullRequestSummary, PullReviewComment, ReviewComment } from "../src/types.js";

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
    title: "Data loss on save",
    fingerprint: `finding:${"a".repeat(64)}`
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

  it("ledger fingerprint EQUALS the gate/finding_outcome_labels fingerprint (end-to-end join works)", () => {
    // A finding whose why_this_matters is load-bearing for the fingerprint: recomputing the hash from
    // the sanitized ReviewComment (no why_this_matters, public title/body) would produce a DIFFERENT
    // key. This test pins that the ledger stores the SAME fingerprint the observe→label path uses.
    const finding: Finding = {
      severity: "P1",
      path: "src/save.ts",
      line: 42,
      title: "Data loss on save",
      body: "overwriteAllData() clobbers the file before the retry lands",
      confidence: 0.9,
      category: "data_loss",
      why_this_matters: "silent, unrecoverable user data loss on the common save path"
    };
    const files: PullFilePatch[] = [
      { filename: "src/save.ts", patch: "@@ -40,2 +40,3 @@\n export function save() {\n+  overwriteAllData();\n }" }
    ];
    const gate = applyDeterministicReviewGate({ findings: [finding], files });
    expect(gate.comments).toHaveLength(1);

    const { store } = newStore();
    recordPostedReviewFindings({
      state: store,
      repo: "owner/repo",
      pull: { number: 1, head: { sha: "sha1" } } as PullRequestSummary,
      comments: gate.comments
    });

    const expected = buildFindingFingerprint(finding); // the key finding_outcome_labels uses
    const ledgerFingerprint = store.listReviewFindings({})[0]?.fingerprint;
    expect(ledgerFingerprint).toBe(expected);

    // Guard against regression to the lossy recompute: hashing the sanitized comment (no
    // why_this_matters) yields a DIFFERENT fingerprint, which is exactly what we must NOT store.
    const lossy = buildFindingFingerprint({
      severity: gate.comments[0].severity,
      path: gate.comments[0].path,
      line: gate.comments[0].line,
      title: gate.comments[0].title,
      body: gate.comments[0].body,
      category: gate.comments[0].category
    });
    expect(ledgerFingerprint).not.toBe(lossy);
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

  it("does NOT advance a repo's cooldown for a selected-but-UNMERGED target (re-observable next cycle)", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const now = new Date("2026-07-06T10:00:00.000Z");

    const result = await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome: () => fullObserved({ merged: false }), // selected, read, but not yet merged
      now
    });

    // The target was selected + read (so the global check-clock advances) but produced NO label,
    // so the repo cooldown must NOT advance — otherwise we'd delay re-observing until it merges.
    expect(result).toMatchObject({ ran: true, targets: 1, labeled: 0 });
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    expect(store.getCalibrationObserveAt("__global__")).toBe(now.toISOString());
    expect(store.getCalibrationObserveAt("owner/repo")).toBeUndefined();
    store.close();
  });

  it("DOES advance a repo's cooldown for a merged+observed target (a label was recorded)", async () => {
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

    expect(result).toMatchObject({ ran: true, targets: 1, labeled: 1 });
    expect(store.getCalibrationObserveAt("owner/repo")).toBe(now.toISOString());
    store.close();
  });

  it("cap interacts with multi-repo cooldown: cooled heads are skipped WITHOUT consuming a slot, cap applies across the post-cooldown set", async () => {
    const { store, root } = newStore();
    const now = new Date("2026-07-06T10:00:00.000Z");
    // repoA is in cooldown (observed 1h ago, 720min cooldown); repoB and repoC are eligible.
    // Order the ledger so the cooled repoA head is encountered FIRST — it must not eat a slot, and
    // with maxPullsPerCycle=2 both eligible heads (B and C) must still be selected.
    store.recordCalibrationObserveAt("owner/repoA", "2026-07-06T09:00:00.000Z");
    store.recordReviewFindings([
      { ...FINDING, repo: "owner/repoA", pullNumber: 1, headSha: "shaA", fingerprint: `finding:${"a".repeat(64)}`, recordedAt: "2026-07-06T09:59:59.000Z" },
      { ...FINDING, repo: "owner/repoB", pullNumber: 2, headSha: "shaB", fingerprint: `finding:${"b".repeat(64)}`, recordedAt: "2026-07-06T09:59:58.000Z" },
      { ...FINDING, repo: "owner/repoC", pullNumber: 3, headSha: "shaC", fingerprint: `finding:${"c".repeat(64)}`, recordedAt: "2026-07-06T09:59:57.000Z" }
    ]);
    const observedRepos: string[] = [];

    const result = await runScheduledObservePass({
      state: store,
      config: { ...OBSERVE_SCHEDULE, maxPullsPerCycle: 2 },
      evidenceDir: join(root, "evidence"),
      fetchOutcome: (target) => {
        observedRepos.push(target.repo);
        return fullObserved({ merged: false });
      },
      now
    });

    expect(result.targets).toBe(2);
    // The cooled repoA is absent; the two eligible repos consumed the two slots.
    expect(observedRepos.sort()).toEqual(["owner/repoB", "owner/repoC"]);
    store.close();
  });

  it("advances the global interval clock on a ZERO-target due pass (intervalMinutes is a check cadence)", async () => {
    const { store, root } = newStore();
    // A due pass with nothing to observe (no findings at all). The clock must still advance so a
    // barren cycle waits a full interval before re-checking rather than re-querying every tick.
    const now = new Date("2026-07-06T10:00:00.000Z");
    expect(store.getCalibrationObserveAt("__global__")).toBeUndefined();

    const result = await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome: () => fullObserved({ merged: false }),
      now
    });

    expect(result).toMatchObject({ ran: true, targets: 0, labeled: 0 });
    expect(store.getCalibrationObserveAt("__global__")).toBe(now.toISOString());
    store.close();
  });

  it("redacts secret-shaped CONTENT in the written evidence packet, not just its structure", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const token = ["ghp", "x".repeat(36)].join("_");

    await runScheduledObservePass({
      state: store,
      config: OBSERVE_SCHEDULE,
      evidenceDir: join(root, "evidence"),
      fetchOutcome: () => fullObserved({ merged: true, revertedFlaggedChange: true, evidenceRef: `revert ${token}` }),
      now: new Date("2026-07-06T10:00:00.000Z")
    });

    const raw = readFileSync(join(root, "evidence", "calibration-observe.json"), "utf8");
    expect(raw).toContain("revert"); // the observation surfaced
    expect(raw).not.toContain(token); // ...but the secret-shaped token was redacted
    // And the token never reached the persisted label evidenceRef either.
    expect(JSON.stringify(store.listFindingOutcomeLabels())).not.toContain(token);
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

  it("is fail-open: a throwing observe pass never propagates out of the daemon cycle", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    // getPull throws INSIDE runScheduledObservePass (at the fetchOutcome boundary) with a secret-shaped
    // token in the message; observeScheduledOutcomes must swallow it (never disturb the review cycle)
    // and redact the token in the warning.
    const token = ["ghp", "z".repeat(36)].join("_");
    const github: SchedulerGitHubApi = {
      listOpenPulls: async () => [],
      getPull: async () => {
        throw new Error(`boom ${token}`);
      },
      listIssueComments: async () => []
    };
    const config = loadConfigFromObject(
      baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } })
    );

    await expect(
      observeScheduledOutcomes({ config, github, state: store, now: new Date("2026-07-06T10:00:00.000Z") })
    ).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain(token);
    store.close();
  });

  it("exercises the PRODUCTION deriveOutcomeLabel path end-to-end (merged getPull ⇒ recorded label)", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const github = stubGithub();
    // Real merged PR shape flowing through the production fetchOutcome ⇒ deriveOutcomeLabel. The
    // bounded reader supplies no revert/hotfix/merged-fix signal, so the honest derived label is
    // none_observed / unvalidated (a merged PR with no post-merge evidence).
    github.getPull.mockResolvedValueOnce({
      number: 1,
      head: { sha: "sha1" },
      merged_at: "2026-07-05T00:00:00.000Z"
    } as unknown as PullRequestSummary);
    const config = loadConfigFromObject(
      baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } })
    );

    await observeScheduledOutcomes({ config, github, state: store, now: new Date("2026-07-06T10:00:00.000Z") });

    const labels = store.listFindingOutcomeLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({
      fingerprint: FINDING.fingerprint,
      labelSource: "none_observed",
      verdict: "unvalidated"
    });
    store.close();
  });

  it("writes the evidence packet under the SAME date the observe pass timestamps (single now)", async () => {
    const { store, root } = newStore();
    store.recordReviewFindings([FINDING]);
    const github = stubGithub();
    github.getPull.mockResolvedValueOnce({
      number: 1,
      head: { sha: "sha1" },
      merged_at: "2026-07-05T00:00:00.000Z"
    } as unknown as PullRequestSummary);
    // evidenceDir is config.evidenceDir/<localDateFolder(now)>/calibration-observe. Use a fixed now
    // and assert the folder and the packet's observedAt derive from that same instant.
    const now = new Date("2026-07-06T10:00:00.000Z");
    const config = loadConfigFromObject(
      baseConfigObject({ evidenceDir: join(root, "evidence"), calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } })
    );

    await observeScheduledOutcomes({ config, github, state: store, now });

    const dateFolder = localDateFolder(now);
    const packetPath = join(root, "evidence", dateFolder, "calibration-observe", "calibration-observe.json");
    const packet = JSON.parse(readFileSync(packetPath, "utf8"));
    // The packet's observedAt is the same instant that named the date folder.
    expect(localDateFolder(new Date(packet.observedAt))).toBe(dateFolder);
    expect(packet.observedAt).toBe(now.toISOString());
    store.close();
  });
});

// ---------------------------------------------------------------------------------------------------
// #371: deepen scheduled observation to revert / hotfix-line-touch / human-thread signals.
// ---------------------------------------------------------------------------------------------------

const OBSERVED_FINDING: ObservedFinding = {
  fingerprint: FINDING.fingerprint,
  path: FINDING.path,
  line: FINDING.line,
  severity: "P1",
  category: "data_loss",
  confidence: 0.9
};

// A merged fix / hotfix diff that touches the flagged line (src/save.ts:42) via a +line at 42.
const HOTFIX_FILES: PullFilePatch[] = [
  { filename: "src/save.ts", patch: "@@ -40,3 +40,4 @@\n export function save() {\n+  flushBeforeOverwrite();\n   overwriteAllData();\n }" }
];
// A human reply thread on the finding's path/line — the false-positive dismissal signal.
const HUMAN_THREAD: PullReviewComment[] = [
  { id: 10, path: "src/save.ts", line: 42, in_reply_to_id: 9, user: { login: "maintainer", type: "User" } }
];

/**
 * Build a hermetic scheduler GitHub stub exposing the deeper-observation read surface (#371). The
 * target merged PR is #1@sha1; `subsequent` are later merged PRs (revert / hotfix) the reader scans.
 */
function deepGithub(input: {
  merged?: boolean;
  mergeCommitSha?: string;
  pullTitle?: string;
  targetMergedAt?: string;
  subsequent?: Array<{ number: number; title?: string; body?: string; files?: PullFilePatch[]; mergedAt?: string }>;
  reviewComments?: PullReviewComment[];
}): SchedulerGitHubApi {
  const subsequent = input.subsequent ?? [];
  return {
    listOpenPulls: async () => [],
    listIssueComments: async () => [],
    getPull: async (_repo, pullNumber) =>
      ({
        number: pullNumber,
        title: input.pullTitle ?? "Add save path",
        head: { sha: `sha${pullNumber}` },
        merged_at: (input.merged ?? true) ? (input.targetMergedAt ?? "2026-07-05T00:00:00.000Z") : null,
        merge_commit_sha: input.mergeCommitSha ?? "mergesha1"
      }) as unknown as PullRequestSummary,
    listRecentMergedPulls: async () =>
      subsequent.map(
        (pull) =>
          ({
            number: pull.number,
            title: pull.title ?? "",
            body: pull.body ?? "",
            head: { sha: `sha${pull.number}` },
            // Subsequent PRs default to AFTER the target's merge (12:00 > 00:00); a test may set a
            // BEFORE time to exercise the temporal guard.
            merged_at: pull.mergedAt ?? "2026-07-05T12:00:00.000Z"
          }) as unknown as PullRequestSummary
      ),
    listPullFiles: async (_repo, pullNumber) => subsequent.find((pull) => pull.number === pullNumber)?.files ?? [],
    listPullReviewComments: async () => input.reviewComments ?? []
  };
}

describe("buildObservedPullOutcome enrichment (#371)", () => {
  it("detects a revert PR that back-references the original PR number", () => {
    const observed = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "Add save path",
      mergeCommitSha: "mergesha1",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [{ pullNumber: 2, title: 'Revert "Add save path" (#1)', body: "", changedLines: new Map() }],
      reviewComments: []
    });
    expect(observed.revertedFlaggedChange).toBe(true);
  });

  it("detects a revert via `This reverts commit <merge_commit_sha>` body", () => {
    const observed = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "Add save path",
      mergeCommitSha: "mergesha1",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [{ pullNumber: 2, title: "Revert regression", body: "This reverts commit mergesha1.", changedLines: new Map() }],
      reviewComments: []
    });
    expect(observed.revertedFlaggedChange).toBe(true);
  });

  it("revert `Reverts #n` body construction matches; an incidental `#n` mention does NOT (correctness)", () => {
    const revertsBody = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "Add save path",
      findings: [OBSERVED_FINDING],
      // Revert-shaped title but NO title/sha back-ref; the only PR reference is the `Reverts #1` line.
      subsequentPulls: [{ pullNumber: 2, title: "Revert regression", body: "Reverts owner/repo#1", changedLines: new Map() }],
      reviewComments: []
    });
    expect(revertsBody.revertedFlaggedChange).toBe(true);

    const incidentalMention = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "Add save path",
      findings: [OBSERVED_FINDING],
      // A revert-shaped PR that reverts something ELSE but merely mentions #1 in prose must NOT match.
      subsequentPulls: [{ pullNumber: 2, title: "Revert unrelated change", body: "See #1 for prior context.", changedLines: new Map() }],
      reviewComments: []
    });
    expect(incidentalMention.revertedFlaggedChange).toBe(false);
  });

  it("does NOT treat the PR as its own revert/hotfix, and ignores unrelated later PRs", () => {
    const observed = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "Add save path",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [{ pullNumber: 1, title: 'Revert "Add save path" (#1)', body: "", changedLines: new Map() }],
      reviewComments: []
    });
    expect(observed.revertedFlaggedChange).toBe(false);
    expect(observed.hotfixLines.size).toBe(0);
  });

  it("temporal guard: a PR merged BEFORE the target is NOT counted as a revert or a hotfix", () => {
    const hotfixLines = new Map([["src/save.ts", new Set([42])]]);
    const priorMerged = buildObservedPullOutcome({
      merged: true,
      mergedAt: "2026-07-05T00:00:00.000Z",
      pullNumber: 1,
      pullTitle: "Add save path",
      mergeCommitSha: "mergesha1",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [
        // Merged an hour BEFORE the target — cannot be its post-merge revert/fix even though its title
        // reverts it and its diff touches the flagged line.
        { pullNumber: 2, title: 'Revert "Add save path" (#1)', body: "This reverts commit mergesha1.", mergedAt: "2026-07-04T23:00:00.000Z", changedLines: hotfixLines }
      ],
      reviewComments: []
    });
    expect(priorMerged.revertedFlaggedChange).toBe(false);
    expect(priorMerged.hotfixLines.size).toBe(0);

    // The SAME candidate merged AFTER the target IS counted (guard is strictly-after, not a blanket skip).
    const laterMerged = buildObservedPullOutcome({
      merged: true,
      mergedAt: "2026-07-05T00:00:00.000Z",
      pullNumber: 1,
      pullTitle: "Add save path",
      mergeCommitSha: "mergesha1",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [
        { pullNumber: 2, title: 'Revert "Add save path" (#1)', body: "", mergedAt: "2026-07-05T01:00:00.000Z", changedLines: new Map() }
      ],
      reviewComments: []
    });
    expect(laterMerged.revertedFlaggedChange).toBe(true);
  });

  it("revert title must be the EXACT `Revert \"<title>\"` construction, not a loose substring", () => {
    // Target title is a substring of the candidate's reverted title — the loose `includes` would have
    // false-matched; the exact-construction match must reject it.
    const substringFalseMatch = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "save",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [{ pullNumber: 2, title: 'Revert "add safe save path"', body: "", changedLines: new Map() }],
      reviewComments: []
    });
    expect(substringFalseMatch.revertedFlaggedChange).toBe(false);

    // The exact default construction (optionally with a (#n) tail) matches.
    const exactMatch = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      pullTitle: "save",
      findings: [OBSERVED_FINDING],
      subsequentPulls: [{ pullNumber: 2, title: 'Revert "save" (#1)', body: "", changedLines: new Map() }],
      reviewComments: []
    });
    expect(exactMatch.revertedFlaggedChange).toBe(true);
  });

  it("bot-login defensiveness: a bot reply with a MISSING type but matching botLogin is not a human thread", () => {
    const botReplyMissingType = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      findings: [OBSERVED_FINDING],
      subsequentPulls: [],
      // in_reply_to_id set (a reply), author login matches botLogin, but user.type is UNDEFINED — the
      // shared bot-identity check must still exclude it, so no human-thread signal is derived.
      reviewComments: [{ path: "src/save.ts", line: 42, in_reply_to_id: 9, user: { login: "my-bot[bot]" } }],
      botLogin: "my-bot[bot]"
    });
    expect(botReplyMissingType.humanThreadResolved).toBe(false);

    // A genuine human reply (different login) on the same line IS counted.
    const humanReply = buildObservedPullOutcome({
      merged: true,
      pullNumber: 1,
      findings: [OBSERVED_FINDING],
      subsequentPulls: [],
      reviewComments: [{ path: "src/save.ts", line: 42, in_reply_to_id: 9, user: { login: "maintainer" } }],
      botLogin: "my-bot[bot]"
    });
    expect(humanReply.humanThreadResolved).toBe(true);
  });
});

describe("scheduled reader reaches CLI-observer label parity (#371 acceptance)", () => {
  const now = new Date("2026-07-06T10:00:00.000Z");

  // The parity contract: fed the same underlying facts, the scheduled reader must record the SAME
  // label the CLI observer (runOutcomeObserverFromInput) records from the equivalent ObservedPullOutcome.
  async function scheduledLabel(github: SchedulerGitHubApi): Promise<FindingOutcomeLabelRecordLike> {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const config = loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } }));
    await observeScheduledOutcomes({ config, github, state: store, now });
    const labels = store.listFindingOutcomeLabels();
    store.close();
    expect(labels).toHaveLength(1);
    return labels[0];
  }

  function cliLabel(observed: ObservedPullOutcome): FindingOutcomeLabelRecordLike {
    const { store, root } = newStore();
    const result = runOutcomeObserverFromInput({
      store,
      entries: [{ review: { repo: "owner/repo", pullNumber: 1, headSha: "sha1", findings: [OBSERVED_FINDING] }, observed }],
      evidenceDir: join(root, "cli-evidence"),
      dryRun: false,
      now
    });
    expect(result.labeled).toBe(1);
    const labels = store.listFindingOutcomeLabels();
    store.close();
    return labels[0];
  }

  // The load-bearing guarantee is VERDICT parity (true_positive / false_positive / unvalidated). In the
  // scenarios below the CLI input is fed the SAME source the scheduled reader derives, so labelSource
  // matches too; the separate merged_fix-vs-hotfix test documents where only the verdict is guaranteed.
  function assertVerdictParity(scheduled: FindingOutcomeLabelRecordLike, cli: FindingOutcomeLabelRecordLike): void {
    expect(scheduled.verdict).toBe(cli.verdict);
  }

  it("revert: scheduled reader and CLI observer both label `revert` / true_positive", async () => {
    const scheduled = await scheduledLabel(
      deepGithub({ subsequent: [{ number: 2, title: 'Revert "Add save path" (#1)' }] })
    );
    const cli = cliLabel(fullObserved({ merged: true, revertedFlaggedChange: true }));
    expect(scheduled.labelSource).toBe("revert");
    assertVerdictParity(scheduled, cli);
  });

  it("hotfix touching the flagged line: both label a true_positive fix (hotfix)", async () => {
    const scheduled = await scheduledLabel(
      deepGithub({ subsequent: [{ number: 2, title: "Fix data loss on save", files: HOTFIX_FILES }] })
    );
    const cli = cliLabel(fullObserved({ merged: true, hotfixLines: new Map([["src/save.ts", new Set([42])]]) }));
    expect(scheduled.labelSource).toBe("hotfix");
    expect(scheduled.verdict).toBe("true_positive");
    assertVerdictParity(scheduled, cli);
  });

  it("human thread on the finding: both label `human_thread` / false_positive", async () => {
    const scheduled = await scheduledLabel(deepGithub({ reviewComments: HUMAN_THREAD }));
    const cli = cliLabel(fullObserved({ merged: true, humanThreadResolved: true }));
    expect(scheduled.labelSource).toBe("human_thread");
    expect(scheduled.verdict).toBe("false_positive");
    assertVerdictParity(scheduled, cli);
  });

  it("merged with no deeper signal stays none_observed (honest floor preserved)", async () => {
    const scheduled = await scheduledLabel(deepGithub({ subsequent: [] }));
    expect(scheduled.labelSource).toBe("none_observed");
    expect(scheduled.verdict).toBe("unvalidated");
  });
});

describe("scheduled deeper-observation cost caps + invariants (#371)", () => {
  const now = new Date("2026-07-06T10:00:00.000Z");

  it("bounds deeper reads: recent-merged window is fetched ONCE per repo and capped at maxPullsPerCycle", async () => {
    const { store } = newStore();
    // Two merged target heads in the SAME repo — the recent-merged window must be read once, shared.
    store.recordReviewFindings([
      { ...FINDING, pullNumber: 1, headSha: "sha1", fingerprint: `finding:${"a".repeat(64)}` },
      { ...FINDING, pullNumber: 2, headSha: "sha2", fingerprint: `finding:${"b".repeat(64)}` }
    ]);
    const listRecentMergedPulls = vi.fn(async () => [] as PullRequestSummary[]);
    const github: SchedulerGitHubApi = {
      ...deepGithub({ subsequent: [] }),
      listRecentMergedPulls
    };
    const config = loadConfigFromObject(
      baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, maxPullsPerCycle: 2 } } })
    );

    await observeScheduledOutcomes({ config, github, state: store, now });

    // One window read for the repo (memoized across both heads), and it requested at most maxPullsPerCycle.
    expect(listRecentMergedPulls).toHaveBeenCalledTimes(1);
    expect(listRecentMergedPulls).toHaveBeenCalledWith("owner/repo", 2);
    store.close();
  });

  it("bounds per-subsequent-PR file reads: listPullFiles is called at most once per (repo, subsequent-pull) across targets", async () => {
    const { store } = newStore();
    // Two merged target heads in the SAME repo share the SAME recent-merged window (PRs #10, #11).
    store.recordReviewFindings([
      { ...FINDING, pullNumber: 1, headSha: "sha1", fingerprint: `finding:${"a".repeat(64)}` },
      { ...FINDING, pullNumber: 2, headSha: "sha2", fingerprint: `finding:${"b".repeat(64)}` }
    ]);
    const listPullFiles = vi.fn(async (_repo: string, _pullNumber: number) => [] as PullFilePatch[]);
    const github: SchedulerGitHubApi = {
      ...deepGithub({ subsequent: [{ number: 10, title: "later A" }, { number: 11, title: "later B" }] }),
      listRecentMergedPulls: async () =>
        [10, 11].map((number) => ({ number, title: "later", body: "", head: { sha: `sha${number}` }, merged_at: "2026-07-05T12:00:00.000Z" }) as unknown as PullRequestSummary),
      listPullFiles
    };
    const config = loadConfigFromObject(
      baseConfigObject({ calibrationLoop: { observeSchedule: { ...OBSERVE_SCHEDULE, maxPullsPerCycle: 2 } } })
    );

    await observeScheduledOutcomes({ config, github, state: store, now });

    // Two targets × two subsequent PRs would be 4 reads unmemoized; the (repo, pull) cache holds it to 2.
    expect(listPullFiles).toHaveBeenCalledTimes(2);
    expect(new Set(listPullFiles.mock.calls.map((call) => call[1]))).toEqual(new Set([10, 11]));
    store.close();
  });

  it("caches the RESOLVED window (not a rejected promise): a first-target failure does not poison later targets", async () => {
    const { store } = newStore();
    store.recordReviewFindings([
      { ...FINDING, pullNumber: 1, headSha: "sha1", fingerprint: `finding:${"a".repeat(64)}` },
      { ...FINDING, pullNumber: 2, headSha: "sha2", fingerprint: `finding:${"b".repeat(64)}` }
    ]);
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let calls = 0;
    const listRecentMergedPulls = vi.fn(async () => {
      calls += 1;
      if (calls === 1) throw new Error("transient window read failure");
      // Second target re-attempts and succeeds with a revert of PR #2.
      return [{ number: 20, title: 'Revert "x" (#2)', body: "", head: { sha: "sha20" }, merged_at: "2026-07-05T12:00:00.000Z" }] as unknown as PullRequestSummary[];
    });
    const github: SchedulerGitHubApi = {
      ...deepGithub({}),
      getPull: async (_repo, pullNumber) =>
        ({ number: pullNumber, title: `PR ${pullNumber}`, head: { sha: `sha${pullNumber}` }, merged_at: "2026-07-05T00:00:00.000Z", merge_commit_sha: `merge${pullNumber}` }) as unknown as PullRequestSummary,
      listRecentMergedPulls
    };
    const config = loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } }));

    await observeScheduledOutcomes({ config, github, state: store, now });

    // Both targets attempted the read (rejection was NOT cached): #1 degraded to none_observed, #2 got revert.
    expect(listRecentMergedPulls).toHaveBeenCalledTimes(2);
    const bySource = Object.fromEntries(store.listFindingOutcomeLabels().map((label) => [label.pullNumber, label.labelSource]));
    expect(bySource[1]).toBe("none_observed");
    expect(bySource[2]).toBe("revert");
    store.close();
  });

  it("fails open: a throwing deeper-read degrades to the merge-state cut (none_observed), never throws", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const token = ["ghp", "q".repeat(36)].join("_");
    const github: SchedulerGitHubApi = {
      ...deepGithub({ subsequent: [{ number: 2, title: "Fix", files: HOTFIX_FILES }] }),
      listRecentMergedPulls: async () => {
        throw new Error(`recent-merged read boom ${token}`);
      }
    };
    const config = loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } }));

    await expect(observeScheduledOutcomes({ config, github, state: store, now })).resolves.toBeUndefined();
    const labels = store.listFindingOutcomeLabels();
    // The merged PR still gets an HONEST none_observed label (never a mislabel), and the pass advances.
    expect(labels).toHaveLength(1);
    expect(labels[0].labelSource).toBe("none_observed");
    expect(warn).toHaveBeenCalled();
    expect(warn.mock.calls.flat().join(" ")).not.toContain(token);
    store.close();
  });

  it("never posts/aggregates/writes config: only finding_outcome_labels + schedule state are written", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const github = deepGithub({ subsequent: [{ number: 2, title: 'Revert "Add save path" (#1)' }] });
    // Fail loudly if any WRITE-shaped GitHub surface is invoked by the observe pass.
    const forbidden = {
      createReview: vi.fn(),
      upsertIssueComment: vi.fn()
    };
    const config = loadConfigFromObject(baseConfigObject({ calibrationLoop: { observeSchedule: OBSERVE_SCHEDULE } }));

    await observeScheduledOutcomes({ config, github: { ...github, ...forbidden } as SchedulerGitHubApi, state: store, now });

    expect(forbidden.createReview).not.toHaveBeenCalled();
    expect(forbidden.upsertIssueComment).not.toHaveBeenCalled();
    expect(store.listFindingOutcomeLabels()).toHaveLength(1);
    store.close();
  });

  it("disabled ⇒ byte-identical no-op: no deeper reads, no labels", async () => {
    const { store } = newStore();
    store.recordReviewFindings([FINDING]);
    const listRecentMergedPulls = vi.fn(async () => [] as PullRequestSummary[]);
    const github: SchedulerGitHubApi = { ...deepGithub({}), listRecentMergedPulls };
    const config = loadConfigFromObject(baseConfigObject());

    await observeScheduledOutcomes({ config, github, state: store, now });

    expect(listRecentMergedPulls).not.toHaveBeenCalled();
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    store.close();
  });
});

// The label-record shape the parity assertions read (subset of the store record).
type FindingOutcomeLabelRecordLike = { labelSource: string; verdict: string };
