# NeonDiff Desktop 1.1.0 — signing & notarization credential policy

Canonical names, custody, and CI-injection rules for every credential in the
Desktop signing/notarization/auto-update chain. **This file contains no secret
values and no real fingerprints — only names and policy.** The accepted Desktop
declaration/index and content-addressed accepted packet remain authoritative for
release identity; credential state never replaces either one.

Two invariants govern everything below:

1. **Public keys are committed; private keys never touch the repo.** The Sparkle
   *public* EdDSA key ships in the app's `Info.plist` (`SUPublicEDKey`) and may be
   committed/published freely. Every *private* key, certificate, password, and API
   key is owner-custody or CI-injected — it is never committed, printed, or logged.
2. **Presence is checked, values are not disclosed.** `script/preflight-credentials.sh`
   reports each credential as `present` / `missing` / `invalid` and never prints
   a secret value. It signs and notarizes nothing; those remain owner-authorized
   release actions.

Run the doctor anytime (it mutates nothing):

```sh
apps/neondiff-desktop/script/preflight-credentials.sh          # human table
apps/neondiff-desktop/script/preflight-credentials.sh --json   # machine-readable
```

Exit `0` = all required credentials present; non-zero lists exactly what is missing.

## Release identity and package gate

Before an RC or stable signing action, resolve the accepted Desktop declaration,
exact source/package identity, and logical credential profile. Construction does
not consume the final accepted promotion packet: artifact verification and the
required real tests supply that packet afterward. RC and stable require a distinct annotated tag object whose
annotation contains exactly one line:

```text
NeonDiff-Release-Class: desktop-only
```

The RC product channel remains `rc`, even though its retained Sparkle enclosure
and enclosure proof use the observed `beta` feed ring. Stable uses the `stable`
feed ring. Construction must agree with the declaration's tag, peeled source,
package, channel, and intended feed identity. After construction, verify the
actual artifact and tree; before promotion, require the complete accepted packet
and agreement of all artifact, tree, attestation, and feed identities.

Issue #559 must first publish and provenance-bind immutable `neondiff@1.0.5`.
The release manager must read back its exact manifest, tarball, CLI, worker,
integrity, provenance, and source identity before declaring, signing, or
notarizing a Desktop candidate. Credential presence cannot bypass this gate.
The Desktop-only npm no-op is valid only after that package identity is
reconciled; the tag marker alone does not prove unchanged CLI/worker bytes.

A redundant `release-candidate` alias resolving to the same verified `1.0.5`
does not block private staging or construction. It does not satisfy #559's
strict typed closure, which remains required before public GA.

Executable update, rollback, identical-byte re-update, feed/publication, and
local-adoption commands remain blocked until #895 reaches `source-accepted`.
Manual copy, source reset, rebuild, LaunchAgent restart, or ad hoc feed mutation
is not a supported substitute.

---

## Credential classes

### 1. Developer ID Application certificate (code signing)

Signs the `.app` bundle with the team's Developer ID so Gatekeeper trusts it.

| GitHub Actions secret               | What it is                                                        | Custody        |
| ----------------------------------- | ----------------------------------------------------------------- | -------------- |
| `APPLE_DEVELOPER_ID_CERT_P12_BASE64`| Base64 of the exported Developer ID Application cert + private key (`.p12`) | CI-injected    |
| `APPLE_DEVELOPER_ID_CERT_PASSWORD`  | Password protecting that `.p12` export                            | CI-injected    |

- **CI import:** decode the base64 to a `.p12`, then
  `security import` it into a throwaway CI keychain unlocked for the signing step.
- **Local/owner:** the cert lives in the login keychain; the doctor probes it with
  `security find-identity -v -p codesigning` and reports the identity **name** only
  (e.g. `Developer ID Application: <Team> (<TEAMID>)`) — never the private key.
- **Required:** yes. Missing → doctor exits non-zero (`developer_id_application`).

### 2. Notarization credentials

Submits the signed bundle to Apple's notary service (`xcrun notarytool`). Two
supported paths — either satisfies the check:

**(a) App Store Connect API key — the CI path.**

