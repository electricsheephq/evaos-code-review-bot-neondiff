# NeonDiff Setup

This guide is the first-run path for the current source-available beta. It uses
the checked-out repository scripts until the public CLI package and final
`neondiff` binary are completed in issue #107.

## Requirements

- Node.js 26 or newer
- npm
- GitHub App credentials for the repos you want to review
- a provider/model path available on the machine running the worker
- optional NeonDiff license key for private or commercial repo use

Public open-source repos are free. Private and commercial repos require a paid
license. Final license wording is tracked in issue #104.

## 1. Install From Source

```bash
git clone https://github.com/electricsheephq/evaos-code-review-bot.git neondiff
cd neondiff
npm install
npm run build
```

## 2. Create A GitHub App

Create a GitHub App for NeonDiff and install it only on repos you intend to
review.

Required repository permissions:

- Contents: read
- Pull requests: read/write
- Checks: read
- Actions: read
- Metadata: read

Optional issue-enrichment permissions are separate from PR review and should not
be enabled just because a repo is monitored:

- Issues: read, only for dry-run/operator issue enrichment reads
- Issues: write, only after a tracked rollout enables sticky issue comments

Save the generated private key outside the repository.

```bash
export EVAOS_REVIEW_BOT_APP_ID="<github-app-id>"
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
```

## 3. Configure Provider And License

Copy the example config and edit it for your local repo allowlist, provider
path, state path, and evidence path:

```bash
cp config.example.json config.local.json
```

For the current internal provider path, the worker derives transient ZCode/GLM
environment from the local app config referenced by `config.local.json`. Do not
copy provider API keys into this repository.

If you are reviewing private or commercial repos, set your license key through
the configured local secret path or environment used by your operator wrapper.
Do not paste license keys into tracked config.

## 4. Check Readiness

Run doctor with the config you intend to use:

```bash
npm run doctor -- --config config.local.json
```

The doctor output is JSON. Check:

- `ok`
- `github.readMode`
- each `github.readChecks[]`
- provider readiness
- repo policy allow/skip state

## 5. Run A Dry-Run Review

Use a known repo, PR number, and current head. A dry-run review should produce
structured output and evidence without posting comments:

```bash
npm run run-once -- \
  --config config.local.json \
  --repo owner/name \
  --pr 123 \
  --dry-run true \
  --zcode false
```

Do not run with `--dry-run false` until dry-run evidence, focused tests, and
the relevant issue explicitly approve the exact repo, PR, head SHA, and config
path.

## 6. Inspect Daemon And Status

Before touching launchd, use JSON status commands:

```bash
npm run cli -- status --json --config config.local.json
npm run cli -- queue --config config.local.json
npm run cli -- dashboard --config config.local.json --limit 10
```

After `npm run build`, the local package also exposes the current beta binary:

```bash
./dist/src/cli.js status --config config.local.json
```

Launchd and live beta promotion are advanced operator tasks. Use
[docs/launchd.md](launchd.md), [docs/operator-cli.md](operator-cli.md), and
[docs/beta-release-runbook.md](beta-release-runbook.md) only after dry-run proof
passes.

## Troubleshooting

- `doctor` cannot read repos: verify GitHub App installation, app ID, private
  key path, and repo permissions.
- Provider calls fail: verify local provider config outside this repository and
  inspect redacted provider errors only.
- Review says stale head: re-fetch the PR head and rerun against the current
  SHA; do not post stale findings.
- Evidence contains sensitive material: stop, remove the unsafe artifact from
  shareable evidence, and file a security/private follow-up.
- Private repo review is blocked: verify license setup and repo policy before
  widening permissions.

## What Setup Does Not Prove

Setup does not prove public launch, final legal adequacy, calibrated review
accuracy, enterprise readiness, desktop client readiness, package publishing, or
live beta promotion. Those are separate issues and release gates.
