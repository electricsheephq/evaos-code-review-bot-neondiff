# License Subscription Lifecycle Implementation Plan

**Goal:** Implement issue #562's sole-authority subscription lifecycle without changing the shipped v1.0.4 client contract or reopening checkout.

**Authority and boundaries:** The merged design at `edc6aeb6fa293a58844384ceba7f798ac5a8a744` is authoritative, with two explicit corrections from current shipped/public truth: Individual Yearly receives a 7-day initial trial (Monthly 7, Organization Yearly 30), and the initial supported billing currency is USD only. Issue #562 owns implementation; #559 owns the immutable v1.0.5 release; website #46 owns the checkout adapter and live Stripe proof. Do not deploy, mutate Stripe or production SQLite, reopen checkout, publish, or claim customer readiness in this branch.

**Architecture:** Upgrade the license service to a crash-safe SQLite schema v2 with immutable checkout/subscription bindings and an append-only lifecycle ledger. Checkout issuance becomes server-policy-owned. A strict parser validates a small lifecycle command matrix, while a single atomic store transaction enforces replay safety, monotonic renewal, cancellation behavior, and terminal revocation. A separately rate-limited admin endpoint uses the existing issuance-secret boundary. Existing hashes, activations, and the v1.0.4 client protocol remain compatible.

**Execution rule:** Each task follows RED → minimal GREEN → focused/full verification → commit → fresh independent task review. P0-P2 findings block progression.

## Task 1: Crash-safe schema v2 migration

Create `services/license-api/test/store-migration.test.ts`; modify `services/license-api/src/store.ts`.

- Add `SchemaMigrationStep`, `LicenseStoreOptions`, and an optional migration hook for deterministic rollback tests.
- Empty `user_version=0` creates the complete v2 schema atomically.
- The exact legacy three-table schema migrates additively; unknown non-empty v0 schemas fail before mutation.
- Add immutable `checkout_subscription_bindings` and append-only `license_subscription_lifecycle_events`, including the issuance/time index.
- Verify v2 on reopen and prove hook-triggered failures roll back all DDL while preserving legacy rows.

RED/GREEN: `node --import tsx --test test/store-migration.test.ts`; then service `npm test` and `npm run build`.

Commit: `feat(license-api): add crash-safe schema v2 migration`

## Task 2: Server-owned checkout policy and bound issuance

Create `src/checkout-policy.ts` and `test/issuance-policy.test.ts`; modify issuance, store, and HTTP tests.

- Policies: Monthly 7-day trial/62-day max/USD/1 seat; Individual Yearly 7-day trial/400-day max/USD/1 seat; Organization Yearly 30-day trial/400-day max/USD/1 seat.
- Require issuance reference plus provider/account/mode/subscription/checkout identifiers.
- Reject caller authority over expiry, plan, scope, ownership, or seats; compatibility `seats` is accepted only when exactly 1.
- Derive expiry from the injected clock and insert license, issuance, and binding in one transaction.
- Quarantine conflicting unbound or multi-seat replays with `409`.

RED/GREEN: `node --import tsx --test test/issuance-policy.test.ts test/http.test.ts`, then the service suite/build.

Commit: `feat(license-api): bind checkout issuance to server policy`

## Task 3: Strict lifecycle parser and canonical hash

Create `src/subscription-lifecycle.ts` and `test/subscription-lifecycle-parser.test.ts`.

- Commands: `renew_paid`, `reconcile`, `cancel_at_period_end`, `payment_attention`, `revoke`.
- Enforce the exact field set, bounded body/strings, integer event time, five-minute future skew, provider tuple, command/event/status matrix, and lowercase USD.
- `renew_paid` requires active status, positive provider-collected subscription-cycle payment, reference, and period end; reject zero, credits/trials, out-of-band, non-cycle, and trialing evidence.
- Canonicalize fixed fields for a stable request hash and store only a one-way payment-reference fingerprint.

RED/GREEN: `node --import tsx --test test/subscription-lifecycle-parser.test.ts`.

Commit: `feat(license-api): validate subscription lifecycle commands`

## Task 4: Atomic replay and monotonic renewal

Create `test/subscription-lifecycle-store.test.ts`; modify store and lifecycle modules.

- In `BEGIN IMMEDIATE`, resolve the bound issuance, hash the request, replay exact event/hash, conflict on event/hash mismatch, and require the exact provider tuple.
- Enforce plan period caps and extend using `max(existing, incoming)`.
- Reactivate only non-terminal stored expiry with a future valid paid end.
- Write ledger and entitlement mutation in one transaction; never store raw keys or payment references.

