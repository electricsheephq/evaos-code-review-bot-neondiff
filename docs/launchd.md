# Launchd Pilot

Launchd should stay disabled until GitHub App installation is complete and a real ZCode dry-run succeeds without rate limiting.

For the BYO Mac path, the LaunchAgent's background PR review lane remains held,
including when the daemon runs with `--dry-run false`. That live daemon mode may
run the independently admitted issue-enrichment lane. A heartbeat proves service
liveness only; issue-enrichment success requires lane-specific result evidence.
Neither its admission nor the heartbeat authorizes PR work. Native live PR
posting uses only the exact scoped `review-pr` dry review plus explicit
same-head confirmation.

Recommended first review proof:

```bash
cd /path/to/neondiff
export NEONDIFF_GITHUB_APP_ID="<github-app-id>"
export NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
npm run cli -- review-pr \
  --config /absolute/path/to/config.local.json \
  --repo owner/repo \
  --pr 123 \
  --expected-config-revision <verified-config-revision> \
  --dry-run true \
  --zcode true
```

Use the exact `configRevision` from the successful provider verification. The
returned exact head and this scoped dry receipt are prerequisites for the
separate same-head live confirmation.

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
</dict>
```

Switch the long-running daemon to `--dry-run false` only for its independently
governed issue-enrichment work; the background PR review lane stays held. Before
that transition:

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
