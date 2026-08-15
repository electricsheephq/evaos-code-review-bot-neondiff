# Issue Enrichment Rollout Policy

Issue enrichment is a separate lane from PR review monitoring. `pilotRepos`, `canaryPulls`, `repoProfiles.repos`, and `repoProfiles.suggestedLabels` or `suggestedReviewers` do not opt a repo into issue enrichment.

Use `issueEnrichment.allowlist` for issue scanning and comment eligibility. Use `issueEnrichment.allowedLabels` and `issueEnrichment.allowedReviewers` for issue suggestions only; repo-level `issueEnrichment.repos.<owner/repo>.allowedLabels` and `allowedReviewers` override those suggestion allowlists for that issue repo. Repo overrides may also carry `advisoryPolicy`, `validationSuggestions`, `suggestedLabels`, `suggestedReviewers`, and `labelAliases`. Policy and validation fields are private configuration and must never appear in a public comment. Raw `advisoryPolicy` and `validationSuggestions` text is not passed into the issue-analysis model; the fixed schema, quality gates, leak checks, allowlists, and publication rules enforce the safe analysis contract outside the untrusted issue/model boundary. Suggested labels and reviewers may appear as proposals, but NeonDiff never applies them.

The tracked LCM-X profile (`electricsheephq/lcm-x`) is intentionally explicit:

- LCM-X is an independent Hermes ContextEngine extension for lossless context memory, not OpenClaw.
- Review data loss/duplication, chronology/provenance, profile/session contamination, source coverage, tool-call/result grouping, fresh-tail behavior, SQLite/concurrency/crash safety, import idempotency, and unsupported Hermes host assumptions.
- Require current-main reproduction or a named mandatory invariant, and distinguish NeonDiff severity from LCM-X P0-P4.
- Suggested labels are `data-integrity`, `security`, `performance`, `needs-repro`, `test`, `documentation`, and `upstream-evidence`; `docs` aliases to `documentation` and `tests` aliases to `test`; suggested reviewer is `Tosko4`.

Aliases apply to inferred and configured suggestions before the issue allowlist filter. `processExistingOpenIssuesOnActivation` remains explicitly `false` in the tracked example, and no path filters are used for this issue policy.

Live enrichment is model-backed. NeonDiff requires a strict structured result with issue-specific classification, priority, repository impact, current-main applicability, evidence, reproduction or invariant gap, related work, migration disposition, and next gate. Schema validation, quality checks, and public-output leak checks run before comment creation. Model, schema, quality, or leak-check failures are fail-closed and create no public comment.

Issues labeled `upstream-intake` are preservation records, not actionable work. NeonDiff skips them before model invocation, comment creation, and rollout-cap accounting unless a maintainer explicitly removes that label to promote the record.

Live issue comments are blocked until all of these are true:

- `issueEnrichment.enabled` is `true`.
- `issueEnrichment.postIssueComment` is `true`.
- `issueEnrichment.allowlist` contains at least one repo.
- the configured Codex runtime is enabled for structured issue analysis.
- the GitHub App credential path can post as the App.
- every live allowlisted repo has explicit repo-level thresholds for `maxIssuesPerCycle`, `maxCommentsPerCycle`, `cooldownMs`, `burstWindowMs`, `maxIssuesPerBurst`, and `lookbackMs`.

Keep new rollouts dry-run first:

```json
{
  "issueEnrichment": {
    "enabled": true,
    "postIssueComment": false,
    "allowlist": ["owner/repo"],
    "allowedLabels": ["bug", "docs"],
    "allowedReviewers": ["maintainer-login"],
    "repos": {
      "owner/repo": {
        "enabled": true,
        "maxIssuesPerCycle": 3,
        "maxCommentsPerCycle": 1,
        "cooldownMs": 3600000,
        "burstWindowMs": 3600000,
        "maxIssuesPerBurst": 6,
        "lookbackMs": 600000,
        "processExistingOpenIssuesOnActivation": false,
        "advisoryPolicy": "Keep this repo's issue guidance explicit and suggestion-only.",
        "validationSuggestions": ["Require current-main reproduction or a named mandatory invariant."],
        "suggestedLabels": ["documentation"],
        "suggestedReviewers": ["maintainer-login"],
        "labelAliases": { "docs": "documentation", "tests": "test" }
      }
    }
  }
}
```

Manual live pilots should use the selected-issue runner before daemon
promotion:

```bash
npx tsx src/cli.ts issue-enrichment-run \
  --config <config.json> \
  --repo owner/repo \
  --issue 123 \
  --dry-run true \
  --output-dir <evidence-dir>/issue-enrichment-pilot
```

Live posting is intentionally noisier to type:

```bash
npx tsx src/cli.ts issue-enrichment-run \
  --config <config.json> \
  --repo owner/repo \
  --issue 123 \
  --dry-run false \
  --confirm true
```

The runner requires repo membership in `issueEnrichment.allowlist`, rejects
closed issues, PR-shaped issue records, and `upstream-intake` preservation
records before model invocation or posting, writes/upserts only
one bot-owned sticky marker comment per issue, records state in
`issue_enrichment_records`, and never mutates labels, owners, reviewers, or
roadmap fields. Repeat `--issue` only for small selected batches. Use `--force
true` only with `--dry-run false` to deliberately re-upsert an unchanged issue's
existing marker comment. Selected live runs reject batches that exceed the
effective repo/global issue or comment cap before fetching or posting. Dry runs
do not post comments or run the model, but they still plan against the live issue/comment caps
and may report deferred rows so operators can see what live posting would do.
If a confirmed live run cannot acquire the issue-enrichment worker lease, it
exits nonzero and reports `workerSkipped: 1` in the JSON output; retry after the
active lease clears.

Operator status exposes `issueEnrichment.liveThresholdsMissingRepos` and the `issue_enrichment_live_repo_thresholds_required` blocker before live comments can become ready. This is intentional: repo-specific thresholds must be visible in config before any active rollout.

When more than one live rollout blocker applies, operator status reports blockers in deterministic policy order:

1. feature disabled
2. empty issue enrichment allowlist
3. live posting disabled
4. missing per-repo live thresholds
5. model runtime disabled
6. missing GitHub App posting credentials

Threshold blockers intentionally appear before credential blockers so operators fix unsafe rollout scope before debugging App identity.
