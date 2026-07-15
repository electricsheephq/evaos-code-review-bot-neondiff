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
3. Leave "Request user authorization (OAuth) during installation" unchecked for
   the install/authorize broker flow (the broker binds via installation id +
   one-shot state, not a user OAuth token).

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

## 3. Callback and setup URLs

- **Callback URL:** the broker callback route on the license-service host:
  `https://<license-service-host>/github/connect/callback`
  (GitHub appends `installation_id` and the `state` the broker issued). This is
  the only redirect the broker consumes.
- **Setup URL:** may be left unset, or point to the same callback; the broker
  treats the install return purely via the callback route.
- **"Redirect on update":** enabled, so re-configuring the installation returns
  through the same callback.

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
the shared `services/license-api` deployment). The broker reads the private key
from this secret store at runtime and never persists, logs, or returns it. These
names are the contract for the future production-wiring step in `server.ts`
(currently the broker is omitted from `server.ts` until the App exists, so broker
routes return 503):

| Secret                          | Purpose |
|---------------------------------|---------|
| `GITHUB_BROKER_APP_ID`          | Numeric staging App id. |
| `GITHUB_BROKER_PRIVATE_KEY`     | Staging App private key PEM contents. |
| `GITHUB_BROKER_INSTALL_BASE_URL`| `https://github.com/apps/<staging-app-slug>/installations/new`. |
| `GITHUB_BROKER_DB_PATH`         | Path for the broker SQLite DB on the mounted volume (separate from `LICENSE_DB_PATH`). |
| `GITHUB_BROKER_API_BASE_URL`    | Optional; defaults to `https://api.github.com`. |

Do not reuse the production `LICENSE_ISSUANCE_SECRET` or any production credential
for staging.

## 8. Verification boundary

Registering this staging App proves the broker's install-return and token-issuance
flow against a real App identity. It does **not** create the production App, prove
Marketplace readiness, deploy anything, or satisfy the security review that must
precede production credentials. Keep staging installations, tokens, and evidence
clearly labeled staging, and revoke them per the issue #613 rollback plan when the
staging exercise ends.
