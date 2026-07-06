/**
 * Seeded scenario library for the QA lab timing harness (#341, tracker #340).
 *
 * Reuse-first: scenarios are shaped as raw model-output JSON (`{ findings: [...] }`) plus a
 * `PullFilePatch[]` diff context, matching the exact inputs `parseFindings` and
 * `applyDeterministicReviewGate` already accept in src/findings.ts and src/review-gate.ts. This
 * mirrors the `botFindings` / diff shape used by tests/fixtures/eval-suite-scenarios/*.json rather
 * than inventing a parallel scenario format.
 *
 * Six scenario classes from issue #341: docs-only, normal code, auth/security, migration, release
 * config, and issue-burst. The first five run through the deterministic review pipeline
 * (parseFindings -> applyDeterministicReviewGate, which itself chains validateFindingLocations ->
 * normalizeFindingsForReview -> decideReviewEvent). "issue-burst" is issue-enrichment shaped rather
 * than PR-review shaped, so pass 1 seeds it as a fixture input shape only; timing wiring for the
 * issue-enrichment path is pass 2 scope (provider/GitHub calls are out of scope for hermetic pass 1).
 */
import type { PullFilePatch } from "../../src/types.js";

export type QaLabScenarioClass =
  | "docs_only"
  | "normal_code"
  | "auth_security"
  | "migration"
  | "release_config"
  | "issue_burst";

export interface QaLabScenario {
  id: string;
  scenarioClass: QaLabScenarioClass;
  description: string;
  /** Raw model-output shape, exactly what parseFindings(input.botFindings) expects. */
  botFindings: { findings: unknown[] };
  /** Diff context, exactly what validateFindingLocations(findings, files) expects. */
  files: PullFilePatch[];
}

function patch(newStartLine: number, addedLines: string[]): string {
  const header = `@@ -0,0 +${newStartLine},${addedLines.length} @@`;
  const body = addedLines.map((line) => `+${line}`).join("\n");
  return `${header}\n${body}`;
}

