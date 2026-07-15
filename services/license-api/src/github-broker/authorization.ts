import type { BrokerReason } from "./errors.js";
import type { GitHubRepositoryVisibility } from "./github-app.js";

export interface RequestedRepository {
  fullName: string;
  /** The installation's canonical repository id, used to narrow the minted token. */
  id: number;
  visibility: GitHubRepositoryVisibility;
}

/**
 * The entitlement snapshot the seam binds a private/internal request against.
 * It is derived from the production entitlement contract (the license-api
 * `Entitlement`, merged #574) BEFORE the seam runs, so the decision function
 * stays pure and table-testable. `active` carries whether the live license
 * covers private repositories; every terminal state maps to a distinct
 * fail-closed reason code. `none` is the public-free default — no NeonDiff
 * Activation Key was presented. The broker never derives entitlement from a
 * provider key; only an active, private-covering entitlement unlocks private.
 */
export type EntitlementSnapshot =
  | { status: "active"; privateRepoAllowed: boolean }
  | { status: "expired" }
  | { status: "revoked" }
  | { status: "invalid" }
  | { status: "seat_exhausted" }
  | { status: "replay_conflict" }
  | { status: "service_unavailable" }
  | { status: "none" };

export type IssuanceAuthorizationDecision =
  | { decision: "allow"; repositories: string[] }
  | { decision: "deny"; reason: BrokerReason };

/**
 * THE single token-issuance decision point. Every mint path in the broker flows
 * through this function; there is no other code path that can authorize an
 * installation token (the gate-every-caller rule). Callers resolve each requested
 * repository against the installation's current selection before calling this, so
 * a repo outside the installation never reaches the seam.
 *
 * #614 policy (fail closed), evaluated in order:
 *   1. an empty request is `invalid_request`.
 *   2. any repository whose visibility the App could not authoritatively
 *      determine denies with `visibility_unknown` — never assume public (AC1/AC3).
 *   3. an all-public request is authorized with NO Activation Key required
 *      (the public-free layer-3 policy); the entitlement snapshot is not consulted.
 *   4. otherwise (at least one private/internal repository) an active,
 *      private-covering entitlement is required; every other entitlement state
 *      denies with its own distinct fail-closed reason code (AC3/AC4/AC5). The
 *      snapshot is resolved from the license authority before this runs, so the
 *      decision function stays pure; an omitted snapshot fails closed as `none`.
 */
export function authorizeTokenIssuance(input: {
  requestedRepositories: RequestedRepository[];
  entitlement?: EntitlementSnapshot;
}): IssuanceAuthorizationDecision {
  const repositories = input.requestedRepositories;
  if (repositories.length === 0) {
    return { decision: "deny", reason: "invalid_request" };
  }
  if (repositories.some((repository) => repository.visibility === "unknown")) {
    return { decision: "deny", reason: "visibility_unknown" };
  }
  const allow: IssuanceAuthorizationDecision = {
    decision: "allow",
    repositories: repositories.map((repository) => repository.fullName)
  };
  if (repositories.every((repository) => repository.visibility === "public")) {
    return allow;
  }
  const denial = entitlementDenialReason(input.entitlement ?? { status: "none" });
  return denial ? { decision: "deny", reason: denial } : allow;
}

/**
 * Map a non-public request's entitlement snapshot to its fail-closed reason code,
 * or `undefined` when the entitlement authorizes private/internal work. The only
 * authorizing state is an active license whose scope covers private repositories;
 * a provider key is never an input here, so it can never unlock private (AC5).
 */
function entitlementDenialReason(entitlement: EntitlementSnapshot): BrokerReason | undefined {
  switch (entitlement.status) {
    case "active":
      return entitlement.privateRepoAllowed ? undefined : "entitlement_scope_insufficient";
    case "expired":
      return "entitlement_expired";
    case "revoked":
      return "entitlement_revoked";
    case "invalid":
      return "entitlement_invalid";
    case "seat_exhausted":
      return "entitlement_seat_exhausted";
    case "replay_conflict":
      return "entitlement_replay_conflict";
    case "service_unavailable":
      return "entitlement_service_unavailable";
    case "none":
      return "entitlement_missing";
  }
}
