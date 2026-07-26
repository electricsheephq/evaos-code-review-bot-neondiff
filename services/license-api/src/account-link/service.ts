import { createHash, randomBytes } from "node:crypto";
import { RateLimiter } from "../service.js";
import { authenticateDevice, deviceIdFromPublicJwk } from "../github-broker/device-auth.js";
import { BrokerError } from "../github-broker/errors.js";
import { GitHubBrokerStore } from "../github-broker/store.js";

const STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_ACCESS_TOKEN_LENGTH = 4_096;

export interface AccountBotSnapshot {
  id: string;
  appId: number;
  appSlug: string;
  mode: "byo" | "managed";
  githubInstallationId: number | null;
  githubAccountLogin: string | null;
  status: "pending" | "verified" | "suspended" | "revoked";
}

export interface AccountWorkspaceSnapshot {
  accounts: Array<{
    id: string;
    kind: "personal" | "organization";
    name: string;
    role: "owner" | "admin" | "member";
    entitlement: "public_free" | "paid" | "internal_admin" | "trial" | "none";
    bots: AccountBotSnapshot[];
  }>;
}

/** Trusted server seam for Lovable/Supabase identity verification and snapshots. */
export interface AccountAuthority {
  connectOrigin: string;
  verifyAccessToken(accessToken: string): Promise<string | null>;
  loadWorkspaceSnapshot(
    userId: string,
    deviceAuthorization: string
  ): Promise<AccountWorkspaceSnapshot>;
}

export interface AccountLinkServiceOptions {
  store: GitHubBrokerStore;
  authority: AccountAuthority;
  now?: () => Date;
  registerRateLimiter?: RateLimiter;
  connectRateLimiter?: RateLimiter;
  completeRateLimiter?: RateLimiter;
  workspaceRateLimiter?: RateLimiter;
}

/** B0-safe account linking; independent from the managed GitHub App runtime. */
export class AccountLinkService {
  private readonly store: GitHubBrokerStore;
  private readonly authority: AccountAuthority;
  private readonly now: () => Date;
  private readonly registerRateLimiter: RateLimiter;
  private readonly connectRateLimiter: RateLimiter;
  private readonly completeRateLimiter: RateLimiter;
  private readonly workspaceRateLimiter: RateLimiter;

  constructor(options: AccountLinkServiceOptions) {
    this.store = options.store;
    this.authority = options.authority;
    this.now = options.now ?? (() => new Date());
    this.registerRateLimiter =
      options.registerRateLimiter ?? new RateLimiter({ maxPerWindow: 20, windowMs: 60_000 });
    this.connectRateLimiter =
      options.connectRateLimiter ?? new RateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
    this.completeRateLimiter =
      options.completeRateLimiter ?? new RateLimiter({ maxPerWindow: 10, windowMs: 60_000 });
    this.workspaceRateLimiter =
      options.workspaceRateLimiter ?? new RateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
  }

  get connectOrigin(): string {
    return this.authority.connectOrigin;
  }

