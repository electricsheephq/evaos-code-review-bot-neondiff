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
 * stays pure and table-testable. `none` is the public-free default — no NeonDiff
 * Activation Key was presented. The broker never derives entitlement from a
 * provider key; only an active entitlement whose coverage names a repository
 * unlocks that repository.
 *
 * `active` authorizes ONLY the repositories in `coveredPrivateRepositories`
 * (matched by `owner/name`). This is per-repository, not a single global
 * boolean: a request spanning several private repos is authorized only when
 * every one of them is covered (the resolver enumerates the covered set from the
 * account/license scope). A public-only license covers none (empty set).
 */
export type EntitlementSnapshot =
  | { status: "active"; coveredPrivateRepositories: string[] }
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
 *   4. otherwise (at least one private/internal repository) an active entitlement
 *      that covers EVERY requested private repository is required; any other
 *      state — or any private repo the active entitlement does not cover — denies
 *      with a distinct fail-closed reason code (AC3/AC4/AC5). The snapshot is
 *      resolved from the license authority before this runs, so the decision
 *      function stays pure; an omitted snapshot fails closed as `none`.
 *
 * The ONLY path that returns `allow` for a non-public request is an explicit,
 * per-repository coverage match; every other input — including an entitlement
 * status outside the known union (contract drift) — falls through to a
 * fail-closed deny (never an implicit allow).
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
  const nonPublic = repositories.filter((repository) => repository.visibility !== "public");
  if (nonPublic.length === 0) {
    return allow;
  }
  const entitlement = input.entitlement ?? { status: "none" };
  // Fail closed by construction: the sole authorizing branch is an active
  // entitlement whose covered set names every requested private repository.
  if (entitlement.status === "active" && Array.isArray(entitlement.coveredPrivateRepositories)) {
    const covered = new Set(entitlement.coveredPrivateRepositories);
    if (nonPublic.every((repository) => covered.has(repository.fullName))) {
      return allow;
    }
    return { decision: "deny", reason: "entitlement_scope_insufficient" };
  }
  return { decision: "deny", reason: entitlementDenialReason(entitlement) };
}

/**
 * Map a non-authorizing entitlement snapshot to its fail-closed reason code. The
 * `default` is load-bearing: any status outside the known union (contract drift,
 * a future license state, a malformed snapshot) denies as `entitlement_invalid`
 * rather than falling through — the seam never mints on an unrecognized state.
 */
function entitlementDenialReason(entitlement: EntitlementSnapshot): BrokerReason {
  switch (entitlement.status) {
    case "active":
      // An active snapshot without a usable covered set covers nothing.
      return "entitlement_scope_insufficient";
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
    default:
      return "entitlement_invalid";
  }
}
