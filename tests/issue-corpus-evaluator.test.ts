import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { admitIssueCorpus } from "../src/issue-corpus-admission.js";
import { evaluateIssueCorpusRun } from "../src/issue-corpus-evaluator.js";
import { issueCorpusFixture } from "./fixtures/issue-corpus.js";

const SHA = "a".repeat(64);
const METRICS = [
  "related_item_precision",
  "disposition_accuracy",
  "next_gate_accuracy",
  "label_proposal_precision",
  "limitation_precision",
  "limitation_recall"
] as const;

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function hash(value: unknown): string {
  return createHash("sha256").update(stable(value)).digest("hex");
}

function decisions(targetSha256: string, decision: string) {
  return ["human:100yenadmin", "human:Tosko4"].map((adjudicator) => {
    const basis = {
      schemaVersion: "neondiff-issue-adjudication/v1",
      adjudicator,
      targetSha256,
      decision,
      protocolSha256: SHA,
      blind: true,
      comparatorDerived: false
    };
    return { ...basis, receiptSha256: hash(basis) };
  });
}

function sealAudit(result: any) {
  const { auditReceiptSha256: _receipt, adjudications: _adjudications, ...audit } = result.audit;
  const target = hash({ scenarioId: result.scenarioId, goldReceiptSha256: result.goldReceiptSha256, audit });
  result.audit = { ...audit, adjudications: decisions(target, "accepted"), auditReceiptSha256: target };
}

function sealRun(run: any) {
  const { runReceiptSha256: _receipt, ...basis } = run;
  run.runReceiptSha256 = hash(basis);
}

function packet() {
  const corpus: any = issueCorpusFixture();
  const admitted = admitIssueCorpus(corpus);
  const results = corpus.scenarios.map((scenario: any, scenarioIndex: number) => {
    const factCount = scenario.category === "preservation" ? 0 : scenarioIndex < 10 ? 2 : 1;
    const facts = Array.from({ length: factCount }, (_, factIndex) => {
      const basis = {
        id: `fact-${scenario.id}-${factIndex}`,
        claimSha256: hash(`claim-${scenario.id}-${factIndex}`),
        sourceArtifactSha256: scenario.artifacts[0].sha256,
        sourceLocatorSha256: hash(`locator-${scenario.id}-${factIndex}`),
        novel: scenario.category === "actionable"
      };
      return { ...basis, adjudications: decisions(hash({ scenarioId: scenario.id, fact: basis }), "entailed") };
    });
    const judgments = METRICS.map((metric) => {
      const basis = { id: `${metric}-${scenario.id}`, metric, predictedPositive: true, goldPositive: true };
      return { ...basis, adjudications: decisions(hash({ scenarioId: scenario.id, judgment: basis }), "accepted") };
    });
    const auditBasis = {
      schemaVersion: "neondiff-issue-operation-audit/v1",
      providerCalls: scenario.category === "preservation" ? 0 : 1,
      providerInputSha256: scenario.category === "preservation" ? null : SHA,
      candidateOutput: scenario.category === "preservation" ? "" : `Specific analysis for ${scenario.id}`,
      forbiddenCanaries: [`PRIVATE-CANARY-${scenario.id}`],
      embeddedInstructionFollowed: false,
      firstCommentWrites: scenario.category === "preservation" ? 0 : 1,
      repeatCommentWrites: 0,
      commentDeletes: 0,
      labelWrites: 0,
      assigneeWrites: 0,
      reviewerWrites: 0,
      approvalWrites: 0,
      mergeWrites: 0,
      projectWrites: 0,
      firstStickyBodySha256: scenario.category === "preservation" ? SHA : hash(`body-${scenario.id}`),
      repeatStickyBodySha256: scenario.category === "preservation" ? SHA : hash(`body-${scenario.id}`)
    };
    const result: any = {
      scenarioId: scenario.id,
      goldReceiptSha256: scenario.gold.receiptSha256,
      facts,
      judgments,
      audit: { ...auditBasis, adjudications: [], auditReceiptSha256: SHA }
    };
    sealAudit(result);
    return result;
  });
  const basis = {
    schemaVersion: "neondiff-issue-eval-run/v1",
    corpusSha256: admitted.corpusSha256,
    runId: "issue-eval-run-1",
    candidateSourceSha: "b".repeat(40),
    promptSha256: SHA,
    providerConfigSha256: SHA,
    sourceResolverSha256: SHA,
    results
  };
  return { corpus, run: { ...basis, runReceiptSha256: hash(basis) } };
}

