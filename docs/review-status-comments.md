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

`provider_deferred` is not a settled state. It means the provider cooldown lane
still intends to retry later; agents should keep waiting or inspect bot status.

The marker is head-specific so a stale worker for an older head cannot overwrite
the live head's queued or in-progress status. This intentionally follows the
same broad pattern used by CodeRabbit and ClawSweeper: acknowledge quickly,
then edit a durable comment into the final state.

Manual `review` / `re-review` commands intentionally use a quieter lifecycle
and may move directly from `queued` to `completed`; command
acknowledgement/state lives in the separate command lane. Non-review commands
such as `stop` and `explain` do not create review status comments.

This is a soft coordination signal for humans and agents. It does not block
GitHub merges by itself. Requiring the bot before merge should be implemented
later with a dedicated GitHub Check and branch protection after the comment lane
has proven quiet.

Operator status includes `statusCommentFailures`. A non-zero value means the
sticky status lane could not post or edit at least one comment, usually because
App credentials were unavailable or GitHub rejected the upsert. The review run
may still complete, but operators should treat the coordination signal as
degraded until the next green release/status cycle. Token-mode deployments
without GitHub App credentials should keep `reviewStatusComment.enabled=false`
or expect `missing_app_credentials` failures while the lane is enabled.
