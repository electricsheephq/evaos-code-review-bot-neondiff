import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { BrokerError, type BrokerReason } from "../src/github-broker/index.ts";

/**
 * The client-facing typed error contract for the #614 entitlement decisions.
 * Native and CLI consumers key their locked/free explanations and recovery
 * actions off these reason codes and HTTP statuses; this pins the contract so a
 * status change is a deliberate, reviewed break. Bodies stay public-safe: a fixed
 * shape carrying only the reason and a redaction-safe detail phrase.
 */

const ENTITLEMENT_REASON_STATUS: Array<[BrokerReason, number]> = [
  ["entitlement_missing", 403],
  ["entitlement_expired", 403],
  ["entitlement_revoked", 403],
  ["entitlement_invalid", 403],
  ["entitlement_scope_insufficient", 403],
  ["entitlement_seat_exhausted", 409],
  ["entitlement_replay_conflict", 409],
  ["entitlement_service_unavailable", 503],
  ["visibility_unknown", 403]
];

describe("github broker #614 typed reason-code contract", () => {
  for (const [reason, status] of ENTITLEMENT_REASON_STATUS) {
    it(`${reason} surfaces HTTP ${status} with a public-safe body`, () => {
      const error = new BrokerError(reason, "a fixed public-safe phrase");
      assert.equal(error.httpStatus, status);
      const body = error.body();
      assert.deepEqual(Object.keys(body).sort(), ["detail", "reason", "status"]);
      assert.equal(body.status, "error");
      assert.equal(body.reason, reason);
      assert.equal(body.detail, "a fixed public-safe phrase");
    });
  }

  it("the retired pre-#614 placeholder reason is no longer part of the contract", () => {
    // entitlement_gate_not_implemented was the #613 fail-closed default; #614
    // replaces it with the concrete entitlement reason codes above, so it no
    // longer maps to a status.
    const retired = "entitlement_gate_not_implemented" as BrokerReason;
    assert.equal(new BrokerError(retired).httpStatus, undefined);
  });
});
