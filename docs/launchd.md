# Launchd Pilot

Launchd should stay disabled until GitHub App installation is complete and a real ZCode dry-run succeeds without rate limiting.

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

When installed as a LaunchAgent, write stdout/stderr to `~/Library/Logs/evaos-code-review-bot/`. On this Mac, launchd failed with `EX_CONFIG` when those paths pointed directly at the Lexar volume; copy the local launch logs into the Lexar evidence packet after each proof window.

Set `NODE_OPTIONS=--use-system-ca` in the LaunchAgent environment. Without this
flag, launchd-started Node processes may fail GitHub App installation reads with
`unable to verify the first certificate` even while the same CLI commands work
from an interactive shell. `release:status` reports the loaded launchd
environment and fails when launchd explicitly omits this option.

Minimum LaunchAgent environment block:

```xml
<key>EnvironmentVariables</key>
<dict>
  <key>NEONDIFF_GITHUB_APP_ID</key>
  <string>&lt;github-app-id&gt;</string>
  <key>NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH</key>
  <string>/absolute/path/to/neondiff.private-key.pem</string>
  <key>NODE_OPTIONS</key>
  <string>--use-system-ca</string>
  <key>NEONDIFF_LAUNCHD_STDOUT_PATH</key>
  <string>/Users/your-user/Library/Logs/evaos-code-review-bot/launchd.out.log</string>
  <key>NEONDIFF_LAUNCHD_STDERR_PATH</key>
  <string>/Users/your-user/Library/Logs/evaos-code-review-bot/launchd.err.log</string>
  <key>NEONDIFF_LAUNCHD_LOG_MAX_BYTES</key>
  <string>10485760</string>
  <key>NEONDIFF_LAUNCHD_LOG_ARCHIVE_COUNT</key>
  <string>5</string>
  <key>NEONDIFF_LAUNCHD_LOG_MAX_AGE_HOURS</key>
  <string>168</string>
</dict>
```

## Bounded launchd logs

The managed LaunchAgent policy bounds stdout and stderr independently. Each
live file rotates before the next record would take it past 10 MiB, retains at
most five archives, and removes archives older than 168 hours. One record may
be larger than the threshold; otherwise the expected upper bound is about
120 MiB across two live files and ten archives. The log directory is `0700`;
live files and archives are `0600` and must be owned by the current user.

Rotation copies the current bytes into a private same-directory archive,
durably closes that archive, and then truncates the already-open inherited file
descriptor. The visible live path keeps the same device and inode, so launchd
does not need to reopen it and the worker continues writing after rotation.
The runtime fails closed on symlinks, a path/descriptor inode mismatch, broader
permissions, wrong ownership, or an archive/copy/truncate failure. It never
renames the live inode and does not use a second daemon, log shipper, or
privileged `/etc/newsyslog.d` policy.

The worker installer adds the exact policy idempotently, creates missing live
files without reading or truncating them, and narrows their permissions. It
preserves existing archives. Rolling back to an earlier managed worker keeps
the policy; rolling back to the original invocation restores the original
environment values and leaves the directory, live files, and archives in
place. Uninstall or rollback must not delete unrelated logs. Archives contain
only the exact already-local log bytes and remain in the same private directory;
rotation does not copy credentials or logs to another surface.

Source and packaging tests do not prove installed adoption. A separately
authorized post-install smoke must verify a fresh heartbeat, continued stdout
and stderr writes through one rotation, bounded file growth, and the installed
plist values. Do not truncate the current log or restart launchd merely to
validate source changes.

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

For a public paid B0 BYO Mac worker update, do not edit `ProgramArguments`,
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
