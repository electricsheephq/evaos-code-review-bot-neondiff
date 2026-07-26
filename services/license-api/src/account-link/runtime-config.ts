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
  "ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY"
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
  const serviceRoleKey = required(values, "ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY");
  if (publishableKey.length > 4_096) {
    return invalid("ACCOUNT_LINK_SUPABASE_PUBLISHABLE_KEY", "invalid");
  }
  if (serviceRoleKey.length > 4_096) {
    return invalid("ACCOUNT_LINK_SUPABASE_SERVICE_ROLE_KEY", "invalid");
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
      authority: createSupabaseAccountAuthority({
        connectOrigin,
        supabaseUrl,
        publishableKey,
        serviceRoleKey
      })
    }
  };
}

export interface SupabaseAccountAuthorityOptions {
  connectOrigin: string;
  supabaseUrl: string;
  publishableKey: string;
  serviceRoleKey: string;
  fetchImpl?: typeof fetch;
  now?: () => Date;
  requestTimeoutMs?: number;
}

export function createSupabaseAccountAuthority(
  options: SupabaseAccountAuthorityOptions
): AccountAuthority {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? (() => new Date());
  const timeout = options.requestTimeoutMs ?? 8_000;
  const base = options.supabaseUrl.replace(/\/$/, "");
  const serviceHeaders = supabaseHeaders(options.serviceRoleKey);

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
        signal: AbortSignal.timeout(timeout)
      });
      if (response.status === 401 || response.status === 403) return null;
      if (!response.ok) throw new Error("account identity request failed");
      const body = await boundedJson(response);
      if (!isRecord(body) || typeof body.id !== "string" || !UUID.test(body.id)) return null;
      return body.id;
    },

    async loadWorkspaceSnapshot(userId: string): Promise<AccountWorkspaceSnapshot> {
      if (!UUID.test(userId)) throw new Error("invalid bound user id");
      const memberships = parseMemberships(await supabaseGet(
        "/rest/v1/account_memberships",
        {
          select: "account_id,role",
          user_id: `eq.${userId}`
        },
        serviceHeaders,
        fetchImpl,
        base,
        timeout
      ));
      if (memberships.length === 0) return { accounts: [] };

      const accountIds = memberships.map((membership) => membership.accountId);
      const inFilter = `in.(${accountIds.join(",")})`;
      const accounts = parseAccounts(await supabaseGet(
        "/rest/v1/accounts",
        { select: "id,kind,name", id: inFilter },
        serviceHeaders,
        fetchImpl,
        base,
        timeout
      ));
      const bots = parseBots(await supabaseGet(
        "/rest/v1/bot_installations",
        {
          select: "id,account_id,app_id,app_slug,mode,github_installation_id,github_account_login,status",
          account_id: inFilter
        },
        serviceHeaders,
        fetchImpl,
        base,
        timeout
      ));
      const grants = parseGrants(await supabaseGet(
        "/rest/v1/account_entitlement_grants",
        {
          select: "account_id,grant_kind,status,expires_at",
          account_id: inFilter,
          status: "eq.active"
        },
        serviceHeaders,
        fetchImpl,
        base,
        timeout
      ));

      return {
        accounts: memberships.map((membership) => {
          const account = accounts.find((candidate) => candidate.id === membership.accountId);
          if (!account) throw new Error("membership account is missing");
          return {
            id: account.id,
            kind: account.kind,
            name: account.name,
            role: membership.role,
            entitlement: entitlementFor(
              grants.filter((grant) => grant.accountId === account.id),
              now()
            ),
            bots: bots
              .filter((bot) => bot.accountId === account.id)
              .map(({ accountId: _accountId, ...bot }) => bot)
          };
        })
      };
    }
  };
}

