# Maintainer Commands

Maintainer commands are a narrow PR-comment control surface for trusted humans
and agents. They do not grant repair, merge, approval, branch-push, test-run, or
repo-mutation capabilities. Commands only steer the existing read-only review
pipeline.

Commands are disabled by default:

```json
{
  "commands": {
    "enabled": false,
    "botMentions": ["@evaos-code-review-bot"],
    "trustedAuthors": ["100yenadmin"],
    "acknowledge": false
  }
}
```

Enable them only in a tracked beta promotion after GitHub App permissions and
comment-volume behavior are verified.

## Supported Commands

Each command must appear as its own trimmed line in a PR comment:

- `@evaos-code-review-bot review`
- `@evaos-code-review-bot re-review`
- `@evaos-code-review-bot explain`
- `@evaos-code-review-bot stop`

`review` and `re-review` route into the same ZCode review pipeline used by
polling. They still use the current PR head SHA, current RIGHT-side diff-line
validation, secret redaction, ZCode read-only policy, and Git clean checks.

`explain` records the command and can post a marker-backed status comment when
`commands.acknowledge` is enabled. It does not start a review.

`stop` records the command and skips queued review work for that PR/head when
the command is the latest unprocessed command.

## Trust Boundary

Only authors listed in `commands.trustedAuthors` are executable in this MVP.
Unauthorized commands are detected and ignored. Collaborator/maintainer
permission lookup can be added later, but it should be tested against the
GitHub App's installed permissions before enabling in live config.

## Dedupe Boundary

Commands are deduped by:

- repo
- PR number
- live head SHA
- GitHub comment id

Reprocessing the same command comment on the same head does nothing. A new push
creates a new head SHA, so the same comment id is not treated as proof for the
new head unless a trusted author comments again.

## Evidence

Command-triggered reviews write evidence under the normal PR/head evidence path
with a `command-<comment-id>` subfolder. The evidence includes the command
source JSON. Polling reviews keep the existing evidence path shape.

The live daemon result includes command counters such as `skippedCommandStop`,
`skippedCommandExplain`, `commandReviewRequested`, and `skippedPolicy`.
