import { describe, expect, it } from "vitest";
import { buildChangedSurfaceValidationReport, evaluateProofRequirements } from "../src/validation-selector.js";
import type { PullFilePatch, PullRequestSummary } from "../src/types.js";

describe("changed-surface validation selector", () => {
  it("selects Unity proof for WorldOS runtime surfaces", () => {
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/WorldOS",
      pull: pull({ body: "" }),
      files: [
        { filename: "Assets/Scenes/Main.unity", additions: 10, deletions: 1 },
        { filename: "Assets/Scripts/SaveController.cs", additions: 5, deletions: 0 }
      ]
    });

    expect(validation.docsOnly).toBe(false);
    expect(validation.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "unity_editor_smoke", status: "required" })
      ])
    );
  });

  it("treats docs-only changes as not requiring runtime proof", () => {
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: pull({ body: "" }),
      files: [{ filename: "docs/operator-cli.md", additions: 4, deletions: 1 }]
    });
    const proof = evaluateProofRequirements({ pull: pull({ body: "" }), validation });

    expect(validation.docsOnly).toBe(true);
    expect(validation.summary).toContain("Documentation-only");
    expect(validation.recommendations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "bot_focused_tests" })])
    );
    expect(proof.status).toBe("not_applicable");
  });

  it("requires focused bot tests and detects proof from PR metadata", () => {
    const pullWithProof = pull({
      body: "Validation: focused Vitest passed and npm run build passed. release:status is green."
    });
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: pullWithProof,
      files: [
        { filename: "src/worker.ts", additions: 12, deletions: 2 },
        { filename: "tests/worker.test.ts", additions: 20, deletions: 0 }
      ]
    });
    const proof = evaluateProofRequirements({ pull: pullWithProof, validation });

    expect(validation.recommendations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "typescript_build", status: "required" }),
        expect.objectContaining({ id: "bot_focused_tests", status: "required" })
      ])
    );
    expect(proof.status).toBe("sufficient");
    expect(proof.detectedEvidence).toEqual(expect.arrayContaining(["build/typecheck", "tests", "release/operator checks"]));
  });

  it("requires both focused tests and build evidence for bot runtime changes", () => {
    const weakBodies = [
      "Validation: npm run build passed. release:status is green.",
      "Validation: focused Vitest passed. release:status is green."
    ];

    for (const body of weakBodies) {
      const validation = buildChangedSurfaceValidationReport({
        repo: "electricsheephq/evaos-code-review-bot",
        pull: pull({ body }),
        files: [{ filename: "src/worker.ts", additions: 1, deletions: 0 }]
      });
      const proof = evaluateProofRequirements({ pull: pull({ body }), validation });

      expect(proof.status).toBe("missing");
      expect(proof.missingRecommendationIds).toContain("bot_focused_tests");
    }
  });

  it("does not treat near-miss repo names as WorldOS", () => {
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/worldos-utils",
      pull: pull({ body: "" }),
      files: [{ filename: "src/index.ts", additions: 1, deletions: 0 }]
    });

    expect(validation.recommendations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "unity_editor_smoke" })])
    );
  });

  it("does not accept unrelated historical proof wording as current proof", () => {
    const pullWithWeakProof = pull({
      body: "The previous build passed but we reverted that branch. No current validation was run."
    });
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: pullWithWeakProof,
      files: [{ filename: "src/worker.ts", additions: 1, deletions: 0 }]
    });
    const proof = evaluateProofRequirements({ pull: pullWithWeakProof, validation });

    expect(proof.status).toBe("missing");
    expect(proof.detectedEvidence).toEqual([]);
  });

  it("does not accept unrelated CI or negated test wording as proof", () => {
    const weakBodies = [
      "The CI passed on main but fails on this branch.",
      "Ran vitest, that's not ok, tests are failing."
    ];

    for (const body of weakBodies) {
      const pullWithWeakProof = pull({ body });
      const validation = buildChangedSurfaceValidationReport({
        repo: "electricsheephq/evaos-code-review-bot",
        pull: pullWithWeakProof,
        files: [{ filename: "src/worker.ts", additions: 1, deletions: 0 }]
      });
      const proof = evaluateProofRequirements({ pull: pullWithWeakProof, validation });

      expect(proof.status).toBe("missing");
      expect(proof.detectedEvidence).toEqual([]);
    }
  });

  it("does not count negated Unity visual proof as evidence", () => {
    const pullWithNegatedProof = pull({
      body: "No screenshot or recording was captured."
    });
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/WorldOS",
      pull: pullWithNegatedProof,
      files: [{ filename: "Assets/Scenes/Main.unity", additions: 1, deletions: 0 }]
    });
    const proof = evaluateProofRequirements({ pull: pullWithNegatedProof, validation });

    expect(proof.status).toBe("missing");
    expect(proof.detectedEvidence).toEqual([]);
  });

  it("matches nested package and TypeScript config paths", () => {
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/electric-sheep-website-dashboard-6158a244",
      pull: pull({ body: "" }),
      files: [
        { filename: "packages/ui/package.json", additions: 1, deletions: 1 },
        { filename: "packages/ui/tsconfig.json", additions: 1, deletions: 0 }
      ]
    });

    expect(validation.recommendations).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "typescript_build", status: "required" })])
    );
  });

  it("does not treat ordinary release-named source files as release surfaces", () => {
    const validation = buildChangedSurfaceValidationReport({
      repo: "electricsheephq/electric-sheep-website-dashboard-6158a244",
      pull: pull({ body: "" }),
      files: [{ filename: "components/ReleaseBanner.tsx", additions: 1, deletions: 0 }]
    });

    expect(validation.recommendations).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "ci_release_smoke" })])
    );
  });
});

function pull(input: { body: string }): PullRequestSummary {
  return {
    number: 1,
    title: "Test PR",
    body: input.body,
    draft: false,
    head: {
      sha: "head",
      ref: "branch"
    },
    base: {
      sha: "base",
      ref: "main",
      repo: {
        full_name: "owner/repo"
      }
    },
    html_url: "https://github.test/owner/repo/pull/1"
  };
}
