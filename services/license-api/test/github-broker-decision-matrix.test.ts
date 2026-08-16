import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeTokenIssuance,
  type EntitlementSnapshot,
  type RequestedRepository
} from "../src/github-broker/index.ts";

/**
 * Unit decision-matrix for the #614 authorization boundary. This drives the pure
 * seam function directly across visibility × installation-binding × entitlement ×
 * seat × service-state, so the whole policy is table-provable without the HTTP
 * stack. Red first against the #613 placeholder (which denies every private repo
 * with a single `entitlement_gate_not_implemented`); green once the seam binds the
 * full matrix. The public/no-key row and the unknown-fails-closed row are the two
 * load-bearing anchors: public work must succeed with no Activation Key, and any
 * visibility the App could not authoritatively determine must fail closed.
 */

function repo(fullName: string, visibility: RequestedRepository["visibility"], id = 1): RequestedRepository {
  return { fullName, id, visibility };
}

const PUBLIC = repo("octo/site", "public", 11);
const PRIVATE = repo("octo/secret", "private", 12);
const INTERNAL = repo("octo/internal", "internal", 13);
const UNKNOWN = repo("octo/mystery", "unknown", 14);

const ACTIVE_PRIVATE: EntitlementSnapshot = {
  status: "active",
  coveredPrivateRepositories: ["octo/secret", "octo/internal"]
};
const ACTIVE_PUBLIC_ONLY: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: [] };

interface Row {
  name: string;
  repositories: RequestedRepository[];
  entitlement?: EntitlementSnapshot;
  expect:
    | { decision: "allow"; repositories: string[] }
    | { decision: "deny"; reason: string };
}

const MATRIX: Row[] = [
  // Public tier — no Activation Key required (layer-3 policy). Entitlement is not
  // consulted at all on the all-public path.
  {
    name: "public repo, no entitlement (public-free)",
    repositories: [PUBLIC],
    entitlement: { status: "none" },
    expect: { decision: "allow", repositories: ["octo/site"] }
  },
  {
    name: "public repo, entitlement omitted entirely (public-free)",
    repositories: [PUBLIC],
    expect: { decision: "allow", repositories: ["octo/site"] }
  },
  {
    name: "multiple public repos, no entitlement",
    repositories: [PUBLIC, repo("octo/docs", "public", 15)],
    entitlement: { status: "none" },
    expect: { decision: "allow", repositories: ["octo/site", "octo/docs"] }
  },
  // Unknown / ambiguous visibility — fail closed, never assume public. Wins even
  // over a present entitlement and even when mixed with a public repo.
  {
    name: "unknown visibility fails closed",
    repositories: [UNKNOWN],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "deny", reason: "visibility_unknown" }
  },
  {
    name: "public + unknown fails closed on the unknown",
    repositories: [PUBLIC, UNKNOWN],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "deny", reason: "visibility_unknown" }
  },
  // Private / internal — an active, private-covering entitlement is required.
  {
    name: "private repo with active private-covering entitlement",
    repositories: [PRIVATE],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "allow", repositories: ["octo/secret"] }
  },
  {
    name: "internal repo with active private-covering entitlement",
    repositories: [INTERNAL],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "allow", repositories: ["octo/internal"] }
  },
  {
    name: "public + private with active private-covering entitlement",
    repositories: [PUBLIC, PRIVATE],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "allow", repositories: ["octo/site", "octo/secret"] }
  },
  {
    name: "private repo with a public-only active license (scope insufficient)",
    repositories: [PRIVATE],
    entitlement: ACTIVE_PUBLIC_ONLY,
    expect: { decision: "deny", reason: "entitlement_scope_insufficient" }
  },
  {
    name: "private repo with no entitlement (missing)",
    repositories: [PRIVATE],
    entitlement: { status: "none" },
    expect: { decision: "deny", reason: "entitlement_missing" }
  },
  {
    name: "private repo, entitlement omitted (fail-closed default = missing)",
    repositories: [PRIVATE],
    expect: { decision: "deny", reason: "entitlement_missing" }
  },
  {
    name: "private repo with expired entitlement",
    repositories: [PRIVATE],
    entitlement: { status: "expired" },
    expect: { decision: "deny", reason: "entitlement_expired" }
  },
  {
    name: "private repo with revoked entitlement",
    repositories: [PRIVATE],
    entitlement: { status: "revoked" },
    expect: { decision: "deny", reason: "entitlement_revoked" }
  },
  {
    name: "private repo with invalid entitlement",
    repositories: [PRIVATE],
    entitlement: { status: "invalid" },
    expect: { decision: "deny", reason: "entitlement_invalid" }
  },
  {
    name: "private repo over seat allocation",
    repositories: [PRIVATE],
    entitlement: { status: "seat_exhausted" },
    expect: { decision: "deny", reason: "entitlement_seat_exhausted" }
  },
  {
    name: "private repo with an event-order (replay) conflict",
    repositories: [PRIVATE],
    entitlement: { status: "replay_conflict" },
    expect: { decision: "deny", reason: "entitlement_replay_conflict" }
  },
  {
    name: "private repo when the license service is unavailable",
    repositories: [PRIVATE],
    entitlement: { status: "service_unavailable" },
    expect: { decision: "deny", reason: "entitlement_service_unavailable" }
  },
  // Empty request is a malformed request, independent of entitlement.
  {
    name: "empty repository set is invalid",
    repositories: [],
    entitlement: ACTIVE_PRIVATE,
    expect: { decision: "deny", reason: "invalid_request" }
  }
];

describe("github broker issuance decision matrix (#614)", () => {
  for (const row of MATRIX) {
    it(row.name, () => {
      const decision = authorizeTokenIssuance({
        requestedRepositories: row.repositories,
        ...(row.entitlement ? { entitlement: row.entitlement } : {})
      });
      if (row.expect.decision === "allow") {
        assert.equal(decision.decision, "allow", JSON.stringify(decision));
        assert.deepEqual(
          decision.decision === "allow" ? decision.repositories : undefined,
          row.expect.repositories
        );
      } else {
        assert.equal(decision.decision, "deny", JSON.stringify(decision));
        assert.equal(decision.decision === "deny" ? decision.reason : undefined, row.expect.reason);
      }
    });
  }

  it("a provider key never substitutes for entitlement: only an active private-covering license unlocks private", () => {
    // The seam has no provider-key input by construction; the ONLY snapshot that
    // flips a private request to allow is an active, private-covering entitlement.
    const flips = (["active-private", "active-public", "expired", "revoked", "invalid", "seat_exhausted", "replay_conflict", "service_unavailable", "none"] as const).filter((label) => {
      const entitlement: EntitlementSnapshot =
        label === "active-private"
          ? ACTIVE_PRIVATE
          : label === "active-public"
            ? ACTIVE_PUBLIC_ONLY
            : { status: label as Exclude<EntitlementSnapshot["status"], "active"> };
      return authorizeTokenIssuance({ requestedRepositories: [PRIVATE], entitlement }).decision === "allow";
    });
    assert.deepEqual(flips, ["active-private"]);
  });
});
