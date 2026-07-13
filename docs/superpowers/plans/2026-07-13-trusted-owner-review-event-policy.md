# Trusted-Owner Review Event Policy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `REQUEST_CHANGES` an exact-head, trusted-owner, one-shot action while preserving autonomous advisory findings and current-head safety.

**Architecture:** Keep the deterministic review gate's event as the candidate signal. A separate review-event policy selects the public GitHub event immediately before posting, using a freshly read owner command and an atomic SQLite consumption record; every missing, malformed, untrusted, stale, duplicate, consumed, or lookup-failed authorization selects `COMMENT`. The exact command names the repository, pull request, and current head, and it queues one review attempt; ordinary `review` / `re-review` commands never authorize `REQUEST_CHANGES`.

**Tech Stack:** TypeScript, Vitest, Node SQLite, GitHub REST review/comments APIs, JSON Schema.

## Global Constraints

- Supported policy modes are `automatic` and `trusted_command_only` under `reviewGate.reviewEventPolicy.mode`; omitted configuration resolves to the safe `trusted_command_only` default, while `automatic` is an explicit legacy opt-in prohibited in the internal production config.
- `trusted_command_only` never removes inline P0/P1 findings; it changes only the GitHub review event from candidate `REQUEST_CHANGES` to selected `COMMENT` unless a valid authorization is atomically consumed.
- The authorization command is exactly `<configured bot mention> request-changes --repo <owner/name> --pr <positive integer> --head <40 lowercase-or-uppercase hexadecimal characters>` on one normalized line.
- Authorization is accepted only from an explicit login in `commands.trustedAuthors`; wildcard `*` can never authorize `REQUEST_CHANGES`. The named repository, pull request, and normalized head must match the live review target exactly.
- A valid authorization command queues one review attempt. Existing `review` / `re-review` commands continue to queue analysis but never authorize `REQUEST_CHANGES`.
- Authorization is one-shot for `{repo, pull_number, head_sha}`. A second command for the same head is denied; a new head requires a new exact command. Dry-run never consumes authority.
- The final comment reread and atomic consume occur after the existing `before_post` live-head check. The authority is consumed before GitHub review POST even when the candidate event is `COMMENT`, and it is never restored after timeout, 5xx, or another post failure. A GitHub comment-read failure fails closed to `COMMENT` without failing the advisory review.
- Every review POST supplies the expected head as GitHub's `commit_id`. GitHub documents that this binds the review to the named commit but does not promise stale-head rejection, so the worker also rereads the PR immediately after POST and records `head_changed_during_post` when the live head moved; that review is never claimed as current-head proof.
- Evidence stores candidate event, selected event, mode, decision reason, exact head, bounded redacted author, and comment id only. It never stores comment bodies, tokens, keys, or credentials.
- NeonDiff still never submits `APPROVE`, merges, pushes, repairs branches, changes settings, or expands permissions.
- Local validation remains focused; GitHub Actions owns the broad suite.

---

### Task 1: Pure policy and configuration contract

**Files:**
- Create: `src/review-event-policy.ts`
- Create: `tests/review-event-policy.test.ts`
- Modify: `src/config.ts`
- Modify: `tests/confidence-config.test.ts`

**Interfaces:**
- Produces: `ReviewEventPolicyConfig`, `ReviewEventAuthorizationAttempt`, `ReviewEventDecision`, `selectReviewEventAuthorizationAttempt`, and `decideReviewEventPolicy`.
- Consumes later: Task 3 uses the pure decision object without reimplementing policy rules.

- [ ] **Step 1: Write failing policy tests**

```ts
expect(decideReviewEventPolicy({
  mode: "trusted_command_only",
  candidateEvent: "REQUEST_CHANGES",
  headSha: HEAD,
  authorization: { status: "missing" }
})).toMatchObject({ selectedEvent: "COMMENT", reason: "authorization_missing" });

expect(decideReviewEventPolicy({
  mode: "trusted_command_only",
  candidateEvent: "REQUEST_CHANGES",
  headSha: HEAD,
  authorization: { status: "eligible", headSha: HEAD, author: "100yenadmin", commentId: 41 }
})).toMatchObject({ selectedEvent: "REQUEST_CHANGES", reason: "authorization_eligible" });
```