RED/GREEN: focused `binding|replay|renewal` store tests, then full service suite/build.

Commit: `feat(license-api): apply bound paid renewals atomically`

## Task 5: Ordering, cancellation, attention, and terminal dominance

Extend lifecycle store tests and implementation.

- Reconcile records without extending/reactivating; stale non-mutating events become audited `ignored_stale` results.
- Cancellation preserves expiry; payment attention grants no time and does not revoke early.
- Revoke needs no period end, records a bounded reason, and is terminal.
- Prove no resurrection, max-period convergence, same-second order convergence, and preservation of activation/key hashes.

RED/GREEN: focused `cancel|attention|stale|same-second|terminal` tests, then full service suite/build.

Commit: `feat(license-api): enforce terminal lifecycle ordering`

## Task 6: Guarded lifecycle HTTP endpoint

Create `test/subscription-lifecycle-http.test.ts`; modify `src/http.ts`, `src/server.ts`, and HTTP tests.

- Add `POST /v1/admin/licenses/lifecycle` behind the existing issuance secret and a distinct `subscriptionLifecycleRateLimiter` (never reuse the GitHub OIDC lifecycle limiter).
- Enforce a 16 KiB body cap, generic pre-lookup `401`, bounded redacted `429`, and no request/exception echo.
- Map applied/replay/stale/attention/revoke to `200`, terminal/conflict to `409`, unknown/unbound/mismatch to `404`, policy/parser errors to `400`, and transient storage errors to `503`.

RED/GREEN: `node --import tsx --test test/subscription-lifecycle-http.test.ts`, then service suite/build.

Commit: `feat(license-api): add guarded subscription lifecycle endpoint`

## Task 7: Owner-only legacy binding backfill

Modify store, admin CLI, and admin tests.

- Add `bind-checkout-subscription` with provider tuple and optional `--dry-run`; never accept or print a raw key.
- Bind only existing `source=checkout` issuance, make identical replay idempotent, and conflict on tuple differences.
- Return only result plus an opaque issuance fingerprint. Production execution remains a separate owner-approved operation.

RED/GREEN: focused admin `bind checkout subscription` tests, then service suite/build.

Commit: `feat(license-api): add guarded checkout binding backfill`

## Task 8: Real v1.0.4 client compatibility

Extend `tests/license-service-contract.test.ts` and service tests.

- With the real client, prove bound issue → activate → paid renew → validate active → cancel while active → expire, plus separate terminal revocation.
- Prove no raw key appears in lifecycle responses/evidence and the existing activate/validate/deactivate/seat flow is unchanged.

RED/GREEN: focused contract/license/mandatory-activation tests with one worker, then root build.

Commit: `test(license): prove lifecycle compatibility with v1.0.4 client`

## Task 9: Rollout and disaster-recovery contract

Create `services/license-api/docs/subscription-lifecycle.md`; update service/root admin, deploy, DR docs/tests, and only rename the existing CI service gate if needed.

- Document endpoint/matrix/results/redaction/backfill and the continuing checkout hold.
- Require a verified Litestream recovery point immediately before v2 rollout; forbid copying an open SQLite database.
- Migration failure must prevent start. Image rollback does not reverse schema; restore uses the reviewed recovery point on a fresh path/volume.
- Preserve sandbox/live separation, prohibit raw-key recovery/replacement minting during reconciliation, and remove stale offline-cache authorization claims.
- Explicitly hand release/version/manifest/live proof to #559.

RED/GREEN: focused DR test, then complete verification below.

Commit: `docs(license): add lifecycle rollout and recovery runbook`

## Final verification and proof boundary

Run, in order:

```bash
npm ci --prefix services/license-api
npm test --prefix services/license-api
npm run build --prefix services/license-api
npm ci
npx vitest run tests/license-service-contract.test.ts tests/license-service-dr.test.ts tests/license.test.ts tests/mandatory-activation-matrix.test.ts --pool=forks --maxWorkers=1
npm run build
npm test -- --pool=forks --maxWorkers=1
npm run check:public-claims
npm run check:secrets
git diff --check
```

Then require exact-head CI and CodeQL, independent spec/security review, and zero unresolved current-head P0-P2 threads. Merge proves source/contract readiness only. Deployment, production backfill, website integration, live Stripe lifecycle proof, checkout reopening, and immutable v1.0.5 release remain separately gated.
