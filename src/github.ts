import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import { isMap, isProxy, isSet } from "node:util/types";
import type { IssueCommentCommandSource } from "./commands.js";
import type { GitHubRelatedIssueOrPull } from "./github-related-context.js";
import type { IssueEnrichmentIssueList } from "./issue-enrichment.js";
import { redactSecrets } from "./secrets.js";
import type { PullFilePatch, PullRequestSummary, PullReviewComment, RepositorySummary, ReviewComment, ReviewEvent } from "./types.js";
import { buildApiUrl, normalizeHttpApiBaseUrl } from "./url-safety.js";

/** The bot's own GitHub App login — single source of truth for "who am I" (#345 reuse). */
export const DEFAULT_BOT_LOGIN = "evaos-code-review-bot[bot]";

/**
 * Hard page cap for the bounded outcome-observation review-comment read (#371). At 100/page this bounds
 * a single PR's comment scan to 500, so a pathological thread count can't drive unbounded GitHub reads
 * (the deeper-observation reader is contractually bounded). A human dismissal thread on a flagged line
 * is found well within this window; exceeding it truncates rather than paging forever.
 */
const MAX_REVIEW_COMMENT_PAGES = 5;
const MAX_ISSUE_COMMENT_PAGES = 5;
export const DEFAULT_GITHUB_REQUEST_TIMEOUT_MS = 30_000;

/** Array-compatible metadata for bounded GitHub reads. `rawCount` is the count before downstream filters. */
export type BoundedGithubList<T> = T[] & {
  items: T[];
  rawCount: number;
  truncated: boolean;
  overflow: boolean;
};

/**
 * Additive P1a issue-comment pagination receipt (#738). This reader is intentionally not used by
 * command acknowledgement, marker lookup, or issue enrichment until their consumers are updated in
 * separate slices.
 */
export interface BoundedIssueCommentRead {
  items: IssueCommentCommandSource[];
  pagesRead: number;
  rawCount: number;
  uniqueCount: number;
  duplicateCount: number;
  terminal: "short_page" | "page_cap";
  truncated: boolean;
  overflow: boolean;
}

function boundedGithubList<T>(items: T[], truncated: boolean): BoundedGithubList<T> {
  const result = items as BoundedGithubList<T>;
  result.items = items.slice();
  result.rawCount = items.length;
  result.truncated = truncated;
  result.overflow = truncated;
  return result;
}

function boundedIssueCommentRead(
  items: IssueCommentCommandSource[],
  metadata: Pick<BoundedIssueCommentRead, "pagesRead" | "rawCount" | "duplicateCount" | "terminal">
): BoundedIssueCommentRead {
  return {
    items: items.slice(),
    ...metadata,
    uniqueCount: items.length,
    truncated: metadata.terminal === "page_cap",
    overflow: metadata.terminal === "page_cap"
  };
}

export function unpackBoundedGithubList<T>(result: T[] | BoundedGithubList<T>): {
  items: T[];
  rawCount: number;
  truncated: boolean;
  overflow: boolean;
} {
  const bounded = result as Partial<BoundedGithubList<T>>;
  if (Array.isArray(bounded.items) && typeof bounded.truncated === "boolean") {
    return {
      items: bounded.items,
      rawCount: bounded.rawCount ?? bounded.items.length,
      truncated: bounded.truncated,
      overflow: bounded.overflow ?? bounded.truncated
    };
  }
  return { items: result, rawCount: result.length, truncated: false, overflow: false };
}

export interface GitHubApiOptions {
  appId?: string;
  privateKey?: string;
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
  app_id?: number;
  readMode: "app_installation" | "fallback_token" | "unconfigured";
  visibility_result: GitHubRepositoryVisibility;
  visibility_source: GitHubRepositoryVisibilitySource;
  installation_id_present: boolean;
  installation_id?: number;
  installation_account?: string;
  app_slug?: string;
  app_can_read_metadata: boolean;
  app_can_read_pull_requests: boolean;
  openPullCount?: number;
  github_api_status?: number;
  github_api_error_class?: GitHubRepositoryAccessErrorClass;
  github_api_error?: string;
}

