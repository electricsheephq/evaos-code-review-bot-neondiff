# Staging GitHub App Registration Spec

The exact checklist to register the **staging** NeonDiff GitHub App that the
managed authorization broker (issue #613, `services/license-api/src/github-broker/`)
runs against. This is the fixture-to-live bridge: the agent builds and tests the
broker against an in-memory client; the owner registers a real staging App with
the settings below so the broker can be exercised end-to-end before any
production identity or security review exists.

Every step marked **[OWNER-GATED]** requires the repository/organization owner —
the agent cannot create App registrations, hold private keys, or provision
deployment secrets. Do not create the production App from this document; the
production identity is created only after the committed security review
(`docs/security/github-app-broker.md`, AC7).

## 1. Create the staging App [OWNER-GATED]

1. Under the owning org (or a personal account for early staging), create a new
   GitHub App named distinctly for staging, e.g. `NeonDiff (Staging)`.
2. Homepage URL: the NeonDiff website or repository URL.
3. **[OWNER-GATED — BLOCKING for #614]** **Enable** "Request user authorization
   (OAuth) during installation", set the **User authorization callback URL** to
   the broker's `/github/connect/callback`, and provision the App's OAuth
   **client id** and **client secret** as deployment secrets
   (`githubBroker.oauthClientId` / `oauthClientSecret`). Note that with
   OAuth-during-install enabled GitHub makes the separate **Setup URL** field
   **unavailable** (the two are mutually exclusive) and routes the post-install
   return to this callback URL instead — so there is no Setup URL to set. The
   broker binds a device to an installation ONLY after exchanging the install-time
   authorization `code` and confirming the authorizing user can access it; because
   installation membership alone (`GET /user/installations`) does not prove access
   to every repository in an org installation, the broker enumerates the user's
   accessible repositories with `GET /user/installations/{id}/repositories` and
   scopes the binding to that exact set (per-repo, #614 P1). Without this, a valid
   one-shot state alone lets a caller bind to an arbitrary (victim) installation id
   — the install-binding forgery the #614 security review flagged (P1). Until it is
   enabled, `connectCallback` fails closed with
   `installation_authorization_unverified` and no binding is recorded.

## 2. Repository permissions

Set exactly the least-privilege PR-review set (matches `docs/github-app-setup.md`):

| Permission     | Access       | Why |
|----------------|--------------|-----|
| Metadata       | Read-only    | Identify installed repositories (mandatory). |
| Contents       | Read-only    | Fetch and inspect the target head. |
| Pull requests  | Read & write | Read PR metadata and submit App-authored reviews. |
| Checks         | Read-only    | Include CI context in review summaries. |
| Actions        | Read-only    | Read workflow-run context without modifying runs. |

**Issues: leave OFF.** Issue enrichment is a separate, separately-rolled-out
permission with its own allowlist (`docs/github-app-setup.md`). Do not enable
Issues merely because the App reviews PRs.

Organization permissions: none. Account permissions: none.

## 3. Callback URL (post-install redirect)

Because OAuth-during-install is **enabled** (step 1), the post-install browser
return carries an OAuth **`code`** in addition to `installation_id`, `state`, and
`setup_action`; the broker exchanges that code to prove the returning identity
owns the installation before it records any binding (the #614 P1 requirement).
With OAuth-during-install on, GitHub makes the separate **Setup URL** field
**unavailable** — there is exactly one URL to set, and every install/reconfigure
return comes through it. Get it wrong and the broker never receives the install
return (or receives it without a `code` and fails closed with
`installation_authorization_unverified`), so the desktop poll pends until the
state expires.

- **User authorization callback URL (the only URL to set):** the broker return
  route on the license-service host:
  `https://<license-service-host>/github/connect/callback`
  With OAuth-during-install enabled, GitHub redirects here after install with
  `installation_id`, `setup_action`, the `state` the broker placed on the install
  link, and the OAuth `code` — exactly what `GET /github/connect/callback`
  consumes and verifies.
- **Redirect on update (reconfigure):** a reconfigure/update return arrives at the
  same callback URL but is **code-less** (it carries `setup_action` and
  `installation_id`, not a new authorization `code`). The broker acknowledges it
  with the neutral return page and binds nothing, so a legitimate installation
  update is **never locked out** — the existing binding is untouched and the device
  simply keeps polling. Only a code-less return that is *not* a `setup_action`
  update fails closed with `installation_authorization_unverified`.

## 4. Webhook

**Leave the webhook URL blank and uncheck "Active".** v1 has no webhook receiver;
the local worker polls, and the broker discovers uninstall/suspension at the next
token request (`docs/security/github-app-broker.md`, "Failure and abuse states").
A webhook is not required and adding one is a separate design change.

## 5. Device flow

Enable **"Enable Device Flow"** while the current desktop "Connect GitHub" (Repos
pane) path still uses device-flow OAuth (`GitHubDeviceAuthClient.swift`;
`docs/github-app-setup.md` notes GitHub returns `device_flow_disabled` if it is
off). The broker's install/authorize + one-shot-state flow does **not** itself
depend on device flow; this setting is only for the existing desktop path until
#612 migrates it onto the broker.

## 6. Private key and install URL [OWNER-GATED]

1. Generate a private key for the staging App and store the `.pem` **outside any
   repository** (never commit it — secret scanning and `npm run check:secrets`
   reject tracked `.pem`/key files, and committing key material is prohibited
   regardless).
2. Record the numeric **App ID** and the generated **install URL**
   (`https://github.com/apps/<staging-app-slug>/installations/new`).
3. Install the staging App on a small set of **selected** test repositories (at
   least one public and one private, to exercise the pre-#614 fail-closed gate).

## 7. Deployment secrets [OWNER-GATED]

Place the following in the license-service deployment environment (Fly secrets for
the shared `services/license-api` deployment). The broker reads the private key and
the OAuth client secret from this secret store at runtime and never persists, logs,
or returns them. These names are the contract for the future production-wiring step
in `services/license-api/src/http.ts` (`HttpHandlerOptions.githubBroker` →
`createGitHubBrokerService`), read there from the deployment environment; `server.ts`
only starts the listener and today passes no `githubBroker` option and reads no
`GITHUB_BROKER_*` env vars. Until `http.ts` is given `githubBroker`, the shared
license request listener matches every broker path (`isGitHubBrokerPath`) and
returns a typed `{ "reason": "broker_unavailable" }` 503 — a deliberate fail-closed
status, not an unrouted 404:

| Secret                          | Purpose |
|---------------------------------|---------|
| `GITHUB_BROKER_APP_ID`          | Numeric staging App id. |
| `GITHUB_BROKER_PRIVATE_KEY`     | Staging App private key PEM contents. |
| `GITHUB_BROKER_OAUTH_CLIENT_ID`     | Staging App OAuth **client id** ("Request user authorization (OAuth) during installation", step 1). Wires to `githubBroker.oauthClientId`. Required for callback identity verification (#614 P1). |
| `GITHUB_BROKER_OAUTH_CLIENT_SECRET` | Staging App OAuth **client secret**. Wires to `githubBroker.oauthClientSecret`. Used only to exchange the callback `code` for a short-lived user token to confirm installation ownership; never persisted, logged, or returned. |
| `GITHUB_BROKER_INSTALL_BASE_URL`| `https://github.com/apps/<staging-app-slug>/installations/new`. |
| `GITHUB_BROKER_DB_PATH`         | Path for the broker SQLite DB on the mounted volume (separate from `LICENSE_DB_PATH`). |
| `GITHUB_BROKER_API_BASE_URL`    | Optional; defaults to `https://api.github.com`. |
| `GITHUB_BROKER_OAUTH_BASE_URL`  | Optional; OAuth authorization host, defaults to `https://github.com`. Wires to `githubBroker.oauthBaseUrl`. |

Do not reuse the production `LICENSE_ISSUANCE_SECRET` or any production credential
for staging.

## 8. Verification boundary

Registering this staging App proves the broker's install-return and token-issuance
flow against a real App identity. It does **not** create the production App, prove
Marketplace readiness, deploy anything, or satisfy the security review that must
precede production credentials. Keep staging installations, tokens, and evidence
clearly labeled staging, and revoke them per the issue #613 rollback plan when the
staging exercise ends.
