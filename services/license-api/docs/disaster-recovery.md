# License API disaster recovery runbook

This runbook covers disaster recovery for the NeonDiff license API SQLite
database at `/data/license.sqlite`.

Issue scope: [#423](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/423).
This source-only PR does not prove live replication; it only adds the buildable
Litestream wiring, owner runbook, static assertions, and local client outage
grace verification. Live object storage, Fly secrets, deploy, and timed restore
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

The shipped client already has an offline entitlement cache. If the license API
is unreachable, paying private-repo users with a fresh active cache should remain
inside the configured offline grace window; once that window expires, the
private-repo gate fails closed. This PR includes a local real-server test for
activate -> stop server -> within-grace allow -> after-grace deny.

During a production outage:

1. Confirm whether the outage is HTTP, Fly machine, volume, object store, or
   credential related.
2. Preserve the current volume and logs before mutation.
3. Restore on staging first when time allows; if production replacement is
   required, restore only to a missing DB path or a fresh volume.
4. Do not overwrite an existing production DB with `-force` unless the owner has
   explicitly approved a data replacement and the evidence packet names the
   selected replica timestamp.
5. Communicate the grace-window boundary clearly: cached private-repo users can
   continue only while their cache remains inside `offlineGraceMs`.