interface GitHubInstallationIdentity {
  id: number;
  app_id: number;
  account_login: string;
  app_slug: string;
}

interface GitHubInstallationResponse {
  id: number;
  app_id?: number;
  account?: { login?: string };
  app_slug?: string;
}

export interface CanonicalGitHubInstallationIdentity {
  id: number;
  app_id: number;
  account_id: number;
  account_login: string;
  account_type: "User" | "Organization";
  app_slug: string;
  bot_login: string;
}

export interface GitHubInstallationIdentityExpectation {
  expectedAppId: string;
  expectedBotLogin: string;
  repo: string;
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

export class GitHubApiTimeoutError extends Error {
  readonly failureKind = "timeout" as const;
  readonly path: string;
  readonly timeoutMs: number;

  constructor(input: { path: string; timeoutMs: number }) {
    super(`GitHub API request timed out after ${input.timeoutMs}ms for ${input.path}`);
    this.name = "GitHubApiTimeoutError";
    this.path = input.path;
    this.timeoutMs = input.timeoutMs;
  }
}

export class GitHubApi {
  private readonly appId?: string;
  private readonly privateKey?: string;
  private readonly token?: string;
  private readonly apiBaseUrl: URL;
  private readonly botLogin: string;
  private readonly requestTimeoutMs: number;
  private installationTokens = new Map<string, { token: string; expiresAt: number }>();
  private repoInstallationTokens = new Map<string, { installationId: number; token: string; expiresAt: number }>();

