# NeonDiff Managed GitHub App Authorization Broker

Threat model, data-flow, and retention for the server-side authorization broker
that lets a NeonDiff desktop client connect the official NeonDiff GitHub App and
obtain bounded, short-lived installation access without ever holding the App
private key.

This document covers the **server-side slice** (issues #613 and #614) and its
rollout-disabled native composition under #630. The repository-visibility and
entitlement decision is bound at token issuance in the single seam function
`authorizeTokenIssuance` (#614); the live device<->license linkage and deployment
wiring belong to the paid-beta deployment lane (#633). At the 2026-07-18
checkpoint the official App registration and selected-repository canary install
exist, but App privacy conversion is not yet verified and the production broker
kill switch remains off. Fixture/source proof below is therefore not a live
connect, token-mint, release, or customer-readiness claim.

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
4. **Callback (GitHub to broker).** `GET /github/connect/callback?installation_id&state&code`.
   OAuth-during-install is **enabled**, so this route is the App's **user
   authorization callback URL** (with OAuth-during-install on, GitHub makes the
   Setup URL unavailable and sends the post-install browser return here), carrying
   an install-time OAuth `code` alongside `installation_id` and `state`. The broker
   verifies the one-shot state (unconsumed, unexpired, CSRF-proof — mirrors website
   PR #48: one-shot fulfillment tokens + explicit owned return origins + framework
   CSRF), then — **before** resolving the installation (decide before side effects,
   so a forged callback cannot use App-JWT 403-vs-404 to probe arbitrary victim
   installation ids) — exchanges the `code` for the returning user identity and
   confirms via `GET /user/installations/{id}/repositories` that the user can
   access the installation, capturing the exact repositories they can access (the
   authorized set the binding is scoped to). Only then does it verify the
   installation exists and belongs to the App (`GET /app/installations/{id}` with an
   App JWT), record the binding (device id <-> installation id, scoped to that
   authorized repo set), and mark the state consumed. A **code-less** return — a
   bare install/reconfigure **update** redirect that carries `setup_action` but no
   `code` (GitHub sends these to the same callback URL and they prove no new
   authorization) — is acknowledged with the neutral return page and binds nothing,
   so legitimate updates are never locked out; any *other* code-less callback fails
   closed with `installation_authorization_unverified`.
5. **Return (native to broker).** The app confirms the binding at
   `POST /github/connect/complete` with its device credential and the original
   `state`. See "Return path" for why this is a device poll rather than a
   browser-to-app URL-scheme redirect in v1.
6. **Repository discovery (native to broker).** The app calls
   `POST /github/repositories` with the device credential, installation id, and
   page. The broker requires the exact device/installation binding, rechecks that
   the installation is live and not suspended, then returns only the intersection
   of the OAuth-authorized bind-time repository set and the installation's current
   selected repositories. The response contains canonical repository names and
   GitHub-authoritative visibility metadata in deterministic pages of at most 50.
   Each native page maps to exactly one bounded upstream repository-list page; the
   broker does not drain the full installation selection for every request. It may
   use a metadata:read-only installation token internally, but no token is returned
   and the review-token mint seam is never called.
7. **Token issuance (native to broker, recurring).** `POST /github/token` with the
   device credential, `installation_id`, and the requested `repositories` /
   `permissions`. The broker checks, in order: the binding exists; the
   installation is live and not suspended; every requested repository is present
   in the installation's current selection; every requested repository is within
   the connecting user's authorized set captured at bind time (else
   `repo_outside_authorization`, so an entitled but GitHub-unauthorized user cannot
   reach a private repo they cannot access); **then** the seam decision
   (`authorizeTokenIssuance`, the #614 gate); and only on `allow` mints an
   installation access token via App JWT, narrowed by the canonical
   `repository_ids` (GitHub rejects `owner/name` here) and a **server-clamped**
   permission set — at most the minimal review set (Metadata/Contents/Checks/
   Actions read, Pull requests write), never the device-supplied permissions
   verbatim, and never omitted (an omitted `permissions` field would make GitHub
   grant all App permissions). The token and its expiry (GitHub TTL <= 1 h) are
   returned. The App private key never appears in any response, log, or client
   artifact. Reading the installation's repository list to make the visibility
   decision uses a separate **metadata:read-only** installation token, so no
   broad token is ever minted before the seam authorizes.
8. **Local operation.** The local worker polls GitHub with the brokered token
   exactly as it does today with a locally minted one, and renews via step 7
   before expiry. Reviews post as the NeonDiff App installation identity (AC6),
   because installation tokens author as the App.

## Identity: what is a "verified native session"?

The v1 device credential is a client-generated keypair. On first run the app
stores the private key in the Keychain and registers the public key. Each broker
call is authenticated by a short-lived device-signed JWT whose `sub` is the
device id (the digest of the registered public key). The broker verifies the
signature against the stored public key and rejects expired or wrong-subject
tokens.

The GitHub installation flow is the proof of repository authority, but the
one-shot state nonce alone is NOT sufficient: it binds the returning browser
session to the initiating device, yet it does not prove the returning identity
actually owns the installation id in the callback. So the callback additionally
requires an **install-time OAuth authorization code** and verifies, via the
exchanged user identity, that the user can access the requested installation
before recording any binding (#614, P1). Membership alone
(`GET /user/installations`) does **not** prove access to every repository in an
installation — an org install can list for a user who can reach only some of its
repos. The broker therefore uses `GET /user/installations/{id}/repositories` to
capture the **exact repository set** the returning user can access and scopes the
binding to it; a later `POST /github/token` for any repo outside that set fails
closed with `repo_outside_authorization`, so an entitled but GitHub-unauthorized
user can never mint a token for a private repo they cannot access on GitHub. A
device therefore obtains tokens only for installations — and repositories — whose
access it proved at callback time — a valid state plus an arbitrary victim installation id binds
nothing. Enabling OAuth-during-install and provisioning the OAuth client
credentials is OWNER-GATED (see the staging-registration spec); until then the
callback fails closed with `installation_authorization_unverified`.

The authorized repository set is a **bind-time snapshot** — the short-lived user
OAuth token is deliberately not persisted, so the set is not re-verified on every
`POST /github/token`. A repository-access revocation on GitHub therefore takes
effect for the broker on the user's **next connect/bind**, not mid-session; this
is acceptable because the minted installation tokens are short-lived (GitHub TTL
<= 1 h) and re-connecting refreshes the set atomically. A periodic bind-refresh
(re-running the user-token repository check on a cadence, or on token renewal) is
a possible future tightening if near-real-time revocation is required. Private-tier
binding to an activation/entitlement record at the license service is #612/#614
work, layered at the same seam.

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
- `installation_authorization_unverified` — the callback did not prove the
  returning identity owns the installation (missing/invalid install-time OAuth
  code, or OAuth-during-install not yet provisioned); fail closed, no binding
  (HTTP 403, #614 P1).
- `repo_outside_installation` — a requested repo is not in the installation's
  current selection (AC4).
- `repo_outside_authorization` — a requested repo is in the installation but
  outside the set the connecting OAuth user could access at bind time; fail closed
  (HTTP 403, #614 P1). Installation membership alone (`GET /user/installations`)
  does not prove per-repo access, so the binding is scoped to the exact repository
  set from `GET /user/installations/{id}/repositories`.
- `repo_renamed_or_transferred` — the installation repository list is re-fetched at
  issuance; a stale repository reference is a typed error, never a silent pass.
- `visibility_unknown` — a requested repo's visibility could not be determined;
  fail closed rather than assume public (HTTP 403).
- Entitlement decisions for a private/internal request (#614), each a distinct
  fail-closed reason code so native/CLI consumers can key their locked/free
  explanation and recovery action off the exact state:
  - `entitlement_missing` — no active entitlement was resolved (HTTP 403).
  - `entitlement_expired` — the entitlement has lapsed (HTTP 403).
  - `entitlement_revoked` — the entitlement was revoked (HTTP 403).
  - `entitlement_invalid` — the entitlement is not recognized (HTTP 403).
  - `entitlement_scope_insufficient` — an active license whose scope covers only
    public repositories (HTTP 403).
  - `entitlement_seat_exhausted` — the license seat allocation is exhausted for
    this device (HTTP 409).
  - `entitlement_replay_conflict` — an entitlement event-order/replay conflict
    (HTTP 409).
  - `entitlement_service_unavailable` — the license authority could not be
    reached; fail closed, never allow (HTTP 503).
- `rate_limited` — per-device and per-installation budgets on the broker; GitHub
  secondary limits are surfaced distinctly.
- `broker_unavailable` — the broker or its GitHub dependency is unreachable; the
  app shows a typed offline state with no fallback.

## The issuance seam (`authorizeTokenIssuance`)

There is exactly one code path that can mint an installation token, and it flows
through `authorizeTokenIssuance`. The function is pure: it receives the requested
repositories already resolved against the installation's repository list (each
with its GitHub-authoritative visibility) plus the entitlement snapshot the
service resolved from the license authority, and returns either `allow` (with the
exact repositories to narrow to) or `deny` with a typed reason code. No caller can
skip it because minting is unreachable except through its `allow` result (the
gate-every-caller rule).

**#614 policy, evaluated in order:**

1. An empty request is `invalid_request`.
2. Any repository whose visibility could not be authoritatively determined denies
   with `visibility_unknown` — never assume public.
3. An **all-public** request is authorized with **no NeonDiff Activation Key**
   (the public-free tier); the entitlement snapshot is not consulted, so the free
   tier does not depend on the license authority being reachable.
4. Otherwise (at least one `private`/`internal` repository) an **active,
   private-covering entitlement** is required. Every other entitlement state
   denies with its own distinct reason code (see "Failure and abuse states").

**Ordering and egress.** The service resolves entitlement for the non-public
repositories *before* calling the seam and *before* any mint, using only the
license authority (no GitHub content API, no provider/model call). A blocked
private request therefore mints no usable installation token — zero content
egress. Reading the installation's repository list to determine visibility uses a
separate **metadata:read-only** token, so no broad token exists before the seam
authorizes.

**Server-authoritative visibility (AC1/AC6).** The token request body carries no
visibility field; the broker derives visibility from GitHub. A modified client
that believes a private repo is public gains nothing — the server's fresh read
wins, and a private repo without an active entitlement is denied.

**A provider key never unlocks private (AC5).** The seam has no provider-key
input by construction; the only snapshot that authorizes a private request is an
active, private-covering entitlement.

The entitlement snapshot is resolved through an injected authority (contract
shape: the license-api `Entitlement`, merged #574). Its default is fail-closed
(deny all private work) until the paid-beta deployment lane (#633) wires the live
device<->license linkage; the broker slice proves the binding against fixtures
only.

## Threat model (STRIDE)

- **Spoofing.** Unauthenticated token minting is prevented by device-signed
  requests plus callback-time binding; the state nonce is one-shot with a 10-minute
  expiry, and the callback additionally requires proof (the install-time OAuth
  code) that the returning identity owns the installation, so neither a stolen or
  replayed callback nor a valid state paired with a guessed victim installation id
  can bind a foreign installation (#614 P1).
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
  - **Per-repo access is enforced at bind time (#614 P1).** The callback proves the
    OAuth identity can access the installation AND enumerates the exact repositories
    that user can reach (`GET /user/installations/{id}/repositories`); the binding is
    scoped to that set, and token issuance refuses any repo outside it
    (`repo_outside_authorization`). So in an org installation whose selection spans
    repos the OAuth user can only partially access, the device can mint only for the
    repos that user could actually reach — not the whole installation.
  - **Known limitation — the authorized set is a bind-time snapshot (OPEN, future).**
    The user OAuth token is deliberately not persisted, so the per-repo set is
    captured once at connect and not re-verified on every `POST /github/token`. A
    repository-access revocation on GitHub therefore takes effect for the broker on
    the user's *next* connect/bind, not mid-session — acceptable because minted
    installation tokens are short-lived (<= 1 h) and re-connecting refreshes the set
    atomically. A periodic bind-refresh (re-running the user-token repo check on a
    cadence or at token renewal) is a possible future tightening if near-real-time
    revocation is required.

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
   on the free tier. Initial posture: the real gate is **proven per-repo GitHub
   access at callback time** — a binding now requires the install-time OAuth code
   exchange (#614 P1) and is scoped to the exact repositories that user can reach
   (`GET /user/installations/{id}/repositories`), so a device can mint nothing
   without it; installation membership + registration rate limits are the base
   layer beneath that proof, not the primary control. This closes the
   install-binding forgery where a valid state plus a guessed victim installation
   id could bind a foreign installation, and prevents an entitled-but-unauthorized
   user from reaching a private repo they cannot access. **Blocking
   owner-gated dependency:** the App must enable "Request user authorization
   (OAuth) during installation" and provision its OAuth client id/secret (see
   `docs/security/github-app-staging-registration.md`); until then the callback
   fails closed. Revisit registration abuse with telemetry.
3. **Token-response repo snapshot (RESOLVED).** `POST /github/token` returns only
   the token, its expiry, and the granted repositories/permissions. Repository
   selection uses the separate device-authenticated `POST /github/repositories`
   metadata route, so the native app never needs an unnarrowed review token merely
   to populate its selector.
4. **Staging vs. production App registration sequence (OWNER-GATED, PARTIAL).**
   The official App identity now exists and is installed only on the two
   dedicated canary repositories, but production broker credentials, verified
   private-App posture, live wiring, and security approval remain gated. The
   staging checklist remains the settings contract.

## Owner-gated boundary

Agent-executable now: the broker service/client contracts, integration,
adversarial, and redaction tests against fixtures; the default-off native
composition; this threat model and data-flow document; and the staging App
registration spec.

Owner-only (blocked, needs-owner): finalizing/confirming the official App's
private posture, holding its private key/OAuth client secret, provisioning the
Fly deployment secrets, and approving the production security review before the
broker is enabled (AC7). No code in this slice proves the live install flow; it
proves the source/fixture composition only.