| GitHub Actions secret          | What it is                                              | Custody     |
| ------------------------------ | ------------------------------------------------------ | ----------- |
| `APPLE_NOTARY_API_KEY_ID`      | ASC API key ID (the `-p8` key's short id)              | CI-injected |
| `APPLE_NOTARY_API_ISSUER_ID`   | ASC API issuer id (the team's issuer UUID)             | CI-injected |
| `APPLE_NOTARY_API_KEY_BASE64`  | Base64 of the `AuthKey_<id>.p8` private key file       | CI-injected |

  The doctor reads the equivalent env at runtime as
  `NEONDIFF_NOTARY_API_KEY_ID`, `NEONDIFF_NOTARY_API_ISSUER_ID`, and one of
  `NEONDIFF_NOTARY_API_KEY_PATH` / `NEONDIFF_NOTARY_API_KEY_BASE64` — map the CI
  secrets onto these in the workflow `env:`.

**(b) notarytool keychain profile — the local/owner path.**

  Created once with `xcrun notarytool store-credentials <profile-name>`. The doctor
  probes the profile named by `NEONDIFF_NOTARY_KEYCHAIN_PROFILE` (default
  `neondiff-notary`) via a read-only `notarytool history` call — it submits nothing.

- **Required:** yes. Missing both paths → doctor exits non-zero (`notarization`).
  A stored-but-unauthenticated profile is reported `invalid` (rotate/re-store).

### 3. Sparkle EdDSA appcast-signing keys (auto-update)

Sparkle signs each appcast/update with an EdDSA key so clients verify authenticity
against the `SUPublicEDKey` baked into the app.

| Name                              | What it is                                          | Custody              | Committed? |
| --------------------------------- | --------------------------------------------------- | -------------------- | ---------- |
| `SPARKLE_ED_PRIVATE_KEY`          | EdDSA **private** key that signs appcasts (`sign_update`) | Owner-custody / CI-injected | **Never** |
| `SUPublicEDKey` (Info.plist)      | EdDSA **public** key clients verify against         | in-repo build config | **Yes**    |
| `NEONDIFF_SPARKLE_PUBLIC_ED_KEY`  | Build-time env the build script injects as `SUPublicEDKey` | build config       | value is public |
| `NEONDIFF_SPARKLE_FEED_URL`       | Appcast feed URL injected as `SUFeedURL`            | build config         | value is public |

- **Private key custody:** generated once by Sparkle's `generate_keys` (stored in
  the login keychain) or supplied to CI via `SPARKLE_ED_PRIVATE_KEY`. The doctor
  reports only whether it is *reachable* — never the key.
- **Public key / feed:** injected by `script/build_and_run.sh`, which already reads
  `NEONDIFF_SPARKLE_PUBLIC_ED_KEY` and `NEONDIFF_SPARKLE_FEED_URL` and writes
  `SUPublicEDKey` / `SUFeedURL` into `Info.plist`. Absent → the app ships with
  Sparkle **off** (a valid dev-build state; the private-key check remains the hard
  gate, the public-key check is advisory/non-required).
- **Appcast generation:** channel fixtures, rollback behavior, and dry-run XML
  generation are documented in `appcast-channels.md`. Real signing and hosting
  remain a separate owner-authorized release step.

---

## Rotation

Rotate on any suspected exposure and on the team's regular cadence:

- **Developer ID cert:** re-issue in the Apple Developer portal, re-export the
  `.p12`, and update `APPLE_DEVELOPER_ID_CERT_P12_BASE64` / `_PASSWORD`.
- **ASC API key:** revoke the old key in App Store Connect, mint a new one, and
  update `APPLE_NOTARY_API_KEY_ID` / `_ISSUER_ID` / `_KEY_BASE64`.
- **Sparkle EdDSA key:** rotating the **private** key means the **public**
  `SUPublicEDKey` must be updated in `Info.plist` in the *same* release, or clients
  will reject the newly-signed appcast. Ship both together.

After any rotation, run `preflight-credentials.sh` in the target environment to
confirm the new credential resolves before relying on it.

---

## Boundary

This doc and the doctor **report credential presence only**. They do not sign,
notarize, upload, or fetch anything, print no secret values, and touch no
review-pipeline surface. Actual signing/notarization remains part of the #610
release path; the signed updater outcome is owned by #116 and the sole
transition implementation by #895.