Cover candidate `COMMENT`, `automatic`, missing, malformed, untrusted, stale head, lookup failure, and eligible exact head. Assert output never includes a command body.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/review-event-policy.test.ts tests/confidence-config.test.ts`

Expected: FAIL because the policy types/module and configuration field do not exist.

- [ ] **Step 3: Implement the pure contract and fail-closed validation**

```ts
export type ReviewEventPolicyMode = "automatic" | "trusted_command_only";

export interface ReviewEventPolicyConfig {
  mode: ReviewEventPolicyMode;
}

export interface ReviewEventDecision {
  candidateEvent: ReviewEvent;
  selectedEvent: ReviewEvent;
  mode: ReviewEventPolicyMode;
  reason: ReviewEventDecisionReason;
  headSha: string;
  author?: string;
  commentId?: number;
}
```

Add `reviewEventPolicy: { mode: "trusted_command_only" }` under `DEFAULT_CONFIG.reviewGate`, merge old configs additively, reject unknown keys/modes, and keep the pure selector free of GitHub and SQLite dependencies. Permit `automatic` only as an explicit compatibility mode.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/review-event-policy.test.ts tests/confidence-config.test.ts && npm run build`

Expected: PASS with pristine output.

- [ ] **Step 5: Commit**

```bash
git add src/review-event-policy.ts src/config.ts tests/review-event-policy.test.ts tests/confidence-config.test.ts
git commit -m "feat(review): add owner-gated event policy"
```

---

### Task 2: Authorization command parsing and atomic one-shot state

**Files:**
- Modify: `src/commands.ts`
- Modify: `tests/commands.test.ts`
- Modify: `src/state.ts`
- Modify: `tests/state.test.ts`

**Interfaces:**
- Produces: an exact `request-changes` command parse carrying bounded repo/PR/head metadata and `ReviewStateStore.tryConsumeReviewEventAuthorization(input): boolean`.
- Preserves: existing review/re-review scheduling semantics; the new command queues exactly one manual review attempt.

- [ ] **Step 1: Write failing parser and state tests**

```ts
const attempts = collectReviewEventAuthorizationAttempts([
  comment(41, "100yenadmin", `@neondiff request-changes --repo org/repo --pr 7 --head ${HEAD}`)
], commandConfig, { repo: "org/repo", pullNumber: 7, headSha: HEAD });
expect(attempts.selected).toMatchObject({ status: "eligible", headSha: HEAD, commentId: 41 });

expect(store.tryConsumeReviewEventAuthorization({
  repo: "org/repo", pullNumber: 7, headSha: HEAD, commentId: 41, author: "100yenadmin"
})).toBe(true);
expect(store.tryConsumeReviewEventAuthorization({
  repo: "org/repo", pullNumber: 7, headSha: HEAD, commentId: 41, author: "100yenadmin"
})).toBe(false);
```

Cover uppercase SHA normalization, malformed/short SHA, repo/PR/head mismatch, untrusted author, wildcard-only trust, duplicate comment, a second command on the same head, and a new command on a new head. Assert ordinary `review` / `re-review` commands produce no authorization attempt and `request-changes` produces one queued review request.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/commands.test.ts tests/state.test.ts`

Expected: FAIL because authorization parsing and the consumption table do not exist.

- [ ] **Step 3: Implement parsing and the additive SQLite table**

```sql
create table if not exists review_event_authorization_consumptions (
  repo text not null,
  pull_number integer not null,
  head_sha text not null,
  comment_id integer not null,
  author text not null,
  consumed_at text not null,
  primary key (repo, pull_number, head_sha)
);
```

Parse only the exact flag-based command and reject extra or reordered tokens. Return bounded metadata, never the comment body. Implement consume as `insert ... on conflict do nothing` and return `changes === 1`; validate repo, PR, comment id, explicit author, and the 40-character SHA before the write.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/commands.test.ts tests/state.test.ts && npm run build`

Expected: PASS; a legacy database opens and gains the table without losing prior rows.

- [ ] **Step 5: Commit**

```bash
git add src/commands.ts src/state.ts tests/commands.test.ts tests/state.test.ts
git commit -m "feat(review): persist one-shot owner authorization"
```

