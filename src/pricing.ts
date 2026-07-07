export type NeonDiffPricingPlanId =
  | "free_oss"
  | "monthly_support"
  | "yearly_support"
  | "org_yearly_support"
  | "lifetime_support";

export type NeonDiffActiveCheckoutLookupKey =
  | "neondiff_monthly"
  | "neondiff_yearly"
  | "neondiff_org_yearly";

export interface NeonDiffPricingPlan {
  id: NeonDiffPricingPlanId;
  name: string;
  priceUsd: number;
  displayPrice: string;
  cadence: "public open-source repositories" | "month" | "year" | "legacy";
  summary: string;
  requiresPaidLicense: boolean;
  repoVisibilityScope: "public" | "private";
  commercialUse: boolean;
  autoUpdates: boolean;
  providerCreditsIncluded: false;
  buyerSegment: "public" | "individual" | "organization" | "legacy";
  availableForNewPurchase: boolean;
  trialDays?: 7 | 30;
  checkoutLookupKey?: NeonDiffActiveCheckoutLookupKey;
  entitlementPlan?: Exclude<NeonDiffPricingPlanId, "free_oss">;
  legacyNote?: string;
}

export const NEONDIFF_PRICING_PLANS: readonly NeonDiffPricingPlan[] = [
  {
    id: "free_oss",
    name: "Free OSS",
    priceUsd: 0,
    displayPrice: "$0",
    cadence: "public open-source repositories",
    summary: "Free local review for public open-source projects.",
    requiresPaidLicense: false,
    repoVisibilityScope: "public",
    commercialUse: false,
    autoUpdates: false,
    providerCreditsIncluded: false,
    buyerSegment: "public",
    availableForNewPurchase: true
  },
  {
    id: "monthly_support",
    name: "Individual Monthly",
    priceUsd: 1,
    displayPrice: "$1/mo",
    cadence: "month",
    summary: "Single-user monthly support tier for private repo review, commercial use, and auto-updates.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    buyerSegment: "individual",
    availableForNewPurchase: true,
    trialDays: 7,
    checkoutLookupKey: "neondiff_monthly",
    entitlementPlan: "monthly_support"
  },
  {
    id: "yearly_support",
    name: "Individual Yearly",
    priceUsd: 10,
    displayPrice: "$10/yr",
    cadence: "year",
    summary: "Single-user yearly support tier for private repo review, commercial use, and auto-updates.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    buyerSegment: "individual",
    availableForNewPurchase: true,
    trialDays: 7,
    checkoutLookupKey: "neondiff_yearly",
    entitlementPlan: "yearly_support"
  },
  {
    id: "org_yearly_support",
    name: "Organization Yearly",
    priceUsd: 100,
    displayPrice: "$100/yr",
    cadence: "year",
    summary: "Flat organization yearly support tier for private and commercial repositories.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    buyerSegment: "organization",
    availableForNewPurchase: true,
    trialDays: 30,
    checkoutLookupKey: "neondiff_org_yearly",
    entitlementPlan: "org_yearly_support"
  },
  {
    id: "lifetime_support",
    name: "Legacy Lifetime Support",
    priceUsd: 100,
    displayPrice: "legacy; no longer sold",
    cadence: "legacy",
    summary: "Legacy lifetime licenses remain honored for existing holders but are no longer sold.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    buyerSegment: "legacy",
    availableForNewPurchase: false,
    entitlementPlan: "lifetime_support",
    legacyNote: "Existing lifetime license holders remain entitled; new lifetime checkout is disabled."
  }
] as const;

export function buildPricingOutput() {
  return {
    ok: true,
    command: "pricing",
    product: "NeonDiff",
    currency: "USD",
    billingModel: "local-first support tiers",
    sourceAvailableBeta: true,
    publicOpenSourceReposFree: true,
    paidTierIncludes: [
      "private repo review",
      "commercial usage",
      "auto-updates"
    ],
    providerCosts: {
      model: "BYOK or local provider",
      includedHostedModelCredits: false,
      detail: "NeonDiff pricing does not include hosted model credits, unlimited SaaS inference, or bundled provider tokens."
    },
    plans: NEONDIFF_PRICING_PLANS,
    entitlementShape: {
      freeOss: {
        repoVisibilityScope: "public",
        requiresPaidLicense: false,
        commercialUse: false,
        autoUpdates: false
      },
      paidSupport: {
        repoVisibilityScope: "private",
        requiresPaidLicense: true,
        commercialUse: true,
        autoUpdates: true,
        activeCheckoutPlanIds: ["monthly_support", "yearly_support", "org_yearly_support"],
        legacyAcceptedPlanIds: ["lifetime_support"],
        acceptedPlanIds: ["monthly_support", "yearly_support", "org_yearly_support", "lifetime_support"],
        checkoutLookupKeys: ["neondiff_monthly", "neondiff_yearly", "neondiff_org_yearly"],
        trialDays: {
          individual: 7,
          organization: 30
        }
      }
    },
    sourceOfTruth: {
      roadmap: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103",
      licenseBoundary: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104",
      pricingImplementation: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105",
      pricingParityGate: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/421"
    },
    forbiddenClaims: [
      "hosted model credits included",
      "unlimited SaaS inference included",
      "free private repo review",
      "OSI open-source license"
    ]
  };
}
