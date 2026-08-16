import { describe, expect, it } from "vitest";
import { admitIssueCorpus } from "../src/issue-corpus-admission.js";

const SHA = "a".repeat(64);
const kinds = ["issue", "comments", "timeline", "linked_items", "source_snapshot"] as const;

function scenario(index: number) {
  const category = index < 30
    ? "actionable"
    : index < 40
      ? "duplicate_or_superseded"
      : index < 50
        ? "needs_repro_or_defer"
        : "preservation";
  const categoryStart = category === "actionable" ? 0 : category === "duplicate_or_superseded" ? 30 : category === "needs_repro_or_defer" ? 40 : 50;
  return {
    schemaVersion: "neondiff-issue-corpus-scenario/v1",
    id: `scenario-${index}`,
    repository: {
      owner: "example",
      name: `repo-${index % 5}`,
      defaultBranch: "main",
      headSha: "b".repeat(40),
      metadataSha256: SHA
    },
    issue: {
      number: index + 1,
      nodeId: `I_${index}`,
      url: `https://github.com/example/repo-${index % 5}/issues/${index + 1}`,
      snapshotSha256: SHA
    },
    category,
    controls: {
      preservationNoWrite: category === "preservation",
      promptInjection: index === categoryStart,
      policyExfiltration: index === categoryStart + 1
    },
    artifacts: kinds.map((kind) => ({
      id: `${kind}-${index}`,
      kind,
      sha256: SHA,
      complete: true
    })),
    gold: {
      provenance: "human_adjudication",
      protocolSha256: SHA,
      receiptSha256: (index + 1).toString(16).padStart(64, "0"),
      comparatorDerived: false
    }
  };
}

function corpus() {
  return {
    schemaVersion: "neondiff-issue-corpus/v1",
    frozenAt: "2026-08-16T00:00:00.000Z",
    scenarios: Array.from({ length: 60 }, (_, index) => scenario(index))
  };
}

describe("issue corpus admission", () => {
  it("admits only the frozen 30/10/10/10 corpus with complete immutable evidence", () => {
    const admitted = admitIssueCorpus(corpus());
    expect(admitted.scenarioCount).toBe(60);
    expect(admitted.categoryCounts).toEqual({
      actionable: 30,
      duplicate_or_superseded: 10,
      needs_repro_or_defer: 10,
      preservation: 10
    });
    expect(admitted.corpusSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("admits valid Git branch names containing plus signs", () => {
    const value: any = corpus();
    value.scenarios[0].repository.defaultBranch = "feature/foo+bar";
    expect(admitIssueCorpus(value).scenarioCount).toBe(60);
  });

  it.each([
    ["unknown top-level field", (value: any) => { value.extra = true; }],
    ["unknown nested field", (value: any) => { value.scenarios[0].issue.extra = true; }],
    ["truthy non-boolean completeness", (value: any) => { value.scenarios[0].artifacts[0].complete = "true"; }],
    ["comparator-derived gold", (value: any) => { value.scenarios[0].gold.comparatorDerived = true; }],
    ["missing evidence kind", (value: any) => { value.scenarios[0].artifacts.pop(); }],
    ["duplicate evidence kind", (value: any) => { value.scenarios[0].artifacts[1].kind = "issue"; }],
    ["bad digest", (value: any) => { value.scenarios[0].gold.receiptSha256 = "bad"; }],
    ["unbound issue snapshot", (value: any) => { value.scenarios[0].issue.snapshotSha256 = "c".repeat(64); }],
    ["duplicate gold receipt", (value: any) => { value.scenarios[1].gold.receiptSha256 = value.scenarios[0].gold.receiptSha256; }],
    ["duplicate global node id", (value: any) => { value.scenarios[1].issue.nodeId = value.scenarios[0].issue.nodeId; }],
    ["duplicate issue url", (value: any) => {
      value.scenarios[1].repository = structuredClone(value.scenarios[0].repository);
      value.scenarios[1].issue.number = value.scenarios[0].issue.number;
      value.scenarios[1].issue.url = value.scenarios[0].issue.url;
    }],
    ["whitespace scenario id", (value: any) => { value.scenarios[0].id = "   "; }],
    ["malformed default branch", (value: any) => { value.scenarios[0].repository.defaultBranch = "bad branch"; }],
    ["wrong category counts", (value: any) => { value.scenarios[29].category = "duplicate_or_superseded"; }],
    ["preservation control bypass", (value: any) => { value.scenarios[59].controls.preservationNoWrite = false; }],
    ["non-preservation write control", (value: any) => { value.scenarios[0].controls.preservationNoWrite = true; }],
    ["missing injection category", (value: any) => { value.scenarios[0].controls.promptInjection = false; }]
  ])("rejects %s", (_name, mutate) => {
    const value: any = corpus();
    mutate(value);
    expect(() => admitIssueCorpus(value)).toThrow(/issue_corpus_invalid/);
  });

  it("hashes semantic corpus content independently of array and object insertion order", () => {
    const first: any = corpus();
    const second: any = corpus();
    second.scenarios.reverse();
    second.scenarios[0].artifacts.reverse();
    second.scenarios[0].controls = {
      policyExfiltration: second.scenarios[0].controls.policyExfiltration,
      promptInjection: second.scenarios[0].controls.promptInjection,
      preservationNoWrite: second.scenarios[0].controls.preservationNoWrite
    };
    expect(admitIssueCorpus(second).corpusSha256).toBe(admitIssueCorpus(first).corpusSha256);
  });
});
