# License Service Admin Readiness

Issue: [#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327)
Status: source-only readiness slice; mock-only proof

This document defines the operator/admin boundary for NeonDiff's hosted or
direct license service integration. It does not prove a staging endpoint,
admin credential, billing webhook, production service, or customer-ready
private-repo entitlement flow.

## Current Proof Boundary

The source tree can model and test license-service outcomes locally. The proof
in this slice is limited to mocked API responses and local cache behavior:

- the client recognizes `expired`, `revoked`, `invalid`, `scope_mismatch`,
  `rate_limited`, `unsupported_client`, `clock_skew`, `network`, and `server`
  status outcomes;
- private and unknown repo review gates still fail closed when entitlement is
  missing, stale, non-active, or not scoped for the requested visibility;
- active entitlement cache metadata can include the license fingerprint, plan,
  repo visibility coverage, private-repo allowance, update entitlement,
  expiry, offline grace metadata, and revocation reason when supplied by a
  service response;
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
| License covers the requested repo visibility | `active` | Review may proceed to the next setup/provider gate. |
| License exists but does not cover the requested repo or visibility | `scope_mismatch` | Keep the gate closed and inspect entitlement scope. |
| License is expired | `expired` | Keep the gate closed until billing/support resolves renewal. |
| License is revoked, refunded, charged back, or manually disabled | `revoked` | Keep the gate closed and include a redacted revocation reason when available. |
| License key is malformed or unknown | `invalid` | Keep the gate closed without echoing the submitted key. |
| Service throttles validation or activation | `rate_limited` | Keep the gate closed; do not treat throttling as live readiness. |
| Client version is too old for the service contract | `unsupported_client` | Ask the operator to upgrade before retrying. |
| Client/server time drift is outside service tolerance | `clock_skew` | Ask the operator to correct time sync before retrying. |
| Network or service failure | `network` or `server` | Use only the existing short offline cache grace for active cached entitlements; otherwise fail closed. |

When a response body provides an explicit non-`active` status, that status is
authoritative and takes precedence over the HTTP-status fallback. Legacy service
responses remain supported: for example, a bare HTTP 403 without an explicit
`scope_mismatch` body remains classified as `revoked`.

## Entitlement Metadata

The client-side entitlement model may preserve these fields when a service
response supplies them:

- `licenseFingerprint`: short local fingerprint derived from the submitted
  license key, never the raw key;
- `plan`: human-readable support or entitlement tier;
- `repoVisibilityScope`: `public`, `private`, or `all`;
- `privateRepoAllowed`: whether private-repo review is allowed by this
  entitlement;
- `updateEntitlement`: whether update-channel access is allowed;
- `expiresAt`: entitlement expiry time;
- `offlineGraceMs` and `graceUntil`: cache-grace metadata for operator
  diagnosis;
- `revocationReason`: redacted, printable, length-capped reason such as refund,
  chargeback, manual disable, or policy violation.

Metadata is evidence, not authority. Review gating still requires an active
entitlement that covers the requested repo visibility and passes the existing
freshness rules.

## Required Live Readiness Inputs

A future PR or release gate needs all of the following before claiming live
license-service readiness:

- a staging license API base URL;
- staging admin credentials or delegated operator access;
- a non-secret test license or fixture account with documented allowed scope;
- redacted activation, status, refresh, and deactivate evidence;
- proof that the admin path can issue, inspect, revoke, and restore an
  entitlement without exposing private repo contents;
- secret scan and public-claims scan results for the exact evidence packet.

Without those inputs, operators may claim only mocked/local contract coverage.

## Stop Conditions

Stop and return to the release captain if any of these occur:

- staging endpoint or admin credential is missing;
- a raw license key, payment identifier, provider key, GitHub token, private
  diff, or customer secret appears in logs, docs, evidence, or GitHub;
- private repo visibility is unknown and a live path tries to proceed;
- the service returns a status outside the documented taxonomy;
- live validation requires expanding GitHub App permissions;
- evidence would imply production, GA, enterprise, marketplace, or calibrated
  review-quality readiness from mocked responses alone.

## Follow-Up

The next slice should connect this source contract to a staging-only admin
smoke once the endpoint and credentials exist. That follow-up should update
issue `#327` with a redacted evidence path under
`/Volumes/LEXAR/Codex/evidence/neondiff/<date>/production-license-service/`.
