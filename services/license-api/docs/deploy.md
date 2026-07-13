# License API deploy runbook (fly.io)

Deploy assets for `services/license-api` (#327): `Dockerfile`, `fly.toml`,
`.dockerignore`. This document is the deploy sequence for the owner to run.
**Nothing in this PR executes a deploy** — `flyctl` is unauthenticated on the
machine that produced these assets; every command below is an owner step,
run interactively after `flyctl auth login`.

See also: [`admin-runbook.md`](admin-runbook.md) (key issuance/lifecycle —
does not cover deploy), [`disaster-recovery.md`](disaster-recovery.md)
(Litestream, restore drills, RPO/RTO, alerting), and the service
[`README.md`](../README.md) (HTTP contract, env vars, local run).

## Why this endpoint exists (scope reminder)

Supported review work is client-gated and requires this API for public,
private, internal, and unknown repository visibility. This deploy stands up the
backend that `activate` / `validate` / `deactivate` call before useful review
work. Service outages therefore fail closed for all supported review work; the
release proof must cover that availability boundary explicitly.

## Prerequisites

- `flyctl` installed (`brew install flyctl` or see fly.io docs) and
  authenticated: `flyctl auth login`.
- Repo root as the build context — the Dockerfile compiles the service using
  the root toolchain and installs the service runtime dependency from
  `services/license-api/package-lock.json`. Run every `flyctl`
  command below **from the repo root**, not from `services/license-api/`.

## 1. Create the app (no deploy yet)

```sh
flyctl launch --no-deploy \
  --config services/license-api/fly.toml \
  --dockerfile services/license-api/Dockerfile \
  --name neondiff-license   # placeholder in fly.toml — pick the real name here
```

`--no-deploy` creates the app and lets `flyctl` reconcile `fly.toml` without
shipping a build yet. If the app already exists (re-running this later),
use `flyctl apps create <name>` instead, or skip straight to volumes.

## 2. Create the volume

SQLite (`node:sqlite`, see `src/store.ts`) is a single-writer embedded file
DB on local disk — it needs a Fly Volume, and the volume is machine-pinned
(see the `fly.toml` comment block on `min_machines_running`). Create it in
the **same region** as `primary_region` in `fly.toml`:

```sh
flyctl volumes create license_data --region iad --size 1 \
  --app neondiff-license
```

- `1` GB is generous for a license SQLite file (activation rows are tiny);
  resize later with `flyctl volumes extend` if ever needed.
- The volume name (`license_data`) must match `[mounts].source` in
  `fly.toml`.

## 3. Secrets

Production DR now requires an owner-held Litestream replica URL, provider
credentials, production `LICENSE_LITESTREAM_REQUIRED=true`, and checkout
issuance requires `LICENSE_ISSUANCE_SECRET`. Do not commit secret values. Set
the replica URL, provider credentials, and issuance secret through Fly secrets
before deploying with the required flag enabled; otherwise the container
refuses to start or checkout issuance stays disabled. `LICENSE_DB_PATH` / `PORT` / `HOST` /
`LITESTREAM_CONFIG` / `LITESTREAM_SYNC_INTERVAL` /
`LICENSE_LITESTREAM_REQUIRED` are plain config in `fly.toml`, not secrets.

```sh
flyctl secrets set \
  LICENSE_REPLICA_URL="<object-store-url-for-license.sqlite>" \
  AWS_ACCESS_KEY_ID="<provider-access-key-id>" \
  AWS_SECRET_ACCESS_KEY="<provider-secret-access-key>" \
  LICENSE_ISSUANCE_SECRET="<shared-secret-used-by-website-webhook>" \
  --app neondiff-license
```

Use the provider-specific variables for non-S3-compatible storage. See
[`disaster-recovery.md`](disaster-recovery.md) for the owner-only setup and
restore drill proof boundary.

`LICENSE_ISSUANCE_SECRET` enables `POST /v1/admin/licenses/issue` for the
website payment webhook. Keep the same value configured only on the license API
and the server-side checkout webhook; never expose it to browser code, public
docs, logs, or generated release packets.

After setting the secret and deploying, an unauthenticated request to checkout
issuance or subscription lifecycle must return a redacted `401`. A `503` means
the service is not configured. Neither response is checkout readiness proof.

The same Fly-only secret derives deterministic short-lived keys for
`POST /v1/admin/licenses/issue-lifecycle`; it is never valid authorization for
that route and must not be copied into GitHub. The protected release workflow
uses GitHub Actions OIDC with audience `neondiff-license-lifecycle`. The service
pins the canonical repository IDs, protected `main` ref, workflow path,
`license-lifecycle-production` environment, `workflow_dispatch`, GitHub-hosted
runner, and candidate SHA. Configure the GitHub environment approval policy
before treating this route as production proof. No additional OIDC secret is
required.
Checkout remains held. Do not run authenticated production issuance, lifecycle,
or checkout proof from this source change. Issue
[#559](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559)
owns the immutable version, public manifest, deploy, installed-client,
activation/no-bypass, live Stripe, and checkout-reopening gates. Any eventual
proof must remain redacted: status, replay result, lookup key, and opaque hash
fingerprints are acceptable; bearer headers, the issuance secret, raw license
keys, payment/customer identifiers, cookies, and raw bodies are not.

## 4. Deploy

```sh
flyctl deploy \
  --config services/license-api/fly.toml \
  --dockerfile services/license-api/Dockerfile \
  --app neondiff-license
```

Watch the health check pass (`GET /healthz` → `{ "status": "ok" }`, wired in
`fly.toml` under `[[http_service.checks]]`). `flyctl status --app
neondiff-license` shows machine + volume state; `flyctl logs --app
neondiff-license` streams the Litestream restore/replication logs plus the
`license-api listening on …` boot line from `src/server.ts`.

```sh
curl -s -i -X POST https://neondiff-license.fly.dev/v1/admin/licenses/issue \
  -H 'Content-Type: application/json' \
  -d '{}'
```

## 5. Prepare the schema v2 rollout

1. Keep checkout and lifecycle delivery stopped.
2. Separate Stripe test and live accounts, modes, subscriptions, databases,
   replica prefixes, and evidence. Sandbox proof is never live proof.
3. Immediately before the v2 image rollout, verify and record a fresh pre-v2
   Litestream recovery point. Do not copy the database file while SQLite is
   open; WAL state may make that copy incomplete.
4. Review [`subscription-lifecycle.md`](subscription-lifecycle.md), run its
   focused contract/DR checks, and confirm any legacy checkout binding list.

## 6. Deploy and verify schema v2

Deploy only after the pre-v2 recovery point is reviewed. `LicenseStore` opens
the database before the HTTP listener starts. It accepts only an empty database,
the exact legacy three-table schema, or the exact schema v2 signature. Migration
runs inside one immediate transaction; verification failure rolls back and
prevents the service from starting.

After deploy, verify health, `user_version=2`, redacted admin readback, the real
v1.0.4 activate/validate/deactivate contract, lifecycle idempotency, and
mandatory-online outage behavior with `offlineGraceMs=0`. The local entitlement
cache is diagnostic only; it does not authorize review during an outage.

## 7. Backfill and release handoff

Run `bind-checkout-subscription ... --dry-run` first for every verified legacy
`source=checkout` issuance. A production write needs explicit owner approval of
the opaque fingerprint and exact provider tuple. Do not recover a raw key or
mint a replacement during reconciliation. See
[`admin-runbook.md`](admin-runbook.md).

Then hand the redacted source/contract evidence to #559. This runbook does not
change a version, release candidate, public manifest, deployed client config,
checkout state, or public package. Those remain separately reviewed release
mutations.

## Rollback

Image rollback does not reverse the SQLite schema migration. Deploying a pre-v2
image against a v2 database is not the rollback procedure.

For a v2 migration or data failure, stop writes, preserve the affected volume,
select the reviewed pre-v2 Litestream recovery point, and restore it to a fresh
path or volume using the timestamp-selected point-in-time restore command in the
DR runbook. Verify quick-check, `user_version=0`, and the exact legacy schema
signature before attaching a pre-v2 image. Never overwrite the existing database
and never copy or force-restore into an open SQLite path. Follow
[`disaster-recovery.md`](disaster-recovery.md) for verification and evidence.

An emergency service stop makes all supported review work fail closed; it is
not customer-transparent and does not authorize cache fallback. Restoration,
deployment, or traffic changes remain owner-gated operations under #559.
