# Linux systemd Operator Guide

This guide is the Linux supervised-daemon path for NeonDiff. It mirrors the
macOS launchd guide, but uses systemd, `EnvironmentFile`, and journald. It does
not change review behavior: the worker still reviews only configured repos,
uses current-head duplicate suppression, redacts secrets, and writes evidence
under the configured paths.

## Install The CLI

Install NeonDiff into a path visible to systemd before enabling either unit.
The example units use `/usr/bin/env neondiff`, so `command -v neondiff` should
resolve to a systemd-visible path such as `/usr/local/bin/neondiff` or
`/usr/bin/neondiff`. If your npm global prefix is account-local, edit
`ExecStart` in the copied unit file to the absolute path returned by
`command -v neondiff`.

```bash
npm install -g neondiff
command -v neondiff
```

## User Service

Use the user unit for a single operator account that owns the config, state, and
repo work directories.

```bash
mkdir -p ~/.config/neondiff ~/.config/systemd/user ~/.local/share/neondiff/state
cp systemd/neondiff.user.service.example ~/.config/systemd/user/neondiff.service
```

Create an environment file outside the repository:

```bash
cat > ~/.config/neondiff/neondiff.env <<'EOF'
NEONDIFF_CONFIG=/home/neondiff/.config/neondiff/config.local.json
NEONDIFF_GITHUB_APP_ID=123456
NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH=/home/neondiff/.config/neondiff/neondiff.private-key.pem
EOF
chmod 600 ~/.config/neondiff/neondiff.env
```

Set `statePath` in `~/.config/neondiff/config.local.json` so SQLite state,
leases, duplicate suppression, and license cache defaults stay under the
operator-owned writable state directory:

```json
{
  "statePath": "/home/neondiff/.local/share/neondiff/state/reviews.sqlite"
}
```

Then enable the service:

```bash
systemctl --user daemon-reload
systemctl --user enable --now neondiff
systemctl --user status neondiff
journalctl --user -u neondiff -f
```

If the service should keep running after the SSH session ends, enable lingering
for the operator user:

```bash
sudo loginctl enable-linger "$USER"
```

## System Service

Use the system unit when NeonDiff should run as a dedicated service account.

```bash
sudo useradd --system --home-dir /var/lib/neondiff --create-home --shell /usr/sbin/nologin neondiff
sudo mkdir -p /etc/neondiff /var/lib/neondiff/state
sudo cp systemd/neondiff.service.example /etc/systemd/system/neondiff.service
sudo install -m 600 -o root -g neondiff /dev/null /etc/neondiff/neondiff.env
sudo chown -R neondiff:neondiff /var/lib/neondiff
```

Populate `/etc/neondiff/neondiff.env` with redacted-safe variable names, not raw
secrets in tracked files:

```bash
NEONDIFF_CONFIG=/etc/neondiff/config.local.json
NEONDIFF_GITHUB_APP_ID=123456
NEONDIFF_GITHUB_APP_PRIVATE_KEY_PATH=/etc/neondiff/neondiff.private-key.pem
```

Set `statePath` in `/etc/neondiff/config.local.json` so the hardened system
unit writes all SQLite state and leases under the service account's writable
state directory:

```json
{
  "statePath": "/var/lib/neondiff/state/reviews.sqlite"
}
```

Then start the daemon:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now neondiff
sudo systemctl status neondiff
sudo journalctl -u neondiff -f
```

## Status And Doctor

Run setup checks before enabling the service. Load the same env file into the
current shell first so `NEONDIFF_CONFIG` and credential paths are exported for
the `neondiff` commands:

```bash
set -a
source ~/.config/neondiff/neondiff.env # or /etc/neondiff/neondiff.env for the system unit
set +a

neondiff doctor github --config "$NEONDIFF_CONFIG" --json
neondiff providers list --config "$NEONDIFF_CONFIG" --json
neondiff providers doctor --config "$NEONDIFF_CONFIG" --json
neondiff doctor --config "$NEONDIFF_CONFIG" --json
```

Linux does not use `neondiff daemon start|stop|status`; those subcommands are
launchd controls and intentionally fail closed off macOS with a JSON pointer to
this guide. Use `systemctl --user status neondiff` or
`systemctl status neondiff`, then use NeonDiff's JSON operator commands for
review health:

```bash
neondiff status --config "$NEONDIFF_CONFIG" --json
neondiff queue --config "$NEONDIFF_CONFIG"
neondiff dashboard --operator true --config "$NEONDIFF_CONFIG"
```

## Journald Troubleshooting

```bash
journalctl --user -u neondiff --since "30 minutes ago"
sudo journalctl -u neondiff --since "30 minutes ago"
```

Common failures:

- `status=203/EXEC`: the `neondiff` binary is not on the service user's PATH.
- Config load failure: verify `NEONDIFF_CONFIG` points to readable JSON.
- GitHub read failure: verify App ID, private key path, and selected repo install.
- Provider failure: verify local provider config and use redacted provider output
  from `providers doctor`.
