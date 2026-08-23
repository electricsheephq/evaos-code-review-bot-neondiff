# Legacy CLI/operator boundary

This is the CLI-first and legacy LaunchAgent contract. It is separate from the
native Desktop account/bot path. A legacy plist may use an arbitrary absolute
config path; do not replace it with a guessed Desktop path, a repository
default, or a mounted-volume fallback.

## Establish the operator coordinates

Read the exact `Label`, `WorkingDirectory`, `ProgramArguments`, and
`EnvironmentVariables` from the verified operator-owned plist. The one
`ProgramArguments` value immediately after `--config` is the legacy config
coordinate. `statePath` and `evidenceDir` are read from that config; they are
not inferred from the plist label or checkout name. Keep private-key values out
of notes and evidence; only the absolute credential-file coordinate may be
recorded.

Use an absolute checkout and a separate absolute evidence root for every
reproducible operator capture:

```bash
: "${HOME:?HOME is required}"
: "${NEONDIFF_OPERATOR_CHECKOUT:?set the absolute operator checkout}"
: "${NEONDIFF_OPERATOR_EVIDENCE_ROOT:?set an absolute evidence root}"
: "${NEONDIFF_LEGACY_CONFIG_PATH:?copy the absolute --config operand from the verified plist}"
: "${NEONDIFF_LAUNCHD_LABEL:?set the exact plist Label}"
for path in "$NEONDIFF_OPERATOR_CHECKOUT" "$NEONDIFF_OPERATOR_EVIDENCE_ROOT" \
  "$NEONDIFF_LEGACY_CONFIG_PATH"; do
  case "$path" in /*) ;; *) echo "operator paths must be absolute" >&2; exit 1 ;; esac
done
test -f "$NEONDIFF_LEGACY_CONFIG_PATH"
NEONDIFF_OPERATOR_CHECKOUT="$(cd "$NEONDIFF_OPERATOR_CHECKOUT" && pwd -P)"
NEONDIFF_OPERATOR_EVIDENCE_ROOT="$(cd "$NEONDIFF_OPERATOR_EVIDENCE_ROOT" && pwd -P)"
CHECKOUT_TOP="$(git -C "$NEONDIFF_OPERATOR_CHECKOUT" rev-parse --show-toplevel)"
test "$CHECKOUT_TOP" = "$NEONDIFF_OPERATOR_CHECKOUT"
case "$NEONDIFF_OPERATOR_EVIDENCE_ROOT/" in
  "$NEONDIFF_OPERATOR_CHECKOUT/"*) echo "evidence must be outside checkout" >&2; exit 1 ;;
esac
case "$NEONDIFF_OPERATOR_CHECKOUT/" in
  "$NEONDIFF_OPERATOR_EVIDENCE_ROOT/"*) echo "evidence must not contain checkout" >&2; exit 1 ;;
esac
cd "$NEONDIFF_OPERATOR_CHECKOUT"
export NEONDIFF_OPERATOR_CHECKOUT NEONDIFF_OPERATOR_EVIDENCE_ROOT \
  NEONDIFF_LEGACY_CONFIG_PATH NEONDIFF_LEGACY_STATE_DB NEONDIFF_LAUNCHD_LABEL
```

Do not silently substitute another checkout, config, database, or evidence
root when a coordinate is missing. The config may remain outside the native
Desktop tree because this legacy path has no account/bot identity derived from
its filesystem location.

## Legacy CLI commands

Inspect the effective config first so an omitted `statePath` resolves through
the supported defaults, then run read-only checks against that exact state:

```bash
INSPECT_JSON="$(npx tsx src/cli.ts config inspect --config "$NEONDIFF_LEGACY_CONFIG_PATH")"
NEONDIFF_LEGACY_STATE_DB="$(printf '%s' "$INSPECT_JSON" | jq -er '.config.statePath')"
case "$NEONDIFF_LEGACY_STATE_DB" in /*) ;; *) echo "effective statePath must be absolute" >&2; exit 1 ;; esac
npx tsx src/cli.ts status --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL"
npx tsx src/cli.ts runtime-inventory --json --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL"
npx tsx src/cli.ts daemon status --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL" --state-path "$NEONDIFF_LEGACY_STATE_DB"
```

`daemon start|stop` is launchd control, not the raw daemon loop. It defaults to
dry-run; confirmed mutation requires `--dry-run false --confirm true`. When the
verified plist is outside the package root, confirmed `--plist` use also needs
`--allow-external-plist true`. The CLI checks the plist label before planning
and fails closed on an ambiguous launchd state. Runtime credentials are
accepted only through the bounded stdin contract for the raw daemon's GitHub
App/license envelope. An `api-key-env` provider instead reads its process
environment; redact every credential-valued environment entry from notes and
evidence, and never copy it into config or argv.

