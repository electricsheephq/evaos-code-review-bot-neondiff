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
const ENDPOINT_IDENTITIES = new WeakSet<object>();
const REPOSITORY = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9._-]{1,100})$/;

export function resolveGitHubIssueEventEndpointIdentity(input: GitHubIssueEventEndpointIdentityInput): GitHubIssueEventEndpointIdentityResult {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) return INVALID;
    const { apiBaseUrl, repository, repositoryId, issueNumber } = input;
    if (typeof apiBaseUrl !== "string" || typeof repository !== "string" || !positiveSafeInteger(repositoryId)
      || !positiveSafeInteger(issueNumber)) return INVALID;
    const base = parseExactBase(apiBaseUrl);
    const match = REPOSITORY.exec(repository);
    if (!base || !match || match[2] === "." || match[2] === "..") return INVALID;
    const identity = Object.freeze({
      origin: base.origin,
      basePath: base.basePath,
      repositoryPath: `${base.basePath}/repos/${match[1]}/${match[2]}/issues/${issueNumber}/events`,
      canonicalRepositoryPath: `${base.basePath}/repositories/${repositoryId}/issues/${issueNumber}/events`
    });
    ENDPOINT_IDENTITIES.add(identity);
    return Object.freeze({ ok: true as const, identity });
  } catch { return INVALID; }
}

export function matchesGitHubIssueEventEndpointIdentity(
  identity: Readonly<GitHubIssueEventEndpointIdentity>,
  targetUrl: string
): boolean {
  if (!isEndpointIdentity(identity) || typeof targetUrl !== "string" || hasForbiddenRawSyntax(targetUrl)) return false;
  try {
    const target = new URL(targetUrl);
    const exact = `${target.origin}${target.pathname}`;
    return targetUrl === exact && !target.username && !target.password && !target.search && !target.hash
      && target.origin === identity.origin
      && (target.pathname === identity.repositoryPath || target.pathname === identity.canonicalRepositoryPath);
  } catch { return false; }
}

function parseExactBase(raw: string): Readonly<{ origin: string; basePath: string }> | null {
  if (hasForbiddenRawSyntax(raw) || raw.endsWith("//")) return null;
  const parsed = new URL(raw);
  if ((parsed.protocol !== "https:" && !(parsed.protocol === "http:" && isLoopbackHost(parsed.hostname)))
    || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname.includes("//")) return null;
  const normalizedRaw = raw.endsWith("/") ? raw.slice(0, -1) : raw;
  const basePath = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
  return normalizedRaw === `${parsed.origin}${basePath}` ? Object.freeze({ origin: parsed.origin, basePath }) : null;
}

function hasForbiddenRawSyntax(value: string): boolean {
  return value.trim() !== value || /[%\\\u0000-\u0020\u007f-\uffff]/.test(value)
    || value.includes("?") || value.includes("#") || value.includes("@")
    || /(?:^|\/)\.{1,2}(?:\/|$)/.test(value);
}

function isEndpointIdentity(value: unknown): value is Readonly<GitHubIssueEventEndpointIdentity> {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value) || !Object.isFrozen(value)
      || !ENDPOINT_IDENTITIES.has(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) return false;
    const record = value as Record<string, unknown>;
    return Object.keys(record).length === 4 && typeof record.origin === "string"
      && typeof record.basePath === "string" && typeof record.repositoryPath === "string"
      && typeof record.canonicalRepositoryPath === "string";
  } catch { return false; }
}

function positiveSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
