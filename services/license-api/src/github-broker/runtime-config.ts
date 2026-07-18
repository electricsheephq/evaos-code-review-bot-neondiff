import { createPrivateKey } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { createGitHubInstallationClient } from "./github-app.js";
import type { GitHubBrokerDeps } from "./routes.js";
import { GitHubBrokerStore } from "./store.js";
import { normalizeHttpApiBaseUrl } from "./url.js";

const REQUIRED_SETTINGS = [
  "GITHUB_BROKER_APP_ID",
  "GITHUB_BROKER_PRIVATE_KEY",
  "GITHUB_BROKER_OAUTH_CLIENT_ID",
  "GITHUB_BROKER_OAUTH_CLIENT_SECRET",
  "GITHUB_BROKER_INSTALL_BASE_URL",
  "GITHUB_BROKER_DB_PATH"
] as const;

type RequiredSetting = (typeof REQUIRED_SETTINGS)[number];
type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

export type GitHubBrokerRuntimeConfig =
  | { status: "disabled" }
  | { status: "invalid"; setting: string; reason: string }
  | { status: "ready"; deps: GitHubBrokerDeps };

/**
 * Translate the owner-provisioned Fly environment into the already-reviewed
 * broker dependency seam. The explicit enable flag is both rollout gate and kill
 * switch: secrets may remain provisioned while the public routes keep returning
 * typed `broker_unavailable`.
 *
 * Invalid enabled configuration never includes a submitted value in its result.
 * The production entrypoint can therefore report a setting/reason without
 * logging private key or OAuth material.
 */
export function loadGitHubBrokerRuntimeConfig(
  environment: RuntimeEnvironment,
  licenseDbPath: string
): GitHubBrokerRuntimeConfig {
  const enabled = normalized(environment.GITHUB_BROKER_ENABLED);
  if (enabled === undefined || enabled === "false") return { status: "disabled" };
  if (enabled !== "true") {
    return invalid("GITHUB_BROKER_ENABLED", "must_be_true_or_false");
  }

  const values = new Map<RequiredSetting, string>();
  for (const setting of REQUIRED_SETTINGS) {
    const value = normalized(environment[setting]);
    if (value === undefined) return invalid(setting, "missing");
    values.set(setting, value);
  }

  const appId = required(values, "GITHUB_BROKER_APP_ID");
  if (!/^[1-9]\d{0,19}$/.test(appId)) {
    return invalid("GITHUB_BROKER_APP_ID", "invalid");
  }

  const privateKey = required(values, "GITHUB_BROKER_PRIVATE_KEY");
  try {
    const parsed = createPrivateKey(privateKey);
    if (parsed.asymmetricKeyType !== "rsa") {
      return invalid("GITHUB_BROKER_PRIVATE_KEY", "invalid");
    }
  } catch {
    return invalid("GITHUB_BROKER_PRIVATE_KEY", "invalid");
  }

  const oauthClientId = required(values, "GITHUB_BROKER_OAUTH_CLIENT_ID");
  const oauthClientSecret = required(
    values,
    "GITHUB_BROKER_OAUTH_CLIENT_SECRET"
  );
  if (oauthClientId.length > 512) {
    return invalid("GITHUB_BROKER_OAUTH_CLIENT_ID", "invalid");
  }
  if (oauthClientSecret.length > 2048) {
    return invalid("GITHUB_BROKER_OAUTH_CLIENT_SECRET", "invalid");
  }

  const installBaseUrl = normalizeInstallBaseUrl(
    required(values, "GITHUB_BROKER_INSTALL_BASE_URL")
  );
  if (!installBaseUrl) {
    return invalid("GITHUB_BROKER_INSTALL_BASE_URL", "invalid");
  }

  const dbPath = required(values, "GITHUB_BROKER_DB_PATH");
  if (!isAbsolute(dbPath)) {
    return invalid("GITHUB_BROKER_DB_PATH", "must_be_absolute");
  }
  if (resolve(dbPath) === resolve(licenseDbPath)) {
    return invalid("GITHUB_BROKER_DB_PATH", "must_differ_from_license_db");
  }

  let apiBaseUrl: string | undefined;
  let oauthBaseUrl: string | undefined;
  try {
    if (normalized(environment.GITHUB_BROKER_API_BASE_URL)) {
      apiBaseUrl = normalizeHttpApiBaseUrl(
        environment.GITHUB_BROKER_API_BASE_URL,
        "GITHUB_BROKER_API_BASE_URL",
        "https://api.github.com"
      ).toString();
    }
  } catch {
    return invalid("GITHUB_BROKER_API_BASE_URL", "invalid");
  }
  try {
    if (normalized(environment.GITHUB_BROKER_OAUTH_BASE_URL)) {
      oauthBaseUrl = normalizeHttpApiBaseUrl(
        environment.GITHUB_BROKER_OAUTH_BASE_URL,
        "GITHUB_BROKER_OAUTH_BASE_URL",
        "https://github.com"
      ).toString();
    }
  } catch {
    return invalid("GITHUB_BROKER_OAUTH_BASE_URL", "invalid");
  }

  let store: GitHubBrokerStore;
  try {
    // Open and migrate inside the fail-closed configuration boundary. Passing
    // the ready store onward prevents a later constructor failure from taking
    // down unrelated license and health routes.
    store = new GitHubBrokerStore(dbPath);
  } catch {
    return invalid("GITHUB_BROKER_DB_PATH", "open_failed");
  }

  const githubClient = createGitHubInstallationClient({
    appId,
    privateKey,
    oauthClientId,
    oauthClientSecret,
    requestTimeoutMs: 8_000,
    ...(apiBaseUrl ? { apiBaseUrl } : {}),
    ...(oauthBaseUrl ? { oauthBaseUrl } : {})
  });
  return {
    status: "ready",
    deps: {
      dbPath,
      store,
      githubClient,
      installBaseUrl
    }
  };
}

function normalized(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function required(
  values: ReadonlyMap<RequiredSetting, string>,
  setting: RequiredSetting
): string {
  const value = values.get(setting);
  if (!value) throw new Error(`missing validated setting: ${setting}`);
  return value;
}

function normalizeInstallBaseUrl(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    !/^\/apps\/[a-z0-9-]+\/installations\/new$/.test(url.pathname)
  ) {
    return undefined;
  }
  return url.toString();
}

function invalid(setting: string, reason: string): GitHubBrokerRuntimeConfig {
  return { status: "invalid", setting, reason };
}
