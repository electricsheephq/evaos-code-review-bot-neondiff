const originalFetch = globalThis.fetch;

globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (
    url === "https://neondiff-license.fly.dev/v1/license/activate" ||
    url === "https://neondiff-license.fly.dev/v1/license/validate"
  ) {
    return new Response(JSON.stringify({
      status: "active",
      expiresAt: "2999-01-01T00:00:00.000Z",
      repoVisibilityScope: "all",
      privateRepoAllowed: true,
      updateEntitlement: true
    }), { status: 200, headers: { "content-type": "application/json" } });
  }
  if (url.startsWith("https://neondiff-license.fly.dev/")) {
    throw new Error(`test mock refused an unhandled production license endpoint: ${url}`);
  }
  return originalFetch(input, init);
};