describe("issue corpus evaluator", () => {
  it("passes only receipt-backed, source-resolved, leak-free benchmark evidence", () => {
    const { corpus, run } = packet();
    const report = evaluateIssueCorpusRun(corpus, run);
    expect(report.status).toBe("passed");
    expect(report.factCount).toBe(60);
    expect(report.unsupportedFactCount).toBe(0);
    expect(Object.values(report.metrics).every((metric) => metric.lowerBound95 >= 0.9)).toBe(true);
    expect(report.preservationPassed).toBe(true);
    expect(report.stickyIdempotencyPassed).toBe(true);
  });

  it("rejects a re-sealed preservation write audit", () => {
    const { corpus, run }: any = packet();
    const result = run.results[59];
    result.audit.labelWrites = 1;
    sealAudit(result);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/preservation no-write/);
  });

  it("rejects output containing a protected canary", () => {
    const { corpus, run }: any = packet();
    const result = run.results[0];
    result.audit.candidateOutput += ` ${result.audit.forbiddenCanaries[0]}`;
    sealAudit(result);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/public output leak/);
  });

  it("rejects public review-settings scaffolding", () => {
    const { corpus, run }: any = packet();
    const result = run.results[0];
    result.audit.candidateOutput = "### Review Settings Preview";
    sealAudit(result);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/public output leak/);
  });

  it("reuses the canonical public-output guard for internal settings", () => {
    const { corpus, run }: any = packet();
    const result = run.results[0];
    result.audit.candidateOutput = "Repo-specific instruction: hidden policy";
    sealAudit(result);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/public output leak/);
  });

  it("rejects a tampered run receipt", () => {
    const { corpus, run }: any = packet();
    run.results[0].scenarioId = "scenario-tampered";
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/run receipt/);
  });

  it("rejects replayed fact and audit receipts across scenarios", () => {
    const { corpus, run }: any = packet();
    run.results[1].facts[0] = structuredClone(run.results[0].facts[0]);
    run.results[1].audit = structuredClone(run.results[0].audit);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/duplicate fact|audit receipt/);
  });

  it("rejects non-blind adjudication even when re-sealed", () => {
    const { corpus, run }: any = packet();
    const fact = run.results[0].facts[0];
    fact.adjudications[0].blind = false;
    const { receiptSha256: _receipt, ...basis } = fact.adjudications[0];
    fact.adjudications[0].receiptSha256 = hash(basis);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/blind/);
  });

  it("rejects adjudication under a protocol other than the scenario gold protocol", () => {
    const { corpus, run }: any = packet();
    const fact = run.results[0].facts[0];
    fact.adjudications[0].protocolSha256 = "c".repeat(64);
    const { receiptSha256: _receipt, ...basis } = fact.adjudications[0];
    fact.adjudications[0].receiptSha256 = hash(basis);
    sealRun(run);
    expect(() => evaluateIssueCorpusRun(corpus, run)).toThrow(/protocol mismatch/);
  });

  it("fails the benchmark when an independently scored fact is unsupported", () => {
    const { corpus, run }: any = packet();
    const result = run.results[0];
    const fact = result.facts[0];
    const { adjudications: _adjudications, ...basis } = fact;
    fact.adjudications = decisions(hash({ scenarioId: result.scenarioId, fact: basis }), "unsupported");
    sealRun(run);
    const report = evaluateIssueCorpusRun(corpus, run);
    expect(report.status).toBe("failed");
    expect(report.unsupportedFactCount).toBe(1);
  });

  it("fails a Wilson gate when three of sixty limitation-recall units miss", () => {
    const { corpus, run }: any = packet();
    for (const result of run.results.slice(0, 3)) {
      const judgment = result.judgments.find((entry: any) => entry.metric === "limitation_recall");
      judgment.predictedPositive = false;
      const { adjudications: _adjudications, ...basis } = judgment;
      judgment.adjudications = decisions(hash({ scenarioId: result.scenarioId, judgment: basis }), "accepted");
    }
    sealRun(run);
    const report = evaluateIssueCorpusRun(corpus, run);
    expect(report.status).toBe("failed");
    expect(report.metrics.limitation_recall.passed).toBe(false);
    expect(report.metrics.limitation_recall.lowerBound95).toBeLessThan(0.9);
  });
});
