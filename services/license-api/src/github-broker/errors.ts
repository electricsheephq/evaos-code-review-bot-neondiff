/**
 * Typed, fail-closed broker outcomes. Every refusal in the broker is one of
 * these reason codes; there is never a silent pass or a fallback to a user token
 * (see docs/security/github-app-broker.md, "Failure and abuse states"). Reason
 * codes and their HTTP mapping are the client-facing contract.
 */
export type BrokerReason =
  | "invalid_request"
  | "device_not_registered"
  | "invalid_device_credential"
  | "state_not_found"
  | "state_expired"
  | "state_replayed"
  | "binding_not_found"
  | "installation_not_found"
  | "installation_uninstalled"
  | "installation_suspended"
  | "installation_authorization_unverified"
  | "repo_outside_installation"
  | "repo_outside_authorization"
  | "repo_renamed_or_transferred"
  | "visibility_unknown"
  | "entitlement_missing"
  | "entitlement_expired"
  | "entitlement_revoked"
  | "entitlement_invalid"
  | "entitlement_scope_insufficient"
  | "entitlement_seat_exhausted"
  | "entitlement_replay_conflict"
  | "entitlement_service_unavailable"
  | "rate_limited"
  | "broker_unavailable";

const REASON_STATUS: Record<BrokerReason, number> = {
  invalid_request: 400,
  device_not_registered: 401,
  invalid_device_credential: 401,
  state_not_found: 404,
  state_expired: 409,
  state_replayed: 409,
  binding_not_found: 404,
  installation_not_found: 404,
  installation_uninstalled: 409,
  installation_suspended: 409,
  installation_authorization_unverified: 403,
  repo_outside_installation: 403,
  repo_outside_authorization: 403,
  repo_renamed_or_transferred: 409,
  visibility_unknown: 403,
  entitlement_missing: 403,
  entitlement_expired: 403,
  entitlement_revoked: 403,
  entitlement_invalid: 403,
  entitlement_scope_insufficient: 403,
  entitlement_seat_exhausted: 409,
  entitlement_replay_conflict: 409,
  entitlement_service_unavailable: 503,
  rate_limited: 429,
  broker_unavailable: 503
};

/**
 * A typed broker refusal. `detail` is a fixed, public-safe phrase — it never
 * carries token, key, nonce, or repository-content material (redaction
 * discipline mirrors src/secrets.ts).
 */
export class BrokerError extends Error {
  readonly reason: BrokerReason;
  readonly httpStatus: number;

  constructor(reason: BrokerReason, detail?: string) {
    super(detail ?? reason);
    this.name = "BrokerError";
    this.reason = reason;
    this.httpStatus = REASON_STATUS[reason];
  }

  body(): Record<string, unknown> {
    return { status: "error", reason: this.reason, detail: this.message };
  }
}
