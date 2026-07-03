# Maintainer Commands

Maintainer commands are a narrow PR-comment control surface for trusted humans
and agents. They do not grant repair, merge, approval, branch-push, test-run, or
repo-mutation capabilities. Commands only steer the existing read-only review
pipeline or record draft-only finishing-touch requests.

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
- `@evaos-code-review-bot generate tests`
- `@evaos-code-review-bot generate docs`
- `@evaos-code-review-bot generate docstrings`
- `@evaos-code-review-bot simplify suggestion`
- `@evaos-code-review-bot changelog draft`
- `@evaos-code-review-bot explain risk`
- `@evaos-code-review-bot make review-ready`

`review` and `re-review` route into the same ZCode review pipeline used by
polling. They still use the current PR head SHA, current RIGHT-side diff-line
validation, secret redaction, ZCode read-only policy, and Git clean checks.

`explain` records the command and can post a marker-backed status comment when
`commands.acknowledge` is enabled. It does not start a review.

`stop` records the command and skips queued review work for that PR/head when
the command is the latest unprocessed command.

Command precedence is intentionally conservative: a latest `stop` command wins,
`review` / `re-review` requests are not superseded by later draft-only
finishing-touch commands, and finishing-touch commands are processed only when no
review command is pending for that PR/head.

Finishing-touch commands are draft-only in this release. They record the
trusted author, trigger comment, target head SHA, command action, output SHA,
and proposed draft in local bot state. They also write redacted evidence under
the command-specific evidence folder. They do not call ZCode, fetch PR files,
create commits, push branches, approve, merge, run tests, or mutate the target
repository.

Operators can test the contract without GitHub posting:

```bash
npx tsx src/cli.ts finishing-touch-dry-run \
  --config /path/to/live.json \
  --repo owner/repo \
  --pr 123 \
  --head-sha HEAD \
  --current-head HEAD \
  --comment-id 456 \
  --author maintainer \
  --trusted-authors maintainer \
  --body '@evaos-code-review-bot explain risk'
```

## Trust Boundary

Only authors listed in `commands.trustedAuthors` are executable in this MVP.
Unauthorized commands are detected and ignored. Collaborator/maintainer
permission lookup can be added later, but it should be tested against the
GitHub App's installed permissions before enabling in live config.

## Dedupe Boundary

Commands are deduped by:

- repo
- PR number
- GitHub comment id

Reprocessing the same command comment does nothing, including after a new push.
A new head SHA needs a new trusted command comment. This keeps old `stop`
comments from suppressing future pushes and keeps old `review` commands from
silently re-triggering on new code.

## Evidence

Command-triggered reviews and finishing-touch drafts write evidence under the
normal PR/head evidence path with a `command-<comment-id>` subfolder. The
evidence includes the command source JSON for reviews or the finishing-touch
draft JSON/Markdown for draft-only commands. Polling reviews keep the existing
evidence path shape.

The live daemon result includes command counters such as `skippedCommandStop`,
`skippedCommandExplain`, `skippedFinishingTouchDraft`,
`commandReviewRequested`, and `skippedPolicy`.
