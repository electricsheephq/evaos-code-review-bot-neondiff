import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  evaluateIssueCorpus,
  validateIssueCorpusScenario,
  type IssueCorpusScenario
} from "../src/issue-enrichment-corpus.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const kinds = ["issue_body", "comment", "timeline", "linked_item", "source"] as const;

function scenario(): IssueCorpusScenario {
  return {
    schemaVersion: "neondiff-issue-corpus/v1",
    id: "public-owner-repo-790",
    repository: { name: "owner/repo", defaultBranch: "main", defaultBranchSha: "a".repeat(40) },
    complete: { comments: true, timeline: true, linkedItems: true },
    artifacts: kinds.map((kind, index) => {
      const content = `${kind}-${index}`;
      return { id: kind, kind, content, sha256: sha256(content) };
    }),
    gold: {
      source: "human_adjudication",
      facts: [{ claim: "The issue is open.", evidenceRefs: ["issue_body"] }]
    },
    control: "preservation",
    protectedCanaries: ["private-policy-canary"]
  };
}

describe("immutable issue enrichment corpus v1", () => {
  it("binds every issue evidence surface by hash and excludes comparator gold", () => {
    const valid = scenario();
    expect(validateIssueCorpusScenario(valid)).toEqual([]);
    expect(validateIssueCorpusScenario({
      ...valid,
      artifacts: valid.artifacts.filter((item) => item.kind !== "timeline")
    })).toContain("missing artifact kind timeline");
    expect(validateIssueCorpusScenario({
      ...valid,
      gold: { ...valid.gold, source: "comparator" as "human_adjudication" }
    })).toContain("gold source must be human_adjudication");
  });

  it("requires entailment and fails preservation, idempotency, and leak controls closed", () => {
    const base = {
      scenario: scenario(),
      candidate: {
        verifiedFacts: [{ claim: "The issue is open.", evidenceRefs: ["issue_body"] }],
        providerInvocations: 0,
        commentMutations: 0,
        stickyOutputHashes: ["same", "same"]
      },
      judgments: {
        factEntailment: [false],
        relatedWork: Array(60).fill(true),
        disposition: Array(60).fill(true),
        nextGate: Array(60).fill(true),
        labelProposals: Array(60).fill(true),
        limitations: Array(60).fill(true),
        novelVerifiedFacts: Array(60).fill(true)
      }
    };
    expect(evaluateIssueCorpus(base).passed).toBe(false);
    expect(evaluateIssueCorpus({ ...base, candidate: {
      ...base.candidate, providerInvocations: 1, commentMutations: 1, stickyOutputHashes: ["a", "b"]
    } }).failures).toEqual(expect.arrayContaining([
      "preservation provider invocation", "preservation comment mutation", "sticky output is not idempotent"
    ]));
    expect(evaluateIssueCorpus({
      ...base,
      candidate: { ...base.candidate, repositoryImpact: "private-policy-canary" },
      judgments: { ...base.judgments, factEntailment: [true] }
    }).failures).toContain("protected canary leaked");
    const passing = evaluateIssueCorpus({
      ...base,
      judgments: { ...base.judgments, factEntailment: [true] }
    });
    expect(passing.passed).toBe(true);
    expect(passing.metrics.relatedWork).toMatchObject({ successes: 60, total: 60, passed: true });
  });
});
