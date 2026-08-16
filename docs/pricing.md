# NeonDiff Pricing

NeonDiff is a local-first, source-available beta. The current CLI (v1.0.x)
requires API-backed activation for supported review work on public, private,
internal, and unknown repository visibilities.

Coming with the native app: public open-source repository review will be free
with no NeonDiff Activation Key, while private/commercial review will require an
active entitlement. This managed public-free/private-paid model ships with the
native NeonDiff app and the managed GitHub App broker (#614) and is not enforced
by the current CLI.

NeonDiff pricing is for the software/support entitlement only. Users bring
their own provider key or local model. NeonDiff does not include hosted model
credits, unlimited SaaS inference, or bundled provider tokens.

## Support Tiers

| Tier | Price | Best For | Private Repos | Commercial Use | Auto-Updates | Provider Credits |
| --- | ---: | --- | --- | --- | --- | --- |
| Individual Monthly | $1/mo | Single-user private or commercial use; 7-day free trial | Yes | Yes | Yes | Not included |
| Individual Yearly | $10/yr | Single-user yearly license; 7-day free trial | Yes | Yes | Yes | Not included |
| Organization Yearly | $100/yr | Flat organization license; 30-day free trial | Yes | Yes | Yes | Not included |
| Legacy Lifetime Support | no longer sold | Existing lifetime license holders only | Yes | Yes | Yes | Not included |

## CLI Contract

Use the CLI to inspect the canonical pricing and entitlement shape that docs,
license copy, and website copy should follow:

```bash
neondiff pricing
```

The pricing command emits JSON by default and does not call the network. It reports:

- supported review work requires API-backed activation
- active paid support tiers are `$1/mo`, `$10/yr`, and `$100/yr`
- individual paid plans include a 7-day trial; organization plans include a
  30-day trial
- legacy lifetime licenses remain honored for existing holders but are no
  longer sold
- paid support includes public/private repo review, commercial usage, and auto-updates
- provider/model costs stay external through BYOK or local providers
- hosted model credits and unlimited SaaS inference are not included

## Entitlement Shape

Support licenses map to entitlement plans for public/private repository review,
commercial usage, and auto-updates:

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

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot/issues/105
