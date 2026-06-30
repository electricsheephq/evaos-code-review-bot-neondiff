import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { IssueCommentCommandSource } from "./commands.js";
import type { PullFilePatch, PullRequestSummary, ReviewComment, ReviewEvent } from "./types.js";

export interface GitHubApiOptions {
  appId?: string;
  privateKeyPath?: string;
  token?: string;
  apiBaseUrl?: string;
  botLogin?: string;
}

export class GitHubApi {
  private readonly appId?: string;
  private readonly privateKey?: string;
  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private readonly botLogin: string;
  private installationTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(options: GitHubApiOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKeyPath ? readFileSync(options.privateKeyPath, "utf8") : undefined;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
    this.botLogin = options.botLogin ?? "evaos-code-review-bot[bot]";
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
      pulls.push(...chunk);
      if (chunk.length < 100) return pulls;
    }
  }

  async getPull(repo: string, pullNumber: number): Promise<PullRequestSummary> {
    return this.request<PullRequestSummary>(`/repos/${repo}/pulls/${pullNumber}`, {
      token: await this.getReadToken(repo)
    });
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
    const cached = this.installationTokens.get(repo);
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;
    if (!this.appId || !this.privateKey) throw new Error("Missing GitHub App credentials.");

    const jwt = createAppJwt(this.appId, this.privateKey);
    const installation = await this.request<{ id: number }>(`/repos/${repo}/installation`, { token: jwt });
    const token = await this.request<{ token: string; expires_at: string }>(
      `/app/installations/${installation.id}/access_tokens`,
      { method: "POST", token: jwt, body: { repositories: [repo.split("/")[1]] } }
    );

    this.installationTokens.set(repo, {
      token: token.token,
      expiresAt: new Date(token.expires_at).getTime()
    });
    return token.token;
  }

  private async getReadToken(repo: string): Promise<string | undefined> {
    if (this.canPostAsApp()) return this.getInstallationToken(repo);
    return this.token;
  }

  private async request<T>(
    path: string,
    options: { method?: string; token?: string; body?: unknown } = {}
  ): Promise<T> {
    const token = options.token ?? this.token;
    let response: Response;
    try {
      response = await fetch(`${this.apiBaseUrl}${path}`, {
        method: options.method ?? "GET",
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
    }

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`GitHub API ${response.status} ${response.statusText} for ${path}: ${text.slice(0, 400)}`);
    }

    return (await response.json()) as T;
  }
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
