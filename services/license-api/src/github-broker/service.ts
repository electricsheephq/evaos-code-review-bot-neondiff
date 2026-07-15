import { randomBytes } from "node:crypto";
import { createHash } from "node:crypto";
import { RateLimiter } from "../service.js";
import { authorizeTokenIssuance, type RequestedRepository } from "./authorization.js";
import { authenticateDevice, deviceIdFromPublicJwk } from "./device-auth.js";
import { BrokerError } from "./errors.js";
import {
  GitHubBrokerClientError,
  type GitHubInstallationClient,
  type InstallationSummary
} from "./github-app.js";
import { GitHubBrokerStore } from "./store.js";

const STATE_TTL_MS = 10 * 60 * 1_000;
const MAX_REPOSITORIES_PER_REQUEST = 50;

export interface GitHubBrokerServiceOptions {
  store: GitHubBrokerStore;
  githubClient: GitHubInstallationClient;
  /** Official App install URL, e.g. https://github.com/apps/<app>/installations/new. */
  installBaseUrl: string;
  now?: () => Date;
  deviceRegisterRateLimiter?: RateLimiter;
  connectRateLimiter?: RateLimiter;
  tokenRateLimiter?: RateLimiter;
}

/**
 * The managed GitHub App authorization broker. Custody of the App private key
 * lives behind `githubClient`; this service verifies the native device session
 * and the installation binding, then issues bounded short-lived installation
 * tokens through the single `authorizeTokenIssuance` seam. All failures are typed
 * and fail closed.
 */
export class GitHubBrokerService {
  private readonly store: GitHubBrokerStore;
  private readonly githubClient: GitHubInstallationClient;
  private readonly installBaseUrl: string;
  private readonly now: () => Date;
  private readonly deviceRegisterRateLimiter: RateLimiter;
  private readonly connectRateLimiter: RateLimiter;
  private readonly tokenRateLimiter: RateLimiter;

  constructor(options: GitHubBrokerServiceOptions) {
    this.store = options.store;
    this.githubClient = options.githubClient;
    this.installBaseUrl = options.installBaseUrl;
    this.now = options.now ?? (() => new Date());
    this.deviceRegisterRateLimiter =
      options.deviceRegisterRateLimiter ?? new RateLimiter({ maxPerWindow: 20, windowMs: 60_000 });
    this.connectRateLimiter =
      options.connectRateLimiter ?? new RateLimiter({ maxPerWindow: 30, windowMs: 60_000 });
    this.tokenRateLimiter =
      options.tokenRateLimiter ?? new RateLimiter({ maxPerWindow: 60, windowMs: 60_000 });
  }

