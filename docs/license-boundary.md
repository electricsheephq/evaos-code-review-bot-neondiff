# NeonDiff License Boundary

This document is the canonical public-beta wording for NeonDiff licensing and
commercial boundaries. Copy these claims into README, setup docs, website copy,
CLI help, package metadata, and release notes instead of inventing new wording.

## Short Copy

NeonDiff is source-available beta software, not open-source software. Public
open-source repository review is free. Private, internal, commercial,
proprietary, hosted, marketplace, binary redistribution, and auto-updates require
an active paid NeonDiff license.

Public open-source repositories are free. Private and commercial repository
review requires a paid NeonDiff support license: $1/month, $10/year, or $100
lifetime. NeonDiff support tiers do not include hosted model credits, unlimited
SaaS inference, or bundled provider tokens.

## Allowed Without A Paid License

- Inspecting the source.
- Forking the repository to evaluate NeonDiff or propose changes.
- Running NeonDiff locally to review public open-source repositories.
- Submitting GitHub issues and pull requests.

## Requires A Paid License

- Reviewing private repositories.
- Reviewing internal, proprietary, client, or commercial code.
- Using NeonDiff in a company, agency, consulting, or paid-support workflow.
- Shipping NeonDiff binaries, installers, update channels, marketplace
  packages, or hosted services.
- Enabling private-repo entitlement or auto-updates.

## Public Repo Grant

The public-repository grant is based on repository visibility and use case:

- Public open-source repos: free.
- Private, internal, or non-public repos: paid license required.
- Public repos used primarily for proprietary or commercial distribution:
  paid license required unless Electric Sheep grants an explicit exception.

The default config may keep license enforcement disabled for internal beta
workers. Public/private product installs should enable license enforcement and
keep `license.publicReposFree` true when the public free path is intended.

## Product Surface Wording

Use:

- "source-available beta"
- "free for public open-source repositories"
- "private and commercial repository review requires a paid NeonDiff license"
- "$1/month, $10/year, or $100 lifetime support license"
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

> NeonDiff is source-available beta software. Public open-source repository
> review is free. Private, internal, and commercial repository review requires
> an active paid NeonDiff license. Support tiers are $1/month, $10/year, or
> $100 lifetime; provider/model costs stay external through BYOK or local
> providers.

Private-repo failure copy should say:

> Review blocked: this repo requires an active NeonDiff entitlement before
> worktree prep, provider calls, or GitHub review posting.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105
- License activation implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/111
- Public beta release readiness: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/232
