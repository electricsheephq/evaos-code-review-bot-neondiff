import { isAbsolute, resolve } from "node:path";
import { statSync } from "node:fs";
import { GitHubBrokerStore } from "../github-broker/store.js";
import type { AccountLinkDeps } from "./routes.js";
import type { AccountAuthority, AccountWorkspaceSnapshot } from "./service.js";

const SETTINGS = [
  "ACCOUNT_LINK_DB_PATH",
  "GITHUB_BROKER_DB_PATH",
  "ACCOUNT_LINK_CONNECT_ORIGIN",
  "ACCOUNT_LINK_SUPABASE_URL",
  "ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY",
  "ACCOUNT_LINK_AUTHORITY_URL"
] as const;
const MAX_RESPONSE_BYTES = 256 * 1024;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Setting = (typeof SETTINGS)[number];
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type AccountLinkRuntimeConfig =
  | { status: "disabled" }
  | { status: "invalid"; setting: string; reason: string }
  | { status: "ready"; deps: AccountLinkDeps };

export function loadAccountLinkRuntimeConfig(
  environment: RuntimeEnvironment,
  licenseDbPath: string
): AccountLinkRuntimeConfig {
  const enabled = normalized(environment.ACCOUNT_LINK_ENABLED);
  if (enabled === undefined || enabled === "false") return { status: "disabled" };
  if (enabled !== "true") return invalid("ACCOUNT_LINK_ENABLED", "must_be_true_or_false");

  const values = new Map<Setting, string>();
  for (const setting of SETTINGS) {
    const value = normalized(environment[setting]);
    if (!value) return invalid(setting, "missing");
    values.set(setting, value);
  }

  const dbPath = required(values, "ACCOUNT_LINK_DB_PATH");
  if (!isAbsolute(dbPath)) return invalid("ACCOUNT_LINK_DB_PATH", "must_be_absolute");
  if (sameFileIdentity(dbPath, licenseDbPath)) {
    return invalid("ACCOUNT_LINK_DB_PATH", "must_differ_from_license_db");
  }
  const brokerDbPath = required(values, "GITHUB_BROKER_DB_PATH");
  if (!isAbsolute(brokerDbPath)) {
    return invalid("GITHUB_BROKER_DB_PATH", "must_be_absolute");
  }
  if (!sameFileIdentity(dbPath, brokerDbPath)) {
    return invalid("ACCOUNT_LINK_DB_PATH", "must_match_github_broker_db");
  }

  const connectOrigin = normalizedHttpsUrl(
    required(values, "ACCOUNT_LINK_CONNECT_ORIGIN"),
    { allowPath: "/desktop/connect" }
  );
  if (!connectOrigin) return invalid("ACCOUNT_LINK_CONNECT_ORIGIN", "invalid");
  const supabaseUrl = normalizedHttpsUrl(
    required(values, "ACCOUNT_LINK_SUPABASE_URL"),
    { allowPath: "" }
  );
  if (!supabaseUrl) return invalid("ACCOUNT_LINK_SUPABASE_URL", "invalid");

  const publishableKey = required(values, "ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY");
  if (publishableKey.length > 4_096) {
    return invalid("ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY", "invalid");
  }
  const authorityUrl = normalizedHttpsUrl(
    required(values, "ACCOUNT_LINK_AUTHORITY_URL"),
    { allowPath: "/api/internal/desktop/workspaces" }
  );
  if (!authorityUrl || new URL(authorityUrl).hostname !== "www.neondiff.com") {
    return invalid("ACCOUNT_LINK_AUTHORITY_URL", "invalid");
  }

  let store: GitHubBrokerStore;
  try {
    store = new GitHubBrokerStore(dbPath);
  } catch {
    return invalid("ACCOUNT_LINK_DB_PATH", "open_failed");
  }

  return {
    status: "ready",
    deps: {
      store,
      dbPath,
      authority: createComposedAccountAuthority({
        connectOrigin,
        supabaseUrl,
        publishableKey,
        authorityUrl
      })
    }
  };
}

export interface ComposedAccountAuthorityOptions {
  connectOrigin: string;
  supabaseUrl: string;
  publishableKey: string;
  authorityUrl: string;
  fetchImpl?: typeof fetch;
  requestTimeoutMs?: number;
}