  /** POST /device/register — anonymous, rate-limited by source address. */
  async registerDevice(body: unknown, sourceAddress: string): Promise<Record<string, unknown>> {
    const at = this.now();
    if (!this.deviceRegisterRateLimiter.allow(hashKey(`register:${sourceAddress}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many device registrations");
    }
    const record = asObject(body);
    const { deviceId, publicJwk } = await deviceIdFromPublicJwk(record.publicKeyJwk);
    this.store.upsertDevice(deviceId, JSON.stringify(publicJwk), at.toISOString());
    return { status: "registered", deviceId };
  }

  /** POST /github/connect/start — device-authenticated; returns the install URL + one-shot state. */
  async connectStart(authorization: string | string[] | undefined): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    if (!this.connectRateLimiter.allow(hashKey(`connect:${deviceId}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many connect attempts");
    }
    const state = randomBytes(32).toString("base64url");
    const expiresAt = new Date(at.getTime() + STATE_TTL_MS);
    this.store.createConnectState(state, deviceId, at.toISOString(), expiresAt.toISOString());
    const installUrl = appendStateParam(this.installBaseUrl, state);
    return { status: "connect_started", installUrl, state, expiresAt: expiresAt.toISOString() };
  }

  /**
   * GET /github/connect/callback — the browser return from GitHub. Verifies the
   * one-shot state, confirms the installation belongs to the App, and records the
   * (device, installation) binding. Returns a small HTML page telling the user to
   * return to the app (no URL scheme is registered in v1; see the design doc).
   */
  async connectCallback(query: URLSearchParams): Promise<{ html: string }> {
    const at = this.now();
    const installationIdRaw = query.get("installation_id");
    const state = query.get("state");
    if (!state || !installationIdRaw) {
      throw new BrokerError("invalid_request", "installation_id and state are required");
    }
    const installationId = parseInstallationId(installationIdRaw);

    const stored = this.store.getConnectState(state);
    if (!stored) throw new BrokerError("state_not_found", "connect state is not recognized");
    if (stored.consumed_at) throw new BrokerError("state_replayed", "connect state was already used");
    if (Date.parse(stored.expires_at) <= at.getTime()) {
      throw new BrokerError("state_expired", "connect state has expired");
    }

    const installation = await this.resolveInstallation(installationId);

    // One-shot: only the first caller flips consumed_at; a race loses as a replay.
    if (!this.store.consumeConnectState(state, installationId, at.toISOString())) {
      throw new BrokerError("state_replayed", "connect state was already used");
    }
    this.store.upsertBinding(stored.device_id, installationId, installation.account_login, at.toISOString());
    return { html: connectReturnPage() };
  }

  /** POST /github/connect/complete — device polls to confirm the binding landed. */
  async connectComplete(
    authorization: string | string[] | undefined,
    body: unknown
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    const record = asObject(body);
    const state = record.state;
    if (typeof state !== "string" || state.length === 0) {
      throw new BrokerError("invalid_request", "state is required");
    }
    const stored = this.store.getConnectState(state);
    if (!stored || stored.device_id !== deviceId) {
      throw new BrokerError("state_not_found", "connect state is not recognized");
    }
    if (!stored.consumed_at || stored.installation_id === null) {
      return { status: "pending" };
    }
    const binding = this.store.getBinding(deviceId, stored.installation_id);
    if (!binding) throw new BrokerError("binding_not_found", "installation binding was not found");
    return { status: "bound", installationId: stored.installation_id };
  }

  /**
   * POST /github/token — device-authenticated. Verifies the binding and
   * installation liveness, narrows to the requested repositories, runs the
   * issuance seam, and only on `allow` mints a bounded installation token. The
   * App key never appears in the response; every terminal decision is logged to
   * the append-only ledger.
   */
  async issueToken(
    authorization: string | string[] | undefined,
    body: unknown
  ): Promise<Record<string, unknown>> {
    const at = this.now();
    const deviceId = await authenticateDevice(this.store, authorization, at);
    const { installationId, repositories, permissions } = parseTokenRequest(body);

    if (!this.tokenRateLimiter.allow(hashKey(`token:${deviceId}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many token requests for this device");
    }
    if (!this.tokenRateLimiter.allow(hashKey(`token-inst:${installationId}`), at.getTime())) {
      throw new BrokerError("rate_limited", "too many token requests for this installation");
    }

    try {
      const binding = this.store.getBinding(deviceId, installationId);
      if (!binding) throw new BrokerError("binding_not_found", "no binding for this device and installation");

      const installation = await this.resolveInstallation(installationId, { uninstalledIsGone: true });
      if (installation.suspended) throw new BrokerError("installation_suspended", "installation is suspended");

      const requested = await this.resolveRequestedRepositories(installationId, repositories);

      // The issuance seam: the ONLY path to minting. #614 replaces its body.
      const decision = authorizeTokenIssuance({ requestedRepositories: requested });
      if (decision.decision === "deny") {
        throw new BrokerError(decision.reason, "token issuance is not authorized for the requested repositories");
      }

      const minted = await this.mintToken(installationId, decision.repositories, permissions);
      this.store.appendDecision(deviceId, installationId, "allow", "issued", at.toISOString());
      return {
        status: "issued",
        token: minted.token,
        expiresAt: minted.expires_at,
        repositories: decision.repositories,
        ...(permissions ? { permissions } : {})
      };
    } catch (error) {
      if (error instanceof BrokerError) {
        this.store.appendDecision(deviceId, installationId, "deny", error.reason, at.toISOString());
      }
      throw error;
    }
  }

  private async resolveInstallation(
    installationId: number,
    options: { uninstalledIsGone?: boolean } = {}
  ): Promise<InstallationSummary> {
    let installation: InstallationSummary | null;
    try {
      installation = await this.githubClient.getInstallation(installationId);
    } catch (error) {
      throw mapClientError(error);
    }
    if (!installation) {
      throw new BrokerError(
        options.uninstalledIsGone ? "installation_uninstalled" : "installation_not_found",
        "installation was not found"
      );
    }
    return installation;
  }

  private async resolveRequestedRepositories(
    installationId: number,
    repositories: string[]
  ): Promise<RequestedRepository[]> {
    let available;
    try {
      available = await this.githubClient.listInstallationRepositories(installationId);
    } catch (error) {
      throw mapClientError(error);
    }
    const byName = new Map(available.map((repository) => [repository.full_name, repository]));
    return repositories.map((fullName) => {
      const match = byName.get(fullName);
      if (!match) throw new BrokerError("repo_outside_installation", "a requested repository is not in the installation selection");
      return { fullName, visibility: match.visibility };
    });
  }

  private async mintToken(
    installationId: number,
    repositories: string[],
    permissions: Record<string, string> | undefined
  ): Promise<{ token: string; expires_at: string }> {
    try {
      return await this.githubClient.createInstallationAccessToken(installationId, {
        repositories,
        ...(permissions ? { permissions } : {})
      });
    } catch (error) {
      throw mapClientError(error);
    }
  }
}

function mapClientError(error: unknown): BrokerError {
  if (error instanceof BrokerError) return error;
  if (error instanceof GitHubBrokerClientError) {
    if (error.brokerClientErrorClass === "rate_limited") return new BrokerError("rate_limited", "GitHub rate limit reached");
    if (error.brokerClientErrorClass === "renamed_or_transferred") {
      return new BrokerError("repo_renamed_or_transferred", "a repository was renamed or transferred");
    }
    return new BrokerError("broker_unavailable", "GitHub is temporarily unavailable");
  }
  // Duck-typed fakes may attach a broker client error class without the class instance.
  if (typeof error === "object" && error !== null && "brokerClientErrorClass" in error) {
    const klass = (error as { brokerClientErrorClass: string }).brokerClientErrorClass;
    if (klass === "rate_limited") return new BrokerError("rate_limited", "GitHub rate limit reached");
    if (klass === "renamed_or_transferred") return new BrokerError("repo_renamed_or_transferred", "a repository was renamed or transferred");
    return new BrokerError("broker_unavailable", "GitHub is temporarily unavailable");
  }
  return new BrokerError("broker_unavailable", "GitHub is temporarily unavailable");
}

function parseTokenRequest(body: unknown): {
  installationId: number;
  repositories: string[];
  permissions?: Record<string, string>;
} {
  const record = asObject(body);
  const installationId = parseInstallationId(record.installationId);
  const repositoriesRaw = record.repositories;
  if (!Array.isArray(repositoriesRaw) || repositoriesRaw.length === 0) {
    throw new BrokerError("invalid_request", "repositories must be a non-empty array");
  }
  if (repositoriesRaw.length > MAX_REPOSITORIES_PER_REQUEST) {
    throw new BrokerError("invalid_request", "too many repositories requested");
  }
  const repositories = repositoriesRaw.map((value) => {
    if (typeof value !== "string" || !/^[^/\s]+\/[^/\s]+$/.test(value)) {
      throw new BrokerError("invalid_request", "each repository must be 'owner/name'");
    }
    return value;
  });
  const permissions = parsePermissions(record.permissions);
  return { installationId, repositories, ...(permissions ? { permissions } : {}) };
}

function parsePermissions(value: unknown): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new BrokerError("invalid_request", "permissions must be an object");
  }
  const permissions: Record<string, string> = {};
  for (const [key, scope] of Object.entries(value)) {
    if (!/^[a-z_]{1,40}$/.test(key) || typeof scope !== "string" || !/^(read|write|admin)$/.test(scope)) {
      throw new BrokerError("invalid_request", "permissions must map scope names to read/write/admin");
    }
    permissions[key] = scope;
  }
  return Object.keys(permissions).length > 0 ? permissions : undefined;
}

function parseInstallationId(value: unknown): number {
  const numeric = typeof value === "string" ? Number(value) : value;
  if (typeof numeric !== "number" || !Number.isInteger(numeric) || numeric <= 0) {
    throw new BrokerError("invalid_request", "installationId must be a positive integer");
  }
  return numeric;
}

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new BrokerError("invalid_request", "request body must be a JSON object");
  }
  return body as Record<string, unknown>;
}

function appendStateParam(installBaseUrl: string, state: string): string {
  const url = new URL(installBaseUrl);
  url.searchParams.set("state", state);
  return url.toString();
}

function hashKey(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function connectReturnPage(): string {
  return [
    "<!doctype html>",
    "<html lang=\"en\"><head><meta charset=\"utf-8\">",
    "<meta name=\"viewport\" content=\"width=device-width, initial-scale=1\">",
    "<title>NeonDiff connected</title></head>",
    "<body><main><h1>GitHub connected</h1>",
    "<p>You can return to the NeonDiff app. It will finish connecting automatically.</p>",
    "</main></body></html>"
  ].join("");
}
