import { isIP } from "node:net";

export function isLoopbackHost(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[(.*)\]$/, "$1");
  if (normalized === "localhost" || normalized === "::1") return true;
  if (isIP(normalized) === 4) return normalized.split(".")[0] === "127";
  const mappedIpv4 = ipv4MappedIpv6Address(normalized);
  return mappedIpv4 ? isLoopbackHost(mappedIpv4) : false;
}

export function normalizeHttpApiBaseUrl(value: string | undefined, label: string, fallback: string): URL {
  const raw = value ?? fallback;
  if (typeof raw !== "string" || raw.trim().length === 0) throw new Error(`${label} must be a non-empty URL`);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error(`${label} must use http or https`);
  if (parsed.username || parsed.password) throw new Error(`${label} must not include username or password credentials`);
  if (parsed.protocol === "http:" && !isLoopbackHost(parsed.hostname)) {
    throw new Error(`${label} must use https unless it points to localhost/loopback for local testing`);
  }
  parsed.hash = "";
  parsed.search = "";
  return parsed;
}

export function buildApiUrl(baseUrl: URL, requestPath: string, label: string): string {
  if (!requestPath.startsWith("/") || requestPath.startsWith("//")) {
    throw new Error(`${label} must be a root-relative API path`);
  }
  let parsedPath: URL;
  try {
    parsedPath = new URL(requestPath, "https://neondiff.local");
  } catch {
    throw new Error(`${label} must be a valid root-relative API path`);
  }
  if (parsedPath.origin !== "https://neondiff.local") {
    throw new Error(`${label} must not be an absolute URL`);
  }

  const target = new URL(baseUrl.toString());
  const basePath = target.pathname.replace(/\/+$/, "");
  target.pathname = `${basePath}${parsedPath.pathname}`;
  target.search = parsedPath.search;
  target.hash = "";
  return target.toString();
}

export function isSameHostOrSubdomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, "");
  const normalizedDomain = domain.toLowerCase().replace(/\.$/, "");
  return host === normalizedDomain || host.endsWith(`.${normalizedDomain}`);
}

export function textMentionsHost(text: string, domain: string): boolean {
  for (const token of hostTokens(text)) {
    if (isSameHostOrSubdomain(token, domain)) return true;
  }
  return false;
}

function hostTokens(text: string): string[] {
  const tokens = new Set<string>();
  const hostPattern = /\b(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\b/gi;
  for (const match of text.matchAll(hostPattern)) {
    if (match[0]) tokens.add(match[0].toLowerCase());
  }
  return [...tokens];
}

function ipv4MappedIpv6Address(value: string): string | undefined {
  const match = value.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match?.[1];
}
