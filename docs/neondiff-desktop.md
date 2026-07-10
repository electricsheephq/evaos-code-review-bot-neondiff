# NeonDiff Desktop Dev MVP

The evaluation-first path from this development shell to a GA-quality native
experience is specified in
[NeonDiff Desktop GA UX Evaluation And Modernization](superpowers/specs/2026-07-10-neondiff-desktop-ga-ux-evaluation.md)
and tracked by issue #514. Evaluation and layout stability land before broad
visual redesign.

NeonDiff Desktop is a SwiftPM macOS app scaffold for issue #115. It is a thin local control panel over the NeonDiff CLI and daemon contracts.
For the 1.0 launch bar, the Mac app is intentionally a minimal launcher:
opening the app shows local controls that can start `neondiff dashboard` or open
the same local HTML dashboard used by the CLI.

## Boundaries

- No review engine runs in the desktop app.
- No UI path posts GitHub reviews directly.
- The Mac launcher implements native setup/status controls only where they can
  write through existing CLI contracts. The local HTML dashboard remains the
  deeper browser-first setup surface.
- No signing, notarization, Sparkle appcast, downloadable artifact, TCC, Mac-control, or customer-control proof is claimed here.
- Provider and license keys are stored in macOS Keychain under a NeonDiff-specific service and are never written to config files.
- Native provider verification starts only from an explicit **Verify API Key** click. The stored provider key is read from Keychain for that operation and sent to the child CLI only through bounded standard input; it never enters argv, process environment, config, command previews, stdout/stderr, logs, screenshots, or evidence.

## Local Commands

```bash
cd apps/neondiff-desktop
swift run NeonDiffDesktopCoreSmoke
swift build
./script/build_and_run.sh build
./script/build_and_run.sh bundle-check
```

`./script/build_and_run.sh` stages a local unsigned `.app` bundle under `apps/neondiff-desktop/dist/` for development only.
Use that unsigned bundle for dev smoke and bundle-resource proof only. Signed,
notarized, appcast, and installed-app visual proof belong to the Mac release
runbook after source behavior is already proven.

## CLI Contract

The desktop uses these JSON-first CLI surfaces:

```bash
neondiff config inspect --config config.local.json
neondiff config patch --config config.local.json --input desktop-patch.json --dry-run true --expected-revision <sha256>
neondiff daemon status --config config.local.json --launchd-label com.example.neondiff
neondiff daemon start --config config.local.json --launchd-label com.example.neondiff --dry-run true
neondiff daemon stop --config config.local.json --launchd-label com.example.neondiff --dry-run true
neondiff dashboard --config config.local.json --launchd-label com.example.neondiff --open true
neondiff providers verify --config config.local.json --provider <saved-provider-id> --expected-config-revision <sha256> --api-key-stdin true --allow-remote-smoke true --json
```

The native Providers pane passes the stored key only on standard input. For a hosted provider, the explicit Verify click is also the user's consent to the bounded remote smoke request; no hosted verification runs automatically. The CLI delegates to the existing hardened provider-smoke implementation and returns a strict redacted envelope. Only an exact successful `healthy` envelope is shown as verified. `configured_unverified` (metadata only) and `blocked` remain visible non-success states, and malformed, contradictory, timed-out, or transport-failed results clear any previous verified state.

The pane maps `providers.defaultProviderId` and the selected saved registry
entry (enabled state, adapter, auth mode, base URL, and model). The legacy
desktop endpoint is not verification authority. Any edit, Preview-only state,
apply in progress, or external revision change disables Verify. A successful
Apply/readback enables it only for an enabled `openai-compatible` +
`api-key-env` target. Context changes cancel the tracked child operation; the
pane remains in `Cancelling…` until the sole process owner closes its pipes,
terminates if needed, and reaps the child. A second verification or config edit
cannot start during that cleanup.

The debug-only `NEONDIFF_DESKTOP_VISUAL_PROOF_FIXTURE=provider-verification` launch fixture bypasses Keychain reads and injects fixed redacted metadata for unsigned screenshot evidence. It makes no provider request and is not compiled into release builds.

