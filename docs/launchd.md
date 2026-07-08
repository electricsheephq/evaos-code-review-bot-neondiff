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
</dict>
```

Only switch to `--dry-run false` after:

- current-head duplicate reruns post nothing,
- review-plan JSON contains only valid current-diff lines,
- no secret-like text appears in comments or logs,
- ZCode worktrees stay clean after runs,
- GLM/Z.ai rate limits are not firing,
- `npm run doctor` reports `readMode: "app_installation"` and successful read checks for every pilot repo.
