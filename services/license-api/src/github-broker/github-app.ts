import { createSign } from "node:crypto";
import { buildApiUrl, normalizeHttpApiBaseUrl } from "./url.js";

/**
 * Server-side GitHub App boundary for the broker. This is the only place the App
 * private key is used, and only to sign short-lived App JWTs at runtime — the key
 * is never persisted, logged, or returned. The interface is what the broker
 * service depends on; tests inject an in-memory fake, so no live GitHub call ever
 * runs under test.
 */

export type GitHubRepositoryVisibility = "public" | "private" | "internal" | "unknown";

export interface InstallationSummary {
  id: number;
  account_login?: string;
  suspended: boolean;
}

export interface InstallationRepository {
  id: number;
  full_name: string;
  visibility: GitHubRepositoryVisibility;
}

export interface InstallationRepositoryPage {
  repositories: InstallationRepository[];
  totalCount: number;
  hasNextPage: boolean;
}

export interface InstallationAccessToken {
  token: string;
  expires_at: string;
}

/** Transient/redirect classes the service maps to typed broker reasons. */
export type GitHubBrokerClientErrorClass = "rate_limited" | "renamed_or_transferred" | "unavailable";

export class GitHubBrokerClientError extends Error {
  readonly brokerClientErrorClass: GitHubBrokerClientErrorClass;
  constructor(brokerClientErrorClass: GitHubBrokerClientErrorClass, message: string) {
    super(message);
    this.name = "GitHubBrokerClientError";
    this.brokerClientErrorClass = brokerClientErrorClass;
  }
}

export interface GitHubInstallationClient {
  /** Resolve an installation by id; returns null when it does not exist (uninstalled). */
  getInstallation(installationId: number): Promise<InstallationSummary | null>;
  /**
   * Verify that the identity behind an install-time OAuth authorization code is
   * actually authorized for `installationId` — i.e. the user who completed the
   * GitHub "Request user authorization (OAuth) during installation" flow can
   * access this installation — AND return the exact set of repositories that user
   * can access within it (the authorized set the binding is scoped to). Returns
   * the repository `owner/name` list (possibly empty) when the exchanged user
   * identity can access the installation; returns `null` to DENY the binding when
   * the identity cannot be proven for this installation (no OAuth credentials, a
   * bad/absent code, or the installation is not among the user's accessible ones).
   * Transient failures throw a typed client error so the caller fails closed.
   *
   * This closes two callback forgeries: (1) a valid connect-state alone can no
   * longer bind a device to an arbitrary (victim) installation id; and (2) an
   * entitled but GitHub-unauthorized user can no longer mint a token for a private
   * repo they cannot access — the binding, and every later token, is confined to
   * the user's authorized repository set, not the whole installation selection.
   */
  verifyInstallationForAuthorizationCode(
    installationId: number,
    authorizationCode: string
  ): Promise<string[] | null>;
  /**
   * Verify an already-installed App from a transient GitHub App user access
   * token obtained through Device Flow. The token proves only that the user can
   * access this exact installation and yields the exact authorized repository
   * set. It is never persisted, logged, returned, or used to post a review.
   */
  verifyInstallationForUserToken(
    installationId: number,
    userAccessToken: string
  ): Promise<string[] | null>;
  /** The installation's current repository selection, with each repo's visibility. */
  listInstallationRepositories(installationId: number): Promise<InstallationRepository[]>;
  /**
   * One bounded page of the installation's current repository selection. Native
   * discovery uses this seam so each customer-visible page consumes exactly one
   * upstream list request rather than draining the full installation repeatedly.
   */
  listInstallationRepositoriesPage(
    installationId: number,
    page: number,
    perPage: number
  ): Promise<InstallationRepositoryPage>;
  /** Mint a narrowed installation access token. This is the RETURNED token; it is
   * reached only after the issuance seam authorizes the request. Narrowing uses
   * `repositoryIds` (GitHub's canonical `repository_ids`), never `owner/name`. */
  createInstallationAccessToken(
    installationId: number,
    params: { repositoryIds?: number[]; permissions?: Record<string, string> }
  ): Promise<InstallationAccessToken>;
}

export interface GitHubAppConfig {
  appId: string;
  /** PEM contents, read at runtime from the deployment secret store. Never stored by the broker. */
  privateKey: string;
  apiBaseUrl?: string;
  requestTimeoutMs?: number;
  /**
   * OAuth client credentials for the App's "Request user authorization (OAuth)
   * during installation" flow, used only to exchange the callback authorization
   * code for a short-lived user token when verifying installation ownership. Both
   * are OWNER-GATED deployment secrets (see docs/security/github-app-staging-registration.md);
   * when either is absent, callback identity verification fails closed.
   */
  oauthClientId?: string;
  oauthClientSecret?: string;
  /** OAuth authorization host; defaults to https://github.com. */
  oauthBaseUrl?: string;
}

