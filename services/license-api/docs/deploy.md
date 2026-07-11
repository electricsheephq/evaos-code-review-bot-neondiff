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

After setting the secret and deploying, capture a non-secret readiness proof for
release-status: an unauthenticated request to the checkout issuance endpoint must
return `401` with `{"status":"unauthorized"}`. A `503` response with
`license issuance is not configured` means the Fly app is still missing
`LICENSE_ISSUANCE_SECRET` and is not ready for paid/trial checkout activation.

The same Fly-only secret derives deterministic short-lived keys for
`POST /v1/admin/licenses/issue-lifecycle`; it is never valid authorization for
that route and must not be copied into GitHub. The protected release workflow
uses GitHub Actions OIDC with audience `neondiff-license-lifecycle`. The service
pins the canonical repository IDs, protected `main` ref, workflow path,
`license-lifecycle-production` environment, `workflow_dispatch`, GitHub-hosted
runner, and candidate SHA. Configure the GitHub environment approval policy
before treating this route as production proof. No additional OIDC secret is
required.
This release-status proof intentionally verifies only the fail-closed public
boundary. It does not prove that a valid server-side checkout webhook can issue
a license or write the DB. Stable/GA manifests must also point
`checkoutIssuanceAuthenticatedProofPath` at an owner-held redacted success proof
under `docs/evidence/`. That proof may record `statusCode: 200`,
`status: "issued"`, `replayed`, the checkout lookup key,
`issuedLicensePrefix: "nd_live_"`, and a `sha256:<64-hex>` fingerprint of the
issued license key. It must not store raw bearer headers,
`LICENSE_ISSUANCE_SECRET`, raw `licenseKey`, cookies, customer data, checkout
payload secrets, or raw response bodies.

Use the repo-owned smoke helper for that owner-held success proof. Start with a
dry run so the request shape is visible without reading the secret or sending a
network request:

```sh
npx tsx src/cli.ts checkout-issuance-smoke \
  --url https://neondiff-license.fly.dev/v1/admin/licenses/issue \
  --release-version <release-version> \
  --checkout-lookup-key neondiff_monthly \
  --dry-run true
```

After the same issuance secret has been configured on the license API and the
server-side checkout webhook, run the live proof capture from a clean checkout:

```sh
export LICENSE_ISSUANCE_SECRET="<owner-held-shared-secret>"
npx tsx src/cli.ts checkout-issuance-smoke \
  --url https://neondiff-license.fly.dev/v1/admin/licenses/issue \
  --release-version <release-version> \
  --checkout-lookup-key neondiff_monthly \
  --secret-env LICENSE_ISSUANCE_SECRET \
  --dry-run false \
  --confirm-live-issuance true \
  --output docs/evidence/license-checkout-issuance-authenticated.json
```

The command reads the bearer value only from `--secret-env`, never from argv,
and writes only the strict redacted proof accepted by
`checkoutIssuanceAuthenticatedProofPath`. It rejects non-HTTPS URLs before
reading the secret. The smoke request uses a stable synthetic `idempotencyKey`
as the replay key; `externalCheckoutId` mirrors that value only as smoke
metadata, while the license API's idempotent issuance contract is keyed by
`idempotencyKey`.

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

## 5. Point a client config at the deployed URL

**Use a copy of the client config, not the committed one** — this step is
for verifying the deploy, not for flipping enforcement on for real users
yet. Take `config.example.json`, copy it somewhere scratch, and set:

```jsonc
{
  "license": {
    "enabled": true,
    "apiBaseUrl": "https://neondiff-license.fly.dev"  // your app's URL
  }
}
```

(`apiBaseUrl` is the exact field the client reads — see
`src/license.ts`, `config.example.json`'s `_apiBaseUrlComment`.)

## 6. Verify: contract + a live smoke check

Two different things, both worth doing:

- **Contract test (pre-deploy correctness, already covered):**
  `npm test` at the repo root runs
  `tests/license-service-contract.test.ts`, which drives the real client
  (`src/license.ts`) against the real service in-process (mocked
  request/response objects, no network) through
  activate → validate → deactivate → reactivate-different-machine. This
  proves the HTTP contract shape is correct *before* you ever deploy — it
  does not hit a live URL, so it's not a substitute for step 2 below, but
  there's no need to re-run it post-deploy unless the service code changed.
- **Live smoke check against the real URL (do this post-deploy):** issue a
  throwaway key on the deployed instance and drive the three endpoints
  directly:

  ```sh
  # on the fly machine, or against a copy of the volume — see admin-runbook.md
  flyctl ssh console --app neondiff-license -C \
    "LICENSE_DB_PATH=/data/license.sqlite node dist/admin.js issue --plan yearly --scope private --seats 1"
  # copy the printed key, then from your workstation:
  curl -s https://neondiff-license.fly.dev/healthz
  curl -s -X POST https://neondiff-license.fly.dev/v1/license/activate \
    -H 'Content-Type: application/json' \
    -d '{"licenseKey":"<key from above>","machineId":"smoke-test-1"}'
  ```

  Confirm `/healthz` returns `{"status":"ok"}` and `activate` returns a
  `200` with an `entitlement` object. Revoke the throwaway key afterward
  (`admin.js revoke --key … --reason "deploy smoke test"`) so it doesn't
  linger as a live, unaccounted-for seat.

## 7. Promote

Only after the live smoke check passes: wire the real URL into
`docs/public-release-manifest.json`'s `licenseApi` slot (currently
`"state": "pending"`) and flip `license.enabled` / `apiBaseUrl` in the
actual shipped config for the release that turns enforcement on. This is a
separate, deliberate change — do not fold it into a deploy-assets PR.

## Rollback

- **Bad release, service still reachable:** `flyctl releases --app
  neondiff-license` to list, then `flyctl deploy --image <previous image
  ref>` (or `flyctl releases rollback` if available on your `flyctl`
  version) to go back to the last good image. The SQLite volume is
  untouched by an image rollback — activations/keys persist.
- **Service unreachable / stuck:** `flyctl apps restart neondiff-license`.
  If a bad migration or admin action corrupted data, use the DR runbook before
  replacing data. Litestream restore to a fresh/missing DB path is the primary
  offsite recovery path; Fly volume snapshots remain a secondary rollback
  surface (`flyctl volumes snapshots list` /
  `flyctl volumes create --snapshot-id …` to a fresh volume, then swap the
  mount). Before relying on snapshot rollback in an incident, verify the exact
  snapshot commands against the `flyctl` version used by production operators
  and record that version in the evidence packet. There is no in-app migration
  system today.
- **Emergency full stop:** `flyctl scale count 0 --app neondiff-license`
  stops serving entirely. Since license checks fail closed only for
  all supported review work, this is an emergency stop rather than a
  customer-transparent action. Existing users see their entitlement checks
  start failing (client behavior on
  `apiBaseUrl` unreachable is a server-classified failure, not a silent
  allow — see `README.md`'s HTTP-code table) until service is restored.
