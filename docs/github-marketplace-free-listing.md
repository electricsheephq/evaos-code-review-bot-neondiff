# Retired GitHub Marketplace Free-Listing Packet

Issue: #428

This packet is retained only as a superseded planning record. The free-use
listing strategy is retired: the current NeonDiff CLI (v1.0.x) requires
API-backed activation for public, private, internal, and unknown repository
work. No Marketplace billing or listing is shipped by this packet.

From NeonDiff 1.1.0, review of repositories that GitHub reports as public is
free with no license key through the GitHub Action, `neondiff review-pr --ci`, and the self-hosted
worker (`daemon`, `run-once`, `review-pr`, `providers verify`)
(the Mac app still requires a license key, #1203); private, internal, and unknown-visibility repositories
require an active NeonDiff license. A Marketplace listing is a separate decision
and is not part of that change.

Do not publish the former free-listing copy or imply that installing the GitHub
App grants review entitlement. A future Marketplace listing must represent the
active paid/trial entitlement model, implement the required purchase and
cancellation webhooks, provide a valid privacy-policy URL, and pass a fresh
security/product review. The owner must approve and click the final Marketplace
publish button.

Current references:

- Marketplace requirements: https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app
- Pricing plans: https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps
- Listing workflow: https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace
- Security contact: support@electricsheephq.com
- Repository policy: `SECURITY.md`

Provider/model costs stay external through BYOK or local providers. Do not paste
beta, public-preview, or retired free-use wording into a future Marketplace
listing.
