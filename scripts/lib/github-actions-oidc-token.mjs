const MAX_OIDC_RESPONSE_BYTES = 32 * 1024;

export async function requestGitHubActionsOidcToken(input) {
  if (!input.requestToken || input.requestToken.length > 16 * 1024) {
    throw new Error("GitHub OIDC request token is missing or invalid");
  }
  const url = new URL(input.requestUrl);
  if (url.protocol !== "https:" || !url.hostname.endsWith(".actions.githubusercontent.com")) {
    throw new Error("GitHub OIDC request URL is not trusted");
  }
  url.searchParams.set("audience", input.audience);
  const response = await input.fetchImpl(url, {
    headers: { authorization: `Bearer ${input.requestToken}` },
    signal: AbortSignal.timeout(10_000)
  });
  const text = await response.text();
  if (!response.ok || Buffer.byteLength(text) > MAX_OIDC_RESPONSE_BYTES) {
    throw new Error("GitHub OIDC token request failed");
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("GitHub OIDC token response is invalid");
  }
  if (typeof parsed?.value !== "string" || parsed.value.length > 16 * 1024 || parsed.value.split(".").length !== 3) {
    throw new Error("GitHub OIDC token response is invalid");
  }
  return parsed.value;
}
