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

    const mixedIssues = evaluatePreMergeChecks({
      pull: {
        title: "Add pre-merge checks",
        body: "Validation: focused tests passed.",
        linkedIssues: [
          { number: 42, state: "open" },
          { number: 43, state: "closed" }
        ]
      },
      policy: {
        linkedIssue: { mode: "error", requireOpen: true }
      }
    });

    expect(mixedIssues.ok).toBe(false);
    expect(mixedIssues.checks.find((check) => check.id === "linked_issue")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "linked_issue.references", value: "#42, #43", passed: true }),
        expect.objectContaining({ key: "linked_issue.open_state", value: "open,closed", passed: false })
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

  it("supports title_or_description and normalized linked issue refs", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "Add runtime policy",
        body: "Closes electricsheephq/evaos-code-review-bot#118 and refs #123.",
        linkedIssueRefs: ["100yenadmin/evaOS-GUI#497", "456"],
        changedFiles: ["src/pre-merge-checks.ts"]
      },
      policy: {
        linkedIssue: { mode: "error" },
        customChecks: [
          {
            name: "runtime-wording",
            mode: "error",
            instructions: "Require runtime wording in the title or description.",
            match: { source: "title_or_description", includes: "runtime" }
          },
          {
            name: "tracked-issue",
            mode: "error",
            instructions: "Require a deterministic linked issue reference.",
            match: { source: "linked_issue_refs", includes: "#497" }
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "linked_issue")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "linked_issue.references", value: "#118, #123, #456, #497", passed: true })
      ])
    );
    expect(result.checks.find((check) => check.id === "custom:runtime-wording")).toMatchObject({ status: "pass" });
    expect(result.checks.find((check) => check.id === "custom:tracked-issue")).toMatchObject({ status: "pass" });
  });

  it("evaluates deterministic PR metadata sections without turning warnings into blockers", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "Add deterministic metadata gates",
        body: [
          "Closes #118",
          "",
          "Validation: focused tests passed.",
          "Docstrings: N/A - no public API changes."
        ].join("\n")
      },
      policy: {
        testEvidence: { mode: "warning" },
        docs: { mode: "warning" },
        docstrings: { mode: "error" },
        outOfScope: { mode: "error" }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.reviewEvent).toBe("REQUEST_CHANGES");
    expect(result.warnings.map((warning) => warning.id)).toEqual(["docs"]);
    expect(result.blockingErrors.map((error) => error.id)).toEqual(["out_of_scope"]);
    expect(result.checks.find((check) => check.id === "test_evidence")).toMatchObject({
      status: "pass",
      evidence: expect.arrayContaining([
        expect.objectContaining({ key: "test_evidence.section_present", value: "Validation", passed: true })
      ])
    });
    expect(result.checks.find((check) => check.id === "docstrings")).toMatchObject({
      status: "pass",
      evidence: expect.arrayContaining([
        expect.objectContaining({ key: "docstrings.not_placeholder", value: "true", passed: true })
      ])
    });
  });

  it("accepts not-applicable metadata only when the check policy allows it", () => {
    const body = "Out of scope: N/A - metadata only change.";
    const allowed = evaluatePreMergeChecks({
      pull: { body },
      policy: {
        outOfScope: { mode: "error", allowNotApplicable: true }
      }
    });
    const rejected = evaluatePreMergeChecks({
      pull: { body },
      policy: {
        outOfScope: { mode: "error", allowNotApplicable: false }
      }
    });

    expect(allowed.ok).toBe(true);
    expect(allowed.checks.find((check) => check.id === "out_of_scope")).toMatchObject({
      status: "pass",
      evidence: expect.arrayContaining([
        expect.objectContaining({ key: "out_of_scope.not_applicable_allowed", value: "true", passed: true })
      ])
    });
    expect(rejected.ok).toBe(false);
    expect(rejected.blockingErrors).toEqual([
      expect.objectContaining({
        id: "out_of_scope",
        evidence: expect.arrayContaining([
          expect.objectContaining({ key: "out_of_scope.not_placeholder", value: "false", passed: false })
        ])
      })
    ]);
  });

  it("does not treat concrete No-prefixed metadata as not applicable", () => {
    const result = evaluatePreMergeChecks({
      pull: { body: "Out of scope: No database migrations required for this metadata-only gate." },
      policy: {
        outOfScope: { mode: "error", allowNotApplicable: false }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "out_of_scope")).toMatchObject({
      status: "pass",
      evidence: expect.arrayContaining([
        expect.objectContaining({ key: "out_of_scope.not_placeholder", value: "true", passed: true })
      ])
    });
  });

  it("fails metadata sections whose detail is shorter than the default minimum", () => {
    const result = evaluatePreMergeChecks({
      pull: { body: "Docs: api" },
      policy: {
        docs: { mode: "error" }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.blockingErrors).toEqual([
      expect.objectContaining({
        id: "docs",
        evidence: expect.arrayContaining([
          expect.objectContaining({ key: "docs.section_present", value: "Docs", passed: true }),
          expect.objectContaining({
            key: "docs.not_placeholder",
            value: "false",
            passed: false,
            detail: "minimum_detail_length=6"
          })
        ])
      })
    ]);
  });

  it("honors metadata section heading overrides", () => {
    const result = evaluatePreMergeChecks({
      pull: { body: "Release notes: Documentation pages were updated." },
      policy: {
        docs: { mode: "error", sectionHeadings: ["Release notes"] }
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "docs")).toMatchObject({
      status: "pass",
      evidence: expect.arrayContaining([
        expect.objectContaining({ key: "docs.section_present", value: "Release notes", passed: true })
      ])
    });
  });

  it("blocks error-mode metadata checks when the section is missing", () => {
    const result = evaluatePreMergeChecks({
      pull: { body: "Docs: README updated." },
      policy: {
        testEvidence: { mode: "error" }
      }
    });

    expect(result.ok).toBe(false);
    expect(result.reviewEvent).toBe("REQUEST_CHANGES");
    expect(result.blockingErrors).toEqual([
      expect.objectContaining({
        id: "test_evidence",
        evidence: expect.arrayContaining([
          expect.objectContaining({ key: "test_evidence.section_present", value: "none", passed: false }),
          expect.objectContaining({ key: "test_evidence.not_placeholder", value: "false", passed: false })
        ])
      })
    ]);
  });

  it("honors draft-prefix opt-out and title minLength boundaries", () => {
    const atMinimum = evaluatePreMergeChecks({
      pull: { title: "Draft: okay", body: "Closes #42", linkedIssues: [42] },
      policy: { title: { mode: "error", minLength: 11, rejectDraftPrefixes: false } }
    });
    const oneBelow = evaluatePreMergeChecks({
      pull: { title: "Draft: bad", body: "Closes #42", linkedIssues: [42] },
      policy: { title: { mode: "error", minLength: 11, rejectDraftPrefixes: false } }
    });

    expect(atMinimum.ok).toBe(true);
    expect(atMinimum.checks.find((check) => check.id === "title")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "title.length", value: "11", passed: true }),
        expect.objectContaining({ key: "title.not_draft_prefix", value: "true", passed: true })
      ])
    );
    expect(oneBelow.ok).toBe(false);
    expect(oneBelow.checks.find((check) => check.id === "title")?.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "title.length", value: "10", passed: false })
      ])
    );
  });

  it("blocks explicit wip draft and tmp title prefixes", () => {
    for (const title of ["[wip] Add pre-merge checks", "draft: Add pre-merge checks", "tmp- Add pre-merge checks"]) {
      const result = evaluatePreMergeChecks({
        pull: {
          title,
          body: "Closes #42\n\nValidation: focused tests passed.",
          linkedIssues: [42]
        },
        policy: { title: { mode: "error" } }
      });

      expect(result.ok).toBe(false);
      expect(result.checks.find((check) => check.id === "title")?.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ key: "title.not_draft_prefix", value: "false", passed: false })
        ])
      );
    }
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

  it("rejects unsafe custom regex patterns and caps regex input evidence", () => {
    const validation = validatePreMergeCheckPolicy({
      customChecks: [
        {
          name: "nested-quantifier",
          mode: "warning",
          instructions: "Require safe deterministic regex patterns.",
          match: { source: "description", matches: "^(a+)+$" }
        },
        {
          name: "alternation-loop",
          mode: "warning",
          instructions: "Require safe deterministic regex patterns.",
          match: { source: "description", matches: "(a|a)*b" }
        }
      ]
    });

    expect(validation.ok).toBe(false);
    expect(validation.errors).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check: "custom:nested-quantifier", field: "match.matches" }),
        expect.objectContaining({ check: "custom:alternation-loop", field: "match.matches" })
      ])
    );

    const result = evaluatePreMergeChecks({
      pull: { body: `${"a".repeat(3000)}MATCH_AT_END` },
      policy: {
        customChecks: [
          {
            name: "capped-body",
            mode: "warning",
            instructions: "Require bounded regex input when evaluating descriptions.",
            match: { source: "description", matches: "MATCH_AT_END$" }
          }
        ]
      }
    });

    expect(result.ok).toBe(true);
    expect(result.checks.find((check) => check.id === "custom:capped-body")).toMatchObject({
      status: "warning",
      evidence: [
        expect.objectContaining({
          value: "not_matched",
          detail: "operator=matches; source=description; max_input_chars=2048"
        })
      ]
    });
  });

  it("keeps configured checks visible when policy validation fails", () => {
    const result = evaluatePreMergeChecks({
      pull: {
        title: "Add pre-merge checks",
        body: "Closes #42\n\nValidation: focused tests passed.",
        linkedIssues: [{ number: 42, state: "open" }]
      },
      policy: {
        title: { mode: "error", minLength: 0 },
        description: { mode: "warning" },
        linkedIssue: { mode: "error", requireOpen: true },
        customChecks: [
          {
            name: "body-marker",
            mode: "warning",
            instructions: "Require release notes marker in the PR body.",
            match: { source: "description", includes: "" }
          }
        ]
      }
    });

    expect(result.ok).toBe(false);
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "title", status: "skipped", summary: "Title check was not evaluated because policy validation failed." }),
        expect.objectContaining({ id: "description", status: "skipped", summary: "Description check was not evaluated because policy validation failed." }),
        expect.objectContaining({ id: "linked_issue", status: "skipped", summary: "Linked issue check was not evaluated because policy validation failed." }),
        expect.objectContaining({ id: "custom:body-marker", status: "skipped", summary: "Custom check body-marker check was not evaluated because policy validation failed." }),
        expect.objectContaining({ id: "policy_validation:title:minLength", status: "fail" }),
        expect.objectContaining({ id: "policy_validation:custom:body-marker:match.includes", status: "fail" })
      ])
    );
    expect(result.summary.total).toBe(6);
  });
});