The current `run-model-checks.sh` compile harness is temporary proof while this workstation has Command Line Tools but not full Xcode. The long-term test architecture is to install full Xcode, extract `NeonDiffDesktopModel` into an importable `NeonDiffDesktopAppCore` library target, make the app depend on that target, and add a Swift Testing/XCTest target. That architecture and Xcode installation are follow-up work, not part of this Slice B branch.

`config patch` writes only whitelisted non-secret fields, defaults to dry-run, and requires `--confirm true` for live writes. Direct CLI callers may make an intentional confirmation-only write without `--expected-revision`; that path is serialized and re-reads under the writer lock, but it is not bound to an earlier Preview. The native Policy control center always supplies the inspected revision for Preview, Apply, and rollback.
Patch inputs use nested JSON object shape for editable paths. For example, the advertised `zcode.cliPath` path is supplied as `{ "zcode": { "cliPath": "/path/to/neondiff" } }`; flat dotted keys such as `{ "zcode.cliPath": "/path/to/neondiff" }` are rejected to avoid ambiguous profile keys.

The native Policy pane is a bounded configuration control center for daemon
polling, PR review policy, and issue-enrichment policy. It loads current values
through `config inspect`, validates them natively, and requires a successful
dry-run Preview of the exact settings snapshot before Apply is enabled. Apply
uses the CLI's canonical validation and confirmation contract. The app keeps one
in-memory, non-secret baseline so the most recent Apply can be reversed with an
explicit rollback patch; reopening or reloading the app clears that rollback.
All live config patches are serialized so provider, repository, and policy
writes cannot race one another. Inspect uses a retrying stable-snapshot read so
it converges on the fully-old or fully-new file during an in-flight writer.
Preview, Apply, and rollback each carry an immutable settings snapshot and config path,
so edits or target-path changes made while the CLI is running cannot authorize
or relabel a different operation.
The inspect response includes a secret-safe SHA-256 revision token over the
length-delimited file bytes; the token exposes no raw config values. Policy
Preview binds to that revision, and Apply fails closed
if the config changed before the write. A
successful Apply returns the next revision, which becomes the compare-and-swap
guard for the one-shot rollback.

Provider Preview and Apply use that same whitelisted, revision-bound
`config patch` engine: Preview carries the loaded revision, and confirmed Apply
is authorized only for that exact previewed snapshot. The underlying operation
is reversible by applying the previously inspected non-secret provider values
through a new revision-checked patch. The current Providers pane does **not**
offer the Policy pane's one-click in-memory rollback button, so this is
rollback-safe config machinery rather than a claim that a provider rollback UI
or live rollback was exercised in this slice.
The native client accepts patch success only from an `ok=true`, `config patch`
envelope whose lowercase SHA-256 revisions match the requested operation.
Preview additionally requires `dryRun=true` and `wrote=false`; Apply and rollback
require `dryRun=false` plus a typed write result. Malformed, mismatched, failed,
or transport-ambiguous responses clear all loaded, preview, and rollback
authorization until the config is loaded again.
Live `config patch` writers also hold one exclusive sibling lock across stable
read, validation, revision check, temp-file write, and atomic rename. A second
writer fails closed. Every existing sibling lock fails closed; the CLI never
deletes a lock it did not create. The error identifies a live owner when one can
be verified, or reports the exact stale/corrupt lock path for manual recovery.
If an atomic config write commits but owned-lock cleanup fails, the CLI preserves
`ok`, `wrote`, and revision proof and adds an actionable `warning` with the exact
lock path. The native Policy pane surfaces that warning instead of reporting the
committed write as a failure.
Existing config paths are canonicalized through `realpath` before the sibling
lock is chosen, so symlink aliases to the same physical file share one writer
lock.

