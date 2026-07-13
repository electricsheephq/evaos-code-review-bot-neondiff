# NeonDiff True Review Concurrency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make NeonDiff run three bounded PR-review jobs concurrently while keeping one independent issue-enrichment lane.

**Architecture:** Replace the blocking ZCode child adapter with an asynchronous process lifecycle, then let the scheduler lease and settle one bounded parallel batch per daemon cycle. Start issue enrichment alongside that batch, preserve durable caps and current-head safeguards, and expose actual overlap telemetry.

**Tech Stack:** TypeScript, Node.js child processes, SQLite durable leases, Vitest, launchd.

## Global Constraints

- Work only in issue #579's isolated worktree until the reviewed merge is complete.
- Do not touch license lifecycle/service files, publish npm/GitHub releases, or change public deployment state.
- Add no database migration, configuration key, unbounded queue drain, or repository mutex.
- Write and observe a failing focused test before each production behavior change.
- Use GitHub Actions for repository-wide validation; local validation stays focused.

---

### Task 1: Non-blocking ZCode process lifecycle

**Files:**
- Modify: `src/zcode.ts`
- Modify: `src/self-consistency.ts`
- Modify: `src/worker.ts`
- Create: `tests/zcode-async.test.ts`
- Modify: `tests/self-consistency.test.ts`
- Modify: existing ZCode/worker tests whose adapters become asynchronous

**Interfaces:**
- `runZCodeReview(options): Promise<ZCodeReviewResult>`
- `runSelfConsistencyRecheck(options): Promise<SelfConsistencyResult>`

- [x] Add a fake executable barrier test proving three invocations enter concurrently and the Node event loop remains responsive.
- [x] Run the test and confirm it fails against synchronous `spawnSync` execution.
- [x] Implement asynchronous spawn, bounded stdout/stderr capture, timeout TERM/KILL cleanup, and policy restoration in `finally`.
- [x] Convert self-consistency and worker/provider retry call sites to await the adapter while keeping per-review draws/retries sequential.
- [x] Run ZCode, policy, provenance, output, self-consistency, and worker focused tests until green.

### Task 2: Bounded parallel scheduler batch

**Files:**
- Modify: `src/scheduler.ts`
- Modify: `tests/scheduler.test.ts`
- Modify: `tests/state.test.ts` only if lease-contract coverage needs an assertion

**Interfaces:**
- Effective PR slots are `min(reviewConcurrency.maxActiveRuns, reviewScheduler.maxProviderActive)`.
- `ScheduledRunResult.queue.execution` reports mode, configured slots, effective slots, started count, and peak jobs in flight.

- [x] Add a resolver-barrier scheduler test proving three jobs enter before any completes and no fourth starts.
- [x] Add cap, overload, all-settled, and fresh timestamp assertions; confirm failures against serial behavior.
- [x] Lease one bounded batch atomically, start all jobs, track peak in-flight jobs, and wait for the complete batch.
- [x] Preserve provider/org/repo/manual-reserve rules and defer only unstarted background work after overload.
- [x] Run scheduler/state focused tests until green.

### Task 3: Independent issue-enrichment lane

**Files:**
- Modify: `src/daemon.ts`
- Modify: `tests/daemon-loop.test.ts`

**Interfaces:**
- Issue enrichment starts after the single admission bundle and is always awaited before cycle return.
- Issue failures remain non-fatal; review failures remain fatal after issue cleanup.

- [x] Add daemon tests showing issue work begins before an unresolved review finishes and is awaited on review failure.
- [x] Confirm the tests fail against sequential daemon execution.
- [x] Start issue enrichment beside the review promise and add explicit start/completion/failure logs.
- [x] Run daemon focused tests until green.

### Task 4: Operator contract, validation, and delivery

**Files:**
- Modify: `docs/operator-cli.md`
- Modify: `docs/beta-release-runbook.md`
- Modify: `CHANGELOG.md` only if repository policy requires an unreleased runtime entry

- [x] Document bounded-batch telemetry, true reviewer-session overlap proof, direct-to-three canary checks, and rollback triggers.
- [x] Run focused transport/scheduler/daemon/state tests with one Vitest worker.
- [x] Run build, public-claims scan, secrets scan, and diff check.
- [ ] Commit logical changes, push the branch, open one PR closing #579, and record exact commands/evidence.
- [ ] Wait for exact-head CI and expected reviewers; resolve every current actionable thread with a terminal disposition.
- [ ] Merge only when current-head CI/review gates are terminal and clean.
- [ ] Coordinate with the production task, fast-forward the clean launchd checkout, set 3 PR lanes plus 1 issue lane, and restart through the canonical operator path.
- [ ] Prove real three-session overlap on natural current-head work and complete a 60-minute error/retry/lock/orphan soak before keeping the setting.
