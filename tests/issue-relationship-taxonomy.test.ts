import { describe, expect, it } from "vitest";
import {
  buildIssueRelationshipClusters,
  classifyIssueRelationshipItem,
  ISSUE_RELATIONSHIP_CATEGORIES,
  PROOF_REQUIREMENTS,
  type IssueRelationshipClusterResult,
  type IssueRelationshipItemInput
} from "../src/issue-relationship-taxonomy.js";

describe("issue relationship taxonomy", () => {
  it("exports the deterministic category and proof requirement ids", () => {
    expect(ISSUE_RELATIONSHIP_CATEGORIES).toEqual([
      "blocker",
      "regression",
      "reproduction_gap",
      "stale_duplicate",
      "dependency",
      "release_risk",
      "docs_only",
      "needs_human_routing"
    ]);
    expect(PROOF_REQUIREMENTS).toEqual([
      "current_head_failure",
      "regression_fixture",
      "reproduction_steps",
      "freshness_check",
      "dependency_owner",
      "release_gate",
      "docs_scope",
      "human_triage"
    ]);
  });

  it("classifies stale duplicate and proof-gap issues without leaking private evidence", () => {
    const staleDuplicate = classifyIssueRelationshipItem({
      id: "issue-41",
      kind: "issue",
      number: 41,
      title: "Duplicate: stale repro from old worker queue",
      state: "closed",
      duplicateOf: "issue-17",
      updatedAt: "2026-06-01T00:00:00Z",
      publicSummary: "Old queue failure report superseded by #17.",
      evidenceUrls: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/17"],
      privateEvidence: ["ssh transcript /Volumes/LEXAR/private/raw.log"],
      rawLogs: ["example raw token placeholder"]
    });

    expect(staleDuplicate.category).toBe("stale_duplicate");
    expect(staleDuplicate.proofRequirements).toEqual(["freshness_check"]);
    expect(JSON.stringify(staleDuplicate)).not.toContain("raw.log");
    expect(JSON.stringify(staleDuplicate)).not.toContain("example raw token");

    const proofGap = classifyIssueRelationshipItem({
      id: "issue-42",
      kind: "issue",
      title: "Regression report is missing reproduction steps",
      body: "The queue fails sometimes but no command, head SHA, or fixture is attached.",
      publicSummary: "Needs a deterministic reproduction before routing to implementation.",
      evidenceUrls: []
    });

    expect(proofGap).toMatchObject({
      category: "reproduction_gap",
      proofRequirements: ["reproduction_steps"]
    });
  });

  it("classifies release risks before generic regressions", () => {
    const result = classifyIssueRelationshipItem({
      id: "pr-99",
      kind: "pull_request",
      number: 99,
      title: "Release blocker: appcast regression before beta tag",
      body: "Deploy would publish a beta without the release gate proof.",
      paths: ["docs/release-governance.md"],
      publicSummary: "Release proof is missing for a beta-facing path.",
      evidenceUrls: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/99"]
    });

    expect(result.category).toBe("release_risk");
    expect(result.proofRequirements).toEqual(["release_gate", "regression_fixture"]);
    expect(result.suggestedLabels).toEqual(["release-risk"]);
  });

  it("keeps category hints advisory when higher-risk signals are present", () => {
    const p0DocsHint = classifyIssueRelationshipItem({
      id: "issue-43",
      kind: "issue",
      title: "Docs typo reported as P0",
      paths: ["docs/SETUP.md"],
      severity: "P0",
      categoryHint: "docs_only"
    });

    expect(p0DocsHint).toMatchObject({
      category: "blocker",
      categoryHint: "docs_only",
      categoryHintHonored: false,
      proofRequirements: ["current_head_failure"],
      suggestedLabels: ["blocker"]
    });

    const duplicateReleaseBlocker = classifyIssueRelationshipItem({
      id: "issue-44",
      kind: "issue",
      title: "Duplicate report: release blocker in notarization gate",
      body: "Superseded by #40, but the beta release still cannot pass notarization.",
      duplicateOf: "issue-40"
    });

    expect(duplicateReleaseBlocker).toMatchObject({
      category: "release_risk",
      proofRequirements: ["release_gate"]
    });

    const p0Release = classifyIssueRelationshipItem({
      id: "issue-44b",
      kind: "issue",
      title: "Launchd beta release gate is down",
      severity: "P0",
      categoryHint: "release_risk"
    });

    expect(p0Release).toMatchObject({
      category: "blocker",
      categoryHint: "release_risk",
      categoryHintHonored: false,
      proofRequirements: ["current_head_failure"],
      suggestedLabels: ["blocker"]
    });
  });

  it("routes notarization and release-gate risks without over-triggering on release notes", () => {
    expect(classifyIssueRelationshipItem({
      id: "issue-45",
      kind: "issue",
      title: "Notarization fails before beta release",
      body: "The release gate cannot staple the app.",
      paths: ["docs/release-governance.md"]
    }).category).toBe("release_risk");

    expect(classifyIssueRelationshipItem({
      id: "issue-46",
      kind: "issue",
      title: "Release notes typo",
      body: "Fix wording in the release notes.",
      paths: ["docs/releases/v0.4.0.md"]
    }).category).toBe("docs_only");

    expect(classifyIssueRelationshipItem({
      id: "issue-47",
      kind: "issue",
      title: "Publish docs typo",
      body: "Document the production setup page before publishing the docs.",
      paths: ["docs/SETUP.md"]
    }).category).toBe("docs_only");

    expect(classifyIssueRelationshipItem({
      id: "issue-48",
      kind: "issue",
      title: "Bug in label parser",
      body: "Minor parser failure while reading a label.",
      paths: ["src/labels.ts"]
    }).category).toBe("needs_human_routing");

    expect(classifyIssueRelationshipItem({
      id: "issue-49",
      kind: "issue",
      title: "Worker queue regression fixture update",
      body: "The current fixture proves this regressed.",
      paths: ["src/worker.ts"]
    }).category).toBe("regression");

    expect(classifyIssueRelationshipItem({
      id: "issue-49b",
      kind: "issue",
      title: "package.json change is missing reproduction steps",
      body: "No command or fixture is attached.",
      paths: ["package.json"]
    }).category).toBe("reproduction_gap");

    expect(classifyIssueRelationshipItem({
      id: "issue-49c",
      kind: "issue",
      title: "docs package metadata typo",
      paths: ["docs/package.json"]
    }).category).toBe("docs_only");

    expect(classifyIssueRelationshipItem({
      id: "issue-49d",
      kind: "issue",
      title: "Update beta release gating notes",
      paths: ["docs/beta.md"]
    }).category).toBe("docs_only");
  });

  it("clusters related issues and PRs with public-safe relationship reasons", () => {
    const items: IssueRelationshipItemInput[] = [
      {
        id: "issue-50",
        kind: "issue",
        number: 50,
        title: "Worker queue regression lacks proof",
        body: "Queue regression is reported but no focused fixture is linked.",
        relationshipKeys: ["worker-queue"],
        paths: ["src/worker.ts"],
        publicSummary: "Regression report needs a fixture before implementation.",
        suggestedReviewers: ["queue-owner"],
        privateEvidence: ["local path /Volumes/LEXAR/private/queue.log"]
      },
      {
        id: "pr-51",
        kind: "pull_request",
        number: 51,
        title: "Fix worker queue regression",
        body: "Closes #50 with a fixture update.",
        relationshipKeys: ["worker-queue"],
        paths: ["tests/worker-failure.test.ts"],
        evidenceUrls: ["https://github.com/electricsheephq/evaos-code-review-bot-neondiff/pull/51"],
        publicSummary: "Candidate implementation linked to the proof gap.",
        suggestedLabels: ["needs-proof"]
      },
      {
        id: "issue-52",
        kind: "issue",
        number: 52,
        title: "Docs-only setup typo",
        paths: ["docs/SETUP.md"],
        publicSummary: "Documentation-only follow-up."
      }
    ];

    const result: IssueRelationshipClusterResult = buildIssueRelationshipClusters({ items });

    expect(result.publicIssueCommentState.clusters).toHaveLength(2);
    expect(result.publicIssueCommentState.clusters[0]).toMatchObject({
      id: "worker-queue",
      categories: ["reproduction_gap", "regression"],
      proofRequirements: ["reproduction_steps", "regression_fixture"],
      suggestedLabels: ["needs-proof"],
      suggestedReviewers: ["queue-owner"]
    });
    expect(result.publicIssueCommentState.clusters[0]?.whyItMatters).toContain("Multiple related records");
    expect(result.publicIssueCommentState.clusters[1]).toMatchObject({
      id: "standalone-issue-52",
      categories: ["docs_only"],
      proofRequirements: ["docs_scope"]
    });
    expect(result.privateEvidenceBoundary).toEqual({
      rawEvidenceOmitted: true,
      privateEvidenceItems: 1
    });
    expect(JSON.stringify(result.publicIssueCommentState)).not.toContain("/Volumes/LEXAR");
  });

  it("counts private fields that are sanitized out of public output", () => {
    const result = buildIssueRelationshipClusters({
      items: [
        {
          id: "issue-53",
          kind: "issue",
          title: "Local screenshot proves the failure",
          publicSummary: "Public summary is safe.",
          paths: ["/Volumes/LEXAR/private/screenshot.png"]
        }
      ]
    });

    expect(result.privateEvidenceBoundary).toEqual({
      rawEvidenceOmitted: true,
      privateEvidenceItems: 1
    });
    expect(result.publicIssueCommentState.clusters[0]?.items[0]?.publicPaths).toEqual([]);
  });

  it("redacts local paths from public text fields", () => {
    const result = classifyIssueRelationshipItem({
      id: "issue-54",
      kind: "issue",
      title: "Failure captured at /Volumes/LEXAR/private/raw.log and \\\\fileserver\\secrets\\config.env",
      publicSummary: "Repro notes live in ~/secrets/repro.md, ~, C:secrets.txt, C:\\secrets\\raw.log, /etc/passwd, /var/log/raw.log, /root/.env, /home/lume/.env, /mnt/share/raw.log, /opt/app/raw.log, /srv/app/raw.log, /Library/Logs/raw.log, and file:///tmp/raw.log.",
      paths: ["\\\\fileserver\\secrets\\config.env", "C:secrets.txt", "/etc/passwd"]
    });

    expect(result.title).toBe("Failure captured at [local-path-redacted] and [local-path-redacted]");
    expect(result.summary.match(/\[local-path-redacted\]/g)).toHaveLength(13);
    expect(result.publicPaths).toEqual([]);
    expect(JSON.stringify(result)).not.toContain("/Volumes/LEXAR");
    expect(JSON.stringify(result)).not.toContain("~/secrets");
    expect(JSON.stringify(result)).not.toContain("file:///tmp");
    expect(JSON.stringify(result)).not.toContain("\\\\fileserver");
    expect(JSON.stringify(result)).not.toContain("C:secrets");
    expect(JSON.stringify(result)).not.toContain("/etc/passwd");
  });

  it("documents single-item routing narratives", () => {
    const result = buildIssueRelationshipClusters({
      items: [
        {
          id: "stale-one",
          kind: "issue",
          title: "Duplicate of fresher queue report",
          duplicateOf: "queue-current"
        },
        {
          id: "release-one",
          kind: "issue",
          title: "Appcast release gate stalled before rollout"
        },
        {
          id: "proof-one",
          kind: "issue",
          title: "Worker issue lacks proof"
        },
        {
          id: "default-one",
          kind: "issue",
          title: "Needs owner routing"
        }
      ]
    });

    const byId = new Map(result.publicIssueCommentState.clusters.map((cluster) => [cluster.id, cluster.whyItMatters]));

    expect(byId.get("queue-current")).toContain("Stale duplicate routing");
    expect(byId.get("standalone-release-one")).toContain("Release-risk routing");
    expect(byId.get("standalone-proof-one")).toContain("Proof-gap routing");
    expect(byId.get("standalone-default-one")).toContain("Single-item routing records");
  });
});
