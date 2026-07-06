/**
 * #346 queue-aging starvation simulation (Config Activation QA Lab, tracker #340).
 *
 * Standalone — NO GitHub/provider/network calls. It drives the REAL priority-assignment
 * (riskWeightedQueuePriority over buildChangedSurfaceValidationReport) and the REAL durable-queue
 * enqueue/lease logic (ReviewStateStore.enqueueReviewQueueJob / leaseNextReviewQueueJobs) against a
 * temp sqlite under os.tmpdir — never the live state path. It compares three configs:
 *   (1) flat (risk-weighting off), (2) risk-weighted WITHOUT aging, (3) recommended WITH aging.
 * Output: per-class lease-wait p50/p95/max as JSON + a markdown table, written via the repo's
 * redacted-writer idiom to the polished-config-lab evidence path.
 *
 * Proof boundary: simulation + a default-off capability. It changes no live config or launchd; the
 * recommended config here is a LAB recommendation, not an applied setting.
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfigFromObject, type BotConfig } from "../../src/config.js";
import { ReviewStateStore } from "../../src/state.js";
import { riskWeightedQueuePriority } from "../../src/scheduler.js";
import { buildChangedSurfaceValidationReport } from "../../src/validation-selector.js";
import { stringifyRedactedJson } from "../../src/secrets.js";
import type { PullFilePatch, PullRequestSummary } from "../../src/types.js";
// Reuse the merged QA-lab harness (#341/#358): scenario file-sets drive the REAL tier, and the
// harness percentile math (nearest-rank) is reused rather than re-implemented here.
import { QA_LAB_SCENARIOS } from "./scenarios.js";
import { percentile } from "./stats.js";

const EVIDENCE_DIR = "/Volumes/LEXAR/Codex/evaos-code-review-bot/evidence/2026-07-06/polished-config-lab/risk-queue";
const BASELINE = 50;
const MAX_WAIT_MINUTES = 60;
const TICK_MS = 60_000; // one minute per service interval
const SERVICE_PER_TICK = 2; // maxProviderActive: 2 leases/min — the queue is drainable at steady state
const BURST_MINUTES = 3 * MAX_WAIT_MINUTES; // sustained elevated burst >= 3x max-wait (the starvation window)
const DRAIN_MINUTES = 3 * MAX_WAIT_MINUTES; // post-burst tail so the queue can drain and waits settle
const HORIZON_TICKS = BURST_MINUTES + DRAIN_MINUTES;

// PR-review scenario classes with their real changed-file sets, reused from the merged harness
// (QA_LAB_SCENARIOS). issue_burst is issue-enrichment shaped (not a PR-review queue job) — excluded.
const CLASS_FILES: Record<string, PullFilePatch[]> = Object.fromEntries(
  QA_LAB_SCENARIOS.filter((scenario) => scenario.scenarioClass !== "issue_burst").map((scenario) => [scenario.scenarioClass, scenario.files])
);

// Elevated classes are whatever the REAL changed-surface report elevates — do not assume. Verified
// via riskWeightedQueuePriority: normal_code + auth_security get "required" recs (priority 20); the
// others land at default/baseline (50). During the BURST window the elevated stream arrives >= the
// service rate, filling every slot so lower-priority docs (baseline 50) starve behind elevated work.
const BASE_ARRIVALS: Record<string, number> = {
  docs_only: 0.25,
  normal_code: 0.25,
  auth_security: 0.25,
  migration: 0.1,
  release_config: 0.1
};
const ELEVATED_BURST_CLASSES = ["normal_code", "auth_security"];
const BURST_ARRIVALS_PER_ELEVATED_CLASS = 1.1; // 2 classes x 1.1 = 2.2/min >= 2/min service (fills slots)

function arrivalsAt(cls: string, tick: number): number {
  const inBurst = tick < BURST_MINUTES;
  if (inBurst && ELEVATED_BURST_CLASSES.includes(cls)) return BURST_ARRIVALS_PER_ELEVATED_CLASS;
  return BASE_ARRIVALS[cls]!;
}

// Three configs, all with the RECOMMENDED docsOnlyPriority == baseline (50): docs are not demoted,
// they simply lease behind elevated (20). Under the sustained elevated burst, config (2) (no aging)
// starves docs — they wait out the whole burst behind elevated work. Config (3) is the recommended
// config WITH rescue aging: any docs job waiting past maxWait is rescued ahead of even fresh elevated
// work, bounding docs wait to ~maxWait + rescue-set drain (acceptance (c)). docs stay at baseline (no
// demotion — acceptance (b)); rescue fires only after maxWait.
const CONFIGS: Array<{ id: string; label: string; config: BotConfig }> = [
  { id: "flat", label: "flat (risk-weighting off)", config: loadConfigFromObject({ reviewScheduler: { backgroundPriority: BASELINE } }) },
  {
    id: "risk_no_aging",
    label: "risk-weighted (docsOnly 50), NO aging",
    config: loadConfigFromObject({
      reviewScheduler: { backgroundPriority: BASELINE },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: BASELINE }
    })
  },
  {
    id: "risk_with_aging",
    label: "risk-weighted (docsOnly 50) + rescue aging (recommended)",
    config: loadConfigFromObject({
      reviewScheduler: { backgroundPriority: BASELINE },
      riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: BASELINE, aging: { enabled: true, maxWaitMinutes: MAX_WAIT_MINUTES } }
    })
  }
];

function pullFor(cls: string, n: number): PullRequestSummary {
  return {
    number: n,
    title: `${cls}-${n}`,
    draft: false,
    head: { sha: `${cls}${n}`, ref: "feature" },
    base: { sha: "base", ref: "main", repo: { full_name: "owner/repo" } },
    html_url: `https://example.invalid/owner/repo/pull/${n}`
  };
}

interface ClassStats { class: string; count: number; p50Min: number; p95Min: number; maxMin: number }

function runConfig(config: BotConfig): ClassStats[] {
  const root = mkdtempSync(join(tmpdir(), "queue-sim-"));
  const store = new ReviewStateStore(join(root, "state.sqlite"));
  const t0 = new Date("2026-07-06T00:00:00.000Z").getTime();
  const waitsByClass = new Map<string, number[]>();
  const jobClass = new Map<string, string>();
  const enqueuedAt = new Map<string, number>();
  const pending: Record<string, number> = {};
  let seq = 0;

  for (let tick = 0; tick < HORIZON_TICKS; tick += 1) {
    const now = new Date(t0 + tick * TICK_MS);
    // Arrivals: accumulate fractional rates, enqueue whole jobs at the REAL assigned priority.
    for (const cls of Object.keys(CLASS_FILES)) {
      pending[cls] = (pending[cls] ?? 0) + arrivalsAt(cls, tick);
      while (pending[cls]! >= 1) {
        pending[cls]! -= 1;
        seq += 1;
        const report = buildChangedSurfaceValidationReport({ repo: "owner/repo", pull: pullFor(cls, seq), files: CLASS_FILES[cls]! });
        const priority = riskWeightedQueuePriority({ config, repo: "owner/repo", report }).priority ?? BASELINE;
        const job = store.enqueueReviewQueueJob({ repo: "owner/repo", pullNumber: seq, headSha: `${cls}${seq}`, priority, now }).job;
        jobClass.set(job.jobId, cls);
        enqueuedAt.set(job.jobId, now.getTime());
      }
    }
    // Service: lease up to SERVICE_PER_TICK via the REAL lease path (with aging threaded from config).
    const aging = config.riskWeightedQueue?.aging;
    for (let s = 0; s < SERVICE_PER_TICK; s += 1) {
      const leased = store.leaseNextReviewQueueJobs({
        maxProviderActive: SERVICE_PER_TICK, maxOrgActive: 1000, maxRepoActive: 1000, limit: 1, now,
        ...(aging ? { aging } : {})
      });
      const job = leased[0];
      if (!job) break;
      const cls = jobClass.get(job.jobId)!;
      const waitMin = (now.getTime() - enqueuedAt.get(job.jobId)!) / 60_000;
      (waitsByClass.get(cls) ?? waitsByClass.set(cls, []).get(cls)!).push(waitMin);
      store.updateReviewQueueJobState({ jobId: job.jobId, state: "posted", now });
    }
  }

  // Starvation must be visible: a job still QUEUED at the horizon has an unbounded (>= censored)
  // wait, not a zero wait. Record its wait-so-far so a starved class shows a large max, not "0".
  const horizonMs = t0 + HORIZON_TICKS * TICK_MS;
  let starvedTotal = 0;
  for (const job of store.listReviewQueueJobs()) {
    if (job.state !== "queued") continue;
    const cls = jobClass.get(job.jobId);
    if (!cls) continue;
    (waitsByClass.get(cls) ?? waitsByClass.set(cls, []).get(cls)!).push((horizonMs - enqueuedAt.get(job.jobId)!) / 60_000);
    starvedTotal += 1;
  }

  store.close();
  rmSync(root, { recursive: true, force: true });
  void starvedTotal;

  return Object.keys(CLASS_FILES).map((cls) => {
    const waits = waitsByClass.get(cls) ?? [];
    return {
      class: cls,
      count: waits.length,
      // Reuse the harness percentile (p in [0,1], nearest-rank). Guard the empty case it rejects.
      p50Min: waits.length ? round(percentile(waits, 0.5)) : 0,
      p95Min: waits.length ? round(percentile(waits, 0.95)) : 0,
      maxMin: waits.length ? round(Math.max(...waits)) : 0
    };
  });
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

function markdownTable(results: Record<string, ClassStats[]>): string {
  const lines = [
    "# #346 risk-weighted queue aging — starvation simulation",
    "",
    `Horizon ${HORIZON_TICKS} min · service ${SERVICE_PER_TICK}/min · maxWait ${MAX_WAIT_MINUTES}m · baseline ${BASELINE}.`,
    "Lease-wait minutes (leased jobs), per class, per config.",
    "",
    "| class | config | p50 | p95 | max |",
    "| --- | --- | ---: | ---: | ---: |"
  ];
  for (const cls of Object.keys(CLASS_FILES)) {
    for (const { id } of CONFIGS) {
      const s = results[id]!.find((r) => r.class === cls)!;
      lines.push(`| ${cls} | ${id} | ${s.p50Min} | ${s.p95Min} | ${s.maxMin} |`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function main(): void {
  const results: Record<string, ClassStats[]> = {};
  for (const { id, config } of CONFIGS) results[id] = runConfig(config);

  const recommendedConfig = {
    riskWeightedQueue: { enabled: true, elevatedPriority: 20, docsOnlyPriority: BASELINE, aging: { enabled: true, maxWaitMinutes: MAX_WAIT_MINUTES } }
  };
  const recommendationNote =
    "Recommended config: elevatedPriority 20, docsOnlyPriority 50 (== baseline, NO demotion), aging " +
    "{enabled, maxWaitMinutes: 60}. Under a sustained elevated burst, config (2) (no aging) starves docs " +
    "(they lease behind elevated 20 for the whole burst); config (3) rescue-aging bounds any docs job to " +
    "~maxWait: once it waits 60 min it is rescued AHEAD of even fresh elevated work (amended two-tier rule). " +
    "docs stay at baseline (acceptance b, not demoted); rescue fires only after maxWait. Lower priority " +
    "number = leases sooner; the spec's original 70/50 sample had elevated/docsOnly inverted vs the shipped " +
    "#301 convention (elevated must be the SMALLER number) — corrected here to 20/50.";
  const payload = {
    issue: "#346",
    tracker: "#340",
    generatedAt: new Date().toISOString(),
    parameters: {
      baseline: BASELINE,
      maxWaitMinutes: MAX_WAIT_MINUTES,
      serviceRatePerMinute: SERVICE_PER_TICK,
      burstMinutes: BURST_MINUTES,
      drainMinutes: DRAIN_MINUTES,
      horizonMinutes: HORIZON_TICKS,
      baseArrivalsPerMinute: BASE_ARRIVALS,
      burstElevatedArrivalsPerClass: BURST_ARRIVALS_PER_ELEVATED_CLASS
    },
    configs: CONFIGS.map(({ id, label }) => ({ id, label })),
    recommendedConfig,
    recommendationNote,
    results,
    proofBoundary: "Offline simulation over a default-off capability. No live config or launchd change; enabling aging stays a #340 lab decision."
  };

  mkdirSync(EVIDENCE_DIR, { recursive: true });
  writeFileSync(join(EVIDENCE_DIR, "queue-sim.json"), `${stringifyRedactedJson(payload)}\n`);
  writeFileSync(join(EVIDENCE_DIR, "queue-sim.md"), markdownTable(results));
  console.log(stringifyRedactedJson({ ok: true, evidenceDir: EVIDENCE_DIR, results }));
}

main();
