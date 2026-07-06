# NeonDiff

**NeonDiff is a local-first AI PR reviewer for teams and agents that want the
review loop without handing every diff to a hosted review SaaS.**

![NeonDiff cyberpunk wordmark in toxic green inside a black HUD frame](assets/readme/neondiff-cyberpunk-hero.png)

Use it when you want a GitHub App to review pull requests from a local worker,
with your GitHub installation, your provider keys, your repo policy, and
public-safe evidence for every live posting decision.

Public open-source repos are free. Private and commercial repos require a paid
NeonDiff support license: $1/month, $10/year, or $100 lifetime. NeonDiff is a
source-available beta, not an open-source or GA release.

[Website](https://www.neondiff.com) · [Setup](docs/SETUP.md) ·
[GitHub App Install](docs/github-app-setup.md) · [Contributing](CONTRIBUTING.md) ·
[Agent Instructions](AGENTS.md) · [Security](SECURITY.md) ·
[Code of Conduct](CODE_OF_CONDUCT.md) · [License](LICENSE.md) ·
[License Boundary](docs/license-boundary.md) · [Pricing](docs/pricing.md) ·
[Providers](docs/providers.md) ·
[Roadmap](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103) ·
[Repository](https://github.com/electricsheephq/evaos-code-review-bot-neondiff)

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

Recommended package install for the current beta:

```bash
npm install -g neondiff@0.4.30-beta.1
```

Installer script path:

```bash
curl -fsSL https://www.neondiff.com/install | sh
```

The installer script checks for Node.js 26 or newer and installs the same npm
package. To preview without changing your machine:

```bash
curl -fsSL https://www.neondiff.com/install | sh -s -- --dry-run
```

Source checkout fallback:

```bash
git clone https://github.com/electricsheephq/evaos-code-review-bot-neondiff.git neondiff
cd neondiff
npm install
npm run build
```

If you intentionally use the source checkout without the global package,
substitute `./dist/src/cli.js` anywhere this guide calls `neondiff`.

## Set Up

Follow [docs/SETUP.md](docs/SETUP.md) for the full first-run path. The short
version is:

```bash
neondiff init --config config.local.json
export EVAOS_REVIEW_BOT_APP_ID="<github-app-id>"
export EVAOS_REVIEW_BOT_PRIVATE_KEY_PATH="/absolute/path/to/neondiff.private-key.pem"
neondiff doctor github --config config.local.json --json
neondiff providers list --config config.local.json --json
neondiff providers doctor --config config.local.json --json
neondiff doctor --config config.local.json --json
```

Do not store the GitHub App private key, provider API key, license key, tokens,
or customer data in this repository. Keep local config, secrets, state DBs, and
evidence outside git.

## Provider Resources And Compatibility

NeonDiff is local-first for checkout state, credentials, config, evidence, and
operator control. Model egress depends on the provider you choose: local or
self-hosted endpoints can keep prompts and diffs on your machine or network,
while hosted providers such as GLM/Z.AI through ZCode or hosted
OpenAI-compatible gateways receive the review prompt and diff context required
to answer.

For setup details, see [docs/providers.md](docs/providers.md). Useful provider
resources:

- [Z.AI quick start](https://docs.z.ai/guides/overview/quick-start),
  [Z.AI API reference](https://docs.z.ai/api-reference/introduction), and
  [Z.AI OpenAI SDK compatibility](https://docs.z.ai/guides/develop/openai/python)
- [Z.AI current GLM coding model guidance](https://docs.z.ai/devpack/latest-model)
- [Ollama OpenAI compatibility docs](https://docs.ollama.com/api/openai-compatibility)
- [cheahjs/free-llm-api-resources](https://github.com/cheahjs/free-llm-api-resources)
  for volatile free/trial provider discovery, not NeonDiff compatibility proof

Small NeonDiff compatibility matrix:

| Provider or resource | NeonDiff status | Egress posture |
| --- | --- | --- |
| GLM/Z.AI through ZCode | Default beta path; tested by NeonDiff as the current live review route | Hosted provider receives prompts and diffs |
| Ollama on `localhost` | Compatible by interface; provider doctor/smoke only until adapter proof promotes live review | No-egress only when endpoint and model are local |
| LM Studio, vLLM, or local gateways | Compatible by interface; tracked for provider proof before live promotion | No-egress only for local/self-hosted endpoints |
| Hosted OpenAI-compatible BYOK gateways | Compatible by interface; remote smoke and live review proof required | Hosted provider receives prompts and diffs |
| Free-provider catalogs | Resource only; untested by NeonDiff unless a provider has its own proof issue | Usually hosted; check each provider |

## First Dry-Run Review

Run a dry-run review before any live posting. Replace `--repo owner/name` and
`--pr 123` below with a repo already listed in your local config's
`pilotRepos` and an open PR number on that repo — `review-pr` fails with "repo
must be present in configured repos" if the repo is not in `pilotRepos`:

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

- [#103 NeonDiff public product roadmap](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103)
- [#104 license and commercial boundary](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104)
- [#105 pricing implementation](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105)
- [#107 CLI package and local daemon public install flow](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/107)
- [#113 agent-first CLI and API documentation contract](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/113)

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
tracked in [#103](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103).
Provider registry, `.neondiff.yml`, public package publishing, license activation,
desktop client, wiki exports, marketplace packaging, and confidence calibration
each have separate issues and must not be treated as shipped until their PRs and
proof gates close.

Use [LICENSE.md](LICENSE.md) and [docs/license-boundary.md](docs/license-boundary.md)
as the canonical public-beta license language. Do not copy older issue comments
or release notes into public product surfaces when these files are more recent.

For live beta operation, use [docs/beta-release-runbook.md](docs/beta-release-runbook.md)
and [docs/release-governance.md](docs/release-governance.md). Documentation-only
changes do not restart launchd or promote a release by themselves.

For public source-beta release readiness, use
[docs/public-release-manifest.json](docs/public-release-manifest.json) with
`neondiff release-status --public-release-manifest docs/public-release-manifest.json --expected-public-version <public-beta-tag>`.
Replace `<public-beta-tag>` with the actual semver prerelease tag, such as
`v0.4.30-beta.1`; the CLI rejects literal placeholders. The manifest is the
compact version/alignment surface for setup docs, release notes, license API
state, and update-channel readiness.
