import { describe, expect, it } from "vitest";
import { admitIssueCorpus } from "../src/issue-corpus-admission.js";
import { issueCorpusFixture } from "./fixtures/issue-corpus.js";

describe("issue corpus admission", () => {
  it("admits only the frozen 30/10/10/10 corpus with complete immutable evidence", () => {
    const admitted = admitIssueCorpus(issueCorpusFixture());
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
    const value: any = issueCorpusFixture();
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
    const value: any = issueCorpusFixture();
    mutate(value);
    expect(() => admitIssueCorpus(value)).toThrow(/issue_corpus_invalid/);
  });

  it("hashes semantic corpus content independently of array and object insertion order", () => {
    const first: any = issueCorpusFixture();
    const second: any = issueCorpusFixture();
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
