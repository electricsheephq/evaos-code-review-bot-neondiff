# License API disaster recovery runbook

This runbook covers disaster recovery for the NeonDiff license API SQLite
database at `/data/license.sqlite`.

Issue scope: [#423](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/423)
and [#562](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/562).
This source-only PR does not prove live replication; it only adds the buildable
Litestream wiring, owner runbook, static assertions, and local client outage
fail-closed verification. Live object storage, Fly secrets, deploy, and timed restore
evidence remain Owner-gated.

## Targets

- RPO target: <= 5 minutes. Litestream is configured to sync from
  `/data/license.sqlite` to the object-store replica every `1s`; the <= 5 minute
  target leaves room for transient platform or object-store latency.
- RTO target: <= 30 minutes. A trained owner should be able to provision or
  restart a staging/replacement Fly app, restore the missing DB, pass `/healthz`,
  and validate admin readback inside this window.
- Data owner: Electric Sheep owner/operator with Fly app and object-store
  access.
- Proof boundary: source/tests can prove configuration and client behavior only;
  production readiness requires owner-held secrets plus a live restore drill.

## Architecture

- Primary database: `/data/license.sqlite` on the Fly volume `license_data`.
- Runtime supervisor: `docker-entrypoint.sh`.
- Replication config: `/etc/litestream.yml`, copied from `litestream.yml`.
- Replica URL: `LICENSE_REPLICA_URL`, set only through Fly secrets or an
  equivalent platform secret store.
- Provider credentials: set through provider-native environment variables or
  Fly secrets. Do not commit values. For S3-compatible storage, use the
  provider's recommended key variables.

The container fails closed by default when `LICENSE_REPLICA_URL` is absent
because this service is release-required for supported review entitlements. Local
development may set `LICENSE_LITESTREAM_REQUIRED=false` to run without
replication.

## Schema v2 recovery invariant

Immediately before the schema v2 rollout, verify a recoverable Litestream point
from the running pre-v2 database and record its timestamp/freshness in the
owner-held evidence packet. This is the reviewed rollback point; a Fly image or
filesystem copy is not.

Never copy an open SQLite database. An open database may have authoritative WAL
state that a plain copy of `license.sqlite` omits. Quiesce writes through the
approved service/platform procedure, or restore through Litestream to a missing
database path.

Migration failure prevents the service from starting. The store migrates the
exact legacy schema inside one immediate transaction, verifies the exact v2
schema and constraints, and sets `user_version=2` only after verification.
Failure rolls the transaction back and the HTTP listener never starts.

Image rollback does not reverse the SQLite schema migration. A pre-v2 image is
not approved to open a v2 database. Restore the reviewed pre-v2 Litestream point
to a fresh path or volume, verify it separately, and only then attach it to the
reviewed pre-v2 service. Preserve the failed volume for investigation; never
overwrite it in place.

## Owner-only secret setup

Run these commands from a secure shell after choosing the object-store bucket,
path, provider, and app name. Replace every placeholder with values from the
owner's secret manager; do not paste real values into issues, PRs, docs, or
chat.

```sh
flyctl secrets set \
  LICENSE_REPLICA_URL="<object-store-url-for-license.sqlite>" \
  AWS_ACCESS_KEY_ID="<provider-access-key-id>" \
  AWS_SECRET_ACCESS_KEY="<provider-secret-access-key>" \
  --app neondiff-license
```

Use provider-specific variable names when not using S3-compatible storage. Keep
the replica path dedicated to this service, for example a `license-api/prod`
prefix, so restore drills do not collide with unrelated databases.

## Deploy verification

After secrets are set, deploy from the repo root using
[`deploy.md`](deploy.md). Then verify:

```sh
flyctl status --app neondiff-license
flyctl logs --app neondiff-license
curl -fsS https://neondiff-license.fly.dev/healthz
```

Expected evidence:

- the boot logs show either an existing DB or a missing-file restore attempt;
- Litestream logs show replication started for `/data/license.sqlite`;
- `/healthz` returns `{"status":"ok"}`;
- admin readback against `LICENSE_DB_PATH=/data/license.sqlite` lists issued
  license hashes and never raw keys.

## Timed staging restore drill

Run this before GA and then on the cadence below. Use a staging app and staging
volume; never destroy the production volume as a drill.

1. Record start time, source commit SHA, app name, volume id, and replica URL
   prefix in the evidence packet.
2. Create or reset a staging Fly app with a fresh `license_data` volume and no
   `/data/license.sqlite` file.
3. Set the same shape of secrets as production, but point
   `LICENSE_REPLICA_URL` at the staging restore replica/prefix.
4. Deploy the image. The entrypoint must attempt:
   `litestream restore -if-replica-exists -config "$LITESTREAM_CONFIG" "$LICENSE_DB_PATH"`.
5. Wait for `/healthz` to pass and run admin `list` against the restored DB.
6. Record end time and calculate restore duration. The drill passes only if
   duration is <= 30 minutes and the restored DB contains the expected license
   hashes/activation rows.
7. Revoke or delete any throwaway keys created solely for the drill, then
   destroy the staging app/volume if it is not reused.

If no backups are found, the entrypoint may initialize a new empty DB. That is
acceptable for a brand-new staging replica, but it is not acceptable proof for
production DR. Production restore proof must show expected existing rows.

For the v2 rollout drill, also prove that the selected pre-v2 recovery point
opens with the reviewed pre-v2 image on a fresh path or volume. Do not use the
production replica destination for the drill, and do not let staging write back
into the production replica prefix.

## Verification cadence

- Daily: monitor `/healthz` and Fly machine health.
- Daily: alert on Litestream replication errors, repeated restart loops, or a
  missing `LICENSE_REPLICA_URL` in production.
- Weekly: inspect replica freshness using Litestream object-store metadata or a
  provider inventory command; save a compact evidence note.
- Monthly until GA, then quarterly: run a timed staging restore drill and store
  the evidence packet in the team-owned release evidence location named by the
  release tracker or runbook for that drill.
- Before any GA/release claim: rerun the staging restore drill if the service
  image, Litestream version, storage provider, or Fly volume changed.

## Alerting notes

Minimum alert set:

- HTTP `/healthz` down or timing out.
- Fly machine restart loop.
- Litestream process exit or repeated replication error in logs.
- Object-store replica has no recent generation/snapshot evidence within the
  RPO window.
- Volume snapshot or object-store lifecycle policy disabled unexpectedly.

Treat healthz-only green as insufficient for DR. Healthz proves the HTTP
process is alive; it does not prove offsite recovery data is current.

## Customer outage playbook

The supported v1.0.4 configuration is mandatory-online:
`offlineGraceMs=0`. A successful activation writes an entitlement cache for
setup/status diagnosis, but that cache is diagnostic only and grants no review
authority. If the API is unreachable, refreshed status reports
`source="none"` with a network/server classification and the review gate fails
closed immediately for public, private, internal, and unknown visibility.

Do not raise `offlineGraceMs`, enable a public-repo bypass, or treat a cached
`active` record as outage authorization. Recovery restores the API; it does not
move authority into user-editable client config.

During a production outage:

1. Confirm whether the outage is HTTP, Fly machine, volume, object store, or
   credential related.
2. Preserve the current volume and logs before mutation.
3. Restore on staging first when time allows; if production replacement is
   required, restore only to a missing DB path or a fresh volume.
4. Never overwrite an existing production database. Owner approval may select
   the reviewed replica timestamp and authorize attaching a fresh restore path
   or volume; it cannot authorize an in-place overwrite.
5. Verify the real-client outage path still returns `source="none"` and denies
   review with `offlineGraceMs=0`; the presence of a cache file is diagnostic
   evidence only.
6. Keep checkout and subscription event delivery held until database and API
   verification completes. Do not recover raw keys or mint replacement keys as
   part of reconciliation.

Issue
[#559](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/559)
owns version, manifest, deploy, install, live activation, and checkout proof.
This source-only PR does not prove live replication, production restore,
production migration, or customer readiness.
