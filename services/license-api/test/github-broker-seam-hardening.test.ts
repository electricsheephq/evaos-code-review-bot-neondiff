import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authorizeTokenIssuance,
  type EntitlementSnapshot,
  type RequestedRepository
} from "../src/github-broker/index.ts";

/**
 * Security-review hardening of the pure issuance seam (PR #620 AC8 findings):
 *  - P2 (fail-OPEN): an entitlement status outside the known union (contract
 *    drift, a future license state, malformed/undefined) must FAIL CLOSED, never
 *    fall through to an allow+mint.
 *  - P3 (coarse collapse): a request spanning several private repositories must
 *    be authorized PER REPOSITORY — the whole request is denied unless every
 *    requested private repo is covered by the active entitlement.
 */

function repo(fullName: string, visibility: RequestedRepository["visibility"], id: number): RequestedRepository {
  return { fullName, id, visibility };
}

const PUB = repo("octo/site", "public", 1);
const PRIV_A = repo("octo/a", "private", 2);
const PRIV_B = repo("octo/b", "private", 3);

describe("issuance seam hardening (#620 security review)", () => {
  // ---- P2: out-of-union / undefined entitlement status fails closed ----
  it("denies a private request when the entitlement status is outside the known union (drift)", () => {
    const drifted = { status: "some_future_state" } as unknown as EntitlementSnapshot;
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A], entitlement: drifted });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_invalid");
  });

  it("denies a private request when the entitlement snapshot has no status (malformed)", () => {
    const malformed = {} as unknown as EntitlementSnapshot;
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A], entitlement: malformed });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_invalid");
  });

  it("denies a private request when the active snapshot omits its covered set (drift)", () => {
    const noCoverage = { status: "active" } as unknown as EntitlementSnapshot;
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A], entitlement: noCoverage });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    // An active license that names no covered private repos covers none.
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_scope_insufficient");
  });

  it("denies a private request when the active entitlement covers an empty set", () => {
    const empty: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: [] };
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A], entitlement: empty });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_scope_insufficient");
  });

  // ---- P3: per-repository coverage ----
  it("allows only when every requested private repo is covered by the active entitlement", () => {
    const covered: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: ["octo/a", "octo/b"] };
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A, PRIV_B], entitlement: covered });
    assert.equal(decision.decision, "allow", JSON.stringify(decision));
    assert.deepEqual(decision.decision === "allow" ? decision.repositories : undefined, ["octo/a", "octo/b"]);
  });

  it("denies the whole request when a private repo in a mixed set is uncovered", () => {
    const partial: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: ["octo/a"] };
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A, PRIV_B], entitlement: partial });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_scope_insufficient");
  });

  it("allows a single covered private repo, and ignores public repos when checking coverage", () => {
    const covered: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: ["octo/a"] };
    const decision = authorizeTokenIssuance({ requestedRepositories: [PUB, PRIV_A], entitlement: covered });
    assert.equal(decision.decision, "allow", JSON.stringify(decision));
    assert.deepEqual(decision.decision === "allow" ? decision.repositories : undefined, ["octo/site", "octo/a"]);
  });

  it("denies when the active entitlement covers a different repo than the one requested", () => {
    const covered: EntitlementSnapshot = { status: "active", coveredPrivateRepositories: ["octo/other"] };
    const decision = authorizeTokenIssuance({ requestedRepositories: [PRIV_A], entitlement: covered });
    assert.equal(decision.decision, "deny", JSON.stringify(decision));
    assert.equal(decision.decision === "deny" ? decision.reason : undefined, "entitlement_scope_insufficient");
  });
});
