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
  Excludes start with `!`. Include filters are hard prompt filters, not just
  ranking hints: files that do not match a profile include or a built-in safety
  include are omitted from the model prompt.
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
- `finishingTouches`: declaration surface for opt-in draft commands such as
  docstrings or unit-test suggestions. Commands remain draft-only and entries
  should stay `enabled: false` until a repo-specific promotion gate explicitly
  enables them.
- `suggestedLabels` / `suggestedReviewers`: reserved for later enrichment; they
  do not auto-apply labels or reviewers.

## Review Settings Preview

Each review now records a `review-settings-preview.json` evidence file and, when
walkthroughs are enabled, renders a `Review Settings Preview` section in the
walkthrough body. This is the first narrow settings-parity slice for users who
expect CodeRabbit-style knobs to be visible before live posting.

The preview maps current config into user-facing review behavior:

- `reviewProfile` becomes the visible profile, currently `chill` or
  `assertive`.
- `sampleProfile` records the closest public sample profile metadata:
  conservative for `chill`, assertive for `assertive`. Balanced is documented
  as a sample user-facing midpoint for configuration examples, but it does not
  create a third runtime prompt mode yet.
- `walkthrough.enabled` and `walkthrough.postIssueComment` decide whether the
  walkthrough-related sections are inline review content or a sticky issue
  comment.
- changed-file table, effort estimate, related issues/PRs, suggested labels,
  and suggested reviewers are reported as enabled sections when the configured
  review output can render them.
- `reviewStatusComment.enabled` is shown as a sticky-status section when on.
- `pathInstructions` are listed with their glob and instructions so maintainers
  can confirm path-specific guidance before enabling broader review coverage.
- label and reviewer settings remain suggestions only. Auto-applying labels or
  requesting reviewers is explicitly roadmap-only until permissions and eval
  gates justify it.
- `unsupportedSettings` records CodeRabbit-like settings that NeonDiff can show
  as evidence but does not execute. This matrix is deterministic so dry-run
  evidence and docs snapshots can be compared directly.

The preview is descriptive evidence only. It does not change repo eligibility,
provider selection, App permissions, live allowlists, labels, reviewers, status
checks, or release state.

### Sample Profile Matrix

The policy layer exposes these sample profiles for documentation, UI previews,
and dry-run evidence:

| Sample | Runtime profile | Default visible sections | Behavior boundary |
| --- | --- | --- | --- |
| Conservative | `chill` | Review summary, walkthrough, changed-files table | Minimal, low-noise rollout posture. Labels and reviewers stay suggestion-only. |
| Balanced | `assertive` | Review summary, walkthrough, changed-files table, effort estimate, related context | Default user-facing midpoint. It is sample metadata only, not a third runtime prompt mode. |
| Assertive | `assertive` | Review summary, walkthrough, changed-files table, effort estimate, related context, suggested labels, suggested reviewers, status comment | Higher-signal posture for release, runtime, and regression-sensitive repos. Suggestions still do not mutate GitHub state. |

### Unsupported Setting Matrix

The unsupported-setting evidence intentionally separates safe preview surfaces
from mutation or enforcement features:

| Setting | Status | Safe alternative |
| --- | --- | --- |
| Auto-apply labels | Roadmap-only | Emit `suggestedLabels` as suggestion-only preview evidence. |
| Auto-request reviewers | Roadmap-only | Emit `suggestedReviewers` as suggestion-only preview evidence. |
| Required status checks | Roadmap-only | Use `reviewStatusComment.enabled` for sticky descriptive status only. |
| Auto-fix or apply suggestions | Unsupported | Open a human-reviewed follow-up PR from a separate implementation lane. |

## Changed-Surface Validation

For every review, the worker now writes deterministic validation and proof
evidence beside the review plan:

- `validation-selector.json`: diff-only recommendations selected from changed
  paths, repo name, and repo profile hints.
- `proof-requirements.json`: whether PR metadata mentions acceptable proof for
  the selected recommendations.
- `deterministic-gate.json`: final inline comment, drop-reason, category, and
  `REQUEST_CHANGES` decisions after schema, diff-line, secret, cap, and taxonomy
  gates.
- `review-settings-preview.json`: mapped review-output settings, path
  instructions, sample profile metadata, suggestion-only labels/reviewers, and
  roadmap-only or unsupported unsafe settings.

These selectors do not run tests, builds, project scripts, Unity, or arbitrary
PR code. They only decide which proof a reviewer should expect and whether that
proof appears in PR metadata.

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

## Filter Impact Evidence

The worker writes `filter-impact.json` in every review evidence directory before
prompt construction. It records:

- original changed-file count
- included and excluded file counts
- profile include/exclude filters
- built-in safety include patterns
- per-file include/exclude reason and matched pattern

Profile include filters are augmented by a built-in safety include baseline for
common root, workflow, dependency, runtime, release, and security files such as
`.github/**`, `README.md`, `AGENTS.md`, `package-lock.json`, `pnpm-lock.yaml`,
`tsconfig*.json`, `Dockerfile`, `Makefile`, `pyproject.toml`, `go.mod`,
`Cargo.toml`, `*.plist`, and entitlements files. Explicit profile excludes
still win, so do not add broad `!` filters without checking filter-impact
evidence.

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

## Active Monitor Profile Template

`config.active-profiles.example.json` mirrors the 19 repositories currently in
the live monitor allowlist and adds explicit repo profiles for each one. It is a
tracked template for review, dry-run, and promotion planning; it is not loaded
by launchd automatically.

The template intentionally keeps:

- `commands.enabled: false`
- `repoProfiles.enableOrgFallbacks: false`
- every `finishingTouches.*.enabled: false`
- `Martian-Engineering/lossless-claw` and `zMartian-Engineering/lossless-claw`
  out of the allowlist until the GitHub App installation is verified

Before copying any part of the template into the active live config, run:

```sh
EVAOS_REVIEW_BOT_APP_ID=4184532 \
EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH=/Volumes/LEXAR/Codex/evaos-code-review-bot/secrets/evaos-code-review-bot.private-key.pem \
npx tsx src/cli.ts doctor --config /path/to/candidate-live-config.json
```

Then run dry-run review evidence for at least one current PR and one
negative-control PR per newly profiled repo group before promoting through
`docs/beta-release-runbook.md`. The promotion packet must include
`filter-impact.json` summaries proving important changed files were not hidden
by profile filters.
