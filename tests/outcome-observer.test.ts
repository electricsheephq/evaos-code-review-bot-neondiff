import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ReviewStateStore } from "../src/state.js";

const tsxCli = createRequire(import.meta.url).resolve("tsx/cli");
import { deriveOutcomeLabel, recordNegativeControlLabels, runOutcomeObserver, type ObservedPullOutcome } from "../src/outcome-observer.js";

const FINDING = {
  fingerprint: `finding:${"a".repeat(64)}`,
  path: "src/save.ts",
  line: 42,
  severity: "P1" as const,
  category: "data_loss",
  confidence: 0.9
};

describe("outcome-observer label derivation precedence (#286 PR A)", () => {
  const cases: Array<{ name: string; observed: Partial<ObservedPullOutcome>; source: string; verdict: string }> = [
    { name: "revert wins over everything", observed: { revertedFlaggedChange: true, hotfixLines: mapOf(), mergedFixLines: mapOf({ "src/save.ts": [42] }), humanThreadResolved: true }, source: "revert", verdict: "true_positive" },
    { name: "hotfix touching flagged lines beats merged-fix + human", observed: { hotfixLines: mapOf({ "src/save.ts": [43] }), mergedFixLines: mapOf({ "src/save.ts": [42] }), humanThreadResolved: true }, source: "hotfix", verdict: "true_positive" },
    { name: "merged-fix diff touching flagged lines beats human thread", observed: { mergedFixLines: mapOf({ "src/save.ts": [42] }), humanThreadResolved: true }, source: "merged_fix", verdict: "true_positive" },
    { name: "human thread resolution when no diff touch", observed: { humanThreadResolved: true }, source: "human_thread", verdict: "false_positive" },
    { name: "none observed when nothing signals", observed: {}, source: "none_observed", verdict: "unvalidated" }
  ];

  for (const testCase of cases) {
    it(testCase.name, () => {
      const label = deriveOutcomeLabel({ finding: FINDING, observed: fullObserved(testCase.observed) });
      expect(label.labelSource).toBe(testCase.source);
      expect(label.verdict).toBe(testCase.verdict);
    });
  }

  it("does not coarse-match a hotfix that touches a DIFFERENT far line", () => {
    const label = deriveOutcomeLabel({ finding: FINDING, observed: fullObserved({ hotfixLines: mapOf({ "src/save.ts": [200] }) }) });
    expect(label.labelSource).toBe("none_observed");
  });
});

describe("outcome-observer run (#286 PR A)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  function seedReview(store: ReviewStateStore, repo: string, pull: number, sha: string) {
    store.recordProcessed({ repo, pullNumber: pull, headSha: sha, status: "posted", event: "REQUEST_CHANGES" });
  }

  it("skips an unmerged PR (no label written)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-observer-unmerged-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    seedReview(store, "owner/repo", 1, "sha1");

    const result = runOutcomeObserver({
      store,
      evidenceDir: join(root, "evidence"),
      reviews: [{ repo: "owner/repo", pullNumber: 1, headSha: "sha1", findings: [FINDING] }],
      fetchOutcome: () => ({ merged: false }) as ObservedPullOutcome
    });

    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    expect(result.skipped).toBe(1);
    expect(result.labeled).toBe(0);
    store.close();
  });

  it("labels a merged PR and is idempotent on re-observe (no duplicate rows)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-observer-idem-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    seedReview(store, "owner/repo", 2, "sha2");
    const observer = () =>
      runOutcomeObserver({
        store,
        evidenceDir: join(root, "evidence"),
        reviews: [{ repo: "owner/repo", pullNumber: 2, headSha: "sha2", findings: [FINDING] }],
        fetchOutcome: () => fullObserved({ merged: true, mergedFixLines: mapOf({ "src/save.ts": [42] }) })
      });

    observer();
    observer();

    const labels = store.listFindingOutcomeLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ labelSource: "merged_fix", verdict: "true_positive", fingerprint: FINDING.fingerprint });
    store.close();
  });

  it("redacts secret-like text in evidence_ref before it is stored or written", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-observer-redact-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    seedReview(store, "owner/repo", 3, "sha3");
    const token = ["ghp", "1234567890abcdefghijklmnopqrstuvwx"].join("_");

    runOutcomeObserver({
      store,
      evidenceDir: join(root, "evidence"),
      reviews: [{ repo: "owner/repo", pullNumber: 3, headSha: "sha3", findings: [FINDING] }],
      fetchOutcome: () => fullObserved({ merged: true, revertedFlaggedChange: true, evidenceRef: `revert commit ${token}` })
    });

    const labels = store.listFindingOutcomeLabels();
    expect(labels[0]?.evidenceRef).not.toContain(token);
    const packet = readFileSync(join(root, "evidence", "outcome-observer.json"), "utf8");
    expect(packet).not.toContain(token);
    store.close();
  });

  it("fills the ledger postMergeOutcome and riskClaims status in the evidence packet", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-observer-ledger-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));
    seedReview(store, "owner/repo", 4, "sha4");

    runOutcomeObserver({
      store,
      evidenceDir: join(root, "evidence"),
      reviews: [{ repo: "owner/repo", pullNumber: 4, headSha: "sha4", findings: [FINDING] }],
      fetchOutcome: () => fullObserved({ merged: true, revertedFlaggedChange: true })
    });

    const packet = JSON.parse(readFileSync(join(root, "evidence", "outcome-observer.json"), "utf8"));
    const entry = packet.observations[0];
    expect(entry.postMergeOutcome.status).toBe("reverted");
    expect(entry.riskClaims[0].status).toBe("validated");
    store.close();
  });
});

