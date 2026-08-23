const APP_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?$/;
const BOT_LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,98}[a-z0-9])?\[bot\]$/i;

export function normalizeBotLogin(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  return BOT_LOGIN_PATTERN.test(normalized) ? normalized : undefined;
}

export function deriveCanonicalBotLogin(input: {
  appSlug?: unknown;
  verifiedBotLogin?: unknown;
}): string | undefined {
  const appSlug = typeof input.appSlug === "string" ? input.appSlug.trim().toLowerCase() : undefined;
  const fromAppSlug = appSlug && APP_SLUG_PATTERN.test(appSlug) ? `${appSlug}[bot]` : undefined;
  const explicit = normalizeBotLogin(input.verifiedBotLogin);
  if (fromAppSlug && explicit && fromAppSlug !== explicit) return undefined;
  return fromAppSlug ?? explicit;
}

export function isBotAuthoredComment(
  comment: { user?: { login?: unknown; type?: unknown } | null } | null | undefined,
  botLogin: string | undefined
): boolean {
  const canonicalBotLogin = normalizeBotLogin(botLogin);
  return Boolean(
    canonicalBotLogin &&
    comment?.user?.type === "Bot" &&
    normalizeBotLogin(comment.user.login) === canonicalBotLogin
  );
}
