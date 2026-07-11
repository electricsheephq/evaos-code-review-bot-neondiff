# License API admin runbook

Operator procedures for the NeonDiff license service
([#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327)).
This runbook covers key issuance and lifecycle. It does **not** cover payment,
billing, or deploy — deploy is a separate gated step driven by the orchestrator.
See [`deploy.md`](deploy.md) for the fly.io deploy sequence (`Dockerfile`,
`fly.toml`, volume/secrets setup, and rollback). See
[`disaster-recovery.md`](disaster-recovery.md) for Litestream replication,
restore drills, RPO/RTO, alerting, and the owner-gated DR proof boundary.

All commands open the SQLite database at `LICENSE_DB_PATH`. In production this is
the file on the mounted fly volume; run the CLI on the instance (or against a
copy of the volume) so it points at the live database.

## Golden rules

- **The raw key is shown exactly once, at issuance.** Copy it to the buyer over a
  secure channel immediately. Only `sha256(key)` is stored; the key cannot be
  recovered afterward. If it is lost, revoke and re-issue.
- **Never paste a raw key into logs, issues, evidence, or chat.** `list`/`show`
  print hashes only; keep it that way.
- Default `seats=1` enforces single-activation: one machine per seat. A second
  machine gets `409 scope_mismatch` until a seat is freed via `deactivate`.

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

## Free a seat for a customer

A customer who changed machines and hit `409 scope_mismatch` needs the old
machine deactivated. The client's `neondiff license deactivate` frees the seat
from the customer side. If they cannot reach the old machine, an operator has no
raw-key path to delete a single activation by design (the key is hashed); the
supported recovery is to `revoke` and re-`issue`, or raise `--seats` on a new key.

## Health

`GET /healthz` → `{ "status": "ok" }`. Use it for the deploy health check and
uptime monitoring. Healthz is not DR proof by itself; pair it with the
replication freshness and timed staging restore checks in
[`disaster-recovery.md`](disaster-recovery.md).