This concurrency guarantee coordinates NeonDiff `config patch` writers on the
same machine/path. An unrelated editor or external tool does not honor the
sibling lock and can still race the final portable atomic rename. Operators must
close external config editors before Apply; the Policy pane shows this boundary
next to the mutation controls. The revision check rejects external drift
observed before the lock-held pre-commit read, but it does not claim a universal
filesystem transaction against non-participating writers.

If a crash leaves an old, empty, or malformed lock, the CLI keeps failing closed
instead of guessing. Verify that no NeonDiff `config patch`
process is running, resolve the config's canonical path, then remove only its
`<config-realpath>.neondiff.lock` sibling before retrying Load and Preview. A PID
record is a conservative liveness signal, not owner identity: macOS can recycle
PIDs. If the recorded PID is in use, confirm that process is actually the active
NeonDiff config patch before deciding whether the sibling lock is stale.

The PR review allowlist remains `pilotRepos` in the Repos pane. The Policy pane
edits only `issueEnrichment.allowlist` plus bounded review, daemon, cap, lease,
cooldown, burst, and lookback settings. Neither preview nor rollback can alter
provider/license secrets, GitHub tokens, working directories, commands, or the
separate PR review allowlist.

The ZCode defaults in `config.example.json` are developer-machine paths. On any non-author workstation or packaged desktop install, set explicit local values for `zcode.cliPath`, `zcode.appConfigPath`, and `zcode.model` before relying on daemon controls.

## GitHub And Repo Allowlist

The Repos pane shows GitHub App setup state without exposing tokens. The public
GitHub App `clientId` may be stored in config for the desktop/device
authorization flow, while GitHub user access tokens belong in Keychain only.

When `github.clientId` is configured and device flow is enabled in the GitHub
App settings, the Repos pane can start GitHub device authorization, show the
short user code, open GitHub's verification page, store the resulting user token
in Keychain, and list repositories visible through the user's GitHub App
installations. Repository discovery is read-only and uses the standard GitHub
user installation APIs; the desktop never stores the user token in config or
release evidence. If GitHub returns `device_flow_disabled`, enable device flow
on the GitHub App before retrying.

The repo selector persists selected repositories by writing a `pilotRepos` patch
through `config patch`. Discovered repositories are disabled until the user
selects them. It does not post reviews, widen App permissions, or write GitHub
user tokens into config. Live PR reviews still post only through the configured
GitHub App bot identity.

The Repos pane links to the public GitHub App's install/manage page and tells
users to choose `Only select repositories`. It names the core review permissions
and keeps optional Issues access scoped to the separate issue-enrichment feature.
It distinguishes expired user
authorization, API rate limiting, missing App installation, and organization
policy or permission blocks without showing raw API bodies. Discovered repos
show one of these access cues:

- `PUBLIC · FREE` for the public-repo path;
- `PRIVATE · LICENSE REQUIRED` until active entitlement is proven;
- `PRIVATE · LICENSE ACTIVE` only for an explicit active entitlement state;
- `INSUFFICIENT READ ACCESS` when GitHub reports that the user cannot read the
  repository.

A stored license key is not treated as active entitlement. Repo selection still
writes only the local allowlist; the worker's pre-checkout license and GitHub App
gates remain authoritative for review execution.

## Local Dashboard Launcher

The dev app no longer opens a browser tab automatically. It exposes explicit
controls to start the same local dashboard server without opening a browser, or
to open the browser dashboard when the user chooses it:

```bash
neondiff dashboard --config config.local.json --launchd-label com.electricsheephq.evaos-code-review-bot --open false
neondiff dashboard --config config.local.json --launchd-label com.electricsheephq.evaos-code-review-bot --open true
```

The dashboard remains the deeper browser-first setup and readiness surface for
license status, GitHub App status, daemon status, and provider readiness. The
Swift Providers pane now also offers the explicit, Keychain-backed verification
action described above and retains only its redacted result metadata. Neither
surface proves signed/notarized distribution, Sparkle/appcast delivery,
browser/native parity, customer readiness, or v1.1 release completion.
