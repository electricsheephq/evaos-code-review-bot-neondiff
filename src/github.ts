import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IssueCommentCommandSource } from "./commands.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import { redactSecrets } from "./secrets.js";
import type { PullFilePatch, PullRequestSummary, RepositorySummary, ReviewComment, ReviewEvent } from "./types.js";
import { buildApiUrl, normalizeHttpApiBaseUrl } from "./url-safety.js";

export interface GitHubApiOptions {
  appId?: string;
  privateKeyPath?: string;
  token?: string;
  apiBaseUrl?: string;
  botLogin?: string;
  requestTimeoutMs?: number;
}

export type GitHubRepositoryVisibility = "public" | "private" | "internal" | "unknown";
export type GitHubRepositoryVisibilitySource = "repository_api" | "private_flag" | "unavailable";
export type GitHubRepositoryAccessErrorClass =
  | "missing_app_credentials"
  | "not_found"
  | "forbidden"
  | "resource_not_accessible"
  | "rate_limited"
  | "suspended_installation"
  | "renamed_or_transferred"
  | "server_error"
  | "network"
  | "unknown";

export interface GitHubRepositoryAccessProof {
  repo_full_name: string;
  readMode: "app_installation" | "fallback_token" | "unconfigured";
  visibility_result: GitHubRepositoryVisibility;
  visibility_source: GitHubRepositoryVisibilitySource;
  installation_id_present: boolean;
  app_can_read_metadata: boolean;
  app_can_read_pull_requests: boolean;
  openPullCount?: number;
  github_api_status?: number;
  github_api_error_class?: GitHubRepositoryAccessErrorClass;
  github_api_error?: string;
}

export class GitHubApiRequestError extends Error {
  readonly status: number;
  readonly statusText: string;
  readonly path: string;
  readonly responseText: string;

  constructor(input: { status: number; statusText: string; path: string; responseText: string }) {
    const responseText = redactSecrets(input.responseText);
    super(`GitHub API ${input.status} ${input.statusText} for ${input.path}: ${responseText.slice(0, 400)}`);
    this.name = "GitHubApiRequestError";
    this.status = input.status;
    this.statusText = input.statusText;
    this.path = input.path;
    this.responseText = responseText;
    Object.defineProperty(this, "responseText", {
      value: responseText,
      enumerable: false,
      configurable: false,
      writable: false
    });
  }
}

export class GitHubApi {
  private readonly appId?: string;
  private readonly privateKey?: string;
  private readonly token?: string;
  private readonly apiBaseUrl: URL;
  private readonly botLogin: string;
  private readonly requestTimeoutMs?: number;
  private installationTokens = new Map<string, { token: string; expiresAt: number }>();
  private repoInstallationTokens = new Map<string, { installationId: number; token: string; expiresAt: number }>();

  constructor(options: GitHubApiOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKeyPath ? readFileSync(options.privateKeyPath, "utf8") : undefined;
    this.token = options.token;
    this.apiBaseUrl = normalizeHttpApiBaseUrl(options.apiBaseUrl, "github.apiBaseUrl", "https://api.github.com");
    this.botLogin = options.botLogin ?? "evaos-code-review-bot[bot]";
    this.requestTimeoutMs = options.requestTimeoutMs;
  }

  canPostAsApp(): boolean {
    return Boolean(this.appId && this.privateKey);
  }

