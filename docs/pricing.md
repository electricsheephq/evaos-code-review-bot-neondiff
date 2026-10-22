# NeonDiff Pricing

NeonDiff is a local-first, source-available beta. From NeonDiff 1.1.0, review of
repositories that GitHub reports as public is free, with no license key, through
the GitHub Action and `neondiff review-pr --ci`, including company-owned public
repositories. The Mac app and the self-hosted worker (`daemon`, `run-once`, and
local `review-pr`) still ask for a license key for every repository for now;
extending free public review to them is tracked in
[#1191](https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/1191).
Private, internal, and
unknown-visibility repositories require an active license, and unknown
visibility fails closed. The npm CLI 1.0.x requires API-backed activation for
every repository.

NeonDiff pricing is for the software/support entitlement only. Users bring
their own provider key or local model. NeonDiff does not include hosted model
credits, unlimited SaaS inference, or bundled provider tokens.

## Plans

Prices are flat: no per-seat charges. Each license activates one review worker
machine, and every developer whose pull requests that worker reviews is covered;
Team covers the private repositories of one GitHub organization.

| Plan | Price | Best For | Private Repos | Commercial Use | Auto-Updates | Provider Credits |
| --- | ---: | --- | --- | --- | --- | --- |
| Public repositories | Free | Any repository that GitHub reports as public, through the GitHub Action or `neondiff review-pr --ci` (1.1.0+; Mac app and self-hosted worker: #1191) | — | Yes | — | Not included |
| Solo Monthly | $9/mo | One developer; 7-day trial | Yes | Yes | Yes | Not included |
| Solo Yearly | $90/yr | One developer, yearly; 7-day trial | Yes | Yes | Yes | Not included |
| Team Yearly | $290/yr | One GitHub organization, any number of developers; 30-day trial | Yes | Yes | Yes | Not included |
| Legacy Lifetime Support | no longer sold | Existing lifetime license holders only | Yes | Yes | Yes | Not included |

Existing subscribers keep their current price for as long as their subscription
stays active. Legacy lifetime licenses remain honored for existing holders but
are no longer sold.

## CLI Contract

Use the CLI to inspect the canonical pricing and entitlement shape that docs,
license copy, and website copy should follow:

```bash
neondiff pricing
```

The pricing command emits JSON by default and does not call the network. It reports:

- review of repositories that GitHub reports as public is free through the
  GitHub Action and `neondiff review-pr --ci` (1.1.0+); the Mac app and the
  self-hosted worker still ask for a license key (#1191)
- private, internal, and unknown-visibility review requires API-backed activation
- active paid plans are `$9/mo`, `$90/yr` (Solo) and `$290/yr` (Team)
- Solo plans include a 7-day trial; Team plans include a 30-day trial
- legacy lifetime licenses remain honored for existing holders but are no
  longer sold
- paid plans include private repo review, commercial usage, and auto-updates
- provider/model costs stay external through BYOK or local providers
- hosted model credits and unlimited SaaS inference are not included

## Entitlement Shape

Paid licenses map to entitlement plans for private repository review,
commercial usage, and auto-updates. Plan ids are stable; display names changed
in 1.1.0 (Individual → Solo, Organization → Team):

- `monthly_support`
- `yearly_support`
- `org_yearly_support`
- `lifetime_support`

`monthly_support`, `yearly_support`, and `org_yearly_support` are active
checkout plans. `lifetime_support` is a legacy entitlement id kept for existing
lifetime holders only; it is read-only for compatibility and not offered for new
checkout.

Runtime license enforcement is outside this pricing command. This document only
defines the pricing and entitlement vocabulary that enforcement code and setup
docs should use.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105
