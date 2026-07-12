import type { RepoVisibilityScope } from "./store.js";

export const CHECKOUT_LOOKUP_KEYS = [
  "neondiff_monthly",
  "neondiff_yearly",
  "neondiff_org_yearly"
] as const;

export type CheckoutLookupKey = (typeof CHECKOUT_LOOKUP_KEYS)[number];

export interface CheckoutPolicy {
  plan: string;
  trialDays: number;
  maximumPeriodDays: number;
  currency: "usd";
  seats: 1;
  repoVisibilityScope: RepoVisibilityScope;
  privateRepoAllowed: true;
  updateEntitlement: true;
}

const CHECKOUT_POLICIES: Record<CheckoutLookupKey, CheckoutPolicy> = {
  neondiff_monthly: {
    plan: "monthly_support",
    trialDays: 7,
    maximumPeriodDays: 62,
    currency: "usd",
    seats: 1,
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true
  },
  neondiff_yearly: {
    plan: "yearly_support",
    trialDays: 7,
    maximumPeriodDays: 400,
    currency: "usd",
    seats: 1,
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true
  },
  neondiff_org_yearly: {
    plan: "org_yearly_support",
    trialDays: 30,
    maximumPeriodDays: 400,
    currency: "usd",
    seats: 1,
    repoVisibilityScope: "private",
    privateRepoAllowed: true,
    updateEntitlement: true
  }
};

export function checkoutPolicyFor(key: CheckoutLookupKey): CheckoutPolicy {
  return CHECKOUT_POLICIES[key];
}

export function isCheckoutLookupKey(value: string): value is CheckoutLookupKey {
  return Object.prototype.hasOwnProperty.call(CHECKOUT_POLICIES, value);
}