---

### Task 3: Apply the policy at the final live-post boundary

**Files:**
- Modify: `src/worker.ts`
- Modify: `src/github.ts`
- Modify: `src/review-event-policy.ts`
- Modify: `tests/worker-context-budget.test.ts`
- Modify: `tests/stale-head.test.ts`
- Modify: `tests/github-app-read.test.ts`
- Modify: `tests/review-event-policy.test.ts`

**Interfaces:**
- Consumes: Task 1 policy decision and Task 2 authorization collector/atomic consume.
- Produces: `review-event-decision.json`; `ReviewPlan.event` and `processed_reviews.event` contain the selected public event.

- [ ] **Step 1: Write failing worker tests**

```ts
expect(postedReview.event).toBe("COMMENT");
expect(postedReview.comments).toContainEqual(expect.objectContaining({ severity: "P1" }));

expect(authorizedPostedReview.event).toBe("REQUEST_CHANGES");
expect(store.getProcessedReview(REPO, PR, HEAD)?.event).toBe("REQUEST_CHANGES");
```

Add real worker-path cases for no authorization, exact trusted authorization, consumed authorization, review/re-review only, comment lookup failure, dry-run non-consumption, a head change between authorization lookup and post, expected `commit_id` propagation, and a head change during POST.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/worker-context-budget.test.ts tests/stale-head.test.ts tests/github-app-read.test.ts`

Expected: FAIL because the worker still posts the deterministic candidate directly.

- [ ] **Step 3: Integrate without weakening current-head checks**

```ts
const candidateEvent = selfConsistency.event;
// dry-run: select without consuming and label the decision as dry-run evidence
// live: after liveBeforePost passes, re-read comments, select the exact-head attempt,
// atomically consume it, and downgrade to COMMENT if lookup/consume fails.
const finalDecision = decideReviewEventPolicy({
  mode: config.reviewGate.reviewEventPolicy.mode,
  candidateEvent,
  headSha: pull.head.sha,
  authorization
});
plan.event = finalDecision.selectedEvent;
```

Consume an eligible command after the final live-head check even when the candidate is already `COMMENT`, then decide the selected event. Never roll consumption back after a post failure. Require `headSha` in `GitHubApi.createReview` and send it as `commit_id`. Rebuild the walkthrough from the final selected event before posting it. Write the redacted decision packet and final review plan before `createReview`. Immediately reread the pull after posting; if the head moved, write a bounded `head_changed_during_post` incident and withhold current-head success evidence. Never throw away findings when the selected event is `COMMENT`.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/review-event-policy.test.ts tests/commands.test.ts tests/state.test.ts tests/worker-context-budget.test.ts tests/stale-head.test.ts tests/github-app-read.test.ts && npm run build`

Expected: PASS; live and dry-run evidence distinguish candidate and selected events.

- [ ] **Step 5: Commit**

```bash
git add src/worker.ts src/github.ts src/review-event-policy.ts tests/worker-context-budget.test.ts tests/stale-head.test.ts tests/github-app-read.test.ts tests/review-event-policy.test.ts
git commit -m "feat(review): enforce exact-head owner authorization"
```

---

### Task 4: Scheduler, public schema, settings preview, and operator documentation

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `tests/scheduler.test.ts`
- Modify: `src/repo-policy.ts`
- Modify: `tests/worker-settings-preview.test.ts`
- Modify: `docs/schema/neondiff-config.schema.json`
- Modify: `tests/neondiff-config-schema.test.ts`
- Modify: `config.example.json`
- Modify: `config.active-profiles.example.json`
- Modify: `docs/neondiff-config.md`
- Modify: `docs/maintainer-commands.md`

**Interfaces:**
- Scheduler treats `request-changes` as a manual analysis request and carries its comment id into the queued job; ordinary review/re-review commands remain advisory-only authority-wise.
- Settings preview exposes the configured policy mode without claiming authorization.

- [ ] **Step 1: Write failing scheduler/schema/preview tests**

```ts
expect(result.commandReviewRequested).toBe(1); // exact command queues one attempt
expect(state.listReviewQueueJobs({ state: "queued" })).toHaveLength(1);
expect(settings.reviewGate.reviewEventPolicy).toEqual({ mode: "trusted_command_only" });
```

