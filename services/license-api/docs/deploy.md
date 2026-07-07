# License API deploy runbook (fly.io)

Deploy assets for `services/license-api` (#327): `Dockerfile`, `fly.toml`,
`.dockerignore`. This document is the deploy sequence for the owner to run.
**Nothing in this PR executes a deploy** — `flyctl` is unauthenticated on the
machine that produced these assets; every command below is an owner step,
run interactively after `flyctl auth login`.

See also: [`admin-runbook.md`](admin-runbook.md) (key issuance/lifecycle —
does not cover deploy) and the service [`README.md`](../README.md) (HTTP
contract, env vars, local run).

## Why this endpoint exists (scope reminder)

License gating is **client-side and private-repo only**: public repos are
free and never call this service (`publicReposFree: true` in
`config.example.json`; see the client at `src/license.ts` and the contract
description in `README.md`). This deploy stands up the backend that
`activate` / `validate` / `deactivate` calls hit **only when a user has
enabled license enforcement for a private repo**. There is no scenario where
this service being down affects a public-repo user.

## Prerequisites

- `flyctl` installed (`brew install flyctl` or see fly.io docs) and
  authenticated: `flyctl auth login`.
- Repo root as the build context — the Dockerfile compiles the service using
  the root `typescript` devDependency (the service itself has zero runtime
  npm dependencies; see `Dockerfile` header comment). Run every `flyctl`
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

**None required for pass 1.** The service takes no API keys, auth tokens, or
third-party credentials — it's a self-contained SQLite-backed HTTP service
(`LICENSE_DB_PATH` / `PORT` / `HOST` are plain config, already set as
`[env]` in `fly.toml`, not secrets). If a future pass adds e.g. an admin-CLI
auth token for remote issuance, set it with:

```sh
flyctl secrets set SOME_KEY=value --app neondiff-license
```

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
neondiff-license` streams the `license-api listening on …` boot line from
`src/server.ts`.

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
  If a bad migration or admin action corrupted data, restore from a Fly
  volume snapshot (`flyctl volumes snapshots list` /
  `flyctl volumes create --snapshot-id …` to a fresh volume, then swap the
  mount) — there is no in-app migration system today, so data-level
  recovery is volume-snapshot only.
- **Emergency full stop:** `flyctl scale count 0 --app neondiff-license`
  stops serving entirely. Since license checks fail closed only for
  *private* repos with enforcement enabled, this is a safe last resort — it
  does not affect public-repo users, and existing private-repo users just
  see their entitlement checks start failing (client behavior on
  `apiBaseUrl` unreachable is a server-classified failure, not a silent
  allow — see `README.md`'s HTTP-code table) until service is restored.
