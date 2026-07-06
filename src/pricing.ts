export type NeonDiffPricingPlanId =
  | "free_oss"
  | "monthly_support"
  | "yearly_support"
  | "organization_yearly"
  | "lifetime_support";

export interface NeonDiffPricingPlan {
  id: NeonDiffPricingPlanId;
  name: string;
  priceUsd: number;
  displayPrice: string;
  cadence: "public open-source repositories" | "month" | "year";
  summary: string;
  requiresPaidLicense: boolean;
  repoVisibilityScope: "public" | "private";
  commercialUse: boolean;
  autoUpdates: boolean;
  providerCreditsIncluded: false;
  entitlementPlan?: "monthly_support" | "yearly_support" | "organization_yearly" | "lifetime_support";
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
    providerCreditsIncluded: false
  },
  {
    id: "monthly_support",
    name: "Monthly Support",
    priceUsd: 1,
    displayPrice: "$1/mo",
    cadence: "month",
    summary: "Paid support tier for private repo review, commercial use, and auto-updates.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    entitlementPlan: "monthly_support"
  },
  {
    id: "yearly_support",
    name: "Yearly Support",
    priceUsd: 10,
    displayPrice: "$10/yr",
    cadence: "year",
    summary: "Annual paid support tier for private repo review, commercial use, and auto-updates.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    entitlementPlan: "yearly_support"
  },
  {
    id: "organization_yearly",
    name: "Organization Yearly",
    priceUsd: 100,
    displayPrice: "$100/yr",
    cadence: "year",
    summary: "Flat yearly organization support tier for private repo review, commercial use, and auto-updates.",
    requiresPaidLicense: true,
    repoVisibilityScope: "private",
    commercialUse: true,
    autoUpdates: true,
    providerCreditsIncluded: false,
    entitlementPlan: "organization_yearly"
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
        acceptedPlanIds: ["monthly_support", "yearly_support", "organization_yearly", "lifetime_support"],
        legacyReadOnlyPlanIds: ["lifetime_support"]
      }
    },
    sourceOfTruth: {
      roadmap: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/103",
      licenseBoundary: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/104",
      pricingImplementation: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/105",
      organizationEntitlements: "https://github.com/electricsheephq/evaos-code-review-bot-neondiff/issues/329"
    },
    forbiddenClaims: [
      "hosted model credits included",
      "unlimited SaaS inference included",
      "free private repo review",
      "OSI open-source license"
    ]
  };
}
