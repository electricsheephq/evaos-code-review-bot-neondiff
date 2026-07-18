# Subscription lifecycle reference and rollout

This document describes the source contract for checkout-backed subscription
renewal, reconciliation, cancellation, payment attention, and terminal
revocation. It is both the API reference for webhook integrators and the
operator checklist for rolling SQLite schema v2 into the license service.

Checkout remains held. The endpoint and migration are source-ready, but issue
[#559](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559)
owns the immutable package version, public release manifest, production deploy,
installed-client proof, live activation proof, and any decision to reopen
checkout.

## Reference: authorization and endpoint

`POST /v1/admin/licenses/lifecycle` accepts JSON and requires
`Authorization: Bearer <LICENSE_ISSUANCE_SECRET>`. This is a server-to-server
boundary. Never expose the secret to browsers, clients, GitHub evidence, or
logs.

The endpoint is separate from:

- `/v1/admin/licenses/issue`, which issues a checkout-bound license with the
  same server-held bearer boundary; and
- `/v1/admin/licenses/issue-lifecycle`, which accepts a pinned GitHub Actions
  OIDC token for release proof and does not accept the shared secret as
  authorization.

Authentication happens before JSON parsing or correlation lookup. Missing or
wrong authorization returns the same redacted `401` response. The lifecycle
route has a dedicated per-client limiter; it does not consume the activation or
release-lifecycle limiter budgets. Fly client-address headers are trusted only
when the service is running behind Fly's operator-controlled proxy boundary.

## Reference: common request fields

Every request is a JSON object no larger than 16 KiB. Unknown fields are
rejected. Common fields are:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `1`. |
| `issuanceIdempotencyKey` | Required non-empty string, at most 200 characters. Correlates to an existing `source=checkout` issuance. |
| `eventId` | Required non-empty provider event identifier, at most 200 characters. Identical replay is idempotent; reuse with different content conflicts. |
| `eventCreatedAt` | Non-negative integer epoch seconds, no more than five minutes ahead of the service clock. |
| `provider` | Exactly `stripe`. |
| `providerAccountId` | Required non-empty string, at most 160 characters. |
| `providerMode` | Exactly `test` or `live`. |
| `externalSubscriptionId` | Required non-empty string, at most 160 characters. |
| `providerEventType` | Event type allowed by the command matrix below. |
| `command` | One of the five commands below. |
| `subscriptionStatus` | Status allowed by the command matrix below. |
| `cancelAtPeriodEnd` | Required boolean with command-specific meaning. |

The provider, provider account, mode, and external subscription must match the
immutable tuple stored at checkout issuance or owner-approved legacy backfill.
Unknown, unbound, and mismatched correlations all return the same redacted
`404 not_found`. A `test` binding cannot accept a `live` event, and a `live`
binding cannot accept a `test` event.

## Reference: strict command matrix

| Command | Allowed provider events | Allowed subscription statuses | Extra requirements | Effect |
| --- | --- | --- | --- | --- |
| `renew_paid` | `invoice.paid`, `invoice.payment_succeeded` | `active` | `paymentReference`; positive integer `amountPaidMinor`; `currency="usd"`; `paidOutOfBand=false`; `billingReason="subscription_cycle"`; strict future UTC `currentPeriodEnd`; `cancelAtPeriodEnd=false` | Extends expiry monotonically and reactivates an expired entitlement. Paid period must remain within the server-owned plan maximum. |
| `reconcile` | `customer.subscription.updated` | `active`, `trialing` | `cancelAtPeriodEnd=false`; optional future `currentPeriodEnd` is diagnostic only | Records a non-terminal audit event without granting time. Older non-mutating events are `ignored_stale`. |
| `cancel_at_period_end` | `customer.subscription.updated` | `active`, `trialing` | `cancelAtPeriodEnd=true`; strict future UTC `currentPeriodEnd` | Records the cancellation state without shortening already-paid time. |
| `payment_attention` | `invoice.payment_failed`, `customer.subscription.updated` | `active`, `past_due`, `incomplete`, `paused` | Payment fields are forbidden; optional future `currentPeriodEnd` is diagnostic only | Records payment attention without revoking or extending the entitlement. |
| `revoke` | `customer.subscription.deleted`, `customer.subscription.updated` | `canceled`, `unpaid`, `incomplete_expired` | `currentPeriodEnd` and payment fields are forbidden; optional `reason` must exactly equal the status-derived code | Sets terminal `revoked` state with `subscription_canceled`, `subscription_unpaid`, or `subscription_incomplete_expired`. Later lifecycle commands fail with `terminally_revoked`. |

Only `renew_paid` accepts payment fields. The service hashes
`paymentReference` into a domain-separated fingerprint before storage. It does
not store the raw payment reference.

Revocation never accepts provider/customer prose. The service derives a fixed
non-secret reason code from `subscriptionStatus`; omitting `reason` uses that
code, while supplying any other value fails with `400 invalid`. This prevents
emails, payment/customer identifiers, CR/LF, and terminal controls from reaching
SQLite, license responses, admin output, logs, or evidence.

For schema-v1 replay compatibility, an omitted reason retains the historical
canonical request hash (`null` in the reason slot) even though the normalized
request and stored revocation use the derived safe code. Supplying the exact
code is explicit content and therefore has its own canonical hash.

## Reference: server-owned checkout policy

Checkout callers do not choose plan, trial length, maximum renewal period,
currency, scope, ownership, update access, or seats.

| Lookup key | Plan | Trial | Maximum accepted paid period | Currency | Seats |
| --- | --- | ---: | ---: | --- | ---: |
| `neondiff_monthly` | `monthly_support` | 7 days | 62 days from apply time | USD | 1 |
| `neondiff_yearly` | `yearly_support` | 7 days | 400 days from apply time | USD | 1 |
| `neondiff_org_yearly` | `org_yearly_support` | 30 days | 400 days from apply time | USD | 1 |

All three policies currently issue private-scope entitlements with private-repo
access and update entitlement enabled. The optional checkout compatibility
field `seats` is accepted only when it is exactly `1`; no lifecycle command can
change seats.

## Reference: response and status mapping

Successful application returns only:

```json
{
  "status": "updated",
  "replayed": false,
  "entitlement": {
    "status": "active",
    "plan": "monthly_support",
    "seats": 1,
    "expiresAt": "2026-08-13T00:00:00.000Z"
  }
}
```

The `status` result is one of `updated`, `payment_attention`,
`terminally_revoked`, `ignored_stale`, or `replayed`. Replayed requests return
`replayed=true`; other successful results return `false`.

| HTTP | Body status | Meaning |
| ---: | --- | --- |
| `200` | lifecycle result above | Applied, replayed, or safely ignored stale event. |
| `400` | `invalid` | Malformed body, unsupported matrix combination, forbidden authority field, or policy violation. |
| `401` | `unauthorized` | Missing or invalid bearer. |
| `404` | `not_found` | Unknown, non-checkout, unbound, orphaned, or tuple-mismatched issuance. |
| `409` | `conflict` | Existing event ID has different canonical content. |
| `409` | `terminally_revoked` | Entitlement was already terminally revoked. |
| `413` | `invalid` | Body exceeds 16 KiB. |
| `429` | `rate_limited` | Dedicated lifecycle budget exhausted; response includes a bounded `Retry-After`. |
| `503` | `unavailable` | Issuance secret is absent or SQLite remained busy beyond its bounded wait. |
| `500` | `server` | Unexpected internal failure. |

Responses never echo the bearer, raw license key, issuance idempotency key,
provider event ID, provider account, subscription ID, payment reference, revoke
reason, parser detail, SQLite detail, or caller-controlled unknown field name.
The lifecycle ledger stores hashes/fingerprints and bounded provider metadata,
not raw license or payment material.

## How to backfill a legacy checkout binding

Use this only for a verified historical issuance whose
`license_issuance_events.source` is already `checkout`. The command cannot
accept a raw key, plan, expiry, scope, ownership, update access, or seat count.

1. Run a no-write preview against the intended database and exact provider
   environment:

   ```sh
   LICENSE_DB_PATH=<quiesced-database-path> npm run admin -- \
     bind-checkout-subscription \
     --issuance-idempotency-key <checkout-issuance-reference> \
     --provider stripe \
     --provider-account-id <provider-account-id> \
     --provider-mode <test-or-live> \
     --external-subscription-id <subscription-id> \
     --external-checkout-id <checkout-id> \
     --dry-run
   ```

2. Verify the redacted result is `would_bind` with an opaque `iss_...`
   issuance fingerprint and a `bnd_...` fingerprint covering the exact
   provider account/mode/subscription/checkout tuple plus the server-derived
   checkout lookup key. `not_found`, `wrong_source`, `conflict`, or
   `unavailable` is a stop condition.
3. Record explicit production owner approval against both fingerprints and the
   exact tuple. Dry-run success is not authorization to write production.
4. Repeat the same command without `--dry-run` only inside the approved
   production maintenance procedure. Expect `bound`; an exact retry returns
   `already_bound`.

No raw-key recovery or replacement-key minting is allowed during
reconciliation or backfill. If business policy requires replacement issuance,
route it as a separate support/security action with its own authorization and
evidence; do not disguise it as lifecycle repair.

## How to roll out schema v2 safely

1. Keep checkout closed and stop lifecycle event delivery.
2. Confirm test and live provider account IDs, modes, subscriptions, secrets,
   databases, replica prefixes, and evidence packets are separated. Never use
   sandbox success as live proof.
3. Immediately before deploying schema v2, verify a Litestream recovery point
   from the still-running pre-v2 service. Record its timestamp and freshness
   without copying credentials or customer data.
4. Quiesce writes through the platform/service procedure. Never copy an open
   SQLite database. A filesystem copy of an open database can omit WAL state
   and is not a valid migration or recovery artifact.
5. Deploy the reviewed image. `LicenseStore` verifies the exact legacy schema,
   creates v2 tables and constraints in one immediate transaction, verifies the
   resulting signature, and only then sets `user_version=2`. Migration failure
   prevents the service from starting and rolls the transaction back.
6. Verify health, schema version, redacted admin readback, activation, validate,
   deactivate, lifecycle idempotency, and mandatory-online outage denial. Keep
   `offlineGraceMs=0`; the cache is diagnostic only and never authorizes review
   during an API outage.
7. Backfill only the approved legacy checkout bindings using the dry-run flow
   above. Do not replay lifecycle events until the exact tuple is bound.
8. Run sandbox lifecycle proof, then a separately approved live proof. Keep
   checkout held until #559 records exact-head CI/review evidence plus version,
   manifest, deploy, install, activation, and no-bypass proof.

## Rollback and recovery boundary

Image rollback does not reverse the SQLite schema migration. If the v2 service
cannot proceed, stop writes and follow
[`disaster-recovery.md`](disaster-recovery.md): use its Litestream 0.5.14
point-in-time restore command to select the recorded pre-v2 RFC3339 timestamp and
write to a fresh path. Verify quick-check, `user_version=0`, and the exact legacy
schema signature before attaching the pre-v2 image. Do not overwrite the
existing database or combine restoration with replacement-key minting.

Source tests and docs prove the contract only. They do not prove a production
database migration, backfill, Stripe webhook, checkout reopening, Fly deploy,
or public release. Those live/release gates remain with #559.

## Related

- [Admin runbook](admin-runbook.md)
- [Deploy runbook](deploy.md)
- [Disaster recovery](disaster-recovery.md)
- [Service README](../README.md)
- [Root license service admin boundary](../../../docs/license-service-admin.md)