/**
 * Sign a short-lived GitHub App JWT (RS256). Mirrors src/github.ts createAppJwt;
 * license-api is its own package, so it keeps its own small helper rather than
 * importing across the package boundary.
 */
export function createAppJwt(
  appId: string,
  privateKey: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat: nowSeconds - 60, exp: nowSeconds + 540, iss: appId });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

/**
 * Production GitHub installation client. Not exercised by tests (no live calls in
 * CI); wired in server.ts when the owner provisions the App id + private key.
 */
export function createGitHubInstallationClient(config: GitHubAppConfig): GitHubInstallationClient {
  const apiBaseUrl = normalizeHttpApiBaseUrl(config.apiBaseUrl, "githubBroker.apiBaseUrl", "https://api.github.com");

  async function request<T>(
    path: string,
    options: { method?: string; token: string; body?: unknown }
  ): Promise<{ status: number; json: T | undefined; text: string }> {
    let response: Response;
    const controller = config.requestTimeoutMs ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(new Error(`GitHub API request timed out for ${path}`)), config.requestTimeoutMs)
      : undefined;
    try {
      response = await fetch(buildApiUrl(apiBaseUrl, path, "GitHub broker request path"), {
        method: options.method ?? "GET",
        signal: controller?.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          Authorization: `Bearer ${options.token}`,
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch {
      throw new GitHubBrokerClientError("unavailable", `GitHub API fetch failed for ${path}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
    const text = await response.text();
    if (!response.ok) classifyAndThrow(response.status, text, path);
    return { status: response.status, json: text ? (JSON.parse(text) as T) : undefined, text };
  }

  async function installationToken(
    installationId: number,
    params: { repositoryIds?: number[]; permissions?: Record<string, string> }
  ): Promise<InstallationAccessToken> {
    const jwt = createAppJwt(config.appId, config.privateKey);
    const body: Record<string, unknown> = {};
    if (params.repositoryIds) body.repository_ids = params.repositoryIds;
    if (params.permissions) body.permissions = params.permissions;
    const result = await request<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: jwt, body }
    );
    if (!result.json) throw new GitHubBrokerClientError("unavailable", "installation token response was empty");
    return { token: result.json.token, expires_at: result.json.expires_at };
  }

  async function authorizedRepositoriesForUserToken(
    installationId: number,
    userToken: string
  ): Promise<string[] | null> {
    const authorized: string[] = [];
    for (let page = 1; ; page += 1) {
      let result;
      try {
        result = await request<{ repositories?: Array<{ full_name: string }> }>(
          `/user/installations/${installationId}/repositories?per_page=100&page=${page}`,
          { token: userToken }
        );
      } catch (error) {
        if (
          error instanceof GitHubApiStatusError
          && (error.status === 401 || error.status === 403 || error.status === 404)
        ) {
          return null;
        }
        throw error;
      }
      const chunk = result.json?.repositories ?? [];
      for (const repository of chunk) authorized.push(repository.full_name);
      if (chunk.length < 100) return authorized;
    }
  }

  return {
    async getInstallation(installationId: number): Promise<InstallationSummary | null> {
      const jwt = createAppJwt(config.appId, config.privateKey);
      try {
        const result = await request<{ id: number; suspended_at?: string | null; account?: { login?: string } }>(
          `/app/installations/${installationId}`,
          { token: jwt }
        );
        if (!result.json) return null;
        return {
          id: result.json.id,
          account_login: result.json.account?.login,
          suspended: Boolean(result.json.suspended_at)
        };
      } catch (error) {
        if (error instanceof GitHubBrokerClientError) throw error;
        if (isNotFound(error)) return null;
        throw error;
      }
    },
    async verifyInstallationForAuthorizationCode(
      installationId: number,
      authorizationCode: string
    ): Promise<string[] | null> {
      // Owner-gated: without the OAuth-during-install client credentials the
      // broker cannot prove installation ownership, so identity is UNVERIFIED.
      // Return null (not a transient error) so the callback surfaces the
      // documented pre-provisioning reason `installation_authorization_unverified`
      // (403), not a broker outage (503).
      if (!config.oauthClientId || !config.oauthClientSecret) {
        return null;
      }
      const oauthBaseUrl = normalizeHttpApiBaseUrl(config.oauthBaseUrl, "githubBroker.oauthBaseUrl", "https://github.com");
      // Build the endpoint with the URL resolver so a base with (or without) a
      // trailing slash never produces a `//login/...` double slash that a strict
      // OAuth host/proxy would 404.
      const tokenUrl = new URL("/login/oauth/access_token", oauthBaseUrl).toString();
      // GitHub's App web flow expects form-encoded parameters (not JSON) at this
      // endpoint; keep `Accept: application/json` so the response is parseable.
      const tokenForm = new URLSearchParams({
        client_id: config.oauthClientId,
        client_secret: config.oauthClientSecret,
        code: authorizationCode
      });
      // Honor the configured request timeout so a stalled token exchange fails
      // closed as a typed broker outage instead of holding the listener open.
      let tokenResponse: Response;
      const controller = config.requestTimeoutMs ? new AbortController() : undefined;
      const timeout = controller
        ? setTimeout(() => controller.abort(new Error("OAuth token exchange timed out")), config.requestTimeoutMs)
        : undefined;
      try {
        tokenResponse = await fetch(tokenUrl, {
          method: "POST",
          signal: controller?.signal,
          headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
          body: tokenForm.toString()
        });
      } catch {
        throw new GitHubBrokerClientError("unavailable", "OAuth token exchange failed");
      } finally {
        if (timeout) clearTimeout(timeout);
      }
      if (!tokenResponse.ok) {
        throw new GitHubBrokerClientError("unavailable", `OAuth token exchange ${tokenResponse.status}`);
      }
      const tokenBody = (await tokenResponse.json().catch(() => undefined)) as { access_token?: string } | undefined;
      const userToken = tokenBody?.access_token;
      // A bad/expired/forged code yields no user token: deny the binding (not a
      // transient error — the identity was not proven).
      if (!userToken) return null;
      return authorizedRepositoriesForUserToken(installationId, userToken);
    },
    async verifyInstallationForUserToken(
      installationId: number,
      userAccessToken: string
    ): Promise<string[] | null> {
      return authorizedRepositoriesForUserToken(installationId, userAccessToken);
    },
    async listInstallationRepositories(installationId: number): Promise<InstallationRepository[]> {
      // Listing an installation's repositories requires an installation token. It is
      // scoped to metadata:read ONLY — the minimum needed to read visibility for the
      // seam decision — so no broad, all-permissions token is ever minted before
      // authorizeTokenIssuance runs. This is not the token returned to the client.
      const token = (await installationToken(installationId, { permissions: { metadata: "read" } })).token;
      const repositories: InstallationRepository[] = [];
      for (let page = 1; ; page += 1) {
        const result = await request<{ repositories: Array<{ id: number; full_name: string; visibility?: string; private?: boolean }> }>(
          `/installation/repositories?per_page=100&page=${page}`,
          { token }
        );
        const chunk = result.json?.repositories ?? [];
        for (const repository of chunk) {
          repositories.push({
            id: repository.id,
            full_name: repository.full_name,
            visibility: normalizeVisibility(repository.visibility, repository.private)
          });
        }
        if (chunk.length < 100) return repositories;
      }
    },
    async listInstallationRepositoriesPage(
      installationId: number,
      page: number,
      perPage: number
    ): Promise<InstallationRepositoryPage> {
      // Discovery needs only one bounded upstream page. The internal token stays
      // metadata:read-only and is never returned to the device.
      const token = (await installationToken(installationId, { permissions: { metadata: "read" } })).token;
      const result = await request<{
        total_count?: number;
        repositories?: Array<{
          id: number;
          full_name: string;
          visibility?: string;
          private?: boolean;
        }>;
      }>(
        `/installation/repositories?per_page=${perPage}&page=${page}`,
        { token }
      );
      const totalCount = result.json?.total_count;
      if (typeof totalCount !== "number" || !Number.isSafeInteger(totalCount) || totalCount < 0) {
        throw new GitHubBrokerClientError("unavailable", "installation repository count was invalid");
      }
      const repositories = (result.json?.repositories ?? []).map((repository) => ({
        id: repository.id,
        full_name: repository.full_name,
        visibility: normalizeVisibility(repository.visibility, repository.private)
      }));
      return {
        repositories,
        totalCount,
        hasNextPage: page * perPage < totalCount
      };
    },
    createInstallationAccessToken(installationId, params) {
      return installationToken(installationId, {
        ...(params.repositoryIds ? { repositoryIds: params.repositoryIds } : {}),
        ...(params.permissions ? { permissions: params.permissions } : {})
      });
    }
  };
}

function normalizeVisibility(visibility: string | undefined, isPrivate: boolean | undefined): GitHubRepositoryVisibility {
  if (visibility === "public" || visibility === "private" || visibility === "internal") return visibility;
  if (isPrivate === true) return "private";
  if (isPrivate === false) return "public";
  return "unknown";
}

function isNotFound(error: unknown): boolean {
  return error instanceof GitHubApiStatusError && error.status === 404;
}

class GitHubApiStatusError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function classifyAndThrow(status: number, body: string, path: string): never {
  if (/\b(rate limit|secondary rate limit|abuse detection)\b/i.test(body)) {
    throw new GitHubBrokerClientError("rate_limited", `GitHub API rate limited for ${path}`);
  }
  if (status === 301 || status === 302 || status === 307 || status === 308) {
    throw new GitHubBrokerClientError("renamed_or_transferred", `GitHub API redirected for ${path}`);
  }
  if (status >= 500) {
    throw new GitHubBrokerClientError("unavailable", `GitHub API ${status} for ${path}`);
  }
  throw new GitHubApiStatusError(status, `GitHub API ${status} for ${path}`);
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
