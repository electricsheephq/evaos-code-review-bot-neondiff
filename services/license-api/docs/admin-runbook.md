# License API admin runbook

Operator procedures for the NeonDiff license service
([#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327),
[#562](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/562)).
This runbook covers manual key administration and the guarded checkout-binding
backfill. The server-to-server event contract is documented in
[`subscription-lifecycle.md`](subscription-lifecycle.md). It does **not**
authorize payment, billing, deploy, production backfill, or checkout reopening.
See [`deploy.md`](deploy.md) for the fly.io deploy sequence (`Dockerfile`,
`fly.toml`, volume/secrets setup, and rollback). See
[`disaster-recovery.md`](disaster-recovery.md) for Litestream replication,
restore drills, RPO/RTO, alerting, and the owner-gated DR proof boundary.

All commands open the SQLite database at `LICENSE_DB_PATH`. In production this
is the file on the mounted Fly volume. Use the owner-approved in-instance or
quiesced maintenance procedure. Never copy an open SQLite database: an open
database may have authoritative WAL state that a file copy omits.

## Golden rules

- **The raw key is shown exactly once, at manual issuance.** Copy it to the
  authorized recipient over a secure channel immediately. Only `sha256(key)` is
  stored; the key cannot be recovered afterward.
- **Never paste a raw key into logs, issues, evidence, or chat.** `list`/`show`
  print hashes only; keep it that way.
- Default `seats=1` enforces single-activation: one machine per seat. A second
  machine gets `409 scope_mismatch` until a seat is freed via `deactivate`.
- No raw-key recovery or replacement-key minting is allowed during checkout
  reconciliation, lifecycle handling, schema migration, or binding backfill.
  Replacement issuance is a separate owner-authorized support/security action.
- Subscription lifecycle revocation stores only the status-derived reason codes
  `subscription_canceled`, `subscription_unpaid`, or
  `subscription_incomplete_expired`. Never pass provider/customer prose, email,
  payment identifiers, or control characters as a reason.

## Issue a key

```sh
LICENSE_DB_PATH=/data/license.sqlite npm run admin -- \
  issue --plan yearly --scope private --seats 1 --expires 2027-01-01T00:00:00Z
```

- Supported review work now requires API-backed activation for every repository
  visibility. Choose `public`, `private`, or `all` deliberately for the
  entitlement being sold or exercised; do not assume public repositories bypass
  activation.
- `--private-repo-allowed false` denies private repos even at scope `all`.
- `--update-entitlement` grants update-channel access.

Record the printed **hash** (not the key) alongside the customer reference.

## Revoke a key

```sh
LICENSE_DB_PATH=/data/license.sqlite npm run admin -- \
  revoke --key nd_live_… --reason "refund"
```

Revocation is immediate: the next `activate`/`validate` returns `403 revoked`
with the redacted reason. Use for refunds, chargebacks, or policy violations.

## Inspect

```sh
npm run admin -- list                 # all licenses: hash, status, scope, seats, activations
npm run admin -- show --key nd_live_…  # one license + its bound machines
```

## Backfill a legacy checkout binding

Backfill only an existing issuance whose stored source is already `checkout`.
The command accepts correlation fields only; it rejects raw key, plan, expiry,
scope, ownership, update-access, and seat fields.

Run the zero-write preview first:

```sh
LICENSE_DB_PATH=/data/license.sqlite npm run admin -- \
  bind-checkout-subscription \
  --issuance-idempotency-key <checkout-issuance-reference> \
  --provider stripe \
  --provider-account-id <provider-account-id> \
  --provider-mode <test-or-live> \
  --external-subscription-id <subscription-id> \
  --external-checkout-id <checkout-id> \
  --dry-run
```

`would_bind` plus both opaque fingerprints is evidence for review, not
permission to write. The `iss_...` fingerprint identifies the checkout
issuance; the `bnd_...` fingerprint covers that issuance, the exact provider
account/mode/subscription/checkout tuple, and the server-derived checkout lookup
key. Stop on `not_found`, `wrong_source`, `conflict`, or `unavailable`. A
production write requires explicit owner approval of both fingerprints,
database, provider account, mode, subscription, checkout, and lookup-key tuple.
Only then repeat the exact command without `--dry-run`; expect `bound`, or
`already_bound` for an identical replay.

Keep Stripe test and live modes, accounts, subscriptions, databases, and
evidence separate. Never backfill a production issuance from sandbox data.

## Free a seat for a customer

A customer who changed machines and hit `409 scope_mismatch` needs the old
machine deactivated. The client's `neondiff license deactivate` frees the seat
from the customer side. If they cannot reach the old machine, an operator has no
raw-key path to delete a single activation by design because the key is hashed.
Stop and route the case through the separately approved support/security policy;
do not mint a replacement or alter seat authority as part of reconciliation.

## Health

`GET /healthz` → `{ "status": "ok" }`. Use it for the deploy health check and
uptime monitoring. Healthz is not DR proof by itself; pair it with the
replication freshness and timed staging restore checks in
[`disaster-recovery.md`](disaster-recovery.md).

Checkout remains held. Issue
[#559](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559)
owns deploy, version/manifest, installed-client, live activation, and checkout
proof; this runbook does not authorize those mutations.