  async registerDevice(body: unknown, sourceAddress: string): Promise<Record<string, unknown>> {
    const at = this.now();
    if (!this.registerRateLimiter.allow(hash(`account-register:${sourceAddress}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many account device registrations");
    }
    const record = asObject(body);
    const { deviceId, publicJwk } = await deviceIdFromPublicJwk(record.publicKeyJwk);
    this.store.upsertDevice(deviceId, JSON.stringify(publicJwk), at.toISOString());
    return { status: "registered", deviceId };
  }

  async connectStart(
    authorization: string | string[] | undefined
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    if (!this.connectRateLimiter.allow(hash(`account-connect:${deviceId}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many account link attempts");
    }
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(at.getTime() + STATE_TTL_MS);
    this.store.createAccountConnectState(
      hash(state),
      deviceId,
      at.toISOString(),
      expiresAt.toISOString()
    );
    const connectUrl = new URL(this.authority.connectOrigin);
    connectUrl.searchParams.set("state", state);
    return {
      status: "account_connect_started",
      connectUrl: connectUrl.toString(),
      state,
      expiresAt: expiresAt.toISOString()
    };
  }

  async connectComplete(
    authorization: string | string[] | undefined,
    body: unknown
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const state = requiredState(body);
    const stateHash = hash(state);
    const stored = this.store.getAccountConnectState(stateHash);
    if (!stored) throw new BrokerError("state_not_found", "account link state is not recognized");
    if (stored.consumed_at) throw new BrokerError("state_replayed", "account link state was already used");
    if (Date.parse(stored.expires_at) <= at.getTime()) {
      throw new BrokerError("state_expired", "account link state has expired");
    }
    if (
      !this.completeRateLimiter.allow(
        hash(`account-complete:${stored.device_id}`),
        at.getTime()
      )
    ) {
      throw new BrokerError("rate_limited", "too many account completion attempts");
    }

    let userId: string | null;
    try {
      userId = await this.authority.verifyAccessToken(accountBearerToken(authorization));
    } catch (error) {
      if (error instanceof BrokerError) throw error;
      throw new BrokerError(
        "account_authority_unavailable",
        "account identity service is unavailable"
      );
    }
    if (!userId) {
      throw new BrokerError(
        "account_identity_unverified",
        "the signed-in account identity could not be verified"
      );
    }
    const completedAt = this.now();
    if (Date.parse(stored.expires_at) <= completedAt.getTime()) {
      throw new BrokerError("state_expired", "account link state has expired");
    }
    if (!this.store.consumeAccountConnectStateAndBind(
      stateHash,
      userId,
      completedAt.toISOString()
    )) {
      throw new BrokerError("state_replayed", "account link state was already used");
    }
    return { status: "account_linked" };
  }

  async workspaces(
    authorization: string | string[] | undefined,
    body: unknown = {}
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    const binding = this.store.getAccountBinding(deviceId);
    if (!binding) {
      throw new BrokerError("account_link_required", "link a signed-in NeonDiff account first");
    }
    const requestedState = optionalState(body);
    if (requestedState) {
      const state = this.store.getAccountConnectState(hash(requestedState));
      if (
        !state
        || state.device_id !== deviceId
        || state.consumed_at === null
        || state.bound_user_id !== binding.user_id
        || Date.parse(state.expires_at) <= at.getTime()
      ) {
        throw new BrokerError(
          "account_link_required",
          "finish this account link before loading workspaces"
        );
      }
    }
    if (!this.workspaceRateLimiter.allow(
      hash(`account-workspaces:${deviceId}`),
      at.getTime()
    )) {
      throw new BrokerError("rate_limited", "too many account workspace refreshes");
    }
    const deviceAuthorization = deviceBearerAuthorization(authorization);
    try {
      return {
        status: "ready",
        ...(await this.authority.loadWorkspaceSnapshot(
          binding.user_id,
          deviceAuthorization
        ))
      };
    } catch {
      throw new BrokerError(
        "account_authority_unavailable",
        "account workspace service is unavailable"
      );
    }
  }

  async introspectDevice(
    authorization: string | string[] | undefined
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    if (!this.workspaceRateLimiter.allow(
      hash(`account-introspect:${deviceId}`),
      at.getTime()
    )) {
      throw new BrokerError("rate_limited", "too many account device introspections");
    }
    const binding = this.store.getAccountBinding(deviceId);
    if (!binding) {
      throw new BrokerError("account_link_required", "link a signed-in NeonDiff account first");
    }
    return { status: "account_device_bound", userId: binding.user_id };
  }
}

function requiredState(body: unknown): string {
  const state = asObject(body).state;
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new BrokerError("invalid_request", "state is invalid");
  }
  return state;
}

function optionalState(body: unknown): string | undefined {
  const state = asObject(body).state;
  if (state === undefined) return undefined;
  if (typeof state !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(state)) {
    throw new BrokerError("invalid_request", "state is invalid");
  }
  return state;
}

function accountBearerToken(authorization: string | string[] | undefined): string {
  const value = Array.isArray(authorization) ? authorization[0] : authorization;
  if (!value?.startsWith("Bearer ")) {
    throw new BrokerError("account_identity_unverified", "signed-in account proof is required");
  }
  const token = value.slice("Bearer ".length);
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH || /\s/.test(token)) {
    throw new BrokerError("account_identity_unverified", "signed-in account proof is invalid");
  }
  return token;
}

function deviceBearerAuthorization(
  authorization: string | string[] | undefined
): string {
  if (Array.isArray(authorization)) {
    throw new BrokerError("invalid_device_credential", "device authentication is invalid");
  }
  const prefix = "Bearer ";
  if (!authorization?.startsWith(prefix)) {
    throw new BrokerError("invalid_device_credential", "device authentication is invalid");
  }
  const token = authorization.slice(prefix.length);
  if (!token || token.length > MAX_ACCESS_TOKEN_LENGTH || !/^[A-Za-z0-9._~-]+$/.test(token)) {
    throw new BrokerError("invalid_device_credential", "device authentication is invalid");
  }
  return authorization;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BrokerError("invalid_request", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
