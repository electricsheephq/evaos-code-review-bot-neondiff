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
  /** The installation's current repository selection, with each repo's visibility. */
  listInstallationRepositories(installationId: number): Promise<InstallationRepository[]>;
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
