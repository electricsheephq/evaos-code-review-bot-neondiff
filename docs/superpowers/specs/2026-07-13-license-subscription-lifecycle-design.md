# Production License Subscription Lifecycle Design

Status: approved for implementation design on 2026-07-13

Execution truth:

- Product issue: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/562
- Website integration: https://github.com/electricsheephq/neon-diff-agent-website/issues/46
- Next immutable release hardening: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559

## Goal

Make the production license API the only entitlement authority for checkout,
renewal, cancellation, revocation, and seat enforcement. Subscription lifecycle
updates must target an existing checkout issuance without receiving, storing, or
returning its raw license key.

The design must preserve the verified v1.0.4 activation contract while checkout
remains disabled. It is implemented and released in a new immutable patch; the
v1.0.4 tag and package are never moved or republished.

## Existing Contract

`POST /v1/admin/licenses/issue` authenticates with the server-only
`LICENSE_ISSUANCE_SECRET`. It derives one deterministic key from the checkout
idempotency reference and stores only its hash. The
`license_issuance_events` row already maps that reference to the license hash.

The mutable entitlement lives in `licenses`. Activation rows bind machine IDs
and enforce `seats`. The current service has no lifecycle mutation by issuance
reference, no Stripe-event ledger, and no ordering watermark. Checkout issuance
also accepts caller-provided seats, which is incompatible with a
server-authoritative seat policy.

The GitHub Actions OIDC `issue-lifecycle` route is release-proof infrastructure,
not subscription billing infrastructure. It remains separate.

## Considered Approaches

### A. Atomic lifecycle ledger against the existing entitlement

Add a distinct authenticated endpoint that resolves the original checkout
issuance reference, records each billing event, and atomically updates the
existing entitlement. This preserves activations, avoids raw-key recovery, and
provides deterministic replay and ordering behavior.

This is the selected approach.

### B. Immutable entitlement versions with a current pointer

Create a new entitlement version for every billing transition and move a
pointer after validation. This offers stronger historical accounting but
requires a larger migration, a new client-resolution model, and broader recovery
proof. It is unnecessary for the current lifecycle requirement.

### C. Mint a replacement key for every renewal

This would require repeated plaintext delivery, invalidate or duplicate machine
activations, and leave multiple keys associated with one subscription. It is
rejected.

## API Contract

Add `POST /v1/admin/licenses/lifecycle` under the existing server-only bearer
boundary. Authentication failures return a generic response and never reveal
whether an issuance reference exists.

The request contains billing facts only:

```json
{
  "schemaVersion": 1,
  "issuanceIdempotencyKey": "checkout-session:<checkout-session-id>",
  "eventId": "<provider-event-id>",
  "eventCreatedAt": 1783900000,
  "provider": "stripe",
  "providerAccountId": "<provider-account-id>",
  "providerMode": "live",
  "externalSubscriptionId": "<provider-subscription-id>",
  "providerEventType": "invoice.paid",
  "command": "renew_paid",
  "paymentReference": "<provider-invoice-id>",
  "subscriptionStatus": "active",
  "currentPeriodEnd": "2026-08-13T00:00:00.000Z",
  "cancelAtPeriodEnd": false
}
```

The command enum is `renew_paid`, `reconcile`, `cancel_at_period_end`,
`payment_attention`, or `revoke`. The product API enforces this complete matrix;
the website mapping is not trusted to make an invalid pairing safe:

| Command | Allowed provider event | Allowed subscription status | Required fields | Forbidden fields |
| --- | --- | --- | --- | --- |
| `renew_paid` | `invoice.paid`, `invoice.payment_succeeded` | `active`, `trialing` | `paymentReference`, `currentPeriodEnd` | none |
| `reconcile` | `customer.subscription.updated` | `active`, `trialing` | none beyond the shared envelope | `paymentReference`; `cancelAtPeriodEnd` must be false |
| `cancel_at_period_end` | `customer.subscription.updated` | `active`, `trialing` | `currentPeriodEnd`; `cancelAtPeriodEnd` must be true | `paymentReference` |
| `payment_attention` | `invoice.payment_failed`, or `customer.subscription.updated` | `active`, `past_due`, `incomplete`, `paused` | none beyond the shared envelope | `paymentReference` |
| `revoke` | `customer.subscription.deleted`, or `customer.subscription.updated` | `canceled`, `unpaid`, `incomplete_expired` | none beyond the shared envelope | `paymentReference`, `currentPeriodEnd` |

`reconcile` and `payment_attention` may omit `currentPeriodEnd`; if supplied it
is parsed for diagnostic consistency but never mutates expiry. `revoke` does not
require or accept a period end. Any command/event/status/field mismatch returns
`400 invalid` before store mutation.

Unknown fields are rejected. The route never accepts a raw key, plan, scope,
seat count, `privateRepoAllowed`, or `updateEntitlement` value. Strings and the
body are bounded.

Checkout issuance is extended to bind `provider`, `providerAccountId`,
`providerMode`, `externalSubscriptionId`, and `externalCheckoutId` to the
issuance reference. A lifecycle request must match that immutable binding.
Unbound legacy issuances cannot receive lifecycle updates until the reviewed
backfill binds them.

Successful responses contain redacted entitlement metadata only:

```json
{
  "status": "updated",
  "replayed": false,
  "entitlement": {
    "status": "active",
    "plan": "yearly_support",
    "seats": 1,
    "expiresAt": "2026-08-13T00:00:00.000Z"
  }
}
```

Valid result states are `updated`, `replayed`, `ignored_stale`,
`payment_attention`, and `terminally_revoked`. No response includes a raw key or
request echo. A bounded rate limiter is separate from the public activation
limiter and from the OIDC release-lifecycle limiter.

HTTP and retry behavior is part of the shared contract:

| Condition | HTTP/result | Website behavior |
| --- | --- | --- |
| Applied event or exact replay | `200` with a valid result state | Acknowledge and update the redacted projection |
| Older non-mutating reconciliation | `200 ignored_stale` | Acknowledge; retain audit row |
| Terminal license receives renewal/reconcile | `409 terminally_revoked` | Quarantine; never retry into resurrection |
| Same event ID with different canonical request | `409 conflict` | Quarantine and alert |
| Unknown/unbound/mismatched issuance correlation | `404 not_found` | Quarantine; do not mint a replacement |
| Malformed, out-of-policy timestamp, or unsupported command | `400 invalid` | Quarantine |
| Missing/invalid bearer | `401 unauthorized` | Alert; no record-existence detail |
| Rate limited | `429 rate_limited` with bounded retry hint | Retry with bounded backoff |
| Transient service/storage failure | `503 unavailable` | Permit provider retry |

## Storage And Migration

Add a `checkout_subscription_bindings` table keyed by issuance reference with an
immutable unique tuple of provider, provider account, provider mode, and
external subscription ID. It also stores the non-secret checkout reference and
license hash.

Add a `license_subscription_lifecycle_events` table:

- `event_id` primary key;
- `issuance_idempotency_key`;
- `license_key_hash`;
- `external_subscription_id`;
- `request_hash`;
- `event_created_at` as an integer provider timestamp;
- provider account/mode, event type, command, optional payment fingerprint,
  normalized transition, and result;
- creation timestamp.

Add an index on the issuance reference and event timestamp. Store the smallest
lifecycle watermark needed for non-mutating reconciliation in the binding row.

Schema evolution uses `PRAGMA user_version` with target schema version 2. The
store recognizes the exact unversioned legacy schema, starts `BEGIN IMMEDIATE`,
creates the additive tables/indexes, verifies their required columns and
constraints, sets `user_version = 2`, and commits. Any error rolls back and
prevents the service from starting. Reopening version 2 is idempotent. The
deployment runbook requires a verified Litestream recovery point before rollout;
the application does not copy a live open database as an ad hoc backup.

