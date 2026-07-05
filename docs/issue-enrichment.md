# Issue Enrichment Rollout Policy

Issue enrichment is a separate lane from PR review monitoring. `pilotRepos`, `canaryPulls`, `repoProfiles.repos`, and `repoProfiles.suggestedLabels` or `suggestedReviewers` do not opt a repo into issue enrichment.

Use `issueEnrichment.allowlist` for issue scanning and comment eligibility. Use `issueEnrichment.allowedLabels` and `issueEnrichment.allowedReviewers` for issue suggestions only; repo-level `issueEnrichment.repos.<owner/repo>.allowedLabels` and `allowedReviewers` override those suggestion allowlists for that issue repo.

Live issue comments are blocked until all of these are true:

- `issueEnrichment.enabled` is `true`.
- `issueEnrichment.postIssueComment` is `true`.
- `issueEnrichment.allowlist` contains at least one repo.
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
        "processExistingOpenIssuesOnActivation": false
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
closed issues and PR-shaped issue records before posting, writes/upserts only
one bot-owned sticky marker comment per issue, records state in
`issue_enrichment_records`, and never mutates labels, owners, reviewers, or
roadmap fields. Repeat `--issue` only for small selected batches. Use `--force
true` only with `--dry-run false` to deliberately re-upsert an unchanged issue's
existing marker comment. Selected live runs reject batches that exceed the
effective repo/global issue or comment cap before fetching or posting. Dry runs
do not post comments, but they still plan against the live issue/comment caps
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
5. missing GitHub App posting credentials

Threshold blockers intentionally appear before credential blockers so operators fix unsafe rollout scope before debugging App identity.
