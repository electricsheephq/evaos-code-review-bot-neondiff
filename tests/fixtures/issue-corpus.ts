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
    artifacts: kinds.map((kind) => ({ id: `${kind}-${index}`, kind, sha256: SHA, complete: true })),
    gold: {
      provenance: "human_adjudication",
      protocolSha256: SHA,
      receiptSha256: (index + 1).toString(16).padStart(64, "0"),
      comparatorDerived: false
    }
  };
}

export function issueCorpusFixture() {
  return {
    schemaVersion: "neondiff-issue-corpus/v1",
    frozenAt: "2026-08-16T00:00:00.000Z",
    scenarios: Array.from({ length: 60 }, (_, index) => scenario(index))
  };
}
