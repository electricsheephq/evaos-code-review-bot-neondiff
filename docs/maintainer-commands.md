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
    "botMentions": ["@neondiff"],
    "trustedAuthors": ["100yenadmin"],
    "acknowledge": false
  }
}
```

Enable them only in a tracked beta promotion after GitHub App permissions and
comment-volume behavior are verified.

## Supported Commands

Each command must appear as its own trimmed line in a PR comment:

- `@neondiff review`
- `@neondiff re-review`
- `@neondiff request-changes --repo owner/name --pr 123 --head <40-character-current-head-sha>`
- `@neondiff explain`
- `@neondiff stop`
- `@neondiff generate tests`
- `@neondiff draft tests`
- `@neondiff generate docs`
- `@neondiff draft docs`
- `@neondiff generate docstrings`
- `@neondiff simplify suggestion`
- `@neondiff changelog draft`
- `@neondiff draft changelog`
- `@neondiff explain risk`
- `@neondiff make review-ready`

Existing internal deployments may keep their current bot mention in
`commands.botMentions`; new public setup should use the NeonDiff mention or the
actual GitHub App slug chosen during installation.

`review` and `re-review` route into the same ZCode review pipeline used by
polling. They still use the current PR head SHA, current RIGHT-side diff-line
validation, secret redaction, ZCode read-only policy, and Git clean checks.
They do not authorize a `REQUEST_CHANGES` GitHub event.

`request-changes` must be the exact one-line command shown above, using the
configured bot mention, exact repository, positive PR number, and exact
40-character current-head SHA. Only an explicit login in
`commands.trustedAuthors` can authorize it; wildcard `"*"` trust never does.
It queues one manual review attempt, and the queued job carries the exact GitHub
comment id. A newer `stop` wins over an older request. Later ordinary `review`
or `re-review` comments do not inherit or erase the exact authorization.

The authorization is one-shot for the exact `{repo, PR, head SHA}`. A second
new command on the same head may queue another analysis attempt, but the
one-shot ledger downgrades its selected event to advisory `COMMENT`; a new head
needs a new exact command. The first eligible authorization is consumed before
the GitHub review POST, even if the candidate has already become `COMMENT`, and
is never restored after timeout, 5xx, or another post failure.

Missing, malformed, untrusted, wildcard-only, wrong-repo, wrong-PR, stale-head,
duplicate, consumed, comment-read-failed, and local-state-failed authorization
all remain advisory: findings still post, but the selected event is `COMMENT`.
The review POST carries the expected SHA as `commit_id`; NeonDiff also performs
its own live-head checks because `commit_id` alone is not current-head proof.

`explain` records the command and can post a marker-backed status comment when
`commands.acknowledge` is enabled. It does not start a review.

`stop` records the command and skips queued review work for that PR/head when
the command is the latest unprocessed command.

Command precedence is intentionally conservative: a latest `stop` command wins,
an exact `request-changes` authorization is not erased by ordinary `review` or
`re-review`, `review` / `re-review` requests are not superseded by later draft-only
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
  --head-sha 0123456789abcdef0123456789abcdef01234567 \
  --current-head 0123456789abcdef0123456789abcdef01234567 \
  --comment-id 456 \
  --author maintainer \
  --trusted-authors maintainer \
  --body '@neondiff explain risk'
```

The dry-run JSON includes a `contract` object with the target repo/PR/head,
trusted-author status, stale-head check, clean-worktree state
(`verified_clean`, `dirty`, or `assumed_clean`), secret-scan state (`passed`,
`failed`, or `not_scanned`), and explicit mutation booleans. All mutation
booleans remain `false`; the command is `defaultOff: true` and
`mode: "draft_only"` even when validation passes. When `--worktree-clean` is
omitted, the dry-run contract reports `assumed_clean` rather than claiming an
explicit Git clean check was performed. Validation fails closed unless both
`--head-sha` and `--current-head` are explicit 40-character Git SHAs; placeholder
values such as `HEAD` are not accepted as generation proof.

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

For `request-changes`, scheduler dedupe is also durable after its queue job
becomes terminal. This queue dedupe is separate from the one-shot event ledger:
a genuinely new exact command may queue, while a previously consumed exact head
still cannot select `REQUEST_CHANGES` again.

## Evidence

Command-triggered reviews and finishing-touch drafts write evidence under the
normal PR/head evidence path with a `command-<comment-id>` subfolder. The
evidence includes command source JSON for ordinary reviews or the
finishing-touch draft JSON/Markdown for draft-only commands. Exact
`request-changes` jobs write bounded authorization-decision metadata and do not
persist the raw comment body. Polling reviews keep the existing evidence path
shape.

The live daemon result includes command counters such as `skippedCommandStop`,
`skippedCommandExplain`, `skippedFinishingTouchDraft`,
`commandReviewRequested`, and `skippedPolicy`.