Migration is additive. It must not rebuild or drop `licenses`, `activations`, or
`license_issuance_events`. A file-backed migration fixture creates the current
schema, issues and activates a key, reopens it with the new store, applies a
lifecycle event, and proves the original key hash and activation survive. A
second fixture injects a migration failure, proves rollback leaves the legacy
data readable, and proves a later clean reopen migrates exactly once.

The store exposes a constrained `applyCheckoutSubscriptionLifecycle` operation.
It does not expose a generic public lookup or arbitrary entitlement mutation.

## Atomicity, Replay, And Ordering

The store applies every event inside `BEGIN IMMEDIATE`:

1. Resolve the issuance reference and require `source = checkout`.
2. Canonicalize the request and calculate its hash.
3. If `eventId` exists with the same hash, return an idempotent replay.
4. If `eventId` exists with a different hash, return conflict.
5. Verify the immutable provider account/mode/subscription binding.
6. Apply the command's monotonic transition and insert the ledger row in one
   transaction.

Provider timestamps are second-granular, so different events with the same
timestamp are expected. Commands are deliberately commutative:

- `renew_paid` may extend to the maximum valid paid period end even if a
  reconciliation event with the same or later timestamp arrived first;
- `reconcile`, `cancel_at_period_end`, and `payment_attention` never extend or
  reactivate, so stale versions are safe audit-only no-ops;
- `revoke` is terminal and dominates every arrival order;
- multiple valid `renew_paid` events converge on the maximum period end;
- only reuse of the same event ID with different canonical content is a replay
  conflict.

Tests run paid-renewal plus subscription-update events in both same-second
arrival orders.

Terminal revocation dominates ordering. Once a license is terminally revoked,
no renewal or cancellation event can reactivate it. A legitimate later purchase
or owner-approved replacement requires a new issuance reference and key.

## Transition Semantics

- `renew_paid`: only an allowlisted paid-invoice event with a payment reference
  may extend expiry. It extends monotonically to the validated paid period end.
- `reconcile`: records active/trialing or other non-terminal billing state but
  never grants time. Trial access is established only by the original guarded
  checkout issuance and its server-bounded initial expiry.
- `cancel_at_period_end`: records non-renewal intent and preserves the existing
  paid expiry. It neither revokes early nor extends access.
- `payment_attention` for `past_due`, `incomplete`, or `paused`: records the
  diagnostic state without extending or resurrecting access.
- `revoke` for `canceled`, `unpaid`, `incomplete_expired`, or a deleted
  subscription: terminally revokes with a bounded non-secret reason.
- A valid paid renewal may reactivate a stored `expired` status only when the
  license is not terminally revoked and the new paid period end is in the
  future. It preserves the same key hash and activations.

`eventCreatedAt` cannot exceed the service clock by more than five minutes.
`currentPeriodEnd` must be a valid future timestamp and must stay within the
server-owned maximum duration for the bound plan: 62 days for monthly and 400
days for yearly/organization. Missing, invalid, non-finite, or out-of-policy
period boundaries fail closed and never create non-expiring access. Terminal
revocation remains valid without a period end.

Client-visible activation and validation behavior remains unchanged: active
returns the existing entitlement shape, elapsed paid time returns expired, and
terminal revocation returns revoked.

## Seat Policy

Checkout plan policy is owned by the product service:

- `neondiff_monthly`: one active machine;
- `neondiff_yearly`: one active machine;
- `neondiff_org_yearly`: one active machine until a separately reviewed and
  tested organization-seat policy is approved.

Checkout callers cannot escalate seats. New checkout requests that supply a
different seat count fail closed during the compatibility transition; the field
is then removed from the supported request contract. Existing multi-seat
checkout issuances retain their stored seat count so already activated machines
are not destructively evicted, but their old issuance request is quarantined
rather than replayed through the new contract until an owner-reviewed migration
classifies it. Lifecycle calls never change those seats. The admin CLI remains
an owner-only operational surface, but its arbitrary-seat behavior is not a
checkout entitlement contract and must be documented separately.

