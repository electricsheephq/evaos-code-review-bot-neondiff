# NeonDiff License Boundary

This document is the canonical public-release wording for NeonDiff licensing and
commercial boundaries. Copy these claims into README, setup docs, website copy,
CLI help, package metadata, and release notes instead of inventing new wording.

## Short Copy

NeonDiff is source-available commercial software, not open-source software.
Supported review and provider work requires active API-backed activation for
every repository visibility. Private, internal, public, commercial,
proprietary, hosted, marketplace, binary redistribution, and auto-updates all
remain inside the paid entitlement boundary.

Repository review requires a paid NeonDiff support license: $1/month or $10/year for
individuals, or $100/year for organizations. Individual plans include a 7-day
trial, organization plans include a 30-day trial, and legacy lifetime licenses
remain honored for existing holders but are no longer sold. NeonDiff support
tiers do not include hosted model credits, unlimited SaaS inference, or bundled
provider tokens.

## Allowed Without A Paid License

- Inspecting the source.
- Forking the repository to evaluate NeonDiff or propose changes.
- Submitting GitHub issues and pull requests.

## Requires A Paid License

- Reviewing public or private repositories through the supported distribution.
- Reviewing internal, proprietary, client, or commercial code.
- Using NeonDiff in a company, agency, consulting, or paid-support workflow.
- Shipping NeonDiff binaries, installers, update channels, marketplace
  packages, or hosted services.
- Enabling private-repo entitlement or auto-updates.

## Supported Distribution Policy

The supported distribution pins the canonical production license API, requires
live activation for public/private/internal/unknown repository work, and grants
zero offline cache authority in v1.0.4. User or legacy config cannot disable
enforcement, restore a public-free path, redirect the API, or enable grace.

## Review Gate Proof Matrix

The license gate is separate from provider setup. A provider API key or local
model path can satisfy the model/provider setup gate, but it never grants
private repository entitlement.

| Repo visibility | NeonDiff entitlement | Provider configured | License gate result | Next blocking layer |
| --- | --- | --- | --- | --- |
| public | none | yes | block before checkout, provider call, or post | license blocked |
| public | none | no | block before checkout, provider call, or post | license blocked |
| public | active covering entitlement | yes | allow | provider output may still fail normally |
| private | none | yes | block before checkout, provider call, or post | license blocked |
| private | active private entitlement | yes | allow | provider output may still fail normally |
| private | expired or revoked entitlement | yes | block before checkout, provider call, or post | license blocked |
| unknown | any | yes | fail closed before checkout, provider call, or post | visibility/license blocked |

Evidence should name the command, repo visibility source, license gate result,
pre-checkout gate result, and redacted evidence path. It must not include raw
private diffs, provider keys, GitHub App private keys, license keys, or customer
logs.

## Product Surface Wording

Use:

- "source-available commercial software"
- "API-backed activation is required for supported review work"
- "private and commercial repository review requires a paid NeonDiff license"
- "$1/month or $10/year individual support license"
- "$100/year organization support license"
- "7-day individual trial and 30-day organization trial"
- "legacy lifetime licenses remain honored but are no longer sold"
- "bring your own provider key or local model"
- "local worker; current-head, secret-redacted review evidence"

Avoid:

- "open source"
- "MIT licensed"
- "Apache licensed"
- "free for private repositories"
- "free for all commercial use"
- "hosted review SaaS"
- "enterprise-ready"
- "production-ready"
- "CodeRabbit parity" unless the eval gate for that exact claim passes

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

> NeonDiff is source-available commercial software. Supported public, private,
> internal, and commercial repository review requires an active API-backed
> NeonDiff license. Individual support tiers are $1/month or
> $10/year, organization support is $100/year, trials are 7 days for individuals
> and 30 days for organizations, and legacy lifetime licenses remain honored but
> are no longer sold; provider/model costs stay external through BYOK or local
> providers.

Private-repo failure copy should say:

> Review blocked: this repo requires an active NeonDiff entitlement before
> worktree prep, provider calls, or GitHub review posting.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105
- License activation implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/111
- Public release readiness: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/396
