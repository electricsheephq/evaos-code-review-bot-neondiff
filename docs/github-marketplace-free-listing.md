# GitHub Marketplace Free Listing Packet

Issue: #428
Status: owner-publish packet; not published by this repository change

This packet prepares a GitHub Marketplace free discoverability listing for the
NeonDiff GitHub App. It is intentionally a directory/listing packet, not a
Marketplace billing integration.

The owner clicks the final Marketplace publish button.

No Marketplace billing is shipped by this packet. Direct paid licenses remain
the current private/commercial repo entitlement path until the Team/Marketplace
entitlement work in #329 ships. The owner clicks the final Marketplace publish
button only after the compliance checkpoints below are satisfied.

## Current GitHub Policy Check

Point-in-time sources checked on 2026-07-08:

- Requirements for listing an app:
  https://docs.github.com/en/apps/github-marketplace/creating-apps-for-github-marketplace/requirements-for-listing-an-app
- Pricing plans for GitHub Marketplace apps:
  https://docs.github.com/en/apps/github-marketplace/selling-your-app-on-github-marketplace/pricing-plans-for-github-marketplace-apps
- Listing an app on GitHub Marketplace:
  https://docs.github.com/en/apps/github-marketplace/listing-an-app-on-github-marketplace
- GitHub Marketplace Developer Agreement:
  https://docs.github.com/en/site-policy/github-terms/github-marketplace-developer-agreement

Compliance read:

- GitHub allows free app listings and free pricing plans.
- Paid Marketplace plans require publisher/payment readiness and Marketplace
  purchase-event handling.
- Free-plan Marketplace apps still need purchase and cancellation webhook
  handling for Marketplace events.
- GitHub's pricing-plan docs currently prohibit a free Marketplace pricing plan
  when the app offers a paid service outside Marketplace.
- NeonDiff currently has direct paid private/commercial support licenses outside
  Marketplace.

Owner checkpoint before publish:

- Either get written GitHub Support/Marketplace confirmation that a free listing
  scoped only to free public open-source repo review is acceptable while direct
  private/commercial support licenses are sold elsewhere, or defer publication
  until #329 adds Marketplace-compatible paid plans and purchase-event handling.
- Do not publish copy that implies private/commercial NeonDiff use is free
  through Marketplace.
- Do not publish copy that implies Marketplace billing, seats, Team plans,
  Enterprise readiness, hosted review service, bundled provider credits, or
  auto-update entitlement is shipped.
- Do not paste beta or public-preview wording into the Marketplace listing
  unless GitHub confirms that wording is acceptable for this listing.

## Pre-Publish Blockers

- Publish blocker: provide a valid privacy-policy URL. README, Security.md
  (`SECURITY.md`), and license-boundary wording are useful source copy, but
  GitHub Marketplace requires a valid privacy-policy link in the listing form.
- Publish blocker: implement or explicitly defer Marketplace purchase-event
  webhooks. Free plans need at least new-purchase and cancellation handling;
  paid plans also need upgrade, downgrade, and trial handling.
- Publish blocker: create Marketplace logo and feature-card assets that meet
  GitHub's current listing-image requirements. The existing README hero is a
  brand asset, not proof that required Marketplace assets exist.
- Publish blocker: record the free-plan/direct-paid-license decision on #428
  with the exact GitHub pricing restriction quoted or linked.
- Publish blocker: remove or replace beta/public-preview listing copy if
  GitHub requires the app to be generally available before publication.

## Listing Fields

