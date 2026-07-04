# NeonDiff Pricing

NeonDiff is a local-first, source-available beta. Public open-source repository
review is free. Private repo review, commercial usage, and auto-updates require
a paid NeonDiff support license.

NeonDiff pricing is for the software/support entitlement only. Users bring
their own provider key or local model. NeonDiff does not include hosted model
credits, unlimited SaaS inference, or bundled provider tokens.

## Support Tiers

| Tier | Price | Best For | Private Repos | Commercial Use | Auto-Updates | Provider Credits |
| --- | ---: | --- | --- | --- | --- | --- |
| Free OSS | $0 | Public open-source projects | No | No | No | Not included |
| Monthly Support | $1/mo | Low-friction private or commercial use | Yes | Yes | Yes | Not included |
| Yearly Support | $10/yr | Annual support license | Yes | Yes | Yes | Not included |
| Lifetime Support | $100 lifetime | One-time support license | Yes | Yes | Yes | Not included |

## CLI Contract

Use the CLI to inspect the canonical pricing and entitlement shape that docs,
license copy, and website copy should follow:

```bash
neondiff pricing
```

The pricing command emits JSON by default and does not call the network. It reports:

- public open-source repositories are free
- paid support tiers are `$1/mo`, `$10/yr`, and `$100 lifetime`
- paid support includes private repo review, commercial usage, and auto-updates
- provider/model costs stay external through BYOK or local providers
- hosted model credits and unlimited SaaS inference are not included

## Entitlement Shape

Free OSS mode is scoped to public open-source repository review. Paid support
licenses map to entitlement plans for private repository review, commercial
usage, and auto-updates:

- `monthly_support`
- `yearly_support`
- `lifetime_support`

Runtime license enforcement is outside this pricing command. This document only
defines the pricing and entitlement vocabulary that enforcement code and setup
docs should use.

## Tracking

- Public product roadmap: https://github.com/electricsheephq/evaos-code-review-bot/issues/103
- License/commercial boundary gate: https://github.com/electricsheephq/evaos-code-review-bot/issues/104
- Pricing implementation: https://github.com/electricsheephq/evaos-code-review-bot/issues/105
