# Repo Profiles

Repo profiles make review behavior explicit per repository before the bot scales
beyond the original pilot repos. They are advisory policy metadata only: a
profile cannot grant new GitHub permissions, enable ZCode write tools, expand
the live allowlist, approve PRs, run tests, or execute PR code.

## Config Shape

Profiles live under `repoProfiles` in the bot config:

```json
{
  "pilotRepos": ["electricsheephq/WorldOS"],
  "repoProfiles": {
    "enableOrgFallbacks": false,
    "repos": {
      "electricsheephq/WorldOS": {
        "displayName": "WorldOS Unity",
        "defaultBranch": "main",
        "reviewProfile": "assertive",
        "promptNote": "Prioritize Unity scene, save-state, gameplay, and release-regression risks.",
        "autoReview": {
          "baseBranches": ["main"],
          "labels": ["!wip", "!do-not-review"]
        },
        "pathFilters": ["Assets/**", "Packages/**", "!Library/**"],
        "pathInstructions": {
          "Assets/**": ["Prioritize scene, prefab, save-state, and gameplay regressions."]
        },
        "riskyPaths": ["Assets/**", "ProjectSettings/**"],
        "proofExpectations": ["Mention Unity editor/play-mode smoke evidence when relevant."],
        "validationHints": ["Prefer correctness and release findings over style-only feedback."],
        "readinessHints": ["Scene and save changes need rollback notes."],
        "preMergeChecks": {
          "testEvidence": {
            "mode": "warning",
            "instructions": "Look for focused Unity/editor smoke, CI, or fixture evidence."
          }
        },
        "finishingTouches": {
          "unitTests": {
            "enabled": false,
            "instructions": "Declaration only until opt-in finishing-touch commands are enabled."
          }
        },
        "suggestedLabels": ["unity", "gameplay"]
      }
    }
  }
}
```

When `repoProfiles.repos` or `repoProfiles.orgFallbacks` is configured, a repo
must resolve to an explicit profile or an intentionally enabled org fallback.
Unknown repos are skipped before GitHub PR fetches. This is deliberate: expanded
monitoring should fail closed until App install, policy, and beta promotion
evidence are recorded.

## Fields

- `enabled`: set to `false` to keep a profile documented but not reviewable.
- `displayName`: human-friendly repo name for prompts and evidence.
- `defaultBranch`: expected base branch for reviewer context.
- `reviewProfile`: `chill` or `assertive`; current Sprint 2 default is
  `assertive`.
- `promptNote`: repo-specific review instruction injected into the ZCode prompt.
- `pathFilters`: include/exclude globs applied before prompt construction.
  Excludes start with `!`.
- `pathInstructions`: path-specific review guidance injected into the prompt
  for matching code areas.
- `riskyPaths`: high-risk file areas called out in the prompt.
- `proofExpectations`: evidence the reviewer should look for in PRs.
- `validationHints`: repo-specific correctness and CI guidance.
- `readinessHints`: release or rollout readiness notes.
- `autoReview`: declarative branch and label filters. These are reviewer policy
  metadata only in v0.2; they do not grant new GitHub permissions or bypass
  `skipDrafts`, `canaryPulls`, duplicate suppression, or live config gates.
- `preMergeChecks`: advisory checks the reviewer should consider when building
  summaries. Each check has `mode: "off" | "warning" | "error"`,
  optional `instructions`, and optional numeric `threshold` from 0 to 100.
  These modes do not create GitHub Checks or force `REQUEST_CHANGES` by
  themselves.
- `finishingTouches`: declaration surface for future opt-in commands such as
  docstrings or unit-test suggestions. Entries must remain `enabled: false`
  until #11 ships explicit command handling and promotion gates.
- `suggestedLabels` / `suggestedReviewers`: reserved for later enrichment; they
  do not auto-apply labels or reviewers.

## Validation Rules

Configuration loads fail closed before the daemon starts when:

- `pilotRepos` or profile repo keys are not GitHub `owner/repo` names.
- `canaryPulls` are not `owner/repo#number` strings.
- booleans, positive integer timeouts/concurrency values, string arrays, or
  policy modes have the wrong type.
- pre-merge check thresholds are outside 0-100.
- finishing-touch declarations omit a boolean `enabled` value.

This is intentionally stricter than the TypeScript interfaces. The live config
is JSON outside this repository, so runtime validation is the safety net that
prevents a typo from changing monitoring behavior silently.

## Graduation To Live Review

Use this path for each new repo from #14 or future allowlists:

1. Add or update a repo profile in config/docs with `enabled` left conservative.
2. Verify the GitHub App is installed and can read/post on that repo.
3. Run dry-run scans against one current PR and one negative-control/noise PR.
4. Check evidence for valid inline coordinates, zero secrets, zero repo
   mutation, and no duplicate review attempts.
5. Update the tracker issue with the profile snapshot and dry-run evidence.
6. Add the repo to the active live config only in a dedicated PR/promotion lane.
7. Promote through `docs/beta-release-runbook.md` and verify
   `npm run release:status` plus fresh launchd heartbeats.

Do not treat `config.example.json` as live config. The active launchd config is
outside the repo under `/Volumes/LEXAR/Codex/evaos-code-review-bot/config/`.
Do not add repos whose GitHub App installation cannot be verified; public
visibility or an admin user's `gh repo view` is not enough because reviews must
be authored by `evaos-code-review-bot`.
