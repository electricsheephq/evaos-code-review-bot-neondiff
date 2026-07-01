# Review Status Comments

`evaos-code-review-bot` can post one App-authored status comment per PR head as
soon as that head enters the durable review queue. The comment is marker-backed
and edited in place as the head moves through the review lifecycle.

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
- `failed`

The marker is head-specific so a stale worker for an older head cannot overwrite
the live head's queued or in-progress status. This intentionally follows the
same broad pattern used by CodeRabbit and ClawSweeper: acknowledge quickly,
then edit a durable comment into the final state.

This is a soft coordination signal for humans and agents. It does not block
GitHub merges by itself. Requiring the bot before merge should be implemented
later with a dedicated GitHub Check and branch protection after the comment lane
has proven quiet.
