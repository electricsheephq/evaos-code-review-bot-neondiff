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
: "${NEONDIFF_LEGACY_STATE_DB:?copy statePath from that config}"
: "${NEONDIFF_LAUNCHD_LABEL:?set the exact plist Label}"
for path in "$NEONDIFF_OPERATOR_CHECKOUT" "$NEONDIFF_OPERATOR_EVIDENCE_ROOT" \
  "$NEONDIFF_LEGACY_CONFIG_PATH" "$NEONDIFF_LEGACY_STATE_DB"; do
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
cd "$NEONDIFF_OPERATOR_CHECKOUT"
export NEONDIFF_OPERATOR_CHECKOUT NEONDIFF_OPERATOR_EVIDENCE_ROOT \
  NEONDIFF_LEGACY_CONFIG_PATH NEONDIFF_LEGACY_STATE_DB NEONDIFF_LAUNCHD_LABEL
```

Do not silently substitute another checkout, config, database, or evidence
root when a coordinate is missing. The config may remain outside the native
Desktop tree because this legacy path has no account/bot identity derived from
its filesystem location.

## Legacy CLI commands

Run read-only checks against the exact legacy config:

```bash
npx tsx src/cli.ts config inspect --config "$NEONDIFF_LEGACY_CONFIG_PATH"
npx tsx src/cli.ts status --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL"
npx tsx src/cli.ts runtime-inventory --json --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL"
npx tsx src/cli.ts daemon status --config "$NEONDIFF_LEGACY_CONFIG_PATH" --launchd-label "$NEONDIFF_LAUNCHD_LABEL" --state-path "$NEONDIFF_LEGACY_STATE_DB"
```

`daemon start|stop` is launchd control, not the raw daemon loop. It defaults to
dry-run; confirmed mutation requires `--dry-run false --confirm true`. When the
verified plist is outside the package root, confirmed `--plist` use also needs
`--allow-external-plist true`. The CLI checks the plist label before planning
and fails closed on an ambiguous launchd state. Runtime credentials are
accepted only through the existing bounded stdin contract for the raw daemon;
never add them to config, argv, notes, or evidence.

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
- A source-managed worker points at a source checkout (`dist/src/cli.js` or
  `src/cli.ts`) and is not updated by the candidate installer.

For a managed candidate, use the existing installer with immutable absolute
manifest and tarball paths. Preview first, then repeat the exact command only
after its digest and state plan are approved:

```bash
for path in "$NEONDIFF_CANDIDATE_MANIFEST" "$NEONDIFF_CANDIDATE_TARBALL"; do
  case "$path" in /*) ;; *) echo "candidate artifacts must be absolute" >&2; exit 1 ;; esac
done
test -f "$NEONDIFF_CANDIDATE_MANIFEST" && test -f "$NEONDIFF_CANDIDATE_TARBALL"
node scripts/install-b0-worker-candidate.mjs update \
  --manifest "$NEONDIFF_CANDIDATE_MANIFEST" \
  --manifest-sha256 <manifest-sha256> \
  --tarball "$NEONDIFF_CANDIDATE_TARBALL" \
  --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run true
node scripts/install-b0-worker-candidate.mjs update \
  --manifest "$NEONDIFF_CANDIDATE_MANIFEST" \
  --manifest-sha256 <manifest-sha256> \
  --tarball "$NEONDIFF_CANDIDATE_TARBALL" \
  --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run false --confirm true
```

Rollback uses the recorded prior manifest and tarball through the same
preview-then-confirm contract; re-update repeats `update` with the retained
current candidate after rollback:

```bash
for path in "$NEONDIFF_PRIOR_MANIFEST" "$NEONDIFF_PRIOR_TARBALL"; do
  case "$path" in /*) ;; *) echo "prior artifacts must be absolute" >&2; exit 1 ;; esac
  test -f "$path" || exit 1
done
node scripts/install-b0-worker-candidate.mjs rollback \
  --manifest "$NEONDIFF_PRIOR_MANIFEST" --manifest-sha256 <prior-manifest-sha256> \
  --tarball "$NEONDIFF_PRIOR_TARBALL" --launchd-label "$NEONDIFF_LAUNCHD_LABEL" \
  --dry-run true
# After approving the preview, repeat it with --dry-run false --confirm true.
node scripts/install-b0-worker-candidate.mjs update \
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
