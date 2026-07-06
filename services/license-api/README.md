# NeonDiff license API (`@neondiff/license-api`)

Self-contained license service for NeonDiff private-repo entitlements
([#327](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/327)).
It implements the exact HTTP contract the shipped client (`src/license.ts`)
already calls — activate / validate / deactivate — backed by SQLite, with an
admin CLI that mints keys. **Payment rails are out of scope**: keys are issued by
an operator via the CLI.

The service is a separate package boundary; it does **not** import the review
worker and can be deployed on its own (SQLite on a mounted volume).

## Contract

Three `POST` endpoints, JSON in / JSON out (`Content-Type: application/json`):

| Endpoint | Request body | Success (200) | Denials |
| --- | --- | --- | --- |
| `/v1/license/activate` | `{ licenseKey, repo?, machineId }` | `{ entitlement: { status:"active", repoVisibilityScope, … } }` | 404 invalid · 403 revoked · 402 expired · **409 scope_mismatch** (seat exhausted) |
| `/v1/license/validate` | `{ licenseKey, repo?, machineId }` | active entitlement | 404 invalid · 403 revoked · 402 expired · 409 scope_mismatch (never activated on this machine) |
| `/v1/license/deactivate` | `{ licenseKey, repo?, machineId }` | `{ status:"active", … }` (idempotent) | 404 invalid |

Cross-cutting: 429 rate_limited (per-key throttle) · 400 malformed · 5xx server.
`machineId` is the single-activation binding — one machine per seat (default
`seats=1`). Only `sha256(licenseKey)` is ever stored; the raw key is never
logged or echoed. `GET /healthz` → `{ "status": "ok" }`.

The HTTP-code → client-classification map is fixed by the client
(`402→expired · 429→rate_limited · 426→unsupported_client · 409→scope_mismatch ·
403/410→revoked · 401/404→invalid · 5xx→server`); the service returns codes that
match it.

## Run

```sh
# from the repo root, deps installed via `npm install`
cd services/license-api
npm run build           # tsc → dist/
LICENSE_DB_PATH=runtime/license.sqlite PORT=8080 npm start
```

Environment:

- `LICENSE_DB_PATH` — SQLite file path (default `runtime/license.sqlite`; point
  at a mounted volume in deploy).
- `PORT` / `HOST` — listen address (default `8080` / `0.0.0.0`). TLS is
  terminated upstream (fly), so the process serves plain HTTP internally.

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
```

`issue` flags: `--plan <p>` (required), `--scope <public|private|all>`
(required), `--seats N` (default 1), `--expires <iso>`,
`--private-repo-allowed <true|false>`, `--update-entitlement`.

See [`docs/admin-runbook.md`](docs/admin-runbook.md) for the operator runbook.

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
