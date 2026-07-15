# NeonDiff Managed GitHub App Authorization Broker

Threat model, data-flow, and retention for the server-side authorization broker
that lets a NeonDiff desktop client connect the official NeonDiff GitHub App and
obtain bounded, short-lived installation access without ever holding the App
private key.

This document covers the **server-side slice only** (issue #613). Native connect
UI states are sequenced after #611/#612; the repository-visibility and
entitlement decision that #614 binds at token issuance is present here only as a
single seam function (`authorizeTokenIssuance`) with a fail-closed pre-#614
default. No production GitHub App exists yet; every code path below is exercised
against fixtures, never a live install (see "Owner-gated boundary").

## Problem

The documented setup (`docs/github-app-setup.md`) requires each user to create a
GitHub App, download a private key, set `NEONDIFF_GITHUB_APP_ID` /
`NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH`, and edit local config. That cannot be the
everyday-user v1 path. The v1 customer path is: click Connect, complete GitHub's
own install/authorize UI, return to the app, done.

Review execution stays local. The local daemon polls GitHub with App
credentials; there is no webhook receiver and v1 does not add one. Exactly one
thing moves server-side: **custody of the GitHub App private key, and with it the
minting of bounded short-lived installation access tokens.**

## Architecture

The broker is a route/module group inside the existing production license
service deployment (`services/license-api`, Fly) under
`services/license-api/src/github-broker/`. One control plane, one decision point,
one audit ledger. The module boundary keeps it splittable later.

Rationale: #614 must bind repository visibility and entitlement at the moment of
token issuance. Colocating the broker with the license authority makes that
binding a single-service decision with a single audit ledger. Revisit only if the
finished security review demands process isolation.

The broker persists to its own SQLite database (`GITHUB_BROKER_DB_PATH`),
separate from the license database, so the two schemas evolve independently and
the license store's strict schema verification is unaffected.

## Data flow (happy path)

1. **Device registration (native to broker).** On first run the app generates a
   keypair in the Keychain and registers its public key at
   `POST /device/register` (rate-limited, anonymous — the public/free tier
   requires no account). The device id is derived from the public key, so
   re-registration is idempotent. Subsequent broker calls carry a short-lived
   device-signed JWT (`sub` = device id) in the `Authorization` header.
2. **Connect start (native to broker).** The device calls
   `POST /github/connect/start`. The broker returns the official NeonDiff App
   install URL plus a one-shot `state` nonce bound to (device, expiry <= 10 min).
3. **GitHub authorization (user's browser).** GitHub's own UI handles account/org
   choice, repository selection, and permission display. NeonDiff never proxies
   or skins this step, so the user sees the official App identity and exact
   permissions on github.com (AC2).
4. **Callback (GitHub to broker).** `GET /github/connect/callback?installation_id&state`.
   The broker verifies the one-shot state (unconsumed, unexpired, CSRF-proof —
   mirrors website PR #48: one-shot fulfillment tokens + explicit owned return
   origins + framework CSRF), verifies the installation exists and belongs to the
   App (`GET /app/installations/{id}` with an App JWT), records the binding
   (device id <-> installation id), and marks the state consumed.
5. **Return (native to broker).** The app confirms the binding at
   `POST /github/connect/complete` with its device credential and the original
   `state`. See "Return path" for why this is a device poll rather than a
   browser-to-app URL-scheme redirect in v1.
6. **Token issuance (native to broker, recurring).** `POST /github/token` with the
   device credential, `installation_id`, and the requested `repositories` /
   `permissions`. The broker checks, in order: the binding exists; the
   installation is live and not suspended; every requested repository is present
   in the installation's current selection; **then** the seam decision
   (`authorizeTokenIssuance`, the #614 gate); and only on `allow` mints an
   installation access token via App JWT, narrowed with the `repositories` and
   `permissions` parameters to the minimum the worker needs. The token and its
   expiry (GitHub TTL <= 1 h) are returned. The App private key never appears in
   any response, log, or client artifact.
7. **Local operation.** The local worker polls GitHub with the brokered token
   exactly as it does today with a locally minted one, and renews via step 6
   before expiry. Reviews post as the NeonDiff App installation identity (AC6),
   because installation tokens author as the App.

## Identity: what is a "verified native session"?

The v1 device credential is a client-generated keypair. On first run the app
stores the private key in the Keychain and registers the public key. Each broker
call is authenticated by a short-lived device-signed JWT whose `sub` is the
device id (the digest of the registered public key). The broker verifies the
signature against the stored public key and rejects expired or wrong-subject
tokens.

The GitHub installation flow itself is the proof of repository authority: a device
can only ever obtain tokens for installations whose callback it completed, because
the one-shot state nonce binds the browser session GitHub authorized to the device
that initiated the connect. Private-tier binding to an activation/entitlement
record at the license service is #612/#614 work, layered at the same seam.

## Return path (resolves design open question #1)

The desktop app registers **no custom URL scheme today** — there is no
`CFBundleURLTypes` / `CFBundleURLSchemes` entry and no `neondiff://` literal
anywhere in `apps/neondiff-desktop`. A browser-to-app redirect with a completion
code therefore has nothing to redirect into.

**v1 decision:** the return is a **device poll**. After the browser callback
records the binding, the app calls `POST /github/connect/complete` with its device
credential and the original `state`; the broker returns `pending` until the
callback lands and `bound` (with the installation id) afterward. No completion
secret crosses the browser-to-app boundary, so there is no code to intercept.

If #612 adds a registered URL scheme, an optional completion-code redirect can be
layered on top of the same one-shot state without changing this contract. This is
a design decision surfaced for #612, not an assumption.

## Failure and abuse states (typed, all fail closed)

Every failure is a typed reason code; none falls back to a user OAuth token or an
embedded key (see Rollback in issue #613).

- `device_not_registered`, `invalid_device_credential` — device auth failures.
- `state_not_found`, `state_expired`, `state_replayed` — one-shot connect-state
  enforcement (a second callback for the same state is `state_replayed`).
- `binding_not_found` — a token request for an installation this device never
  completed a callback for.
- `installation_not_found`, `installation_uninstalled` — the installation is gone
  (discovered at issuance time; there are no webhooks in v1, so uninstall surfaces
  at the next token request or poll failure).
- `installation_suspended` — the installation is suspended.
- `repo_outside_installation` — a requested repo is not in the installation's
  current selection (AC4).
- `repo_renamed_or_transferred` — the installation repository list is re-fetched at
  issuance; a stale repository reference is a typed error, never a silent pass.
- `visibility_unknown` — a requested repo's visibility could not be determined;
  fail closed rather than assume public.
- `entitlement_gate_not_implemented` — the pre-#614 default: a requested repo is
  private or internal and the entitlement gate that would authorize it is not yet
  implemented. Fail closed.
- `entitlement_missing` — reserved for #614 (private repo without active
  entitlement).
- `rate_limited` — per-device and per-installation budgets on the broker; GitHub
  secondary limits are surfaced distinctly.
- `broker_unavailable` — the broker or its GitHub dependency is unreachable; the
  app shows a typed offline state with no fallback.

## The issuance seam (`authorizeTokenIssuance`)

There is exactly one code path that can mint an installation token, and it flows
through `authorizeTokenIssuance`. The function receives the requested repositories
already resolved against the installation's repository list (each with its
visibility) and returns either `allow` (with the exact repositories to narrow to)
or `deny` with a typed reason code.

Pre-#614 policy: `allow` only when **every** requested repository is verified
`public`; any `private`, `internal`, or `unknown` visibility denies with
`entitlement_gate_not_implemented` (or `visibility_unknown`). #614 replaces the
body of this one function to add the entitlement decision; no caller can skip it
because minting is unreachable except through its `allow` result (the
gate-every-caller rule).

## Threat model (STRIDE)

- **Spoofing.** Unauthenticated token minting is prevented by device-signed
  requests plus callback-time binding; the state nonce is one-shot with a 10-minute
  expiry, so a stolen or replayed callback cannot bind a foreign device.
- **Tampering.** Minted tokens are narrowed by the `repositories` and `permissions`
  parameters, so a leaked token bounds blast radius to the user's own selected
  repos for <= 1 h.
- **Repudiation / audit.** An append-only, public-safe decision ledger records
  device id, installation id, decision, reason code, and timestamps — never
  repository content, never key material. Shared with #614.
- **Information disclosure.** The App private key lives only in the deployment
  secret store and is read at runtime; it is never persisted by the broker, never
  logged, never returned. Redaction discipline mirrors `src/secrets.ts`: no token,
  key, or nonce material appears in logs or error bodies. The broker stores no
  source, diffs, provider keys, or private-repo metadata beyond id and visibility.
- **Denial of service.** Per-device and global rate limits, registration
  throttling, and bounded request bodies.
- **Elevation of privilege.** The broker refuses issuance for any installation not
  bound to the requesting device, and refuses repositories outside the
  installation's selection (AC4). #614 refuses private repos without entitlement —
  all at the same seam, so no caller path can skip a gate.

## Retention

The broker persists only: device registrations (public key, created-at,
last-seen-at), installation bindings (device id, installation id, account login,
created-at), one-shot connect states (nonce, device id, expiry, consumed-at,
bound installation id), the decision ledger, and in-memory rate-limit counters.

No tokens are stored at rest — they are minted and returned, never persisted. No
raw device private keys, App keys, source, or diffs are ever stored. Ledger rows
are public-safe by construction. Deletion: device deregistration removes its
bindings and states; uninstalled installations are pruned on discovery.

## Open questions

1. **Return-path handoff (RESOLVED).** URL scheme is not registered today, so v1
   uses the device-poll `complete` endpoint. See "Return path". Layer a scheme
   redirect in #612 if desired.
2. **Device-registration abuse economics (OPEN).** Bot farms registering devices
   on the free tier. Initial posture: registration rate limits plus GitHub-side
   installation authority is the real gate (a device with no completed callback
   can mint nothing). Revisit with abuse telemetry.
3. **Token-response repo snapshot (RESOLVED).** `POST /github/token` returns only
   the token, its expiry, and the granted repositories/permissions. The app lists
   repositories client-side with the brokered token, keeping broker surfaces
   minimal.
4. **Staging vs. production App registration sequence (OWNER-GATED, OPEN).** The
   agent builds against a staging App the owner registers with the documented
   permission set (see `docs/security/github-app-staging-registration.md`). The
   production identity is created only after the security review.

## Owner-gated boundary

Agent-executable now (this slice): the broker service code and its contract,
integration, adversarial, and redaction tests against fixtures; this threat model
and data-flow document; and the staging App registration spec.

Owner-only (blocked, needs-owner): creating the official NeonDiff GitHub App
registration (production identity), holding the App private key, provisioning the
Fly deployment secrets, and approving this security review before any production
credential exists (AC7). No code in this slice proves the live install flow; it
proves the fixtured broker contract only.
