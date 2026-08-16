/**
 * Minimal API-base and path joining for the production GitHub client. license-api
 * is its own package, so it keeps a small local helper rather than importing the
 * root package's url-safety module. Enforces https and rejects path traversal.
 */
export function normalizeHttpApiBaseUrl(
  value: string | undefined,
  settingName: string,
  fallback: string
): URL {
  const raw = value?.trim() ? value.trim() : fallback;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${settingName} must be a valid absolute URL`);
  }
  if (url.protocol !== "https:") {
    throw new Error(`${settingName} must use https`);
  }
  return url;
}

export function buildApiUrl(base: URL, path: string, context: string): URL {
  if (!path.startsWith("/")) {
    throw new Error(`${context} must start with '/'`);
  }
  if (path.includes("..")) {
    throw new Error(`${context} must not contain path traversal`);
  }
  const trimmedBase = base.pathname.replace(/\/$/, "");
  const url = new URL(base);
  const [pathname, search] = path.split("?");
  url.pathname = `${trimmedBase}${pathname}`;
  url.search = search ? `?${search}` : "";
  return url;
}