  async listOpenPulls(repo: string): Promise<PullRequestSummary[]> {
    const pulls: PullRequestSummary[] = [];
    for (let page = 1; ; page += 1) {
      const chunk = await this.request<PullRequestSummary[]>(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
        token: await this.getReadToken(repo)
      });
      pulls.push(...chunk.map(normalizePullRequestSummary));
      if (chunk.length < 100) return pulls;
    }
  }

  async getPull(repo: string, pullNumber: number): Promise<PullRequestSummary> {
    const pull = await this.request<PullRequestSummary>(`/repos/${repo}/pulls/${pullNumber}`, {
      token: await this.getReadToken(repo)
    });
    return normalizePullRequestSummary(pull);
  }

  async getRepo(repo: string): Promise<RepositorySummary> {
    return this.request<RepositorySummary>(`/repos/${repo}`, {
      token: await this.getReadToken(repo)
    });
  }

  async probeRepositoryAccess(repo: string): Promise<GitHubRepositoryAccessProof> {
    const readMode = this.canPostAsApp() ? "app_installation" : this.token ? "fallback_token" : "unconfigured";
    const base: GitHubRepositoryAccessProof = {
      repo_full_name: repo,
      readMode,
      visibility_result: "unknown",
      visibility_source: "unavailable",
      installation_id_present: false,
      app_can_read_metadata: false,
      app_can_read_pull_requests: false
    };
    if (!this.canPostAsApp()) {
      return {
        ...base,
        github_api_error_class: "missing_app_credentials",
        github_api_error: "GitHub App credentials are required for installation-scope proof."
      };
    }

    let installationId: number;
    try {
      installationId = await this.getInstallationId(repo, { followRedirects: false });
    } catch (error) {
      return { ...base, ...describeGitHubAccessError(error) };
    }

    let token: string;
    try {
      token = await this.getInstallationTokenForId(repo, installationId);
    } catch (error) {
      return { ...base, installation_id_present: true, ...describeGitHubAccessError(error) };
    }

    let metadata: RepositorySummary;
    try {
      metadata = await this.request<RepositorySummary>(`/repos/${repo}`, { token, followRedirects: false });
    } catch (error) {
      return { ...base, installation_id_present: true, ...describeGitHubAccessError(error) };
    }

    const visibility = visibilityFromRepositorySummary(metadata);
    try {
      const pulls = await this.listOpenPullsWithToken(repo, token, { followRedirects: false });
      return {
        repo_full_name: metadata.full_name || repo,
        readMode,
        visibility_result: visibility.result,
        visibility_source: visibility.source,
        installation_id_present: true,
        app_can_read_metadata: true,
        app_can_read_pull_requests: true,
        openPullCount: pulls.length
      };
    } catch (error) {
      return {
        repo_full_name: metadata.full_name || repo,
        readMode,
        visibility_result: visibility.result,
        visibility_source: visibility.source,
        installation_id_present: true,
        app_can_read_metadata: true,
        app_can_read_pull_requests: false,
        ...describeGitHubAccessError(error)
      };
    }
  }

  async listPullFiles(repo: string, pullNumber: number): Promise<PullFilePatch[]> {
    const files: PullFilePatch[] = [];
    for (let page = 1; ; page += 1) {
      const chunk = await this.request<PullFilePatch[]>(
        `/repos/${repo}/pulls/${pullNumber}/files?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      files.push(...chunk);
      if (chunk.length < 100) return files;
    }
  }

  async listIssueComments(repo: string, issueNumber: number): Promise<IssueCommentCommandSource[]> {
    const comments: IssueCommentCommandSource[] = [];
    for (let page = 1; ; page += 1) {
      const chunk = await this.request<IssueCommentCommandSource[]>(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      comments.push(...chunk);
      if (chunk.length < 100) return comments;
    }
  }

  async getIssueOrPull(
    repo: string,
    issueNumber: number,
    options: { tolerateUnreadable?: boolean } = {}
  ): Promise<GitHubRelatedIssueOrPull | undefined> {
    const path = `/repos/${repo}/issues/${issueNumber}`;
    try {
      return await this.request<GitHubRelatedIssueOrPull>(path, {
        token: await this.getReadToken(repo)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (options.tolerateUnreadable && isIssueLookupMissingOrUnreadable(message, path)) return undefined;
      throw error;
    }
  }

  async listIssuesForEnrichment(
    repo: string,
    options: {
      state?: "open" | "closed" | "all";
      since?: string;
      perPage?: number;
      pageLimit?: number;
      excludePullRequests?: boolean;
      minIssueResults?: number;
    } = {}
  ): Promise<GitHubRelatedIssueOrPull[]> {
    const issues: GitHubRelatedIssueOrPull[] = [];
    const state = options.state ?? "all";
    const perPage = options.perPage ?? 100;
    const pageLimit = options.pageLimit ?? 1;
    const excludePullRequests = options.excludePullRequests === true;
    const minIssueResults = Math.max(0, options.minIssueResults ?? 0);
    for (let page = 1; page <= pageLimit; page += 1) {
      const params = new URLSearchParams({
        state,
        sort: "updated",
        direction: "desc",
        per_page: String(perPage),
        page: String(page)
      });
      if (options.since) params.set("since", options.since);
      const chunk = await this.request<GitHubRelatedIssueOrPull[]>(`/repos/${repo}/issues?${params.toString()}`, {
        token: await this.getReadToken(repo)
      });
      issues.push(...(excludePullRequests ? chunk.filter((issue) => !issue.pull_request) : chunk));
      if (chunk.length < perPage) return issues;
      if (minIssueResults > 0 && issues.length >= minIssueResults) return issues;
    }
    return issues;
  }

  async createReview(input: {
    repo: string;
    pullNumber: number;
    event: ReviewEvent;
    body: string;
    comments: ReviewComment[];
  }): Promise<{ html_url?: string; id: number }> {
    if (!this.canPostAsApp()) {
      throw new Error("GitHub App credentials are required before posting reviews.");
    }
    const token = await this.getInstallationToken(input.repo);
    return this.request<{ html_url?: string; id: number }>(`/repos/${input.repo}/pulls/${input.pullNumber}/reviews`, {
      method: "POST",
      token,
      body: {
        event: input.event,
        body: input.body,
        comments: input.comments.map((comment) => ({
          path: comment.path,
          line: comment.line,
          side: comment.side,
          body: comment.body
        }))
      }
    });
  }

  async upsertIssueComment(input: {
    repo: string;
    issueNumber: number;
    marker: string;
    body: string;
  }): Promise<{ action: "created" | "updated"; html_url?: string; id: number }> {
    if (!this.canPostAsApp()) {
      throw new Error("GitHub App credentials are required before posting comments.");
    }
    const token = await this.getInstallationToken(input.repo);
    const existing = await this.findIssueCommentByMarker(input.repo, input.issueNumber, input.marker, token);
    if (existing) {
      const updated = await this.request<{ html_url?: string; id: number }>(
        `/repos/${input.repo}/issues/comments/${existing.id}`,
        { method: "PATCH", token, body: { body: input.body } }
      );
      return { action: "updated", html_url: updated.html_url, id: updated.id };
    }

    const created = await this.request<{ html_url?: string; id: number }>(
      `/repos/${input.repo}/issues/${input.issueNumber}/comments`,
      { method: "POST", token, body: { body: input.body } }
    );
    return { action: "created", html_url: created.html_url, id: created.id };
  }

  private async findIssueCommentByMarker(
    repo: string,
    issueNumber: number,
    marker: string,
    token: string
  ): Promise<IssueCommentSummary | undefined> {
    for (let page = 1; ; page += 1) {
      const comments = await this.request<IssueCommentSummary[]>(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { token }
      );
      const existing = comments.find((comment) => comment.body?.includes(marker) && this.isBotAuthoredComment(comment));
      if (existing) return existing;
      if (comments.length < 100) return undefined;
    }
  }

  private isBotAuthoredComment(comment: IssueCommentSummary): boolean {
    return comment.user?.type === "Bot" && comment.user.login === this.botLogin;
  }

  private async getInstallationToken(repo: string): Promise<string> {
    const cached = this.repoInstallationTokens.get(repo);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!this.appId || !this.privateKey) throw new Error("Missing GitHub App credentials.");

    const installationId = await this.getInstallationId(repo);
    return this.getInstallationTokenForId(repo, installationId);
  }

  private async getInstallationId(repo: string, options: { followRedirects?: boolean } = {}): Promise<number> {
    if (!this.appId || !this.privateKey) throw new Error("Missing GitHub App credentials.");
    const jwt = createAppJwt(this.appId, this.privateKey);
    const installation = await this.request<{ id: number }>(`/repos/${repo}/installation`, {
      token: jwt,
      followRedirects: options.followRedirects
    });
    return installation.id;
  }

  private async getInstallationTokenForId(repo: string, installationId: number): Promise<string> {
    const repoCached = this.repoInstallationTokens.get(repo);
    if (repoCached && repoCached.installationId === installationId && repoCached.expiresAt > Date.now() + 60_000) {
      return repoCached.token;
    }
    const tokenCacheKey = `${repo}:${installationId}`;
    const cached = this.installationTokens.get(tokenCacheKey);
    if (cached && cached.expiresAt > Date.now() + 60_000) {
      this.repoInstallationTokens.set(repo, {
        installationId,
        token: cached.token,
        expiresAt: cached.expiresAt
      });
      return cached.token;
    }
    if (!this.appId || !this.privateKey) throw new Error("Missing GitHub App credentials.");
    const jwt = createAppJwt(this.appId, this.privateKey);
    const token = await this.request<{ token: string; expires_at: string }>(
      `/app/installations/${installationId}/access_tokens`,
      { method: "POST", token: jwt, body: { repositories: [repo.split("/")[1]] } }
    );

    const expiresAt = new Date(token.expires_at).getTime();
    this.installationTokens.set(tokenCacheKey, {
      token: token.token,
      expiresAt
    });
    this.repoInstallationTokens.set(repo, {
      installationId,
      token: token.token,
      expiresAt
    });
    return token.token;
  }

  private async listOpenPullsWithToken(
    repo: string,
    token: string,
    options: { followRedirects?: boolean } = {}
  ): Promise<PullRequestSummary[]> {
    const pulls: PullRequestSummary[] = [];
    for (let page = 1; ; page += 1) {
      const chunk = await this.request<PullRequestSummary[]>(`/repos/${repo}/pulls?state=open&per_page=100&page=${page}`, {
        token,
        followRedirects: options.followRedirects
      });
      pulls.push(...chunk.map(normalizePullRequestSummary));
      if (chunk.length < 100) return pulls;
    }
  }

  private async getReadToken(repo: string): Promise<string | undefined> {
    if (this.canPostAsApp()) return this.getInstallationToken(repo);
    return this.token;
  }

  private async request<T>(
    path: string,
    options: { method?: string; token?: string; body?: unknown; followRedirects?: boolean } = {}
  ): Promise<T> {
    const token = options.token ?? this.token;
    let response: Response;
    const controller = this.requestTimeoutMs ? new AbortController() : undefined;
    const timeout = controller
      ? setTimeout(() => controller.abort(new Error(`GitHub API request timed out after ${this.requestTimeoutMs}ms for ${path}`)), this.requestTimeoutMs)
      : undefined;
    try {
      response = await fetch(buildApiUrl(this.apiBaseUrl, path, "GitHub API request path"), {
        method: options.method ?? "GET",
        ...(options.followRedirects === false ? { redirect: "manual" } : {}),
        signal: controller?.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
    } catch (error) {
      throw new Error(`GitHub API fetch failed for ${path}: ${describeFetchError(error)}`);
    } finally {
      if (timeout) clearTimeout(timeout);
    }

    if (!response.ok) {
      const text = await response.text();
      throw new GitHubApiRequestError({
        status: response.status,
        statusText: response.statusText,
        path,
        responseText: text
      });
    }

    return (await response.json()) as T;
  }
}

function normalizePullRequestSummary(pull: PullRequestSummary): PullRequestSummary {
  return {
    ...pull,
    head: {
      ...pull.head,
      ...(pull.head.repo ? { repo: normalizePullRepoSummary(pull.head.repo) } : {})
    },
    base: {
      ...pull.base,
      repo: normalizePullRepoSummary(pull.base.repo)
    }
  };
}

function normalizePullRepoSummary<T extends PullRequestSummary["base"]["repo"]>(repo: T): T {
  const visibility = repo.visibility ?? (repo.private === true ? "private" : repo.private === false ? "public" : undefined);
  return {
    ...repo,
    ...(visibility ? { visibility } : {})
  };
}

function visibilityFromRepositorySummary(repository: RepositorySummary): {
  result: GitHubRepositoryVisibility;
  source: GitHubRepositoryVisibilitySource;
} {
  if (repository.visibility === "public" || repository.visibility === "private" || repository.visibility === "internal") {
    return { result: repository.visibility, source: "repository_api" };
  }
  if (repository.private === true) return { result: "private", source: "private_flag" };
  if (repository.private === false) return { result: "public", source: "private_flag" };
  return { result: "unknown", source: "unavailable" };
}

function describeGitHubAccessError(error: unknown): Pick<
  GitHubRepositoryAccessProof,
  "github_api_status" | "github_api_error_class" | "github_api_error"
> {
  if (error instanceof GitHubApiRequestError) {
    return {
      github_api_status: error.status,
      github_api_error_class: classifyGitHubApiRequestError(error),
      github_api_error: `GitHub API ${error.status} ${error.statusText} for ${error.path}: ${error.responseText.slice(0, 400)}`
    };
  }
  return {
    github_api_error_class: error instanceof Error && /fetch failed|timed out|AbortError/i.test(error.message) ? "network" : "unknown",
    github_api_error: redactSecrets(error instanceof Error ? error.message : String(error))
  };
}

function classifyGitHubApiRequestError(error: GitHubApiRequestError): GitHubRepositoryAccessErrorClass {
  const body = error.responseText;
  if (/\bsuspended\b/i.test(body)) return "suspended_installation";
  if (/\b(rate limit|secondary rate limit|abuse detection)\b/i.test(body)) return "rate_limited";
  if (/\bResource not accessible by integration\b/i.test(body)) return "resource_not_accessible";
  if (error.status === 404) return "not_found";
  if (error.status === 301 || error.status === 302 || error.status === 307 || error.status === 308) return "renamed_or_transferred";
  if (error.status === 403) return "forbidden";
  if (error.status >= 500) return "server_error";
  return "unknown";
}

function isIssueLookupMissingOrUnreadable(message: string, path: string): boolean {
  const marker = `for ${path}:`;
  const markerIndex = message.indexOf(marker);
  if (markerIndex === -1) return false;
  if (/\bGitHub API 404\b/.test(message)) return true;
  if (!/\bGitHub API 403\b/.test(message)) return false;
  if (/\b(rate limit|abuse|secondary rate limit)\b/i.test(message)) return false;
  const responseBody = message.slice(markerIndex + marker.length);
  return /\bResource not accessible by integration\b/i.test(responseBody);
}

interface IssueCommentSummary {
  id: number;
  body?: string | null;
  user?: {
    login: string;
    type?: string;
  } | null;
}

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) return String(error);
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  const causeMessage = cause instanceof Error ? `${cause.name}: ${cause.message}` : cause ? String(cause) : "";
  return causeMessage ? `${error.message}; cause=${causeMessage}` : error.message;
}

export function createAppJwt(appId: string, privateKey: string, nowSeconds = Math.floor(Date.now() / 1000)): string {
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({
    iat: nowSeconds - 60,
    exp: nowSeconds + 540,
    iss: appId
  });
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).sign(privateKey, "base64url");
  return `${unsigned}.${signature}`;
}

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}
