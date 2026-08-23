# macOS LaunchAgent boundary

Signed Desktop `1.1.0` owns Mac first run. After App/provider/activation/App
access verification, it validates the signed app and sealed worker, then
installs a secret-free LaunchAgent. Keychain secrets cross bounded stdin only;
new plists contain public coordinates and the signed app path, never key values,
key paths, or `EnvironmentVariables`. Enabled Codex uses the existing CLI session
without NeonDiff reading OAuth material. Managed App/broker is post-GA/outside BYO.
See the [Mac GA architecture contract](architecture/mac-ga-release-contract.md)
and [Desktop Mac release runbook](../apps/neondiff-desktop/docs/mac-release-runbook.md).
This page does not claim Mac GA completion.

## Native Desktop path

Use the Desktop UI for first-run setup, dry-run approval, and **Install & Start**.
Do not hand-edit the plist, export credentials, or replace the sealed worker
with a global or customer-writable executable. A signed app, Keychain identity,
worker identity, config revision, and selected LaunchAgent label must all match;
ambiguous or missing evidence fails closed.

## Legacy CLI/operator path

The following environment-backed examples are retained only for existing CLI or
operator workers, including legacy Mac installations. They are not instructions
for the native Desktop customer journey.

Recommended first live command:

```bash
cd /path/to/neondiff
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
npm run run-once -- --config /absolute/path/to/config.local.json --dry-run true --repo owner/repo --pr 123
```

After the GitHub App is installed, use app credentials and keep `--dry-run true` for the first observation window:

```bash
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
npm run daemon -- --config /absolute/path/to/config.local.json --dry-run true
```

When installed as a LaunchAgent, write stdout/stderr to a user-owned local log
directory such as `~/Library/Logs/neondiff/`. Keep operator logs outside the
repository and redact them before sharing.

Set `NODE_OPTIONS=--use-system-ca` in the LaunchAgent environment. Without this
flag, launchd-started Node processes may fail GitHub App installation reads with
`unable to verify the first certificate` even while the same CLI commands work
from an interactive shell. `release:status` reports the loaded launchd
environment and fails when launchd explicitly omits this option.

Minimum legacy LaunchAgent environment block:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>NEONDIFF_GITHUB_APP_ID</key>
  <string>&lt;github-app-id&gt;</string>
  <key>NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH</key>
  <string>/absolute/path/to/neondiff.private-key.pem</string>
  <key>NODE_OPTIONS</key>
  <string>--use-system-ca</string>
</dict>
```

Only switch to `--dry-run false` after:

- current-head duplicate reruns post nothing,
- review-plan JSON contains only valid current-diff lines,
- no secret-like text appears in comments or logs,
- ZCode worktrees stay clean after runs,
- GLM/Z.ai rate limits are not firing,
- `npm run doctor` reports `readMode: "app_installation"` and successful read checks for every pilot repo.

## Supported Stop And Start Recovery

Use the JSON-first CLI instead of choosing `bootstrap` or `kickstart` from
plist existence alone. The executable stop/start sequence and confirmation
requirements live in [the operator CLI guide](operator-cli.md#common-operator-flows).

For a legacy customer-owned worker update, do not edit `ProgramArguments`,
`WorkingDirectory`, or credential environment entries by hand. Use the
checksum-bound worker bundle from the same immutable GitHub prerelease as the
app, as described in
[SETUP.md](SETUP.md#update-an-existing-local-worker). Its installer validates
the existing NeonDiff invocation, preserves the label and environment, stages a
versioned user-owned worker, and changes the plist atomically only after
`--dry-run false --confirm true`. If the LaunchAgent was loaded it is restarted;
an unloaded service stays unloaded. The paired rollback command restores the
previous worker or the original invocation without deleting customer state.

After `bootout`, the plist normally remains at
`~/Library/LaunchAgents/<label>.plist` while the service is absent from the
launchd domain. `daemon start` detects that state, plans `bootstrap` followed by
`kickstart -k`, and reports `launchdLoaded: false`. When the service is already
loaded it plans only `kickstart -k`. Dry-run start performs only the read-only
`launchctl print gui/<uid>/<label>` probe needed to distinguish those states;
an ambiguous probe failure is reported fail-closed and no mutation is planned.
Confirmed start accepts a concurrent bootstrap race only when bootstrap reports
an explicit already-loaded signature and a follow-up print proves the service
is loaded; unrelated bootstrap errors remain failures.
If the plist is elsewhere, add its exact
operator-owned path with `--plist`; an external path still requires
`--allow-external-plist true` for confirmed mutation.

After a confirmed start, verify a new PID and a current heartbeat with `daemon
status` or `runtime-inventory`. A plist on disk, `RunAtLoad`, or `KeepAlive`
alone is not proof that the service is registered or healthy.
