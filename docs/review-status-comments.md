# Review Status Comments

`evaos-code-review-bot` can post one App-authored status comment per PR head as
soon as that head enters the durable review queue. The comment is marker-backed
and edited in place as the head moves through the review lifecycle.

The lane is default-off in the built-in config. Enable it only through explicit
runtime config after a dry-run/release-status gate. Rollback is setting
`reviewStatusComment.enabled=false`, redeploying the config, restarting launchd,
and confirming the next `release:status` cycle is green.

The identity marker is stable for one repo, pull request, and head SHA:

```html
<!-- evaos-code-review-bot:review-status repo=OWNER/REPO pr=123 sha=HEAD_SHA -->
```

The mutable state marker is updated with each lifecycle state:

```html
<!-- evaos-code-review-bot:review-status-state status=queued updated_at=... -->
```

Supported states:

- `queued`
- `in_progress`
- `completed`
- `provider_deferred`
- `stale_head`
- `closed_or_merged_before_review`
- `skipped`
- `failed`

`provider_deferred` is not a settled state. It means provider availability,
provider cooldown, or worker capacity still intends to retry later; agents
should keep waiting or inspect bot status.

The marker is head-specific so a stale worker for an older head cannot overwrite
the live head's queued or in-progress status. This intentionally follows the
same broad pattern used by CodeRabbit and ClawSweeper: acknowledge quickly,
then edit a durable comment into the final state.

Manual `review` / `re-review` commands intentionally use a quieter lifecycle
and may move directly from `queued` to `completed`; command
acknowledgement/state lives in the separate command lane. Non-review commands
such as `stop` and `explain` do not create review status comments.

## Durable Readiness State

The worker also persists one machine-readable `review_readiness` row per repo,
PR, and head SHA. This row is the durable state-machine source for operators and
future dashboards; the public sticky comment remains only a human coordination
surface.

Readiness states:

- `queued`: a review job was accepted into the durable queue.
- `reviewing`: a leased queue job is currently running review work.
- `needs_fix`: a posted or dry-run review ended in `REQUEST_CHANGES`.
- `awaiting_re_review`: a trusted `re-review` command was accepted.
- `blocked_on_checks`: reserved for future check-gated readiness.
- `blocked_on_proof`: reserved for future evidence/proof-gated readiness.
- `ready_for_human`: the head has a non-blocking bot review or dry-run result.
- `provider_deferred`: capacity or provider cooldown deferred the head.
- `stale`: an older head was superseded by a newer PR head, or the queued
  head's base/head changed before review.
- `closed`: the PR closed or merged before review work completed.
- `command_recorded`: a trusted non-review command such as `explain` was
  recorded.
- `skipped`: policy, draft, canary, or trusted `stop` skipped the head.
- `failed`: GitHub refetch, review execution, or worker failure stopped the
  head.

No-op scheduler cycles preserve `updated_at`. In practice this means duplicate
processed-head scans do not create fresh readiness events and should not trigger
new comments. Manual command metadata (`command_action`, `command_comment_id`)
is retained across the later terminal transition so operators can connect
`ready_for_human` or `needs_fix` back to the command that requested it.

This is a soft coordination signal for humans and agents. It does not block
GitHub merges by itself. Requiring the bot before merge should be implemented
later with a dedicated GitHub Check and branch protection after the comment lane
has proven quiet.

Operator status includes `statusCommentFailures`. A non-zero value means the
sticky status lane could not post or edit at least one comment, usually because
App credentials were unavailable, comment construction failed, or GitHub
rejected the upsert. The review run may still complete, but operators should
treat the coordination signal as degraded until the next green release/status
cycle. Token-mode deployments without GitHub App credentials should keep
`reviewStatusComment.enabled=false` or expect `missing_app_credentials` failures
while the lane is enabled.