Pin readiness to `needs_fix` only when the persisted selected event is `REQUEST_CHANGES`; stale/untrusted/malformed authorization with a P1 candidate must persist `COMMENT` and `ready_for_human`.

- [ ] **Step 2: Verify RED**

Run: `npm test -- tests/scheduler.test.ts tests/worker-settings-preview.test.ts tests/neondiff-config-schema.test.ts`

Expected: FAIL because the schema/preview and authorization scheduling contract are absent.

- [ ] **Step 3: Implement schema/examples/docs**

Document the exact one-command operator flow:

```text
@neondiff request-changes --repo owner/name --pr 123 --head <40-character-current-head-sha>
```

Document that the command queues one attempt, authority is one-shot per exact head, a second command on that head is denied, a new head needs a new exact command, review/re-review never authorize, wildcard trust never authorizes, and every failure mode remains advisory. Set examples and upgrade behavior to the safe `trusted_command_only` default; document `automatic` only as explicit legacy compatibility.

- [ ] **Step 4: Verify GREEN**

Run: `npm test -- tests/scheduler.test.ts tests/worker-settings-preview.test.ts tests/neondiff-config-schema.test.ts tests/commands.test.ts && npm run build && npm run check:public-claims && npm run check:secrets`

Expected: PASS with no policy overclaim or secret-bearing evidence.

- [ ] **Step 5: Commit**

```bash
git add src/scheduler.ts tests/scheduler.test.ts src/repo-policy.ts tests/worker-settings-preview.test.ts docs/schema/neondiff-config.schema.json tests/neondiff-config-schema.test.ts config.example.json config.active-profiles.example.json docs/neondiff-config.md docs/maintainer-commands.md
git commit -m "docs(review): publish owner-gated event contract"
```

---

### Task 5: Exact-head review, merge, and internal daemon promotion proof

**Files:**
- Modify only if evidence paths are repository-owned: `docs/evidence/<release>/...`
- External live config after merge: `/Volumes/LEXAR/Codex/evaos-code-review-bot/config/active-installed-live.json`

**Interfaces:**
- Consumes the merged implementation artifact.
- Produces issue #557 proof for source, configuration, runtime, and exact-head command behavior.

- [ ] **Step 1: Run focused pre-PR validation**

```bash
npm test -- tests/review-event-policy.test.ts tests/commands.test.ts tests/state.test.ts tests/worker-context-budget.test.ts tests/stale-head.test.ts tests/scheduler.test.ts tests/worker-settings-preview.test.ts tests/neondiff-config-schema.test.ts
npm run build
npm run check:public-claims
npm run check:secrets
git diff --check origin/main...HEAD
```

- [ ] **Step 2: Obtain exact-head GitHub proof**

Require green CI, CodeQL, Linux daemon smoke, applicable Swift gates, independent spec/security review, CodeRabbit, evaOS review, and zero unresolved review threads before merge.

- [ ] **Step 3: Merge without publishing a release**

Verify the merge commit on `main` and post-merge CI. Do not mutate npm, tags, GitHub Releases, checkout, Stripe, Fly, or production license state.

- [ ] **Step 4: Promote the internal daemon under the owner-gated config**

From the merged artifact, back up the existing config privately, add:

```json
"reviewGate": { "reviewEventPolicy": { "mode": "trusted_command_only" } }
```

Validate config, restart only the owned LaunchAgent, and verify launchd PID/heartbeat/current source identity.

- [ ] **Step 5: Run live no-bypass proof on an owner-controlled fixture PR**

Prove: autonomous P1 posts `COMMENT`; untrusted, wildcard-only, malformed, stale, and consumed authorization do not produce `REQUEST_CHANGES`; ordinary `review`/`re-review` does not authorize; one exact trusted `request-changes` command permits exactly one `REQUEST_CHANGES` on the named head. Record only redacted comment ids, authors, head SHA, event decisions, review URLs, and runtime identity.

- [ ] **Step 6: Update #557 and the release tracker**

Report what is proven and keep #559 blocked until this live runtime proof and its post-merge source evidence are complete.
