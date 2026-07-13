# NeonDiff license API (`@neondiff/license-api`)

Self-contained license service for NeonDiff API-backed entitlements
([#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327)).
It implements the exact HTTP contract the shipped client (`src/license.ts`)
already calls — activate / validate / deactivate — backed by SQLite, with an
admin CLI that mints keys. Guarded server-to-server routes issue checkout
licenses and apply provider subscription lifecycle events. Stripe/Lovable
publish wiring remains outside this package and must use the owner-held shared
secret; checkout is still held pending the rollout proof in issue #559.

The service is a separate package boundary; it does **not** import the review
worker and can be deployed on its own (SQLite on a mounted volume).

## Contract

Six `POST` endpoints, JSON in / JSON out (`Content-Type: application/json`):

| Endpoint | Request body | Success (200) | Denials |
| --- | --- | --- | --- |
| `/v1/license/activate` | `{ licenseKey, repo?, machineId }` | `{ entitlement: { status:"active", repoVisibilityScope, … } }` | 404 invalid · 403 revoked · 402 expired · **409 scope_mismatch** (seat exhausted) |
| `/v1/license/validate` | `{ licenseKey, repo?, machineId }` | active entitlement | 404 invalid · 403 revoked · 402 expired · 409 scope_mismatch (never activated on this machine) |
| `/v1/license/deactivate` | `{ licenseKey, repo?, machineId }` | `{ status:"active", … }` (idempotent) | 404 invalid |
| `/v1/admin/licenses/issue` | `{ idempotencyKey, checkoutLookupKey, ... }` + `Authorization: Bearer <LICENSE_ISSUANCE_SECRET>` | `{ status:"issued", licenseKey:"nd_live_...", entitlement, replayed }` | 401 unauthorized · 400 malformed/unsupported lookup or policy · 409 idempotency conflict |
| `/v1/admin/licenses/issue-lifecycle` | exact release identity + GitHub Actions OIDC bearer | short-lived lifecycle license + all-scope entitlement | 401 invalid workflow token · 403 candidate SHA mismatch · 409 workflow-run conflict · 503 unconfigured |
| `/v1/admin/licenses/lifecycle` | strict subscription command + `Authorization: Bearer <LICENSE_ISSUANCE_SECRET>` | redacted `{ status, replayed, entitlement }` | 400 invalid · 401 unauthorized · 404 not_found · 409 conflict/terminally_revoked · 429 rate_limited · 503 unavailable |

Activation, validation, and deactivation use per-license-key rate limiting.
Subscription lifecycle and release-lifecycle issuance use separate client-address rate-limit budgets.
Checkout issuance has no generic `429`
claim; its documented authorization, validation, conflict, and server outcomes
apply. Cross-route failures include `400 malformed` and `5xx server` where the
endpoint table or detailed section specifies them.

`machineId` is the single-activation binding — one machine per seat (default
`seats=1`). Only `sha256(licenseKey)` is stored. Activation, validation,
deactivation, lifecycle, and admin inspection responses never echo a submitted
raw key; issuance returns a raw key only to its authorized caller for one-shot
fulfillment. `GET /healthz` → `{ "status": "ok" }`.

The HTTP-code → client-classification map is fixed by the client
(`402→expired · 429→rate_limited · 426→unsupported_client · 409→scope_mismatch ·
403/410→revoked · 401/404→invalid · 5xx→server`); the service returns codes that
match it.

### Checkout issuance

`POST /v1/admin/licenses/issue` is for the website/payment webhook only. It is
disabled unless `LICENSE_ISSUANCE_SECRET` is configured, and it requires:

```json
{
  "idempotencyKey": "stripe-checkout-session-or-event-id",
  "checkoutLookupKey": "neondiff_monthly",
  "provider": "stripe",
  "providerAccountId": "acct_...",
  "providerMode": "test",
  "externalSubscriptionId": "sub_...",
  "externalCheckoutId": "cs_...",
  "seats": 1
}
```

Supported lookup keys are `neondiff_monthly`, `neondiff_yearly`, and
`neondiff_org_yearly`; they map to `monthly_support`, `yearly_support`, and
`org_yearly_support`. Server policy owns plan, trial, maximum paid period,
currency, scope, update access, and seats: monthly is 7 trial days / 62 maximum
period days, individual yearly is 7 / 400, organization yearly is 30 / 400,
and all three are USD, one seat, private scope, and update-entitled. Callers
cannot supply customer identity, plan, expiry, scope, ownership, or seat
authority. The optional compatibility `seats` field is accepted only when it
is exactly `1`.

The endpoint returns the raw `nd_live_...` license key to the authorized caller
for one-shot customer fulfillment. The immutable provider account, test/live
mode, subscription, and checkout tuple is recorded atomically with issuance.
Test and live tuples never substitute for each other.

Idempotency is keyed by `idempotencyKey`. Retries with identical request data
return the same `licenseKey` and `replayed=true` without minting a duplicate
license. Reusing an idempotency key with different checkout data returns `409
conflict`. SQLite stores only the license hash plus issuance metadata; the raw
key is deterministically derived from `LICENSE_ISSUANCE_SECRET` and the
idempotency key so webhook retries can be safe without storing raw key material.

Checkout remains held. This source contract does not authorize reopening the
website payment path; issue #559 owns version, manifest, deploy, install, and
live activation proof. See
[`docs/subscription-lifecycle.md`](docs/subscription-lifecycle.md) for the
provider event matrix and rollout boundary.

### Release lifecycle issuance

`POST /v1/admin/licenses/issue-lifecycle` is a separate authorization domain
for the protected release proof workflow. It does not accept the checkout
shared secret. The request body is strict and rejects unknown fields:

```json
{
  "releaseVersion": "v1.0.4",
  "candidateHead": "<40-character lowercase commit SHA>",
  "packShasum": "<40-character lowercase npm shasum>",
  "packIntegrity": "sha512-<npm integrity digest>"
}
```

The bearer JWT must be signed by GitHub Actions with RS256 and the GitHub OIDC
JWKS. Verification pins the issuer, `neondiff-license-lifecycle` audience,
canonical repository and numeric repository/owner IDs, protected `main` ref,
workflow file on `main`, `license-lifecycle-production` environment and
subject, `workflow_dispatch` event, GitHub-hosted runner, candidate SHA, numeric
run ID, and a five-minute timestamp window. The request `candidateHead` must
equal the JWT `sha` claim.

The server derives idempotency from the canonical repository ID and workflow
run ID. An identical retry returns the same key; different release data for the
same run fails with `409`. The client cannot choose plan, scope, seats, or
expiry: the server issues a 15-minute, one-seat, all-visibility
`release_lifecycle` entitlement with update access. Only the successful caller
receives the raw key; authorization and validation failures return generic,
redacted errors.

## Run

```sh
# install from the service-local lock
cd services/license-api
npm ci
npm run build           # tsc → dist/
LICENSE_DB_PATH=runtime/license.sqlite PORT=8080 npm start
```

Environment:

- `LICENSE_DB_PATH` — SQLite file path (default `runtime/license.sqlite`; point
  at a mounted volume in deploy).
- `PORT` / `HOST` — listen address (default `8080` / `0.0.0.0`). TLS is
  terminated upstream (fly), so the process serves plain HTTP internally.
- `LICENSE_ISSUANCE_SECRET` — optional server-to-server bearer secret that
  derives issued keys and enables `POST /v1/admin/licenses/issue`. The OIDC
  lifecycle route also requires it for deterministic key derivation, but never
  accepts it as request authorization. Keep it only on Fly and the checkout
  webhook server; do not expose it to browsers, clients, workflows, or logs.

## Admin issuance CLI

The CLI opens `LICENSE_DB_PATH` and never prints raw keys except at issuance.

```sh
# issue — prints the raw key ONCE; only its hash is stored
LICENSE_DB_PATH=runtime/license.sqlite npm run admin -- \
  issue --plan yearly --scope private --seats 1 --expires 2027-01-01T00:00:00Z

# revoke by raw key (optionally with a redacted reason)
npm run admin -- revoke --key nd_live_… --reason refund

# list — hashes + metadata, never raw keys
npm run admin -- list

# show a single license by key (adds its activations)
npm run admin -- show --key nd_live_…

# preview a legacy checkout correlation backfill; remove --dry-run only after
# explicit production owner approval of the exact fingerprint and tuple
npm run admin -- bind-checkout-subscription \
  --issuance-idempotency-key <checkout-issuance-reference> \
  --provider stripe \
  --provider-account-id <provider-account-id> \
  --provider-mode <test-or-live> \
  --external-subscription-id <subscription-id> \
  --external-checkout-id <checkout-id> \
  --dry-run
```

`issue` flags: `--plan <p>` (required), `--scope <public|private|all>`
(required), `--seats N` (default 1), `--expires <iso>`,
`--private-repo-allowed <true|false>`, `--update-entitlement`.

See [`docs/admin-runbook.md`](docs/admin-runbook.md) for the operator runbook,
[`docs/subscription-lifecycle.md`](docs/subscription-lifecycle.md) for the
lifecycle reference/rollout, and
[`docs/disaster-recovery.md`](docs/disaster-recovery.md) for recovery.

## Deploy

Deploy is a **separate, gated step** (not part of the PR that adds this
service). The target is fly.io with SQLite on a mounted volume; the owner
drives `flyctl` (login → launch → volume → deploy → verify → promote) and
wires the prod URL into `docs/public-release-manifest.json`'s `licenseApi`
slot once live. No secrets live in the repo.

Deploy-ready assets (`Dockerfile`, `fly.toml`, `.dockerignore`) and the exact
command sequence live at [`docs/deploy.md`](docs/deploy.md).

## Tests

```sh
npm test   # node:test via tsx — service, http, and admin suites
```

The load-bearing contract test lives at the repo root
(`tests/license-service-contract.test.ts`): it drives the **real** shipped
client (`src/license.ts`) against this service in-process through
activate → validate → deactivate → reactivate-different-machine and asserts the
client parses each into the correct `LicenseStatus`.
