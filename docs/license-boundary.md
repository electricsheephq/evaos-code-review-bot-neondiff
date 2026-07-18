# NeonDiff License Boundary

This document is the canonical public-release wording for NeonDiff licensing and
commercial boundaries. Copy these claims into README, setup docs, website copy,
CLI help, package metadata, and release notes instead of inventing new wording.

## Short Copy

NeonDiff is source-available commercial software, not open-source software.
The current npm CLI (v1.0.x) requires active API-backed activation for every
repository visibility. Private, internal, public, commercial,
proprietary, hosted, marketplace, binary redistribution, and auto-updates all
remain inside the paid entitlement boundary of the current CLI.

Coming with the native app: public open-source repository review will be free
with no NeonDiff Activation Key, while private, internal, and commercial review
will require an active entitlement. This managed public-free/private-paid model
ships with the native NeonDiff app and the managed GitHub App broker (#614) and
is not enforced by the current CLI, which requires activation for every
repository (a local visibility flag would trust the client's own claim).

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
enforcement, restore a public-free path, redirect the API, or enable grace: a
local visibility flag would trust the client's own claim, so the managed
public-free path is deferred to the native app and the server-side GitHub App
broker (#614), which verify repository visibility rather than trusting local
config.

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
| public | none | yes | block before checkout, provider call, or post | license blocked |
| public | none | no | block before checkout, provider call, or post | license blocked |
| public | active covering entitlement | yes | allow | provider output may still fail normally |
| private | none | yes | block before checkout, provider call, or post | license blocked |
| private | active private entitlement | yes | allow | provider output may still fail normally |
| private | expired or revoked entitlement | yes | block before checkout, provider call, or post | license blocked |
| unknown | any | yes | fail closed before checkout, provider call, or post | visibility/license blocked |

This matrix reflects the current CLI (v1.0.x), which blocks every visibility
without activation. The native app and the managed GitHub App broker (#614)
will allow public open-source review with no Activation Key once server-side
visibility verification ships; that public-free path is not enforced by the
current CLI.

For the managed native path, private entitlement is bound to the authenticated
broker device and exact GitHub-selected repository. The raw Activation Key is
Keychain-owned, crosses bounded stdin for activation and a fixed-origin HTTPS
request body for private token issuance, and is never persisted by the broker.
Public token issuance omits the key and does not query the license authority.
These source contracts remain rollout-disabled until production integration and
customer canaries pass.

Evidence should name the command, repo visibility source, license gate result,
pre-checkout gate result, and redacted evidence path. It must not include raw
private diffs, provider keys, GitHub App private keys, license keys, or customer
logs.

## Product Surface Wording

Use:

- "source-available commercial software"
- "the current CLI (v1.0.x) requires API-backed activation for every repository review"
- "public open-source review will be free in the native app (managed broker #614); not enforced by the current CLI"
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
> providers. Coming with the native app: public open-source review will be free
> with no Activation Key via the managed GitHub App broker (#614); the current
> CLI still requires activation for every repository.

Private-repo failure copy should say:

> Review blocked: this repo requires an active NeonDiff entitlement before
> worktree prep, provider calls, or GitHub review posting.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105
- License activation implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/111
- Public release readiness: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/396
