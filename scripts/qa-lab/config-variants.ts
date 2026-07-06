/**
 * Config-variant fixture definitions for the QA lab timing harness (#341).
 *
 * Pass 1 is hermetic: only the "baseline" variant is actually executed for timing. The other
 * variants (github related context, gitnexus context, repo memory, issue enrichment, self
 * consistency) exist here as config fixtures only, per the issue's pass-1/pass-2 split -- their
 * add-on paths call out to providers/GitHub and are out of scope until pass 2 supplies real
 * provider/GitHub env. This module is the seam pass 2 hooks into: it only needs a new case in
 * `applyVariant` plus (if pass 2 wires live calls) a runner change, no scenario-shape rework.
 */
import type { BotConfig } from "../../src/config.js";

/**
 * `BotConfig`'s add-on sections are optional on the type (a caller MAY omit them from a raw JSON
 * file) but `loadConfigFromObject` always deep-merges onto its internal defaults and validates
 * before returning, so every section is populated on any `BotConfig` that reached this module.
 * This narrows the optional field for the compiler with a runtime assertion instead of an `as`
 * cast, so a genuine loader regression fails loudly here rather than silently typing around it.
 */
function requireField<K extends keyof BotConfig>(config: BotConfig, key: K): NonNullable<BotConfig[K]> {
  const value = config[key];
  if (value === undefined) {
    throw new Error(`qa-lab config variant expected config.${String(key)} to be populated by loadConfigFromObject`);
  }
  return value as NonNullable<BotConfig[K]>;
}

export type QaLabConfigVariantId =
  | "baseline"
  | "github_related_context"
  | "gitnexus_context"
  | "repo_memory"
  | "enrichment"
  | "self_consistency";

export const QA_LAB_CONFIG_VARIANT_IDS: QaLabConfigVariantId[] = [
  "baseline",
  "github_related_context",
  "gitnexus_context",
  "repo_memory",
  "enrichment",
  "self_consistency"
];

/** Variants whose timing pass 1 actually executes. All others are fixture-only until pass 2. */
export const HERMETIC_EXECUTABLE_VARIANTS: QaLabConfigVariantId[] = ["baseline"];

export interface QaLabConfigVariant {
  id: QaLabConfigVariantId;
  description: string;
  /** Whether this variant's add-on path requires provider/GitHub calls (out of scope for pass 1). */
  requiresLiveProviderOrGithub: boolean;
  applyVariant: (base: BotConfig) => BotConfig;
}

export const QA_LAB_CONFIG_VARIANTS: QaLabConfigVariant[] = [
  {
    id: "baseline",
    description: "All add-ons off; deterministic-gate-only timing.",
    requiresLiveProviderOrGithub: false,
    applyVariant: (base) => base
  },
  {
    id: "github_related_context",
    description: "githubRelatedContext.enabled=true (pass 2: requires live GitHub calls).",
    requiresLiveProviderOrGithub: true,
    applyVariant: (base) => ({
      ...base,
      githubRelatedContext: { ...requireField(base, "githubRelatedContext"), enabled: true }
    })
  },
  {
    id: "gitnexus_context",
    description: "gitnexusContext.enabled=true (pass 2: requires a live GitNexus adapter/index).",
    requiresLiveProviderOrGithub: true,
    applyVariant: (base) => ({
      ...base,
      gitnexusContext: { ...requireField(base, "gitnexusContext"), enabled: true }
    })
  },
  {
    id: "repo_memory",
    description: "repoMemory.enabled=true (fixture only; on-disk memory packet build is in scope for pass 2 timing).",
    requiresLiveProviderOrGithub: false,
    applyVariant: (base) => ({
      ...base,
      repoMemory: { ...requireField(base, "repoMemory"), enabled: true }
    })
  },
  {
    id: "enrichment",
    description: "issueEnrichment.enabled=true (pass 2: requires live provider + GitHub issue calls).",
    requiresLiveProviderOrGithub: true,
    applyVariant: (base) => ({
      ...base,
      issueEnrichment: { ...requireField(base, "issueEnrichment"), enabled: true }
    })
  },
  {
    id: "self_consistency",
    description: "reviewGate.selfConsistency.enabled=true (pass 2: requires an extra live provider call per re-checked finding).",
    requiresLiveProviderOrGithub: true,
    applyVariant: (base) => {
      const reviewGate = requireField(base, "reviewGate");
      return {
        ...base,
        reviewGate: {
          ...reviewGate,
          selfConsistency: { ...reviewGate.selfConsistency, enabled: true }
        }
      };
    }
  }
];

export function findConfigVariant(id: string): QaLabConfigVariant | undefined {
  return QA_LAB_CONFIG_VARIANTS.find((variant) => variant.id === id);
}
