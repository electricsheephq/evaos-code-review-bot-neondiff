# NeonDiff

**NeonDiff is a local-first AI PR reviewer for teams and agents that want the
review loop without handing every diff to a hosted review SaaS.**

Use it when you want a GitHub App to review pull requests from a local worker,
with your GitHub installation, your provider keys, your repo policy, and
public-safe evidence for every live posting decision.

Public open-source repos are free. Private and commercial repos require a paid
NeonDiff license. NeonDiff is a source-available beta, not an open-source or
GA release.

[Website](https://www.neondiff.com) · [Setup](docs/SETUP.md) ·
[Contributing](CONTRIBUTING.md) · [Agent Instructions](AGENTS.md) ·
[Security](SECURITY.md) · [Code of Conduct](CODE_OF_CONDUCT.md) ·
[Roadmap](https://github.com/electricsheephq/evaos-code-review-bot/issues/103) ·
[License Boundary](https://github.com/electricsheephq/evaos-code-review-bot/issues/104)

## Why It Matters

AI-built software has made PR volume and review fatigue worse. NeonDiff is built
for the opposite posture: run locally, read only the pull request it is asked to
review, post only current-head comments, and keep provider/model cost under the
user's control.

The current implementation grew from the internal evaOS review bot. This repo is
now the NeonDiff implementation surface; older internal naming is legacy
operator history, not the public product name.

## What It Does

NeonDiff currently provides:

- a GitHub App based pull-request reviewer
- current-head duplicate suppression for `{repo, pr, head_sha}`
- dry-run review output before live posting
- inline finding placement only on current RIGHT-side diff lines
- secret-looking finding suppression
- stale-head checks before command-triggered review, planning, and posting
- local evidence logs with secret redaction
- repo profile and policy configuration
- JSON-first operator commands for status, queue, dashboard, cooldowns, and why
- offline eval packets for comparing seeded defects, CI, human review, and bot findings

It intentionally does not approve PRs, merge branches, push repairs, expand
GitHub permissions by profile alone, or claim calibrated review accuracy before
evals prove it.

## Install

Requirements:

- Node.js 26 or newer
- npm
- a GitHub App installed on the repos you want to review
- a model/provider path configured locally, such as GLM/Z.ai, Ollama, or a
  future OpenAI-compatible provider slot

Source checkout install for the current beta:

```bash
git clone https://github.com/electricsheephq/evaos-code-review-bot.git neondiff
cd neondiff
npm install
npm run build
npm link
```

The source checkout exposes the beta `neondiff` binary through `npm link`.
If you intentionally skip linking, substitute `./dist/src/cli.js` anywhere this
guide calls `neondiff`. Public npm/package distribution stays blocked until the license gate in
[issue #104](https://github.com/electricsheephq/evaos-code-review-bot/issues/104)
and the distribution work in
[issue #107](https://github.com/electricsheephq/evaos-code-review-bot/issues/107)
are both resolved.

## Set Up

Follow [docs/SETUP.md](docs/SETUP.md) for the full first-run path. The short
version is:

```bash
neondiff init --config config.local.json
export EVAOS_REVIEW_BOT_APP_ID="<github-app-id>"
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
neondiff doctor --config config.local.json --json
```

Do not store the GitHub App private key, provider API key, license key, tokens,
or customer data in this repository. Keep local config, secrets, state DBs, and
evidence outside git.

## First Dry-Run Review

Run a dry-run review before any live posting:

```bash
neondiff review-pr \
  --config config.local.json \
  --repo owner/name \
  --pr 123 \
  --dry-run true \
  --zcode false
```

Inspect the JSON result and evidence path. Only switch to `--dry-run false`
after setup checks, focused tests, and the relevant GitHub issue record the
exact repo, PR, head SHA, config path, and public-safe evidence.

## Agent And Maintainer Workflow

If you are contributing as an AI coding agent:

1. Read [AGENTS.md](AGENTS.md).
2. Reuse or create a GitHub issue before meaningful work.
3. Write a failing test, smoke, or docs/eval gate before implementation.
4. Keep the PR linked to the issue with `Closes #<issue>` or `Related: #<issue>`.
5. Record validation and evidence without raw secrets, raw customer data, or
   private logs.

Useful public-product issues:

- [#103 NeonDiff public product roadmap](https://github.com/electricsheephq/evaos-code-review-bot/issues/103)
- [#104 license and commercial boundary](https://github.com/electricsheephq/evaos-code-review-bot/issues/104)
- [#107 CLI package and local daemon public install flow](https://github.com/electricsheephq/evaos-code-review-bot/issues/107)
- [#113 agent-first CLI and API documentation contract](https://github.com/electricsheephq/evaos-code-review-bot/issues/113)

## Safety Boundaries

Default behavior:

- review only configured repos
- skip draft PRs by default
- at most one review per `{repo, pr, head_sha}`
- never submit `APPROVE`
- request changes only for validated high-severity findings
- suppress secret-looking findings instead of posting redacted secrets
- re-fetch PR state before live operations
- keep ZCode/model tools read-only during review
- fail closed when credentials, provider readiness, repo policy, or current-head
  proof is missing

Not claimed:

- public launch is complete
- final legal/license adequacy
- hosted review service
- auto-merge or branch repair
- generic GitHub issue mutation
- enterprise or customer-ready security
- calibrated CodeRabbit-level accuracy
- desktop client readiness

## Roadmap Vs Shipped

The current repo is a source-available beta implementation. The public MVP is
tracked in [#103](https://github.com/electricsheephq/evaos-code-review-bot/issues/103).
Provider registry, `.neondiff.yml`, public CLI packaging, license activation,
desktop client, wiki exports, marketplace packaging, and confidence calibration
each have separate issues and must not be treated as shipped until their PRs and
proof gates close.

For live beta operation, use [docs/beta-release-runbook.md](docs/beta-release-runbook.md)
and [docs/release-governance.md](docs/release-governance.md). Documentation-only
changes do not restart launchd or promote a release by themselves.

For public source-beta release readiness, use
[docs/public-release-manifest.json](docs/public-release-manifest.json) with
`neondiff release-status --public-release-manifest docs/public-release-manifest.json --expected-public-version <public-beta-tag>`.
Replace `<public-beta-tag>` with the actual semver prerelease tag, such as
`v1.0.0-beta.1`; the CLI rejects literal placeholders. The manifest is the
compact version/alignment surface for setup docs, release notes, license API
state, and update-channel readiness.
