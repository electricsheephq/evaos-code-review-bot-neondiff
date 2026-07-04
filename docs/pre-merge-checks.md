# Pre-Merge Checks

Pre-merge checks are deterministic PR metadata gates that complement model
findings. They do not inspect code semantically, do not call a model, and do
not turn uncertainty into `REQUEST_CHANGES`.

The module lives in `src/pre-merge-checks.ts` and is intentionally pure: callers
pass PR metadata plus a policy object and receive check results, evidence,
warnings, blocking errors, and the recommended review event.

## Modes

Every check uses one mode:

| Mode | Behavior |
| --- | --- |
| `off` | Emits a skipped check and never warns or blocks. |
| `warning` | Emits a warning on failure and never blocks merge by itself. |
| `error` | Emits a blocking error on deterministic failure. |

Warning and error results are separate arrays in the evaluation output:

- `warnings`: failed warning-mode checks only.
- `blockingErrors`: failed error-mode checks and policy validation failures.

Callers should map `blockingErrors.length > 0` to `REQUEST_CHANGES`. Warning
checks should render as status/walkthrough guidance only.

## Built-In Checks

Built-in checks are enabled only when present in policy:

```ts
const policy = {
  title: { mode: "warning", minLength: 8 },
  description: { mode: "warning", minLength: 20 },
  linkedIssue: { mode: "error" }
};
```

`title` checks for a non-placeholder title with a minimum length and no draft/WIP
prefix by default.

`description` checks for a non-placeholder PR body with a minimum length.

`linkedIssue` checks structured linked issues, explicit linked issue refs, and
PR title/body text such as `Closes #118` or `Related: owner/repo#118`.

Each check returns evidence entries with a `key`, `value`, `passed`, and
optional `detail` field so status rendering can show why a result passed or
failed.

## Custom Checks

Custom checks use a stable name, deterministic instructions, a mode, and a
structured matcher:

```ts
const policy = {
  customChecks: [
    {
      name: "release-notes",
      mode: "warning",
      instructions: "Require a Release notes section in the PR description.",
      match: { source: "description", includes: "Release notes:" }
    },
    {
      name: "focused-test-file",
      mode: "error",
      instructions: "Require a focused test file in the changed files.",
      match: { source: "changed_files", matches: "^tests/.+\\.test\\.ts$" }
    }
  ]
};
```

Supported matcher sources:

| Source | Values searched |
| --- | --- |
| `title` | PR title |
| `description` | PR body |
| `title_or_description` | PR title and body |
| `changed_files` | Changed file paths |
| `linked_issue_refs` | Normalized linked issue refs |

Supported matcher operators:

- `includes`: case-insensitive substring check.
- `matches`: JavaScript regular expression.

Set exactly one matcher operator. A custom check with both `includes` and
`matches` is rejected during policy validation so operators do not accidentally
believe both rules are enforced.

Custom instructions are descriptive only. The pass/fail decision comes from the
matcher, not from model judgment or a human-style interpretation of the prose.

## Policy Validation

Use `validatePreMergeCheckPolicy(policy)` before accepting user or repo config.
Validation rejects:

- custom names outside `^[a-z][a-z0-9-]{1,63}$`
- duplicate custom names
- modes outside `off`, `warning`, and `error`
- empty or invalid matchers
- invalid regular expressions
- custom instructions shorter than 12 or longer than 500 characters
- instructions that delegate pass/fail judgment to a model or vague judgment

`evaluatePreMergeChecks` also validates policy. Invalid policy returns blocking
`policy_validation:*` results so live integrations fail closed instead of
silently skipping a broken deterministic gate.

## Integration Hooks

The captain still needs to wire this module into the shared surfaces:

- config/profile parsing for pre-merge check policy
- walkthrough/status rendering without duplicate status-comment spam
- worker/review flow mapping of `blockingErrors` to `REQUEST_CHANGES`
- dry-run evidence output for fixture PRs covering pass, warning, and error

This PR does not touch `src/cli.ts`, `src/config.ts`, `src/worker.ts`, or
`src/walkthrough.ts`.