| Field | Draft value |
| --- | --- |
| App name | NeonDiff |
| Short description | Local-first AI PR review from your GitHub App, your provider key, and your repo policy. |
| Category | Code review |
| Secondary category | Developer tools |
| Pricing | Blocked until GitHub confirms the free-listing/direct-paid-license boundary or #329 adds Marketplace-compatible paid plans. |
| Website | https://www.neondiff.com |
| Support URL | https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/new/choose |
| Support email | support@electricsheephq.com; owner must verify monitoring before Marketplace publication. |
| Security URL | https://github.com/electricsheephq/evaos-code-review-bot-neondiff/security/policy |
| Privacy policy | Publish blocker: provide a valid privacy-policy URL before publication. |
| Privacy / data handling | Draft from README, Security.md (`SECURITY.md`), and docs/license-boundary.md after the privacy-policy URL exists. |
| Image assets | Publish blocker: create Marketplace logo and feature-card assets before publication. |
| Screenshot source | `assets/readme/neondiff-cyberpunk-hero.png`; owner must add real dashboard/setup screenshots before publication. |

## Listing Copy

### Summary

NeonDiff is a local-first AI pull-request reviewer for teams and agents that
want current-head review help without handing every diff to a hosted review
SaaS. It runs from your local worker, uses your GitHub App installation, and
routes model calls through your configured provider key or local model.

### Details

Use NeonDiff when you want:

- GitHub App based pull-request review from a local worker.
- Current-head duplicate suppression for each reviewed PR head.
- Inline comments only on valid current RIGHT-side diff lines.
- Secret-looking finding suppression before comments are posted.
- Dry-run evidence before live posting.
- Configurable repo policy and provider setup.
- Public-safe operator evidence for posted, skipped, dropped, or failed review
  decisions.

Public open-source repositories are free. Private and commercial repository
review requires a paid NeonDiff support license: $1/month or $10/year for
individuals, or $100/year for organizations. Individual plans include a 7-day
trial, organization plans include a 30-day trial, and legacy lifetime licenses
remain honored but are no longer sold. Provider/model costs stay external
through BYOK or local providers; NeonDiff does not include hosted model credits,
unlimited SaaS inference, or bundled provider tokens.

NeonDiff is source-available software, not open-source software. It does not
approve PRs, merge branches, push repairs, claim calibrated review accuracy, or
replace human review.

### Setup Notes

Marketplace installation should point users to the existing setup flow:

1. Install the GitHub App on selected repositories.
2. Install NeonDiff locally with `npm install -g neondiff`.
3. Run `neondiff dashboard --config config.local.json`.
4. Verify license status, GitHub App status, daemon status, and provider
   readiness with redacted output.
5. Run a dry-run PR review before any live posting.

## Screenshots

Minimum screenshot set before publish:

- Local HTML dashboard first-run setup/status view.
- Provider card with redacted `Verify API Key` pass/fail state.
- GitHub App status card showing selected-repo readiness without secrets.
- Example dry-run review evidence summary with private data redacted.

Use the existing hero image only as a brand asset. Do not use it as the only
screenshot because Marketplace users need to inspect the actual setup and
review flow.

## Publish Checklist

- Current GitHub Marketplace policy rechecked.
- Owner compliance decision recorded on #428.
- Free listing does not imply private/commercial use is free.
- Direct license path is described as outside Marketplace until #329.
- GitHub has confirmed the free-plan/direct-paid-license boundary, or #329 has
  shipped Marketplace-compatible paid plans.
- Marketplace new-purchase and cancellation webhook handling is shipped, or the
  owner has recorded why publication can proceed without it.
- A valid privacy-policy URL is available.
- Marketplace logo and feature-card assets exist.
- Do not paste beta or public-preview wording into the Marketplace listing.
- Support URL points to public-safe issue intake.
- Security reports route to SECURITY.md / private vulnerability reporting.
- Screenshots use real current UI and contain no secrets, private repo names,
  raw diffs, customer data, tokens, cookies, license keys, or connector URLs.
- Public claims scan passes for this packet.
- Owner performs final Marketplace publish action.

## Proof Boundary

This packet proves the listing copy, compliance questions, URLs, category, and
screenshot requirements are ready for owner review. It does not prove that the
GitHub Marketplace listing is live, approved, discoverable, billed through
Marketplace, or connected to a Marketplace entitlement flow.
