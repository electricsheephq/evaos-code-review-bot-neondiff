# Issue 488 Slice B: Keychain-backed Provider Verification

## Goal

Add one explicit native **Verify API Key** action that reads the existing provider secret from macOS Keychain, verifies the configured provider through NeonDiff's existing hardened provider-smoke path, and shows only redacted pass/fail metadata. This closes the remaining provider-verification acceptance criterion in #488 without broadening provider-adapter, daemon, signing, release, or browser/native-parity scope.

## Chosen Architecture

The native app reads the Keychain item only after the user clicks Verify. It sends the secret to a new `providers verify` CLI command over the child process's standard input. The command bounds and consumes stdin, calls the existing `verifyProviderApiKey` implementation, and prints a redacted JSON envelope. The native app parses that envelope and immediately drops its local secret value.

Standard input is the only secret transport. The raw key must never appear in argv, process environment, config files, command previews, stdout/stderr, application logs, screenshots, or evidence artifacts.

Rejected alternatives:

- Environment injection exposes the key through child-process environment and creates another secret-bearing execution surface.
- Posting to the loopback dashboard route makes verification depend on dashboard server lifecycle and duplicates native error handling around an optional process.
- Reimplementing the provider HTTP check in Swift would fork the existing SSRF, redirect, timeout, response-bound, schema, and redaction policy.

## CLI Contract

`neondiff providers verify --config <path> --api-key-stdin true --allow-remote-smoke true --json`

- `--api-key-stdin true` is mandatory for submitted-key verification. Stdin is bounded before decoding and trimmed once.
- `--provider <id>` remains optional; omission uses the configured default provider.
- `--allow-remote-smoke true` is explicit user consent for a hosted `/models` request. Loopback providers do not need remote consent, but the native Verify action may pass it because the button click is the consent event.
- The command delegates to `verifyProviderApiKey`; it does not add a second provider transport.
- Success and failure output is a structured, redacted envelope with command, provider ID, checked time, state, mode, detail, optional redacted check metadata, and troubleshooting.
- The command exits nonzero when verification does not prove health. Metadata-only `configured_unverified` remains a visible non-success result and is never promoted to verified.
- Stdin read, parse, launch, timeout, and provider failures must not echo the key or raw response bodies.

## Native Contract

The Providers pane gains a **Verify API Key** button and a compact verification result card.

- The action is disabled while verification is running or when no Keychain item is stored.
- Clicking Verify performs an interactive Keychain read, constructs the non-secret command arguments, and passes the key only as standard input.
- UI state contains redacted verification metadata only. It never stores the key beyond the local operation scope.
- Malformed JSON, wrong command, nonzero exit, timeout, missing CLI, missing Keychain item, or transport error clears any previous verified state and shows a redacted actionable failure.
- The UI distinguishes `healthy`, `configured_unverified`, and `blocked`; only `healthy` is a verified pass.
- Command preview/copy surfaces omit all secret material and show stdin as an abstract secure-input requirement, not a value.

## Testing And Proof

- TypeScript tests cover bounded stdin, default/explicit provider selection, explicit remote consent, redacted success/failure output, and no secret text in serialized results.
- Swift core checks cover standard-input process plumbing and strict verification-envelope parsing.
- Keychain-backed model tests use an in-memory secret store and fake CLI client; they prove the secret is supplied only as stdin and absent from arguments, logs, errors, and retained state.
- Secret and public-claims scans remain green.
- An unsigned full-pane app smoke shows every configuration section plus the Verify action and a redacted fixture result. No real provider key or hosted request is used for screenshot evidence.

## Stop Conditions

- No raw secret may cross argv, environment, config, logs, screenshots, or evidence.
- No verification result may be treated as healthy without an exact successful structured envelope.
- No live daemon/review/issue-posting state is changed.
- This slice does not claim signed/notarized distribution, Sparkle/appcast, browser/native parity, customer readiness, or v1.1 release completion.
