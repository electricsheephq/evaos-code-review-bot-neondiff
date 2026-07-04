import { describe, expect, it } from "vitest";
import {
  evaluatePreMergeChecks,
  validatePreMergeCheckPolicy,
  type PreMergeCheckPolicy
} from "../src/pre-merge-checks.js";

describe("pre-merge checks", () => {
  it("keeps warning checks out of blocking errors", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "WIP",
        body: "Tiny.",
        linkedIssues: []
      },
      policy: {
        title: { mode: "warning" },
        description: { mode: "warning" },
        linkedIssue: { mode: "error" }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.reviewEvent).toBe("REQUEST_CHANGES");
    expect(result.summary).toMatchObject({
      passed: 0,
      warnings: 2,
      blockingErrors: 1,
      skipped: 0
    });
    expect(result.warnings.map((warning) => warning.id)).toEqual(["title", "description"]);
    expect(result.blockingErrors.map((error) => error.id)).toEqual(["linked_issue"]);
    expect(result.warnings.every((warning) => warning.blocking === false)).toBe(true);
    expect(result.blockingErrors.every((error) => error.blocking === true)).toBe(true);
  });

  it("emits traceable deterministic evidence for built-in checks", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "Add billing export retry limits",
        body: "Closes #42\n\nValidation: focused tests passed.",
        linkedIssues: []
      },
      policy: {
        title: { mode: "error" },
        description: { mode: "error" },
        linkedIssue: { mode: "error" }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.reviewEvent).toBe("COMMENT");
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "title",
          status: "pass",
          evidence: expect.arrayContaining([
            expect.objectContaining({ key: "title.length", value: "31", passed: true })
          ])
        }),
        expect.objectContaining({
          id: "linked_issue",
          status: "pass",
          evidence: expect.arrayContaining([
            expect.objectContaining({ key: "linked_issue.references", value: "#42", passed: true })
          ])
        })
      ])
    );
  });

  it("does not treat normal Test or Testing titles as draft markers", () => {
    for (const title of ["Test runner config updates", "Testing infra improvements"]) {
      const result = evaluatePreMergeChecks({
        pull: {
          title,
          body: "Closes #42\n\nValidation: focused tests passed.",
          linkedIssues: [42]
        },
        policy: {
          title: { mode: "error" }
        }
      });

      expect(result.ok).toBe(true);
      expect(result.blockingErrors).toEqual([]);
      expect(result.checks.find((check) => check.id === "title")).toMatchObject({
        status: "pass",
        evidence: expect.arrayContaining([
          expect.objectContaining({ key: "title.not_draft_prefix", value: "true", passed: true })
        ])
      });
    }
  });

  it("requires structured open issue evidence when requireOpen is enabled", () => {
    const noRefs = evaluatePreMergeChecks({
      pull: {
        title: "Add pre-merge checks",
        body: "Validation: focused tests passed.",
        linkedIssues: []
      },
      policy: {
        linkedIssue: { mode: "error", requireOpen: true }
      }
    });

    expect(noRefs.ok).toBe(false);
    expect(noRefs.blockingErrors).toEqual([expect.objectContaining({ id: "linked_issue" })]);
    expect(noRefs.checks.find((check) => check.id === "linked_issue")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "linked_issue.references", value: "none", passed: false }),
        expect.objectContaining({ key: "linked_issue.open_state", value: "not_applicable", passed: false })
      ])
    );

    const closedIssue = evaluatePreMergeChecks({
      pull: {
        title: "Add pre-merge checks",
        body: "Validation: focused tests passed.",
        linkedIssues: [{ number: 42, state: "closed" }]
      },
      policy: {
        linkedIssue: { mode: "error", requireOpen: true }
      }
    });

    expect(closedIssue.ok).toBe(false);
    expect(closedIssue.checks.find((check) => check.id === "linked_issue")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "linked_issue.references", value: "#42", passed: true }),
        expect.objectContaining({ key: "linked_issue.open_state", value: "closed", passed: false })
      ])
    );
  });

  it("evaluates custom checks with deterministic matchers", () => {
    const policy: PreMergeCheckPolicy = {
      customChecks: [
        {
          name: "release-notes",
          mode: "warning",
          instructions: "Require a Release notes section in the PR description.",
          match: { source: "description", includes: "Release notes:" }
        },
        {
          name: "test-file",
          mode: "error",
          instructions: "Require a focused test file in the changed files.",
          match: { source: "changed_files", matches: "^tests/.+\\.test\\.ts$" }
        }
      ]
    };

    const result = evaluatePreMergeChecks({
      pull: {
        title: "Add pre-merge checks",
        body: "Release notes: none needed.",
        changedFiles: ["src/pre-merge-checks.ts", "docs/pre-merge-checks.md"]
      },
      policy
    });

    expect(result.warnings).toEqual([]);
    expect(result.blockingErrors).toEqual([
      expect.objectContaining({
        id: "custom:test-file",
        mode: "error",
        status: "fail",
        blocking: true
      })
    ]);
    expect(result.checks.find((check) => check.id === "custom:release-notes")).toMatchObject({
      status: "pass",
      blocking: false
    });
  });

  it("does not echo raw PR title body or changed-file values in custom matcher evidence", () => {
    const bodySecret = "Release notes: customer private rollout detail";
    const titleSecret = "Customer private launch checklist";
    const fileSecret = "docs/customer-private-rollout-plan.md";
    const result = evaluatePreMergeChecks({
      pull: {
        title: titleSecret,
        body: bodySecret,
        changedFiles: [fileSecret]
      },
      policy: {
        customChecks: [
          {
            name: "body-marker",
            mode: "warning",
            instructions: "Require release notes marker in the PR body.",
            match: { source: "description", includes: "Release notes:" }
          },
          {
            name: "title-marker",
            mode: "warning",
            instructions: "Require private launch wording in the title.",
            match: { source: "title", includes: "private launch" }
          },
          {
            name: "file-marker",
            mode: "warning",
            instructions: "Require matching docs path without echoing it.",
            match: { source: "changed_files", matches: "customer-private" }
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    const evidenceJson = JSON.stringify(result.checks.flatMap((check) => check.evidence));
    expect(evidenceJson).not.toContain(bodySecret);
    expect(evidenceJson).not.toContain(titleSecret);
    expect(evidenceJson).not.toContain(fileSecret);
    expect(result.checks.map((check) => check.evidence[0]?.value)).toEqual(["matched", "matched", "matched"]);
  });

  it("treats off checks as skipped without producing warnings or errors", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "",
        body: "",
        linkedIssues: []
      },
      policy: {
        title: { mode: "off" },
        description: { mode: "off" },
        linkedIssue: { mode: "off" },
        customChecks: [
          {
            name: "ignored-check",
            mode: "off",
            instructions: "Require a marker that is not present.",
            match: { source: "description", includes: "must-not-run" }
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.summary).toMatchObject({ passed: 0, warnings: 0, blockingErrors: 0, skipped: 4 });
    expect(result.warnings).toEqual([]);
    expect(result.blockingErrors).toEqual([]);
    expect(result.checks.every((check) => check.status === "skipped")).toBe(true);
  });

  it("validates custom check names, instructions, modes, and matchers", () => {
    const validation = validatePreMergeCheckPolicy({
      customChecks: [
        {
          name: "Bad Name",
          mode: "warning",
          instructions: "Ask the model to judge whether the PR seems safe.",
          match: { source: "description", includes: "" }
        },
        {
          name: "good-name",
          mode: "error",
          instructions: "Require a literal marker in the title.",
          match: { source: "title", matches: "[" }
        },
        {
          name: "ambiguous-match",
          mode: "warning",
          instructions: "Require exactly one custom matcher operator.",
          match: { source: "description", includes: "Release notes:", matches: "Release notes:" }
        }
      ]
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "custom:Bad Name", field: "name" }),
        expect.objectContaining({ check: "custom:Bad Name", field: "instructions" }),
        expect.objectContaining({ check: "custom:Bad Name", field: "match.includes" }),
        expect.objectContaining({ check: "custom:good-name", field: "match.matches" }),
        expect.objectContaining({ check: "custom:ambiguous-match", field: "match" })
      ])
    );
  });
});