export function createComposedAccountAuthority(
  options: ComposedAccountAuthorityOptions
): AccountAuthority {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = options.requestTimeoutMs ?? 8_000;
  const base = options.supabaseUrl.replace(/\/$/, "");
  const authorityUrl = options.authorityUrl;

  return {
    connectOrigin: options.connectOrigin,

    async verifyAccessToken(accessToken: string): Promise<string | null> {
      const response = await fetchImpl(`${base}/auth/v1/user`, {
        method: "GET",
        headers: {
          apikey: options.publishableKey,
          Authorization: `Bearer ${accessToken}`,
          Accept: "application/json"
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout)
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("account identity redirect refused");
      }
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error("account identity request failed");
      const body = await boundedJson(response);
      if (!isRecord(body) || typeof body.id !== "string" || !UUID.test(body.id)) return null;
      return body.id;
    },

    async loadWorkspaceSnapshot(
      userId: string,
      deviceAuthorization: string
    ): Promise<AccountWorkspaceSnapshot> {
      if (!UUID.test(userId)) throw new Error("invalid bound user id");
      if (!/^Bearer [A-Za-z0-9._~-]+$/.test(deviceAuthorization) || deviceAuthorization.length > 4_096) {
        throw new Error("invalid device authorization");
      }
      const response = await fetchImpl(authorityUrl, {
        method: "POST",
        headers: {
          Authorization: deviceAuthorization,
          Accept: "application/json"
        },
        redirect: "manual",
        signal: AbortSignal.timeout(timeout)
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("account authority redirect refused");
      }
      if (!response.ok) throw new Error("account authority request failed");
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("application/json")) {
        throw new Error("account authority response is not JSON");
      }
      const body = await boundedJson(response);
      if (
        !isRecord(body)
        || body.status !== "ready"
        || body.userId !== userId
        || !Array.isArray(body.accounts)
      ) {
        throw new Error("account authority identity mismatch");
      }
      return { accounts: parseWorkspaceAccounts(body.accounts) };
    }
  };
}

async function boundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length") ?? 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("account authority response too large");
  if (!response.body) return JSON.parse("") as unknown;
  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw new Error("account authority response too large");
      }
      chunks.push(Buffer.from(value));
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks, size).toString("utf8")) as unknown;
}

function parseWorkspaceAccounts(value: unknown[]): AccountWorkspaceSnapshot["accounts"] {
  if (value.length > 100) throw new Error("too many workspace accounts");
  const accounts = value.map((row) => {
    if (
      !isRecord(row)
      || typeof row.id !== "string"
      || !UUID.test(row.id)
      || (row.kind !== "personal" && row.kind !== "organization")
      || typeof row.name !== "string"
      || row.name.trim().length === 0
      || row.name.length > 120
      || /[\r\n]/.test(row.name)
      || (row.role !== "owner" && row.role !== "admin" && row.role !== "member")
      || !isEntitlement(row.entitlement)
      || !Array.isArray(row.bots)
      || row.bots.length > 100
    ) {
      throw new Error("invalid workspace account");
    }
    const bots = row.bots.map(parseWorkspaceBot);
    if (new Set(bots.map((bot) => bot.id)).size !== bots.length) {
      throw new Error("duplicate workspace bot");
    }
    return {
      id: row.id,
      kind: row.kind as "personal" | "organization",
      name: row.name,
      role: row.role as "owner" | "admin" | "member",
      entitlement: row.entitlement,
      bots
    };
  });
  if (new Set(accounts.map((account) => account.id)).size !== accounts.length) {
    throw new Error("duplicate workspace account");
  }
  return accounts;
}

function parseWorkspaceBot(value: unknown): AccountWorkspaceSnapshot["accounts"][number]["bots"][number] {
  if (!isRecord(value)) throw new Error("invalid workspace bot");
  const installationId = value.githubInstallationId;
  if (
    typeof value.id !== "string"
    || !UUID.test(value.id)
    || typeof value.appId !== "number"
    || !Number.isSafeInteger(value.appId)
    || value.appId <= 0
    || typeof value.appSlug !== "string"
    || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(value.appSlug)
    || (value.mode !== "byo" && value.mode !== "managed")
    || !isBotStatus(value.status)
    || (installationId !== null
      && (typeof installationId !== "number"
        || !Number.isSafeInteger(installationId)
        || installationId <= 0))
    || (value.status === "verified" && installationId === null)
    || (value.githubAccountLogin !== null
      && (typeof value.githubAccountLogin !== "string"
        || !/^[A-Za-z0-9][A-Za-z0-9-]{0,99}$/.test(value.githubAccountLogin)))
  ) {
    throw new Error("invalid workspace bot");
  }
  return {
    id: value.id,
    appId: value.appId,
    appSlug: value.appSlug,
    mode: value.mode,
    githubInstallationId: installationId,
    githubAccountLogin: value.githubAccountLogin as string | null,
    status: value.status
  };
}

function isEntitlement(value: unknown): value is AccountWorkspaceSnapshot["accounts"][number]["entitlement"] {
  return value === "public_free"
    || value === "paid"
    || value === "internal_admin"
    || value === "trial"
    || value === "none";
}

function isBotStatus(value: unknown): value is AccountWorkspaceSnapshot["accounts"][number]["bots"][number]["status"] {
  return value === "pending" || value === "verified" || value === "suspended" || value === "revoked";
}

function sameFileIdentity(left: string, right: string): boolean {
  if (resolve(left) === resolve(right)) return true;
  try {
    const leftStat = statSync(left);
    const rightStat = statSync(right);
    return leftStat.dev === rightStat.dev && leftStat.ino === rightStat.ino;
  } catch {
    return false;
  }
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(values: ReadonlyMap<Setting, string>, setting: Setting): string {
  const value = values.get(setting);
  if (!value) throw new Error(`missing validated setting: ${setting}`);
  return value;
}

function normalizedHttpsUrl(value: string, options: { allowPath: string }): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:"
    || url.username
    || url.password
    || url.port
    || url.search
    || url.hash
    || url.pathname.replace(/\/$/, "") !== options.allowPath
  ) {
    return undefined;
  }
  url.pathname = options.allowPath || "/";
  return url.toString().replace(/\/$/, "");
}

function invalid(setting: string, reason: string): AccountLinkRuntimeConfig {
  return { status: "invalid", setting, reason };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
