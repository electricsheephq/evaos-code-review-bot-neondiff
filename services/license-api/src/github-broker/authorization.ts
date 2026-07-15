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
 * installation token (the gate-every-caller rule). #614 replaces the body of this
 * ONE function to add the repository-visibility + entitlement binding — callers
 * and the surrounding issuance flow do not change.
 *
 * Pre-#614 policy (fail closed): authorize ONLY when every requested repository is
 * verified public. Any private/internal repository denies with
 * `entitlement_gate_not_implemented`; unknown visibility denies with
 * `visibility_unknown` (never assume public). Callers resolve each requested
 * repository against the installation's current selection before calling this, so
 * a repo outside the installation never reaches the seam.
 */
export function authorizeTokenIssuance(input: {
  requestedRepositories: RequestedRepository[];
  entitlement?: EntitlementSnapshot;
}): IssuanceAuthorizationDecision {
  if (input.requestedRepositories.length === 0) {
    return { decision: "deny", reason: "invalid_request" };
  }
  for (const repository of input.requestedRepositories) {
    if (repository.visibility === "unknown") {
      return { decision: "deny", reason: "visibility_unknown" };
    }
    if (repository.visibility !== "public") {
      return { decision: "deny", reason: "entitlement_gate_not_implemented" };
    }
  }
  return {
    decision: "allow",
    repositories: input.requestedRepositories.map((repository) => repository.fullName)
  };
}
