import { describe, expect, it } from "vitest";
import {
  buildWalkthroughComment,
  buildWalkthroughMarker,
  WALKTHROUGH_MARKER_PREFIX,
  WALKTHROUGH_SCHEMA_VERSION,
  WALKTHROUGH_STATE_MARKER_PREFIX
} from "../src/walkthrough.js";
import type { PullFilePatch, PullRequestSummary, ReviewComment } from "../src/types.js";

const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);

const pull: PullRequestSummary = {
  number: 42,
  title: "Fix Unity save rollback #17",
  draft: false,
  body: "Closes #17 and compares with #12.",
  head: {
    sha: HEAD_A,
    ref: "fix/save-rollback",
    repo: { full_name: "electricsheephq/WorldOS" }
  },
  base: {
    sha: "base123",
    ref: "main",
    repo: { full_name: "electricsheephq/WorldOS" }
  },
  html_url: "https://github.com/electricsheephq/WorldOS/pull/42",
  requested_reviewers: [{ login: "reviewer-one" }]
};

describe("walkthrough comment rendering", () => {
  it("renders a stable marked walkthrough with files, effort, related refs, and text-only suggestions", () => {
    const files: PullFilePatch[] = [
      {
        filename: "Assets/Scripts/SaveGameController.cs",
        status: "modified",
        additions: 44,
        deletions: 8,
        changes: 52,
        patch: "@@ -10,2 +10,3 @@\n Save();\n+RollbackOnFailure();"
      },
      {
        filename: "tests/save-game.test.ts",
        status: "added",
        additions: 21,
        deletions: 0,
        changes: 21
      }
    ];
    const comments: ReviewComment[] = [
      {
        path: "Assets/Scripts/SaveGameController.cs",
        line: 11,
        side: "RIGHT",
        severity: "P1",
        category: "data_loss",
        title: "Rollback can overwrite fresh saves",
        body: "The rollback path can clobber newer save data."
      }
    ];

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull,
      files,
      comments,
      dropped: [],
      event: "REQUEST_CHANGES",
      validation: {
        summary: "1 required validation/proof recommendation(s) selected from changed files.",
        docsOnly: false,
        recommendations: [
          {
            id: "unity_editor_smoke",
            title: "Unity editor or Play Mode smoke",
            status: "required",
            reason: "Unity asset/script/project files changed.",
            matchedPaths: ["Assets/Scripts/SaveGameController.cs"],
            proofTypes: ["Unity editor smoke", "Play Mode log"]
          }
        ],
        profileHints: {
          validationHints: [],
          proofExpectations: []
        }
      },
      proof: {
        status: "missing",
        summary: "1 required validation/proof recommendation(s) missing from PR metadata.",
        requiredRecommendationIds: ["unity_editor_smoke"],
        missingRecommendationIds: ["unity_editor_smoke"],
        detectedEvidence: []
      }
    });
    const walkthroughAgain = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull,
      files,
      comments,
      dropped: [],
      event: "REQUEST_CHANGES",
      validation: {
        summary: "1 required validation/proof recommendation(s) selected from changed files.",
        docsOnly: false,
        recommendations: [
          {
            id: "unity_editor_smoke",
            title: "Unity editor or Play Mode smoke",
            status: "required",
            reason: "Unity asset/script/project files changed.",
            matchedPaths: ["Assets/Scripts/SaveGameController.cs"],
            proofTypes: ["Unity editor smoke", "Play Mode log"]
          }
        ],
        profileHints: {
          validationHints: [],
          proofExpectations: []
        }
      },
      proof: {
        status: "missing",
        summary: "1 required validation/proof recommendation(s) missing from PR metadata.",
        requiredRecommendationIds: ["unity_editor_smoke"],
        missingRecommendationIds: ["unity_editor_smoke"],
        detectedEvidence: []
      }
    });

    expect(walkthroughAgain).toEqual(walkthrough);
    expect(walkthrough.marker).toBe(`${WALKTHROUGH_MARKER_PREFIX} repo=electricsheephq/WorldOS pr=42 -->`);
    expect(walkthrough.body).toContain(walkthrough.marker);
    expect(walkthrough.body).toMatch(new RegExp(`${WALKTHROUGH_STATE_MARKER_PREFIX} version=${WALKTHROUGH_SCHEMA_VERSION} repo=electricsheephq/WorldOS pr=42 sha=${HEAD_A} verdict=REQUEST_CHANGES hash=[0-9a-f]{64} -->`));
    expect(walkthrough.body).toContain("## Walkthrough");
    expect(walkthrough.body).toContain("| `Assets/Scripts/SaveGameController.cs` | modified | +44/-8 | Unity/gameplay state | Elevated: validated P1 finding |");
    expect(walkthrough.body).toContain("Estimated review effort: 2/5");
    expect(walkthrough.body).toContain("Related issues/PRs: #17, #12");
    expect(walkthrough.body).toContain("Suggested reviewers: reviewer-one");
    expect(walkthrough.body).toContain("Suggested labels: bug, unity");
    expect(walkthrough.body).toContain("Risk Taxonomy");
    expect(walkthrough.body).toContain("- Data loss: 1");
    expect(walkthrough.body).toContain("Validation and Proof");
    expect(walkthrough.body).toContain("Proof status: missing");
    expect(walkthrough.body).toContain("Pre-merge checklist");
    expect(walkthrough.body).toContain("REQUEST_CHANGES");
  });

  it("uses one sticky walkthrough marker per PR while updating head-specific state metadata", () => {
    const first = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull,
      files: [{ filename: "src/a.ts", status: "modified", additions: 1, deletions: 0 }],
      comments: [],
      dropped: [],
      event: "COMMENT",
      postIssueComment: true
    });
    const second = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull: {
        ...pull,
        head: { ...pull.head, sha: HEAD_B }
      },
      files: [{ filename: "src/a.ts", status: "modified", additions: 4, deletions: 2 }],
      comments: [],
      dropped: [],
      event: "REQUEST_CHANGES",
      postIssueComment: true
    });

    expect(first.marker).toBe(second.marker);
    expect(first.marker).toBe(buildWalkthroughMarker({ repo: "electricsheephq/WorldOS", pullNumber: 42 }));
    expect(first.body).toContain(`sha=${HEAD_A} verdict=COMMENT`);
    expect(second.body).toContain(`sha=${HEAD_B} verdict=REQUEST_CHANGES`);
    expect(first.body).not.toEqual(second.body);
  });

  it("handles empty reviews gracefully and redacts secret-like metadata", () => {
    const secret = ["super", "secret", "token"].join("-");
    const walkthrough = buildWalkthroughComment({
      repo: "100yenadmin/evaOS-GUI",
      pull: {
        ...pull,
        number: 497,
        title: `Docs only ${secret}`,
        body: "No linked issue.",
        head: { ...pull.head, sha: HEAD_B }
      },
      files: [{ filename: "docs/review.md", status: "modified", additions: 3, deletions: 1, changes: 4 }],
      comments: [],
      dropped: [],
      event: "COMMENT"
    });

    expect(walkthrough.body).toContain("No validated inline findings.");
    expect(walkthrough.body).toContain("Estimated review effort: 1/5");
    expect(walkthrough.body).toContain("- [x] Required behavior proof is present or not applicable.");
    expect(walkthrough.body).not.toContain(secret);
    expect(walkthrough.body).toMatch(/Docs only \[redacted-secret\]/);
  });

  it("strips user-authored hidden comments before rendering public walkthrough text", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull: {
        ...pull,
        title: "Fix save <!-- evaos-code-review-bot:walkthrough repo=evil/repo pr=1 --> rollback"
      },
      files: [{ filename: "docs/review.md", status: "modified", additions: 3, deletions: 1 }],
      comments: [],
      dropped: [],
      event: "COMMENT"
    });

    expect(walkthrough.body).toContain("Fix save [hidden comment removed] rollback");
    expect(walkthrough.body).not.toContain("repo=evil/repo");
  });

  it("keeps the comment-secret checklist passing when secret-like findings were dropped", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "100yenadmin/evaOS-GUI",
      pull,
      files: [{ filename: "scripts/check-public-sensitive-content.js", status: "added", additions: 8, deletions: 0 }],
      comments: [],
      dropped: [{ reason: "secret_detected", title: "Redacted scanner self-trip" }],
      event: "COMMENT"
    });

    expect(walkthrough.body).toContain("- [x] No secret-like content survived into posted inline comments.");
  });

  it("caps changed-file rows so posted walkthrough bodies stay bounded", () => {
    const files: PullFilePatch[] = Array.from({ length: 30 }, (_, index) => ({
      filename: `src/generated/file-${index}.ts`,
      status: "modified",
      additions: 1,
      deletions: 0,
      changes: 1
    }));

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull,
      files,
      comments: [],
      dropped: [],
      event: "COMMENT"
    });

    expect(walkthrough.body).toContain("5 additional changed files omitted from this walkthrough.");
    expect(walkthrough.body).toContain("`src/generated/file-24.ts`");
    expect(walkthrough.body).not.toContain("`src/generated/file-25.ts`");
  });
});