async function supabaseGet(
  path: string,
  query: Record<string, string>,
  headers: Record<string, string>,
  fetchImpl: typeof fetch,
  base: string,
  timeout: number
): Promise<unknown> {
  const url = new URL(`${base}${path}`);
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
  const response = await fetchImpl(url, {
    method: "GET",
    headers: { ...headers, Accept: "application/json" },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error("account authority request failed");
  return boundedJson(response);
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

function supabaseHeaders(key: string): Record<string, string> {
  const headers: Record<string, string> = { apikey: key };
  if (key.split(".").length === 3) headers.Authorization = `Bearer ${key}`;
  return headers;
}

function parseMemberships(value: unknown): Array<{
  accountId: string;
  role: "owner" | "admin" | "member";
}> {
  if (!Array.isArray(value)) throw new Error("invalid memberships response");
  return value.map((row) => {
    if (!isRecord(row) || typeof row.account_id !== "string" || !UUID.test(row.account_id)) {
      throw new Error("invalid membership account");
    }
    if (row.role !== "owner" && row.role !== "admin" && row.role !== "member") {
      throw new Error("invalid membership role");
    }
    return { accountId: row.account_id, role: row.role };
  });
}

function parseAccounts(value: unknown): Array<{
  id: string;
  kind: "personal" | "organization";
  name: string;
}> {
  if (!Array.isArray(value)) throw new Error("invalid accounts response");
  return value.map((row) => {
    if (!isRecord(row) || typeof row.id !== "string" || !UUID.test(row.id)) {
      throw new Error("invalid account id");
    }
    if (row.kind !== "personal" && row.kind !== "organization") {
      throw new Error("invalid account kind");
    }
    if (typeof row.name !== "string" || row.name.length === 0 || row.name.length > 120) {
      throw new Error("invalid account name");
    }
    return { id: row.id, kind: row.kind, name: row.name };
  });
}

function parseBots(value: unknown): Array<{
  accountId: string;
  id: string;
  appId: number;
  appSlug: string;
  mode: "byo" | "managed";
  githubInstallationId: number | null;
  githubAccountLogin: string | null;
  status: "pending" | "verified" | "suspended" | "revoked";
}> {
  if (!Array.isArray(value)) throw new Error("invalid bots response");
  return value.map((row) => {
    if (!isRecord(row)) throw new Error("invalid bot row");
    if (typeof row.id !== "string" || !UUID.test(row.id)) throw new Error("invalid bot id");
    if (typeof row.account_id !== "string" || !UUID.test(row.account_id)) {
      throw new Error("invalid bot account");
    }
    if (typeof row.app_id !== "number" || !Number.isSafeInteger(row.app_id) || row.app_id <= 0) {
      throw new Error("invalid bot app id");
    }
    if (typeof row.app_slug !== "string" || !/^[a-z0-9][a-z0-9-]{0,99}$/.test(row.app_slug)) {
      throw new Error("invalid bot slug");
    }
    if (row.mode !== "byo" && row.mode !== "managed") throw new Error("invalid bot mode");
    if (!["pending", "verified", "suspended", "revoked"].includes(String(row.status))) {
      throw new Error("invalid bot status");
    }
    const installationId = row.github_installation_id;
    if (
      installationId !== null
      && (typeof installationId !== "number" || !Number.isSafeInteger(installationId) || installationId <= 0)
    ) {
      throw new Error("invalid installation id");
    }
    if (row.status === "verified" && installationId === null) {
      throw new Error("verified bot has no installation proof");
    }
    if (
      row.github_account_login !== null
      && (typeof row.github_account_login !== "string" || row.github_account_login.length > 100)
    ) {
      throw new Error("invalid GitHub account login");
    }
    return {
      accountId: row.account_id,
      id: row.id,
      appId: row.app_id,
      appSlug: row.app_slug,
      mode: row.mode,
      githubInstallationId: installationId,
      githubAccountLogin: row.github_account_login as string | null,
      status: row.status as "pending" | "verified" | "suspended" | "revoked"
    };
  });
}

function parseGrants(value: unknown): Array<{
  accountId: string;
  kind: "internal_admin" | "trial" | "legacy";
  expiresAt: string | null;
}> {
  if (!Array.isArray(value)) throw new Error("invalid grants response");
  return value.map((row) => {
    if (!isRecord(row) || typeof row.account_id !== "string" || !UUID.test(row.account_id)) {
      throw new Error("invalid grant account");
    }
    if (row.status !== "active") throw new Error("inactive grant in active snapshot");
    if (row.grant_kind !== "internal_admin" && row.grant_kind !== "trial" && row.grant_kind !== "legacy") {
      throw new Error("invalid grant kind");
    }
    if (row.expires_at !== null && (typeof row.expires_at !== "string" || !Number.isFinite(Date.parse(row.expires_at)))) {
      throw new Error("invalid grant expiry");
    }
    return {
      accountId: row.account_id,
      kind: row.grant_kind,
      expiresAt: row.expires_at as string | null
    };
  });
}

function entitlementFor(
  grants: Array<{ kind: "internal_admin" | "trial" | "legacy"; expiresAt: string | null }>,
  at: Date
): "public_free" | "paid" | "internal_admin" | "trial" {
  const active = grants.filter((grant) => !grant.expiresAt || Date.parse(grant.expiresAt) > at.getTime());
  if (active.some((grant) => grant.kind === "internal_admin")) return "internal_admin";
  if (active.some((grant) => grant.kind === "trial")) return "trial";
  if (active.some((grant) => grant.kind === "legacy")) return "paid";
  return "public_free";
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
