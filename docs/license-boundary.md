# NeonDiff License Boundary

This document is the canonical public-release wording for NeonDiff licensing and
commercial boundaries. Copy these claims into README, setup docs, website copy,
CLI help, package metadata, and release notes instead of inventing new wording.

## Short Copy

NeonDiff is source-available commercial software, not open-source software.
From NeonDiff 1.1.0, review of repositories that GitHub reports as public is free,
with no NeonDiff license key, through the GitHub Action, `neondiff review-pr --ci`, and the self-hosted
worker (`daemon`, `run-once`, `review-pr`, `providers verify`),
including company-owned public repositories. The Mac app still requires a
license key for every repository ([#1203](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/1203)).
Private, internal, and unknown-visibility repositories require an active
NeonDiff license; unknown or unreadable visibility fails closed. The npm CLI
1.0.x requires API-backed activation for every repository.

Paid licenses are flat, with no per-seat pricing: Solo is $9/mo or $90/yr for
one developer, and Team is $290/yr per GitHub organization. One license covers
one GitHub organization or user account and activates one review worker machine;
every developer whose pull requests that worker reviews is covered. Solo plans include
a 7-day trial, Team plans include a 30-day trial, and existing subscribers keep
their current price. Legacy lifetime licenses remain honored for existing
holders but are no longer sold. Licenses do not include hosted model credits,
unlimited SaaS inference, or bundled provider tokens: you bring your own
provider key or local model.

## Local Development Exemption

`review-local` is a local development tool that posts nothing and needs no activation,
including for a private checkout: it reviews a local diff without GitHub calls.
This explicit exemption supports local development without granting GitHub
review posting or self-hosted worker entitlement. You bring your own OpenAI
API key or Codex login on your own machine; NeonDiff never pays for or proxies
model calls.

## Allowed Without A Paid License

- Inspecting the source.
- Forking the repository to evaluate NeonDiff or propose changes.
- Submitting GitHub issues and pull requests.
- From 1.1.0, reviewing repositories that GitHub reports as public through the
  GitHub Action, `neondiff review-pr --ci`, or the self-hosted worker (`daemon`,
  `run-once`, `review-pr`, `providers verify`). The Mac app still requires
  activation for every repository (#1203).

## Requires A Paid License

- Reviewing private, internal, or unknown-visibility repositories, including
  proprietary, client, or commercial code.
- Using NeonDiff on private repositories in a company, agency, consulting, or
  paid-support workflow.
- Shipping NeonDiff binaries, installers, update channels, marketplace
  packages, or hosted services.
- Enabling private-repo entitlement or auto-updates.

## Supported Distribution Policy

The supported distribution pins the canonical production license API and grants
zero offline cache authority. From 1.1.0 its official policy sets
`publicReposFree: true`: a review cycle on a repository whose GitHub-reported
visibility is `public` is admitted without a license call, and every other
visibility requires live activation. Keyless public-only worker admission covers
`providers verify`, provider smoke checks, `daemon`, and review discovery for
`run-once` and retries. A stored key always receives live validation; failures
never silently downgrade to public-only mode. Issue enrichment and update
checks remain licensed. The Mac app still requires activation (#1203).
User or legacy config cannot disable
enforcement for private work, redirect the API, or enable grace. The npm CLI
1.0.x requires live activation for public, private, internal, and unknown
repository work.

Visibility comes from GitHub's own repository metadata, read with the
installation or workflow token at review time. A source-available client can be
patched to skip any local check, so the free public path is a product decision,
not an enforcement boundary; private entitlement stays enforced by the license
API.

This boundary applies to the official supported package and future official
desktop distribution. Public source, forks, caches, clones, edited installed
JavaScript, and already-downloaded artifacts cannot be recalled or technically
prevented from running. The npm package exposes the CLI binary but no supported
library or subpath import API; that packaging boundary is not DRM and does not
change the public-source limitation.

## Review Gate Proof Matrix

The license gate is separate from provider setup. A provider API key or local
model path can satisfy the model/provider setup gate, but it never grants
private repository entitlement.

| Repo visibility | NeonDiff entitlement | Provider configured | License gate result | Next blocking layer |
| --- | --- | --- | --- | --- |
| public | none | yes | allow (1.1.0+, GitHub Action, `review-pr --ci`, or self-hosted worker); block before checkout, provider call, or post on 1.0.x | provider output may still fail normally |
| public | none | no | allow the license gate (1.1.0+, GitHub Action, `review-pr --ci`, or self-hosted worker); provider setup still blocks | provider blocked |
| public | active covering entitlement | yes | allow | provider output may still fail normally |
| private | none | yes | block before checkout, provider call, or post | license blocked |
| private | active private entitlement | yes | allow | provider output may still fail normally |
| private | expired or revoked entitlement | yes | block before checkout, provider call, or post | license blocked |
| unknown | any | yes | fail closed before checkout, provider call, or post | visibility/license blocked |

Unknown or unreadable visibility is never treated as public.

For the managed native path, private entitlement is bound to the authenticated
broker device and exact GitHub-selected repository. The raw Activation Key is
Keychain-owned, crosses bounded stdin for activation and a fixed-origin HTTPS
request body for private token issuance, and is never persisted by the broker.
Public token issuance omits the key and does not query the license authority.
These source contracts remain rollout-disabled until production integration and
customer canaries pass. Generic CLI status/deactivate and daemon-admission
validation still use the legacy local identity; #630 must migrate those runtime
callers before the managed path can be enabled.

Evidence should name the command, repo visibility source, license gate result,
pre-checkout gate result, and redacted evidence path. It must not include raw
private diffs, provider keys, GitHub App private keys, license keys, or customer
logs.

## Product Surface Wording

Use:

- "source-available commercial software"
- "review of repositories that GitHub reports as public is free through the GitHub Action, `neondiff review-pr --ci`, and the self-hosted worker (NeonDiff 1.1.0 and later)"
- "the Mac app still requires a license key (#1203)"
- "private, internal, and unknown-visibility repositories require an active NeonDiff license"
- "private repository review requires a paid NeonDiff license"
- "the npm CLI 1.0.x requires API-backed activation for every repository"
- "Solo: $9/mo or $90/yr for one developer"
- "Team: $290/yr per GitHub organization, no per-seat pricing"
- "7-day Solo trial and 30-day Team trial"
- "existing subscribers keep their current price"
- "legacy lifetime licenses remain honored but are no longer sold"
- "bring your own provider key or local model"
- "local worker; current-head, secret-redacted review evidence"

Avoid:

- Do not describe NeonDiff as "open source"
- Do not claim "MIT licensed"
- Do not claim "Apache licensed"
- Do not claim "free for private repositories"
- Do not claim "free for all commercial use"
- Do not claim "hosted review SaaS"
- Do not claim "enterprise-ready"
- Do not claim "production-ready"
- Do not claim "CodeRabbit parity" unless the eval gate for that exact claim passes

## Attribution And Provenance

- Keep Electric Sheep copyright and NeonDiff license notices in source,
  packages, and generated release artifacts.
- Keep third-party notices with bundled third-party code and assets; third-party
  dependencies remain under their own licenses.
- Do not describe historical third-party license grants as revoked unless
  counsel-approved wording explicitly says so.
- Optional GitNexus, repo-wiki, OpenWiki-compatible, desktop, and marketplace
  work must keep their own provenance and license packets.

## CLI And Docs Copy

CLI setup/help copy should say:

> NeonDiff is source-available commercial software. From 1.1.0, review of
> repositories that GitHub reports as public is free with no license key
> through the GitHub Action, `neondiff review-pr --ci`, and the self-hosted worker
> (`daemon`, `run-once`, `review-pr`, `providers verify`); the Mac app still
> requires a license key (#1203).
> Private, internal, and unknown-visibility repositories require an active
> API-backed NeonDiff license: Solo $9/mo or $90/yr, Team $290/yr per GitHub
> organization, with a 7-day Solo trial and a 30-day Team trial. Legacy
> lifetime licenses remain honored but are no longer sold; provider/model costs
> stay external through BYOK or local providers.

Private-repo failure copy should say:

> Review blocked: this repo requires an active NeonDiff entitlement before
> worktree prep, provider calls, or GitHub review posting.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105
- License activation implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/111
- Public release readiness: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/396
