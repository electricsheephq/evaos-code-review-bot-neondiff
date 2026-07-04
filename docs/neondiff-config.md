# NeonDiff Config Schema Draft

This document defines the public draft contract for a future repo-owned `.neondiff.yml`.
It supports issue [#109](https://github.com/electricsheephq/evaos-code-review-bot/issues/109), but this slice is schema, examples, fixtures, and tests only. It is not yet wired into runtime config loading, `neondiff init`, `neondiff config validate`, `neondiff config explain`, review posting, or dry-run filtering, so it must not be treated as completing the full #109 acceptance criteria.

The machine-readable draft schema lives at [`docs/schema/neondiff-config.schema.json`](schema/neondiff-config.schema.json). Example fixtures live under [`tests/fixtures/neondiff-config`](../tests/fixtures/neondiff-config).

## Contract Goals

- Give maintainers and coding agents a deterministic shape for `.neondiff.yml`.
- Keep unsafe behavior explicit and default-off.
- Keep provider credentials out of committed repo config.
- Keep issue enrichment separate from PR review policy.
- Keep public confidence uncalibrated until evaluation evidence exists; no percentages are displayed in this draft.
- Preserve the current NeonDiff public boundary: source-available beta, public open-source repositories are free, and private or commercial repositories require the applicable NeonDiff license.

## Top-Level Fields

| Field | Purpose |
| --- | --- |
| `version` | Schema version. The current draft is `1`. |
| `review` | Review profile, max comments, severity threshold, and path-specific instructions. |
| `paths` | Include and exclude globs. Exclusions win over inclusions. |
| `providers` | Provider selection plus BYOK/local-provider hints. Secrets are referenced by environment variable name only. |
| `safetyGates` | Fail-closed controls for mutation, secret-like text, current-diff-line coverage, and comment caps. |
| `finishingTouches` | Future post-review commands. `enabled` is `false` in this draft. |
| `issueEnrichment` | Future issue enrichment policy. It is separate from PR review and defaults off with explicit allowlist and throttles. |
| `confidence` | Public confidence display policy. It remains `uncalibrated` with percentages disabled. |
| `repo` | Repository visibility and repo-level review settings. |

## Minimal Example

```yaml
$schema: docs/schema/neondiff-config.schema.json
version: 1
review:
  profile: conservative
  maxComments: 12
  severityThreshold: medium
  pathInstructions: []
paths:
  include:
    - "**/*"
  exclude:
    - "dist/**"
    - "coverage/**"
    - "node_modules/**"
providers:
  default: openai-compatible
  allowed:
    - openai-compatible
  byok:
    required: true
    apiKeyEnv: NEONDIFF_PROVIDER_API_KEY
  local:
    enabled: false
    provider: none
    baseUrl: http://localhost:11434/v1
    model: ""
safetyGates:
  mutation:
    enabled: false
  secrets:
    blockSecretLikeText: true
  lineCoverage:
    requireCurrentDiffLine: true
  commentCaps:
    maxPerPullRequest: 12
    maxPerFile: 4
finishingTouches:
  enabled: false
  allowedCommands: []
issueEnrichment:
  enabled: false
  allowlist: []
  throttles:
    maxIssuesPerHour: 0
    cooldownMinutes: 60
confidence:
  mode: uncalibrated
  displayPercentages: false
  calibrationEvidence: none
repo:
  visibility: public
  reviewDraftPullRequests: false
  publicRepoMode: free-source-available-beta
  privateRepoMode: requires-license
```

## Provider Notes

`providers.byok.apiKeyEnv` names an environment variable; it is not a value slot for a raw key. Local provider hints are allowed for loopback URLs such as Ollama, but committed config should still avoid machine-specific secrets and credentials. Machine-specific provider settings belong in local overrides once runtime support exists.

## Safety Defaults

Mutation, finishing touches, issue enrichment, and public confidence percentages are default-off in this draft. A future runtime loader should fail before review starts when a repo config tries to enable unsupported unsafe behavior.

## Proof Boundary

The current proof is limited to schema structure, docs, and fixtures. Runtime behavior remains future work for #109:

- no `.neondiff.yml` discovery
- no CLI generation or validation command
- no review filtering from config
- no dry-run evidence proving config controls posted versus dropped findings