describe("outcome-observe CLI (#286 PR A)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("defaults to dry-run, writes the evidence packet, and does NOT persist labels", () => {
    const dir = mkdtempSync(join(tmpdir(), "evaos-observe-cli-"));
    roots.push(dir);
    const configPath = join(dir, "config.json");
    writeFileSync(configPath, `${JSON.stringify({
      pilotRepos: ["owner/repo"],
      workRoot: join(dir, "runtime"),
      statePath: join(dir, "state.sqlite"),
      evidenceDir: join(dir, "evidence")
    })}\n`);
    const inputPath = join(dir, "input.json");
    writeFileSync(inputPath, `${JSON.stringify({
      reviews: [{
        repo: "owner/repo",
        pullNumber: 7,
        headSha: "sha7",
        findings: [{ fingerprint: FINDING.fingerprint, path: "src/save.ts", line: 42, severity: "P1", category: "data_loss", confidence: 0.9 }],
        observed: { merged: true, mergedFixLines: { "src/save.ts": [42] } }
      }]
    })}\n`);
    const outputDir = join(dir, "packet");

    const output = execFileSync(process.execPath, [
      tsxCli, "src/cli.ts", "outcome-observe", "--config", configPath, "--input", inputPath, "--output-dir", outputDir
    ], { cwd: process.cwd(), encoding: "utf8" });

    const parsed = JSON.parse(output);
    expect(parsed).toMatchObject({ ok: true, command: "outcome-observe", dryRun: true, observed: 1, labeled: 0 });
    expect(existsSync(join(outputDir, "outcome-observer.json"))).toBe(true);

    // Dry-run persisted nothing.
    const store = new ReviewStateStore(join(dir, "state.sqlite"));
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    store.close();
  });
});

describe("explicit negative-control marking (#286 PR C)", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  });

  it("records an explicit_control label for a verifiably-clean (zero-finding) run", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-negctl-clean-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    const result = recordNegativeControlLabels({
      store,
      reviews: [{ repo: "owner/repo", pullNumber: 9, headSha: "sha9", findings: [] }],
      now: new Date("2026-07-06T00:00:00.000Z")
    });

    const labels = store.listFindingOutcomeLabels();
    expect(labels).toHaveLength(1);
    expect(labels[0]).toMatchObject({ labelSource: "explicit_control", verdict: "unvalidated" });
    expect(result.recorded).toBe(1);
    store.close();
  });

  it("refuses to mark a run that posted findings (mirrors #296: explicit + clean only)", () => {
    const root = mkdtempSync(join(tmpdir(), "evaos-negctl-dirty-"));
    roots.push(root);
    const store = new ReviewStateStore(join(root, "state.sqlite"));

    expect(() =>
      recordNegativeControlLabels({
        store,
        reviews: [{ repo: "owner/repo", pullNumber: 10, headSha: "sha10", findings: [FINDING] }]
      })
    ).toThrow(/posted findings/i);
    expect(store.listFindingOutcomeLabels()).toHaveLength(0);
    store.close();
  });
});

function mapOf(entries: Record<string, number[]> = {}): Map<string, Set<number>> {
  return new Map(Object.entries(entries).map(([path, lines]) => [path, new Set(lines)]));
}

function fullObserved(overrides: Partial<ObservedPullOutcome>): ObservedPullOutcome {
  return {
    merged: true,
    revertedFlaggedChange: false,
    hotfixLines: mapOf(),
    mergedFixLines: mapOf(),
    humanThreadResolved: false,
    ...overrides
  };
}