## Website Integration Boundary

The website remains a billing and status projection, not an entitlement
authority. Its server-only client sends the normalized Stripe facts through the
existing approved secret boundary. Browser bundles never receive that secret.

The website persists the non-secret checkout issuance reference against its
Stripe subscription. Later webhook events use that reference; they never read or
recover the raw key. Website event storage supports retries and audit, while the
product API ledger remains authoritative for entitlement ordering and terminal
state.

Website checkout stays hard-held until product deployment, subscription
correlation backfill, and live separated-environment proof complete.

## Failure Handling

- Unknown or unbound issuance references, provider account/mode/subscription
  mismatches, invalid states, malformed timestamps, and conflicting replays fail
  closed.
- Network and product API failures cause the website webhook to fail for retry;
  they are not acknowledged as successful synchronization.
- Logs contain provider event IDs, issuance fingerprints or bounded references,
  result classes, and retry counts only. They exclude raw keys, bearer values,
  email addresses, provider payloads, and internal exception bodies.
- Error responses are bounded and redacted. The website separately records a
  redacted synchronization error instead of interpreting an outage as no
  license.

## Test And Evaluation Contract

Implementation is failing-test-first.

Product service coverage must prove:

- issue, activate, validate, renew, paid-period cancellation, expiry, and revoke;
- exact replay, conflicting replay, commutative same-time arrival orders, stale
  non-mutating events, and terminal non-resurrection;
- paid-evidence-only renewal, trial non-extension, bounded timestamps, expired
  renewal, and terminal revocation without a period end;
- every valid command/event/status/field combination plus negative tests for
  every cross-command pairing;
- server-owned seat policy and caller escalation rejection;
- provider account/mode/subscription binding and cross-environment rejection;
- no raw key in lifecycle responses, errors, logs, fixtures, or evidence;
- current-schema file migration preserving hashes and activations;
- authenticated HTTP behavior, body limits, unknown-field rejection, rate
  limiting, and redacted failure responses;
- compatibility with the shipped v1.0.4 client contract.

Website coverage must prove the Stripe-state mapper, server-only client, retry
classification, subscription-to-issuance correlation, service-role-only event
projection, and environment separation. Browser QA covers checkout pending,
error, and fulfilled states plus active, inactive, and error dashboard states at
320, 375, 768, and desktop widths with zero console errors.

Independent spec and security review, exact-head CI, CodeQL, focused service
tests, and zero unresolved current-head review threads are required before
merge.

## Rollout And Backfill

1. Land and deploy the product lifecycle endpoint with checkout still held.
2. Land website correlation, lifecycle mapping, retry ledger, and server-only
   client with checkout still held.
3. Reconcile existing active live subscriptions to immutable provider
   account/mode/subscription bindings and checkout issuance references through
   owner-only Stripe and product records without handling raw keys.
4. Prove sandbox and live environments cannot cross-resolve customers,
   subscriptions, events, or secrets.
5. Run end-to-end renewal, cancellation, deletion/revocation, replay, and outage
   smokes against non-customer fixtures.
6. Ship the product changes through the next real immutable GitHub/npm patch
   release under issue #559 and repeat install plus activation/no-bypass proof.
7. Reopen checkout only in a separate reviewed source change after every live
   subscription is reconciled or explicitly owner-gated.

## Proof Boundary

This design does not authorize checkout reopening, production database changes,
live Stripe mutations, raw-key recovery, predecessor deletion, or release
publication by itself. It does not prove signed or notarized Mac delivery,
Sparkle/appcast, browser/native parity, customer readiness, or v1.1 completion.

Public source, forks, caches, clones, and already-downloaded artifacts cannot be
recalled.
