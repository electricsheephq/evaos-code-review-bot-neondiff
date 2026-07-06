import { describe, expect, it } from "vitest";
import {
  buildWalkthroughComment,
  buildWalkthroughMarker,
  WALKTHROUGH_MARKER_PREFIX,
  WALKTHROUGH_SCHEMA_VERSION,
  WALKTHROUGH_STATE_MARKER_PREFIX
} from "../src/walkthrough.js";
import { applyDeterministicReviewGate } from "../src/review-gate.js";
import type { ReviewSettingsPreview } from "../src/repo-policy.js";
import type { Finding, PullFilePatch, PullRequestSummary, ReviewComment } from "../src/types.js";

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

function expectPathInstructionCodeSpan(body: string, expectedContent: string): void {
  const line = body.split("\n").find((candidate) => candidate.startsWith("- Path instructions: "));
  expect(line).toBeDefined();
  const remainder = line!.slice("- Path instructions: ".length);
  const delimiter = remainder.match(/^`+/)?.[0];
  expect(delimiter).toBeDefined();
  const closingIndex = remainder.indexOf(delimiter!, delimiter!.length);
  expect(closingIndex).toBeGreaterThan(delimiter!.length - 1);
  expect(remainder.slice(delimiter!.length, closingIndex)).toBe(expectedContent);
  expect(remainder.slice(closingIndex + delimiter!.length)).toMatch(/^ - /);
}

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
        confidence: 0.9,
        title: "Rollback can overwrite fresh saves",
        body: "The rollback path can clobber newer save data.",
        fingerprint: `finding:${"0".repeat(64)}`
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
      },
      provider: {
        providerId: "zcode-glm",
        adapter: "zcode",
        displayName: "GLM / Z.ai",
        model: "GLM-5.2"
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
      },
      provider: {
        providerId: "zcode-glm",
        adapter: "zcode",
        displayName: "GLM / Z.ai",
        model: "GLM-5.2"
      }
    });

    expect(walkthroughAgain).toEqual(walkthrough);
    expect(walkthrough.marker).toBe(`${WALKTHROUGH_MARKER_PREFIX} repo=electricsheephq/WorldOS pr=42 -->`);
    expect(walkthrough.body).toContain(walkthrough.marker);
    expect(walkthrough.body).toMatch(new RegExp(`${WALKTHROUGH_STATE_MARKER_PREFIX} version=${WALKTHROUGH_SCHEMA_VERSION} repo=electricsheephq/WorldOS pr=42 sha=${HEAD_A} verdict=REQUEST_CHANGES hash=[0-9a-f]{64} -->`));
    expect(walkthrough.body).toContain("## Walkthrough");
    expect(walkthrough.body).toContain("| `Assets/Scripts/SaveGameController.cs` | modified | +44/-8 | Unity/gameplay state | Elevated: validated P1 finding |");
    expect(walkthrough.body).toContain("Estimated review effort: 2/5");
    expect(walkthrough.body).toContain("Provider: GLM / Z.ai (`zcode-glm`, zcode, model `GLM-5.2`).");
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

  it("renders the review UX fixture walkthrough from validated inline findings and dropped evidence", () => {
    const files: PullFilePatch[] = [
      {
        filename: "src/save.ts",
        status: "modified",
        additions: 2,
        deletions: 0,
        changes: 2,
        patch: "@@ -1,2 +1,4 @@\n export function save() {\n+  overwriteAllData();\n+  auditSave();\n }"
      }
    ];
    const findings: Finding[] = [
      {
        severity: "P1",
        category: "data_loss",
        path: "src/save.ts",
        line: 2,
        title: "Save can overwrite state",
        body: "The new write can overwrite newer customer state.",
        confidence: 0.93
      },
      {
        severity: "P1",
        category: "data_loss",
        path: "src/save.ts",
        line: 99,
        title: "Invalid line",
        body: "This finding points outside the current diff.",
        confidence: 0.93
      }
    ];
    const gate = applyDeterministicReviewGate({ files, findings, droppedFromSchema: [{ reason: "invalid_schema" }] });
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        number: 110,
        title: "Review UX fixture",
        body: "Refs #110.",
        head: {
          sha: HEAD_A,
          ref: "fixture-review-ux",
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files,
      comments: gate.comments,
      dropped: gate.dropped,
      event: gate.event,
      provider: {
        providerId: "zcode-glm",
        adapter: "zcode",
        model: "GLM-5.2"
      },
      postIssueComment: true
    });

    expect(gate.event).toBe("REQUEST_CHANGES");
    expect(gate.comments).toHaveLength(1);
    expect(gate.dropped).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "invalid_schema" }),
        expect.objectContaining({ reason: "line_not_in_current_diff" })
      ])
    );
    expect(walkthrough.postIssueComment).toBe(true);
    expect(walkthrough.body).toContain("PR: electricsheephq/evaos-code-review-bot#110 - Review UX fixture");
    expect(walkthrough.body).toContain("Provider: (`zcode-glm`, zcode, model `GLM-5.2`).");
    expect(walkthrough.body).toContain("| `src/save.ts` | modified | +2/-0 | Runtime code | Elevated: validated P1 finding |");
    expect(walkthrough.body).toContain("Validated inline findings: 1 (P0: 0, P1: 1, P2: 0, P3: 0).");
    expect(walkthrough.body).toContain("Dropped findings before posting: 2.");
    expect(walkthrough.body).toContain("REQUEST_CHANGES is only used when eligible P0/P1 findings survive validation.");
  });

  it("renders CodeRabbit-style settings parity as preview-only walkthrough metadata", () => {
    const settingsPreview: ReviewSettingsPreview = {
      profile: "assertive",
      sections: [
        { key: "reviewSummary", label: "Review summary", enabled: true, mode: "inline_review" },
        { key: "walkthrough", label: "Walkthrough", enabled: true, mode: "issue_comment" },
        { key: "changedFiles", label: "Changed-files table", enabled: true, mode: "walkthrough" },
        { key: "effortEstimate", label: "Effort estimate", enabled: true, mode: "walkthrough" },
        { key: "statusComment", label: "Review status comment", enabled: true, mode: "sticky_status" }
      ],
      pathInstructions: [
        { pattern: "src/**", instructions: ["Prioritize runtime correctness and duplicate-posting regressions."] }
      ],
      suggestions: {
        labels: ["review-settings"],
        reviewers: ["maintainer-one"],
        autoApply: false
      },
      roadmapOnly: ["auto-apply labels", "auto-request reviewers"]
    };

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/worker.ts", status: "modified", additions: 5, deletions: 1, changes: 6 }],
      comments: [],
      dropped: [],
      event: "COMMENT",
      settingsPreview
    });

    expect(walkthrough.body).toContain("### Review Settings Preview");
    expect(walkthrough.body).toContain("- Profile: assertive");
    expect(walkthrough.body).toContain("- Enabled sections: Review summary (inline_review); Walkthrough (issue_comment); Changed-files table (walkthrough); Effort estimate (walkthrough); Review status comment (sticky_status)");
    expect(walkthrough.body).toContain("- Path instructions: `src/**` - Prioritize runtime correctness and duplicate-posting regressions.");
    expect(walkthrough.body).toContain("- Label suggestions: review-settings");
    expect(walkthrough.body).toContain("- Reviewer suggestions: maintainer-one");
    expect(walkthrough.body).toContain("- Suggestion behavior: suggestions only; labels and reviewers are not auto-applied.");
    expect(walkthrough.body).toContain("- Roadmap-only settings: auto-apply labels; auto-request reviewers");
    expect(walkthrough.body).not.toContain("auto-apply enabled");
    expect(walkthrough.body).not.toContain("auto-request reviewers enabled");
    expect(walkthrough.body).not.toContain("labels were auto-applied");
  });

  it("redacts secrets and escapes markdown backticks in settings preview metadata", () => {
    const secretLikeToken = "ghp_fake_token";
    const settingsPreview: ReviewSettingsPreview = {
      profile: "assertive",
      sections: [
        { key: "reviewSummary", label: "Review summary", enabled: true, mode: "inline_review" }
      ],
      pathInstructions: [
        {
          pattern: "src/`templates`/**",
          instructions: [`Never quote ${secretLikeToken} in review output.`]
        }
      ],
      suggestions: {
        labels: [`token-${secretLikeToken}`],
        reviewers: ["maintainer-one"],
        autoApply: false
      },
      roadmapOnly: []
    };

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/walkthrough.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      comments: [],
      dropped: [],
      event: "COMMENT",
      provider: {
        providerId: "openai-compatible",
        adapter: "openai-compatible",
        displayName: `Gateway ${secretLikeToken}`,
        model: `review-${secretLikeToken}`
      },
      settingsPreview
    });

    expectPathInstructionCodeSpan(walkthrough.body, "src/`templates`/**");
    expect(walkthrough.body).not.toContain(secretLikeToken);
    expect(walkthrough.body).toContain("[redacted-secret]");
    expect(walkthrough.body).toContain("Provider: Gateway [redacted-secret] (`openai-compatible`, openai-compatible, model `review-[redacted-secret]`).");
  });

  it("uses variable-length code spans for backticks inside inline-code markdown", () => {
    const settingsPreview: ReviewSettingsPreview = {
      profile: "assertive",
      sections: [
        { key: "reviewSummary", label: "Review summary", enabled: true, mode: "inline_review" }
      ],
      pathInstructions: [
        {
          pattern: "src/path\\`template\\`/**",
          instructions: ["Keep inline code markdown intact."]
        }
      ],
      suggestions: {
        labels: [],
        reviewers: [],
        autoApply: false
      },
      roadmapOnly: []
    };

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/walkthrough.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      comments: [],
      dropped: [],
      event: "COMMENT",
      provider: {
        providerId: "provider`id",
        adapter: "openai-compatible",
        model: "model`name"
      },
      settingsPreview
    });

    expectPathInstructionCodeSpan(walkthrough.body, "src/path\\`template\\`/**");
    expect(walkthrough.body).toContain("Provider: (``provider`id``, openai-compatible, model ``model`name``).");
  });

  it("sanitizes confidence settings preview metadata while preserving ordinary likely wording", () => {
    const settingsPreview: ReviewSettingsPreview = {
      profile: "assertive",
      sections: [
        { key: "reviewSummary", label: "Review summary 95% confidence", enabled: true, mode: "inline_review" }
      ],
      pathInstructions: [
        {
          pattern: "src/confidence-95%.ts",
          instructions: ["Treat this as 0.91 likely after historical calibration."]
        }
      ],
      suggestions: {
        labels: ["confidence-95%"],
        reviewers: ["reviewer-0.91-likely"],
        autoApply: false
      },
      roadmapOnly: ["show 95% confidence after calibration"]
    };

    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/walkthrough.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      comments: [],
      dropped: [],
      event: "COMMENT",
      settingsPreview
    });

    expect(walkthrough.body).toContain("confidence not calibrated");
    expect(walkthrough.body).not.toContain("95% confidence");
    expect(walkthrough.body).not.toContain("confidence-95%");
    expect(walkthrough.body).toContain("0.91 likely");
    expect(walkthrough.body).toContain("0.91-likely");
  });

  it("does not surface raw confidence-bearing finding text in visible walkthrough prose", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        title: "Review confidence output",
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/walkthrough.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      comments: [
        {
          path: "src/walkthrough.ts",
          line: 51,
          side: "RIGHT",
          severity: "P3",
          category: "security_boundary",
          confidence: 0.91,
          title: "Confidence: 95% should never be quoted",
          body: "The model says 0.91 reliability in raw finding prose.",
          fingerprint: `finding:${"0".repeat(64)}`
        }
      ],
      dropped: [],
      event: "COMMENT"
    });

    expect(walkthrough.body).not.toContain("Confidence: 95% should never be quoted");
    expect(walkthrough.body).not.toContain("0.91 reliability");
    expect(walkthrough.body).toContain("Validated inline findings: 1");
    expect(walkthrough.body).toContain("- Security boundary: 1");
  });

  it("omits settings preview cleanly when no settings metadata is provided", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/evaos-code-review-bot",
      pull: {
        ...pull,
        head: {
          ...pull.head,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        },
        base: {
          ...pull.base,
          repo: { full_name: "electricsheephq/evaos-code-review-bot" }
        }
      },
      files: [{ filename: "src/walkthrough.ts", status: "modified", additions: 2, deletions: 1, changes: 3 }],
      comments: [],
      dropped: [],
      event: "COMMENT"
    });

    expect(walkthrough.body).not.toContain("### Review Settings Preview");
    expect(walkthrough.body).toContain("Suggested reviewers: reviewer-one.\n\n### Pre-merge checklist");
    expect(walkthrough.body).not.toMatch(/Suggested reviewers:[^\n]*\n\n\n### Pre-merge checklist/);
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

  it("strips public confidence percentages from walkthrough metadata by default", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull: {
        ...pull,
        title: "Review confidence 95%",
        body: "No linked issue."
      },
      files: [{ filename: "src/review.ts", status: "modified", additions: 4, deletions: 1 }],
      comments: [
        {
          path: "src/review.ts",
          line: 4,
          side: "RIGHT",
          severity: "P2",
          category: "runtime_correctness",
          confidence: 0.88,
          title: "Model says 88% confidence",
          body: "Confidence: 88%. The model is 0.88 confident.",
          fingerprint: `finding:${"0".repeat(64)}`
        }
      ],
      dropped: [],
      event: "COMMENT",
      validation: {
        summary: "Confidence 95% from validation summary.",
        docsOnly: false,
        recommendations: [
          {
            id: "focused_tests",
            title: "Run focused tests with 90% confidence",
            status: "recommended",
            reason: "Confidence: 90%.",
            matchedPaths: ["src/review.ts"],
            proofTypes: ["unit test"]
          }
        ],
        profileHints: {
          validationHints: ["Confidence: 91%."],
          proofExpectations: ["0.91 confident proof."]
        }
      }
    });

    expect(walkthrough.body).toContain("Review [confidence not calibrated]");
    expect(walkthrough.body).toContain("Confidence: [confidence not calibrated].");
    expect(walkthrough.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
    expect(walkthrough.body).not.toContain("0.91 confident");
  });

  it("keeps PR title replacement text whole while preserving raw comment-derived signal", () => {
    const walkthrough = buildWalkthroughComment({
      repo: "electricsheephq/WorldOS",
      pull: {
        ...pull,
        title: `${"b".repeat(176)} Confidence: 95%.`,
        body: "No linked issue."
      },
      files: [{ filename: "src/review.ts", status: "modified", additions: 4, deletions: 1 }],
      comments: [
        {
          path: "src/review.ts",
          line: 4,
          side: "RIGHT",
          severity: "P1",
          category: "runtime_correctness",
          confidence: 0.91,
          title: "Regression with 99% confidence",
          body: "Model body says `0.91` likely.",
          fingerprint: `finding:${"0".repeat(64)}`
        }
      ],
      dropped: [],
      event: "REQUEST_CHANGES"
    });

    const title = walkthrough.body.match(new RegExp(`PR: electricsheephq/WorldOS#${pull.number} - (.+)`))?.[1] ?? "";
    expect(title).toHaveLength(200);
    expect(walkthrough.body).toContain("Validated inline findings: 1 (P0: 0, P1: 1, P2: 0, P3: 0).");
    expect(walkthrough.body).toContain("Elevated: validated P1 finding");
    expect(walkthrough.body).not.toMatch(/\b\d+(?:\.\d+)?\s*%/);
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