  constructor(options: GitHubApiOptions) {
    if (options.privateKey && options.privateKeyPath) {
      throw new Error("GitHub App private key must be supplied inline or by path, not both.");
    }
    this.appId = options.appId;
    this.privateKey = options.privateKey ?? (options.privateKeyPath ? readFileSync(options.privateKeyPath, "utf8") : undefined);
    this.token = options.token;
    this.apiBaseUrl = normalizeHttpApiBaseUrl(options.apiBaseUrl, "github.apiBaseUrl", "https://api.github.com");
    this.botLogin = options.botLogin ?? DEFAULT_BOT_LOGIN;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_GITHUB_REQUEST_TIMEOUT_MS;
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

    let installation: GitHubInstallationIdentity;
    try {
      installation = parseGitHubInstallationIdentity(
        await this.getInstallation(repo, { followRedirects: false })
      );
    } catch (error) {
      return { ...base, ...describeGitHubAccessError(error) };
    }
    const installationProof = {
      installation_id_present: true,
      installation_id: installation.id,
      installation_account: installation.account_login,
      app_id: installation.app_id,
      app_slug: installation.app_slug
    };

    let token: string;
    try {
      token = await this.getInstallationTokenForId(repo, installation.id);
    } catch (error) {
      return { ...base, ...installationProof, ...describeGitHubAccessError(error) };
    }

    let metadata: RepositorySummary;
    try {
      metadata = await this.request<RepositorySummary>(`/repos/${repo}`, { token, followRedirects: false });
    } catch (error) {
      return { ...base, ...installationProof, ...describeGitHubAccessError(error) };
    }

    const visibility = visibilityFromRepositorySummary(metadata);
    try {
      const pulls = await this.listOpenPullsWithToken(repo, token, { followRedirects: false });
      return {
        repo_full_name: metadata.full_name || repo,
        readMode,
        visibility_result: visibility.result,
        visibility_source: visibility.source,
        ...installationProof,
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
        ...installationProof,
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

  /**
   * Read-only PR review (inline-diff) comments (#371), paged. Used by the scheduled outcome observer
   * to detect a human reply thread on a finding's path/line. No mutation, no posting.
   */
  async listPullReviewComments(repo: string, pullNumber: number): Promise<PullReviewComment[]> {
    const comments: PullReviewComment[] = [];
    // Hard-capped at MAX_REVIEW_COMMENT_PAGES: the bounded-read guarantee forbids paging forever on a
    // PR with a pathological comment count; we stop after the cap even if a full page came back.
    for (let page = 1; page <= MAX_REVIEW_COMMENT_PAGES; page += 1) {
      const chunk = await this.request<PullReviewComment[]>(
        `/repos/${repo}/pulls/${pullNumber}/comments?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      comments.push(...chunk);
      if (chunk.length < 100) break;
    }
    return comments;
  }

  /**
   * Read-only, BOUNDED list of recently-merged PRs (#371), most-recent-first, capped at `limit`. Used
   * by the scheduled outcome observer to find a revert / subsequent fix touching a finding's lines.
   * Bounded: at most `limit` closed PRs are scanned (one page window), and only merged ones returned.
   */
  async listRecentMergedPulls(repo: string, limit: number): Promise<PullRequestSummary[]> {
    const perPage = Math.min(Math.max(1, limit), 100);
    const chunk = await this.request<PullRequestSummary[]>(
      `/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=${perPage}&page=1`,
      { token: await this.getReadToken(repo) }
    );
    return chunk.map(normalizePullRequestSummary).filter((pull) => Boolean(pull.merged_at)).slice(0, limit);
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

  async listIssueCommentsForEnrichment(
    repo: string,
    issueNumber: number
  ): Promise<BoundedGithubList<IssueCommentCommandSource>> {
    const comments: IssueCommentCommandSource[] = [];
    for (let page = 1; page <= MAX_ISSUE_COMMENT_PAGES; page += 1) {
      const chunk = await this.request<IssueCommentCommandSource[]>(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      comments.push(...chunk);
      if (chunk.length < 100) return boundedGithubList(comments, false);
      if (page === MAX_ISSUE_COMMENT_PAGES) return boundedGithubList(comments, true);
    }
    return boundedGithubList(comments, true);
  }

  /**
   * Read issue comments with a deterministic five-page/500-row bound (#738 P1a). GitHub's page order
   * is preserved and duplicate IDs keep their first occurrence. The receipt is additive and this
   * primitive is deliberately unused by existing command, marker, and enrichment callers.
   */
  async listIssueCommentsBounded(repo: string, issueNumber: number): Promise<BoundedIssueCommentRead> {
    const comments: IssueCommentCommandSource[] = [];
    const seen = new Set<number>();
    let rawCount = 0;
    let duplicateCount = 0;
    for (let page = 1; page <= MAX_ISSUE_COMMENT_PAGES; page += 1) {
      const chunk = await this.request<IssueCommentCommandSource[]>(
        `/repos/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      rawCount += chunk.length;
      for (const comment of chunk) {
        if (seen.has(comment.id)) {
          duplicateCount += 1;
          continue;
        }
        seen.add(comment.id);
        comments.push(comment);
      }
      if (chunk.length < 100) {
        return boundedIssueCommentRead(comments, {
          pagesRead: page,
          rawCount,
          duplicateCount,
          terminal: "short_page"
        });
      }
    }
    return boundedIssueCommentRead(comments, {
      pagesRead: MAX_ISSUE_COMMENT_PAGES,
      rawCount,
      duplicateCount,
      terminal: "page_cap"
    });
  }

  async listIssueLabelEvents(repo: string, issueNumber: number): Promise<Array<{
    event?: string;
    created_at?: string;
    actor?: { login?: string | null } | null;
    label?: { name?: string | null } | null;
  }>> {
    const events: Array<{
      event?: string;
      created_at?: string;
      actor?: { login?: string | null } | null;
      label?: { name?: string | null } | null;
    }> = [];
    for (let page = 1; ; page += 1) {
      const chunk = await this.request<typeof events>(
        `/repos/${repo}/issues/${issueNumber}/events?per_page=100&page=${page}`,
        { token: await this.getReadToken(repo) }
      );
      events.push(...chunk);
      if (chunk.length < 100) return events;
    }
  }

  async getCollaboratorPermission(
    repo: string,
    login: string
  ): Promise<"read" | "triage" | "write" | "maintain" | "admin" | "none"> {
    const result = await this.request<{ permission?: string }>(
      `/repos/${repo}/collaborators/${encodeURIComponent(login)}/permission`,
      { token: await this.getReadToken(repo) }
    );
    const permission = result.permission?.toLowerCase();
    if (permission === "pull") return "read";
    if (permission === "push") return "write";
    if (permission === "read" || permission === "triage" || permission === "write" || permission === "maintain" || permission === "admin") {
      return permission;
    }
    return "none";
  }

  async getIssueComment(repo: string, commentId: number): Promise<IssueCommentCommandSource> {
    if (!Number.isSafeInteger(commentId) || commentId < 1) {
      throw new Error("commentId must be a positive safe integer");
    }
    return this.request<IssueCommentCommandSource>(`/repos/${repo}/issues/comments/${commentId}`, {
      token: await this.getReadToken(repo)
    });
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
  ): Promise<IssueEnrichmentIssueList> {
    const issues: IssueEnrichmentIssueList = [];
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
      if (chunk.length < perPage) return Object.assign(issues, { scanCompletion: "complete" as const });
      if (minIssueResults > 0 && issues.length >= minIssueResults) {
        return Object.assign(issues, { scanCompletion: "stopped_after_min_issue_results" as const });
      }
    }
    return Object.assign(issues, { scanCompletion: "page_limit_reached" as const });
  }

  async createReview(input: {
    repo: string;
    pullNumber: number;
    headSha: string;
    event: ReviewEvent;
    body: string;
    comments: ReviewComment[];
  }): Promise<{ html_url?: string; id: number }> {
    if (!/^[0-9a-f]{40}$/i.test(input.headSha)) {
      throw new Error("headSha must be a 40-character hexadecimal commit SHA");
    }
    if (!this.canPostAsApp()) {
      throw new Error("GitHub App credentials are required before posting reviews.");
    }
    const token = await this.getInstallationToken(input.repo);
    return this.request<{ html_url?: string; id: number }>(`/repos/${input.repo}/pulls/${input.pullNumber}/reviews`, {
      method: "POST",
      token,
      body: {
        commit_id: input.headSha.toLowerCase(),
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
      const issueMarker = marker.includes(" issue=");
      const normalizedMarker = issueMarker ? marker.toLowerCase() : marker;
      const existing = comments.find((comment) => {
        const body = issueMarker ? comment.body?.toLowerCase() : comment.body;
        return body?.includes(normalizedMarker) && this.isBotAuthoredComment(comment);
      });
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

    const installation = await this.getInstallation(repo);
    return this.getInstallationTokenForId(repo, installation.id);
  }

  private async getInstallation(
    repo: string,
    options: { followRedirects?: boolean } = {}
  ): Promise<GitHubInstallationResponse> {
    if (!this.appId || !this.privateKey) throw new Error("Missing GitHub App credentials.");
    const jwt = createAppJwt(this.appId, this.privateKey);
    return this.request<GitHubInstallationResponse>(`/repos/${repo}/installation`, {
      token: jwt,
      followRedirects: options.followRedirects
    });
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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);
    try {
      const response = await fetch(buildApiUrl(this.apiBaseUrl, path, "GitHub API request path"), {
        method: options.method ?? "GET",
        ...(options.followRedirects === false ? { redirect: "manual" } : {}),
        signal: controller.signal,
        headers: {
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(options.body === undefined ? {} : { "Content-Type": "application/json" })
        },
        body: options.body === undefined ? undefined : JSON.stringify(options.body)
      });
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
    } catch (error) {
      if (error instanceof GitHubApiRequestError) throw error;
      if (controller.signal.aborted) {
        throw new GitHubApiTimeoutError({ path, timeoutMs: this.requestTimeoutMs });
      }
      throw new Error(`GitHub API fetch failed for ${path}: ${describeFetchError(error)}`);
    } finally {
      clearTimeout(timeout);
    }
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

const GITHUB_LOGIN_PATTERN = /^(?!-)(?!.*--)[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const GITHUB_APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const MISSING_GITHUB_FIELD = Symbol("missing-github-field");

/** Pure required-field projection; unrelated GitHub metadata is never traversed. */
export function normalizeAndValidateGitHubInstallationIdentity(
  value: unknown,
  expected: GitHubInstallationIdentityExpectation
): CanonicalGitHubInstallationIdentity {
  const id = readGitHubField(value, "id");
  const appId = readGitHubField(value, "app_id");
  const account = readGitHubField(value, "account");
  const accountId = readGitHubField(account, "id");
  const accountLogin = normalizeGitHubValue(readGitHubField(account, "login"), GITHUB_LOGIN_PATTERN);
  const accountType = readGitHubField(account, "type");
  const appSlug = normalizeGitHubAppSlug(readGitHubField(value, "app_slug"));
  const expectedAppId = readGitHubField(expected, "expectedAppId");
  const expectedBotLogin = normalizeGitHubBotLogin(readGitHubField(expected, "expectedBotLogin"));
  const repo = readGitHubField(expected, "repo");
  const repoParts = typeof repo === "string" ? repo.split("/") : [];
  const owner = repoParts.length === 2 && repoParts[1].length > 0 && !/\s/.test(repoParts[1])
    ? normalizeGitHubValue(repoParts[0], GITHUB_LOGIN_PATTERN) : undefined;
  const botLogin = appSlug ? `${appSlug}[bot]` : undefined;
  const positiveInteger = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  if (!positiveInteger(id) || !positiveInteger(appId) || !positiveInteger(accountId)
      || typeof expectedAppId !== "string" || !/^\d+$/.test(expectedAppId.trim())
      || String(appId) !== expectedAppId.trim() || !accountLogin || !owner || accountLogin !== owner
      || (accountType !== "User" && accountType !== "Organization") || !appSlug
      || !botLogin || botLogin !== expectedBotLogin) {
    throw new Error("GitHub installation identity failed canonical validation.");
  }
  return Object.freeze({
    id, app_id: appId, account_id: accountId, account_login: accountLogin,
    account_type: accountType, app_slug: appSlug, bot_login: botLogin
  });
}

function readGitHubField(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || isProxy(value) || isMap(value) || isSet(value)
      || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) return MISSING_GITHUB_FIELD;
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  return descriptor && descriptor.enumerable && "value" in descriptor ? descriptor.value : MISSING_GITHUB_FIELD;
}

function normalizeGitHubAppSlug(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  const slug = normalized.endsWith("[bot]") ? normalized.slice(0, -5) : normalized;
  return GITHUB_APP_SLUG_PATTERN.test(slug) ? slug : undefined;
}

function normalizeGitHubBotLogin(value: unknown): string | undefined {
  const slug = normalizeGitHubAppSlug(value);
  return slug ? `${slug}[bot]` : undefined;
}

function normalizeGitHubValue(value: unknown, pattern: RegExp): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return pattern.test(normalized) ? normalized : undefined;
}

function parseGitHubInstallationIdentity(value: unknown): GitHubInstallationIdentity {
  const installation = value as {
    id?: unknown;
    app_id?: unknown;
    account?: { login?: unknown } | null;
    app_slug?: unknown;
  } | null;
  const positiveInteger = (candidate: unknown): candidate is number =>
    typeof candidate === "number" && Number.isSafeInteger(candidate) && candidate > 0;
  const accountLogin = installation?.account?.login;
  const appSlug = installation?.app_slug;
  const accountLoginValid = typeof accountLogin === "string"
    && /^(?!-)(?!.*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(accountLogin);
  const appSlugValid = typeof appSlug === "string"
    && /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/.test(appSlug);
  if (!positiveInteger(installation?.id) || !positiveInteger(installation?.app_id)
      || !accountLoginValid || !appSlugValid) {
    throw new Error("GitHub installation response is missing canonical identity fields.");
  }
  return { id: installation.id, app_id: installation.app_id, account_login: accountLogin, app_slug: appSlug };
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