export const QA_LAB_SCENARIOS: QaLabScenario[] = [
  {
    id: "docs-only-readme-typo",
    scenarioClass: "docs_only",
    description: "Docs-only PR: a README wording fix with a single low-severity nit finding.",
    botFindings: {
      findings: [
        {
          severity: "P3",
          path: "docs/SETUP.md",
          line: 12,
          title: "Minor wording nit in setup docs",
          body: "Consider rewording this sentence for clarity; not a functional issue.",
          confidence: 0.4,
          category: "docs_only"
        }
      ]
    },
    files: [
      {
        filename: "docs/SETUP.md",
        status: "modified",
        additions: 3,
        deletions: 1,
        changes: 4,
        patch: patch(10, ["## Setup", "", "Follow these steps to install the CLI locally."])
      }
    ]
  },
  {
    id: "normal-code-helper-refactor",
    scenarioClass: "normal_code",
    description: "Ordinary application code change: a small helper refactor with one real finding and one duplicate-shaped near-miss.",
    botFindings: {
      findings: [
        {
          severity: "P2",
          path: "src/example-helper.ts",
          line: 22,
          title: "Off-by-one in retry loop bound",
          body: "The loop should be < maxAttempts, not <= maxAttempts, or it retries one extra time.",
          confidence: 0.72,
          category: "runtime_correctness"
        },
        {
          severity: "P2",
          path: "src/example-helper.ts",
          line: 23,
          title: "Off-by-one in retry loop boundary",
          body: "Loop bound looks incorrect, retries one extra time past maxAttempts.",
          confidence: 0.6,
          category: "runtime_correctness"
        }
      ]
    },
    files: [
      {
        filename: "src/example-helper.ts",
        status: "modified",
        additions: 12,
        deletions: 4,
        changes: 16,
        patch: patch(
          15,
          [
            "export function retryWithBackoff(fn: () => Promise<void>, maxAttempts: number): Promise<void> {",
            "  let attempt = 0;",
            "  return (async () => {",
            "    while (attempt <= maxAttempts) {",
            "      try {",
            "        await fn();",
            "        return;",
            "      } catch (error) {",
            "        attempt += 1;",
            "      }",
            "    }",
            "  })();",
            "}"
          ]
        )
      }
    ]
  },
  {
    id: "auth-security-token-check",
    scenarioClass: "auth_security",
    description: "Auth/security-sensitive change: a permission check regression flagged at P0 plus a P1 secondary finding.",
    botFindings: {
      findings: [
        {
          severity: "P0",
          path: "src/example-auth.ts",
          line: 8,
          title: "Missing role check before privileged action",
          body: "This handler no longer verifies the caller has the admin role before proceeding.",
          confidence: 0.9,
          category: "auth",
          why_this_matters: "Any authenticated user could trigger a privileged action without the admin role."
        },
        {
          severity: "P1",
          path: "src/example-auth.ts",
          line: 6,
          title: "Token comparison is not constant-time",
          body: "Using === for token comparison can leak timing information about the secret value.",
          confidence: 0.68,
          category: "security_boundary"
        }
      ]
    },
    files: [
      {
        filename: "src/example-auth.ts",
        status: "modified",
        additions: 10,
        deletions: 6,
        changes: 16,
        patch: patch(
          5,
          [
            "export function handlePrivilegedAction(user: { role: string }, token: string, expected: string): void {",
            "  if (token === expected) {",
            "    performPrivilegedAction();",
            "  }",
            "}",
            "",
            "function performPrivilegedAction(): void {",
            "  // ...",
            "}"
          ]
        )
      }
    ]
  },
  {
    id: "migration-column-backfill",
    scenarioClass: "migration",
    description: "Schema migration: a backfill migration missing a rollback path, flagged P1.",
    botFindings: {
      findings: [
        {
          severity: "P1",
          path: "migrations/0042_add_status_column.sql",
          line: 4,
          title: "Migration has no down/rollback path",
          body: "This migration adds a NOT NULL column with a default but has no corresponding down migration.",
          confidence: 0.65,
          category: "migration"
        }
      ]
    },
    files: [
      {
        filename: "migrations/0042_add_status_column.sql",
        status: "added",
        additions: 6,
        deletions: 0,
        changes: 6,
        patch: patch(
          1,
          [
            "-- Up",
            "ALTER TABLE accounts ADD COLUMN status TEXT NOT NULL DEFAULT 'active';",
            "UPDATE accounts SET status = 'active' WHERE status IS NULL;",
            "",
            "-- (no corresponding down migration file in this PR)"
          ]
        )
      }
    ]
  },
  {
    id: "release-config-channel-bump",
    scenarioClass: "release_config",
    description: "Release/config change: a desktop update-channel bump with a P1 finding about a missing guard.",
    botFindings: {
      findings: [
        {
          severity: "P1",
          path: "config.example.json",
          line: 2,
          title: "Update channel changed without a version guard",
          body: "Switching updateChannel to \"stable\" here without a paired version bump may serve a stale build to existing installs.",
          confidence: 0.55,
          category: "release_regression"
        }
      ]
    },
    files: [
      {
        filename: "config.example.json",
        status: "modified",
        additions: 2,
        deletions: 2,
        changes: 4,
        patch: patch(1, ['{', '  "updateChannel": "stable",'])
      }
    ]
  },
  {
    id: "issue-burst-duplicate-reports",
    scenarioClass: "issue_burst",
    description:
      "Issue-enrichment-shaped burst: several near-duplicate bug reports arriving together. Fixture input only in pass 1 " +
      "(issue-enrichment timing requires provider/GitHub calls, out of scope for hermetic pass 1); seeded here so pass 2 " +
      "can wire real timing without redesigning the scenario shape.",
    botFindings: {
      findings: [
        {
          severity: "P2",
          path: "src/example-queue.ts",
          line: 30,
          title: "Duplicate-looking issue reports processed independently",
          body: "Three similar bug reports filed within an hour are not being correlated before enrichment.",
          confidence: 0.5,
          category: "unknown"
        }
      ]
    },
    files: [
      {
        filename: "src/example-queue.ts",
        status: "modified",
        additions: 5,
        deletions: 1,
        changes: 6,
        patch: patch(28, ["export function enqueueIssue(issue: { id: string }): void {", "  queue.push(issue);", "}"])
      }
    ]
  }
];

export function findScenario(id: string): QaLabScenario | undefined {
  return QA_LAB_SCENARIOS.find((scenario) => scenario.id === id);
}
