# Mac GA Release Contract

This contract is the source of truth for native NeonDiff Desktop GA. The
native Desktop line is `v1.1.0`; the npm CLI line is independently `1.0.4`.
Neither line may borrow the other line's tag, registry channel, or runtime
proof.

## Accepted artifact boundary

The operations Mac never builds, signs, notarizes, or selects release bytes.
An off-Mac candidate pipeline produces one accepted packet containing:

- the immutable `.app` bundle and SHA-256 bundle digest;
- signing verification, notarization, stapling, and Gatekeeper evidence;
- the exact sealed worker executable identity and LaunchAgent contract;
- the operator-approved config path, launchd label, and Keychain mode;
- CI/review receipts, a unique digest-named evidence directory, and the
  last-known-good packet for rollback.

Promotion accepts only that packet's digest and path. A checkout, source SHA,
local `npm run build`, or `git reset` is not proof of installed Desktop bytes.
The staged bundle must hash to the accepted digest before any launchd mutation.

## Runtime and service contract

The sealed wrapper is
`/Applications/NeonDiff.app/Contents/MacOS/NeonDiffDesktop`; it launches the
sealed helper `Contents/Helpers/NeonDiffWorker` in worker daemon mode. The
packet carries both identities and their digests. The plist has the expected label
`com.electricsheephq.evaos-code-review-bot`, exactly ten ordered
`ProgramArguments`, the stored App/device values in their two argument slots,
and no `EnvironmentVariables` or unexpected top-level keys. The complete
contract is validated from parsed plist data before bootout, bootstrap, or
kickstart. The runtime config remains operator-supplied and account-scoped.

Promotion stages and verifies the accepted bytes, then waits for a natural
cycle boundary (finish current work and stop new admissions) before the single
service transition. It verifies the running bundle and worker digest after the
transition. No-downtime means no DB deletion, queue rewrite, or Keychain
replacement; the existing state and credentials remain in place.

## Containment and rollback

Emergency stop is an independent, exact-path/label operation. It must remain
available when checkout, config, evidence, or runtime health is broken.

Rollback captures current status as advisory, then validates the last-known-good
immutable signed/notarized/stapled packet without requiring current worker
health. It stages that packet, verifies its digest and complete plist contract,
and changes the service only at a natural boundary. Missing or mismatched
targets fail closed before launchd. BYO and managed credentials/configuration
remain separate, and rollback never changes customer data or Keychain state.

## Evidence and ownership

Every promotion and rollback receives a unique immutable packet directory under
`/Users/m1/Codex/evidence/neondiff/`; an existing digest directory is never
overwritten. Release governance owns version/tag identity; the operator owns
packet acceptance and launchd execution. These docs do not claim that a PR,
CI result, signed artifact, or staged bundle proves deployed, fleet, or
customer readiness.
