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