## Native Desktop is a different coordinate system

Native Desktop owns account/bot-scoped config at:

```text
$HOME/Library/Application Support/NeonDiffDesktop/Accounts/<account>/Bots/<bot>/config.local.json
```

Its bot-isolated runtime, state database, evidence, license paths, Keychain
identity, and allowlist are kept with that selected account/bot. The
`Accounts/_unselected` placeholder is not a runnable bot. Native worker
artifacts are under the selected label's Desktop `Workers` root. A legacy
plist's arbitrary absolute config path is not evidence of native account or
bot ownership, and native onboarding must not adopt it by path coincidence.
The native database is the selected bot's `reviews.sqlite`; it is never derived
from a legacy plist's `statePath`.

## Managed candidate versus source-managed worker

Classify the verified plist before changing bytes:

- A managed candidate has an absolute Node executable and an argument prefix
  ending in `Workers/<label>/current/node_modules/neondiff/dist/src/cli.js`.
- A package-installed legacy worker starts with a `neondiff` executable and is
  eligible for its first checksum-managed migration through `update`.
- A source-managed worker points at a source checkout (`dist/src/cli.js` or
  `src/cli.ts`) and is not updated by the candidate installer.

For a managed candidate or first package-installed migration, use the installer
from the checksum-verified extracted bundle with its immutable manifest and
tarball. Preview first, then repeat only after its state plan is approved:

```bash
for path in "$NEONDIFF_CANDIDATE_INSTALLER" "$NEONDIFF_CANDIDATE_MANIFEST" "$NEONDIFF_CANDIDATE_TARBALL"; do
  case "$path" in /*) ;; *) echo "candidate artifacts must be absolute" >&2; exit 1 ;; esac
done
test -f "$NEONDIFF_CANDIDATE_INSTALLER" && test -f "$NEONDIFF_CANDIDATE_MANIFEST" && test -f "$NEONDIFF_CANDIDATE_TARBALL"
node "$NEONDIFF_CANDIDATE_INSTALLER" update \
  --manifest "$NEONDIFF_CANDIDATE_MANIFEST" \
  --manifest-sha256 <manifest-sha256> \
  --tarball "$NEONDIFF_CANDIDATE_TARBALL" \
  --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run true
node "$NEONDIFF_CANDIDATE_INSTALLER" update \
  --manifest "$NEONDIFF_CANDIDATE_MANIFEST" \
  --manifest-sha256 <manifest-sha256> \
  --tarball "$NEONDIFF_CANDIDATE_TARBALL" \
  --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run false --confirm true
```

Rollback uses the recorded prior bundle through the same preview-then-confirm
contract; re-update toggles back through `rollback` with the retained current
candidate after rollback:

```bash
for path in "$NEONDIFF_PRIOR_INSTALLER" "$NEONDIFF_PRIOR_MANIFEST" "$NEONDIFF_PRIOR_TARBALL"; do
  case "$path" in /*) ;; *) echo "prior artifacts must be absolute" >&2; exit 1 ;; esac
  test -f "$path" || exit 1
done
node "$NEONDIFF_PRIOR_INSTALLER" rollback \
  --manifest "$NEONDIFF_PRIOR_MANIFEST" --manifest-sha256 <prior-manifest-sha256> \
  --tarball "$NEONDIFF_PRIOR_TARBALL" --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run true
# After approving the preview, repeat it with --dry-run false --confirm true.
node "$NEONDIFF_CANDIDATE_INSTALLER" rollback \
  --manifest "$NEONDIFF_CANDIDATE_MANIFEST" --manifest-sha256 <current-manifest-sha256> \
  --tarball "$NEONDIFF_CANDIDATE_TARBALL" --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run true
# After approving the re-update preview, repeat it with --dry-run false --confirm true.
```

Rollback preserves the legacy config and its
`statePath` database, allowlist, launchd label, credential/Keychain references,
and one worker pair; it does not reset a source checkout or copy secret bytes.
The candidate installer does not update the signed Desktop app or native
account/bot state. For a source-managed plist, follow the separately approved
source release procedure; do not claim that candidate update/rollback changed
the source-managed worker.

See [operator-cli.md](operator-cli.md) for the command reference and safety
defaults. This document proves only a reviewable operator contract; it does
not prove installation, release, runtime, fleet, customer, or GA readiness.
