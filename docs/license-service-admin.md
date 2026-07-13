# License Service Admin Readiness

Issues: [#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327),
[#562](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/562)
Status: v1.0.4 activation contract proven locally; subscription lifecycle and
schema v2 rollout remain source-only

This document defines the operator/admin boundary for NeonDiff's license
service integration. It does not prove a staging endpoint, admin credential,
billing webhook, production lifecycle deploy, checkout reopening, or
customer-ready entitlement flow.

## Current Proof Boundary

The source tree runs the real v1.0.4 license client against the in-process
license service. That contract proves checkout-bound issue, activate, paid
renew, validate, cancel-at-period-end, expiry, terminal revoke, deactivate, and
different-machine seat behavior without network or production mutation.

The schema v2 subscription lifecycle slice remains source-only. It proves code,
tests, migration rollback, and documentation; it does not prove a production
database migration, legacy backfill, Stripe webhook, Fly deploy, or live
checkout.

Current local proof includes:

- the client recognizes `expired`, `revoked`, `invalid`, `scope_mismatch`,
  `rate_limited`, `unsupported_client`, `clock_skew`, `network`, and `server`
  status outcomes;
- private and unknown repo review gates still fail closed when entitlement is
  missing, stale, non-active, or not scoped for the requested visibility;
- entitlement cache metadata can include the license fingerprint, plan,
  repo visibility coverage, private-repo allowance, update entitlement,
  expiry, diagnostic cache metadata, and non-active revocation reason when
  supplied by a service response;
- mandatory-online configuration uses `offlineGraceMs=0`; a successful
  activation may create a diagnostic cache, but a simulated API outage returns
  `source="none"` and the review gate fails closed;
- checkout lifecycle authorization, correlation failures, results, and errors
  are redacted and never echo a raw key or request identifiers;
- secret-bearing values remain outside tracked config, GitHub evidence, and
  operator docs.

This is not GA readiness, not production readiness, and not a calibrated review
quality claim.

## Expected Admin Outcomes

The license service or admin console should eventually let an authorized
operator perform these actions without exposing raw license keys, payment data,
private repo contents, provider keys, or customer secrets:

| Admin outcome | Client-facing status | Operator note |
| --- | --- | --- |
| License covers the requested repo visibility | `active` | Review may proceed to the next setup/provider gate unless `privateRepoAllowed=false` denies a private repo. |
| License exists but does not cover the requested repo or visibility | `scope_mismatch` | Keep the gate closed and inspect entitlement scope. |
| License is expired | `expired` | Keep the gate closed until billing/support resolves renewal. |
| License is revoked, refunded, charged back, or manually disabled | `revoked` | Keep the gate closed and include a redacted revocation reason when available. |
| License key is malformed or unknown | `invalid` | Keep the gate closed without echoing the submitted key. |
| Service throttles validation or activation | `rate_limited` | Keep the gate closed; do not treat throttling as live readiness. |
| Client version is too old for the service contract | `unsupported_client` | Ask the operator to upgrade before retrying. |
| Client/server time drift is outside service tolerance | `clock_skew` | Ask the operator to correct time sync before retrying. |
| Network or service failure | `network` or `server` | With supported `offlineGraceMs=0`, cache is diagnostic only and review fails closed immediately. Restore the API; do not enable a client-side bypass. |

When a 2xx response body provides a non-`active` status, that status is
authoritative and the gate fails closed without writing an active cache.
For non-2xx responses, durable denial statuses (`expired`, `revoked`, `invalid`,
`scope_mismatch`, and `unsupported_client`) are authoritative when present in the
body. Transient statuses only override when the HTTP code matches the transient
contract (`429` for `rate_limited`, `400` for `clock_skew`). Legacy service
responses remain supported: for example, a bare HTTP 403 without an explicit
`scope_mismatch` body remains classified as `revoked`, and a bare HTTP 409
remains classified as `scope_mismatch`.

## Entitlement Metadata

The client-side entitlement model may preserve these fields when a service
response supplies them:

- `licenseFingerprint`: short local fingerprint derived from the submitted
  license key, never the raw key;
- `plan`: human-readable support or entitlement tier;
- `repoVisibilityScope`: `public`, `private`, or `all`;
- `privateRepoAllowed`: when present as `false`, private-repo review fails
  closed even if `repoVisibilityScope` is `private` or `all`;
- `updateEntitlement`: whether update-channel access is allowed;
- `expiresAt`: entitlement expiry time;
- `offlineGraceMs` and `graceUntil`: legacy/diagnostic cache metadata only. The
  supported mandatory-online configuration fixes `offlineGraceMs=0`; operators
  must not use client-editable config to grant outage authority;
- `revocationReason`: redacted, printable, length-capped reason such as refund,
  chargeback, manual disable, or policy violation; preserved only when the
  entitlement status is not `active`.

Metadata is evidence, not authority, except that `privateRepoAllowed=false` is
treated as an explicit fail-closed private-repo denial. Review gating still
requires an active entitlement that covers the requested repo visibility and
passes the existing freshness rules.

## Subscription lifecycle operator boundary

The guarded endpoint is `POST /v1/admin/licenses/lifecycle`. Its five commands
are `renew_paid`, `reconcile`, `cancel_at_period_end`, `payment_attention`, and
`revoke`. Exact provider account, `test`/`live` mode, and subscription binding
must match an immutable checkout issuance tuple. Server policy owns trial,
maximum period, USD currency, scope, and one-seat authority.

Legacy checkout binding uses the admin
`bind-checkout-subscription` command. Run `--dry-run` first, review the opaque
issuance fingerprint and exact tuple, and require explicit production owner
approval before the write form. Never accept or print a raw key, and do not
mint a replacement key during reconciliation.

The complete matrix, result mapping, rollout steps, and redaction contract live
in
[`services/license-api/docs/subscription-lifecycle.md`](../services/license-api/docs/subscription-lifecycle.md).

## Required live readiness inputs

Issue
[#559](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559)
needs all of the following before claiming live lifecycle/release readiness:

- a staging license API base URL;
- staging admin credentials or delegated operator access;
- a separately identified sandbox and live provider account/mode/database;
- a verified pre-v2 Litestream recovery point and timed fresh-volume restore;
- redacted activation, status, refresh, deactivate, renewal, cancellation,
  expiry, revocation, idempotency, and no-bypass evidence;
- reviewed legacy-binding dry-run/output, if production data needs backfill;
- proof that the admin path can inspect and restore an entitlement without
  exposing private repo contents or minting replacement keys during
  reconciliation;
- secret scan and public-claims scan results for the exact evidence packet.

Without those inputs, operators may claim only the real local v1.0.4 client
contract and source-level schema/lifecycle coverage described above.

## Stop Conditions

Stop and return to the release captain if any of these occur:

- staging endpoint or admin credential is missing;
- a raw license key, payment identifier, provider key, GitHub token, private
  diff, or customer secret appears in logs, docs, evidence, or GitHub;
- private repo visibility is unknown and a live path tries to proceed;
- the service returns a status outside the documented taxonomy;
- live validation requires expanding GitHub App permissions;
- evidence would imply production, GA, enterprise, marketplace, or calibrated
  review-quality readiness from local contract responses alone.
- a rollback plan assumes a previous image reverses schema v2, copies an open
  SQLite database, or restores over the existing volume;
- test-mode evidence is presented as live-mode proof;
- reconciliation attempts raw-key recovery or replacement-key minting.

## Release handoff

Checkout remains held. #559 owns version/manifest changes, deployment,
installed-package verification, live activation, public release proof, and the
decision to reopen checkout. This document, issue #562, and their local tests do
not mutate or satisfy those release gates.
