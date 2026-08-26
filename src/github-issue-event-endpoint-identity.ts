import { isLoopbackHost } from "./url-safety.js";

export interface GitHubIssueEventEndpointIdentityInput {
  apiBaseUrl: string;
  repository: string;
  repositoryId: number;
  issueNumber: number;
}

export interface GitHubIssueEventEndpointIdentity {
  origin: string;
  basePath: string;
  repositoryPath: string;
  canonicalRepositoryPath: string;
}

export type GitHubIssueEventEndpointIdentityResult =
  | Readonly<{ ok: true; identity: Readonly<GitHubIssueEventEndpointIdentity> }>
  | Readonly<{ ok: false; reason: "invalid_endpoint_identity" }>;

const INVALID = Object.freeze({ ok: false, reason: "invalid_endpoint_identity" } as const);
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;

export function resolveGitHubIssueEventEndpointIdentity(input: GitHubIssueEventEndpointIdentityInput): GitHubIssueEventEndpointIdentityResult {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return INVALID;
    const { apiBaseUrl, repository, repositoryId, issueNumber } = input;
    if (typeof apiBaseUrl !== "string" || typeof repository !== "string" || hasForbiddenUrlSyntax(apiBaseUrl)
      || /(?:^|\/)\.{1,2}(?:\/|$)/.test(apiBaseUrl)) return INVALID;
    const base = new URL(apiBaseUrl);
    if ((base.protocol !== "https:" && !(base.protocol === "http:" && isLoopbackHost(base.hostname)))
      || base.username || base.password || base.search || base.hash) return INVALID;
    const match = REPOSITORY.exec(repository);
    if (!match || match[2] === "." || match[2] === ".." || !positiveSafeInteger(repositoryId) || !positiveSafeInteger(issueNumber)) return INVALID;
    const basePath = base.pathname === "/" ? "" : base.pathname.replace(/\/+$/, "");
    if (basePath.includes("//") || basePath.split("/").some((part) => part === "." || part === "..")) return INVALID;
    const identity = Object.freeze({
      origin: base.origin,
      basePath,
      repositoryPath: `${basePath}/repos/${match[1]}/${match[2]}/issues/${issueNumber}/events`,
      canonicalRepositoryPath: `${basePath}/repositories/${repositoryId}/issues/${issueNumber}/events`
    });
    return Object.freeze({ ok: true as const, identity });
  } catch { return INVALID; }
}

export function matchesGitHubIssueEventEndpointIdentity(
  identity: Readonly<GitHubIssueEventEndpointIdentity>,
  targetUrl: string
): boolean {
  if (!Object.isFrozen(identity) || typeof targetUrl !== "string" || hasForbiddenUrlSyntax(targetUrl)) return false;
  try {
    const target = new URL(targetUrl);
    return !target.username && !target.password && !target.search && !target.hash && target.origin === identity.origin
      && (target.pathname === identity.repositoryPath || target.pathname === identity.canonicalRepositoryPath);
  } catch { return false; }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}

function hasForbiddenUrlSyntax(value: string): boolean {
  const schemeEnd = value.indexOf("://");
  const authorityEnd = schemeEnd < 0 ? -1 : value.indexOf("/", schemeEnd + 3);
  const authority = schemeEnd < 0 ? "" : value.slice(schemeEnd + 3, authorityEnd < 0 ? undefined : authorityEnd);
  return value.trim() !== value || /[%\\\u0000-\u0020\u007f-\uffff]/.test(value)
    || value.includes("?") || value.includes("#") || authority.includes("@")
    || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value);
}
