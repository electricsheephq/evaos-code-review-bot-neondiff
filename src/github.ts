import { createSign } from "node:crypto";
import { readFileSync } from "node:fs";
import type { PullFilePatch, PullRequestSummary, ReviewComment, ReviewEvent } from "./types.js";

export interface GitHubApiOptions {
  appId?: string;
  privateKeyPath?: string;
  token?: string;
  apiBaseUrl?: string;
}

export class GitHubApi {
  private readonly appId?: string;
  private readonly privateKey?: string;
  private readonly token?: string;
  private readonly apiBaseUrl: string;
  private installationTokens = new Map<string, { token: string; expiresAt: number }>();

  constructor(options: GitHubApiOptions) {
    this.appId = options.appId;
    this.privateKey = options.privateKeyPath ? readFileSync(options.privateKeyPath, "utf8") : undefined;
    this.token = options.token;
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.github.com";
  }

  canPostAsApp(): boolean {
    return Boolean(this.appId && this.privateKey);
  }

  async listOpenPulls(repo: string): Promise<PullRequestSummary[]> {
    return this.request<PullRequestSummary[]>(`/repos/${repo}/pulls?state=open&per_page=100`, {
      token: await this.getReadToken(repo)
    });
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
    const response = await fetch(`${this.apiBaseUrl}${path}`, {
      method: options.method ?? "GET",
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
      throw new Error(`GitHub API ${response.status} ${response.statusText} for ${path}: ${text.slice(0, 400)}`);
    }

    return (await response.json()) as T;
  }
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
