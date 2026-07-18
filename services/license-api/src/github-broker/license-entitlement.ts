import type { EntitlementResolver } from "./service.js";
import type { LicenseStore } from "../store.js";

const MAX_ACTIVATION_KEY_LENGTH = 512;

/**
 * Resolve a private-repository broker request against the production license
 * store. The raw Activation Key is used only for this in-memory lookup and is
 * never returned, logged, or persisted by the broker.
 *
 * Private coverage is deliberately narrower than license validity: the license
 * must be active and unexpired, and its activation must already bind this exact
 * authenticated broker device to the exact requested repository.
 */
export function createLicenseStoreEntitlementResolver(
  store: LicenseStore,
  now: () => Date = () => new Date()
): EntitlementResolver {
  return (context) => {
    const activationKey = normalizeActivationKey(context.activationKey);
    if (!activationKey) return { status: "none" };

    const license = store.getLicenseByKey(activationKey);
    if (!license) return { status: "invalid" };
    if (license.status === "revoked") return { status: "revoked" };
    if (
      license.status === "expired"
      || (license.expiresAt !== undefined
        && Number.isFinite(Date.parse(license.expiresAt))
        && Date.parse(license.expiresAt) <= now().getTime())
    ) {
      return { status: "expired" };
    }

    const activation = store.getActivation(license.licenseKeyHash, context.deviceId);
    if (!activation) return { status: "replay_conflict" };

    if (
      !license.privateRepoAllowed
      || license.repoVisibilityScope === "public"
      || !activation.repo
    ) {
      return { status: "active", coveredPrivateRepositories: [] };
    }

    return {
      status: "active",
      coveredPrivateRepositories: context.privateRepositories.includes(activation.repo)
        ? [activation.repo]
        : []
    };
  };
}

function normalizeActivationKey(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > MAX_ACTIVATION_KEY_LENGTH) return undefined;
  return trimmed;
}
