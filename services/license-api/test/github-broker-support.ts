import type { Server } from "node:http";
import {
  calculateJwkThumbprint,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type JWK,
  type KeyLike
} from "jose";
import { LicenseStore } from "../src/store.ts";
import { startLicenseServer } from "../src/http.ts";
import { RateLimiter } from "../src/service.ts";

/**
 * Shared harness for the GitHub App broker tests. It intentionally imports only
 * stable, already-shipped modules plus `jose`, so it loads unchanged before the
 * broker exists (contract tests are red for the right reason: routes 404) and
 * after it exists (routes wired, same harness). The broker store is constructed
 * server-side from `githubBroker.dbPath`; tests never import broker internals.
 */

export const INSTALL_BASE_URL = "https://github.com/apps/neondiff-staging/installations/new";
export const FIXED_NOW = new Date("2026-07-15T00:00:00.000Z");

/**
 * The install-time OAuth authorization code a legitimate identity would return
 * for `installationId`. The fake treats this as proof of installation ownership;
 * any other (or absent) code fails the callback identity check. Mirrors the real
 * "OAuth-during-install code proves the user can access this installation".
 */
export function authorizationCodeFor(installationId: number): string {
  return `oauth-code-${installationId}`;
}

/** Fixture-only Device Flow proof for one exact installation. */
export function userAccessTokenFor(installationId: number): string {
  return `device-user-proof-${installationId}`;
}

/** A device identity mirroring the client: keypair + RFC 7638 thumbprint id. */
export interface TestDevice {
  deviceId: string;
  publicJwk: JWK;
  privateKey: KeyLike;
  /** A short-lived device-signed JWT (`sub` = deviceId) for the Authorization header. */
  sign(options?: { expSeconds?: number; subject?: string; now?: Date }): Promise<string>;
}

export async function makeDevice(): Promise<TestDevice> {
  const { publicKey, privateKey } = await generateKeyPair("ES256", { extractable: true });
  const publicJwk = await exportJWK(publicKey);
  const deviceId = await calculateJwkThumbprint(publicJwk, "sha256");
  return {
    deviceId,
    publicJwk,
    privateKey,
    async sign(options = {}): Promise<string> {
      const nowMs = (options.now ?? FIXED_NOW).getTime();
      const iat = Math.floor(nowMs / 1000);
      const exp = iat + (options.expSeconds ?? 120);
      return new SignJWT({})
        .setProtectedHeader({ alg: "ES256" })
        .setSubject(options.subject ?? deviceId)
        .setIssuedAt(iat)
        .setExpirationTime(exp)
        .sign(privateKey);
    }
  };
}

export interface FakeRepository {
  id: number;
  full_name: string;
  visibility: "public" | "private" | "internal" | "unknown";
}

export interface FakeInstallation {
  id: number;
  account_login?: string;
  suspended?: boolean;
  /** null models an uninstalled/missing installation (GitHub 404). */
  missing?: boolean;
  repositories: FakeRepository[];
  /**
   * The `owner/name` set the connecting OAuth user can access in this installation
   * (what `/user/installations/{id}/repositories` returns). Defaults to every
   * installation repository; set a narrower list to model a user with partial
   * access to an org installation.
   */
  userRepositories?: string[];
}

export interface FakeGitHubCall {
  op:
    | "getInstallation"
    | "verifyInstallationForUserToken"
    | "listInstallationRepositories"
    | "createInstallationAccessToken";
  installationId: number;
  params?: unknown;
}

/**
 * An in-memory GitHub installation client. Records call order (`calls`) so tests
 * can prove no token is minted before the issuance seam decision. Never touches
 * the network. `mintedToken` is the sentinel returned by a successful mint.
 */
export function fakeGitHubClient(
  installations: FakeInstallation[],
  overrides: {
    mintedToken?: string;
    onCreateToken?: () => never | void;
  } = {}
): {
  client: Record<string, unknown>;
  calls: FakeGitHubCall[];
  mintedToken: string;
} {
  const calls: FakeGitHubCall[] = [];
  // A non-GitHub-shaped sentinel so the secret scanner does not flag test source.
  const mintedToken = overrides.mintedToken ?? "broker-test-installation-token-value";
  const byId = new Map(installations.map((installation) => [installation.id, installation]));
  const client = {
    async getInstallation(installationId: number) {
      calls.push({ op: "getInstallation", installationId });
      const installation = byId.get(installationId);
      if (!installation || installation.missing) return null;
      return {
        id: installation.id,
        account_login: installation.account_login,
        suspended: installation.suspended === true
      };
    },
    async listInstallationRepositories(installationId: number) {
      calls.push({ op: "listInstallationRepositories", installationId });
      const installation = byId.get(installationId);
      if (!installation || installation.missing) return [];
      return installation.repositories.map((repository) => ({ ...repository }));
    },
    async listInstallationRepositoriesPage(installationId: number, page: number, perPage: number) {
      calls.push({
        op: "listInstallationRepositories",
        installationId,
        params: { page, perPage }
      });
      const installation = byId.get(installationId);
      if (!installation || installation.missing) {
        return { repositories: [], totalCount: 0, hasNextPage: false };
      }
      const offset = (page - 1) * perPage;
      return {
        repositories: installation.repositories
          .slice(offset, offset + perPage)
          .map((repository) => ({ ...repository })),
        totalCount: installation.repositories.length,
        hasNextPage: offset + perPage < installation.repositories.length
      };
    },
    async createInstallationAccessToken(
      installationId: number,
      params: { repositories?: string[]; permissions?: Record<string, string> }
    ) {
      calls.push({ op: "createInstallationAccessToken", installationId, params });
      if (overrides.onCreateToken) overrides.onCreateToken();
      return {
        token: mintedToken,
        expires_at: new Date((overrides.mintedToken ? Date.now() : FIXED_NOW.getTime()) + 3_600_000).toISOString()
      };
    },
    async verifyInstallationForAuthorizationCode(installationId: number, code: string) {
      // The code proves ownership of exactly this installation; a mismatched or
      // absent code (a forged callback) is not authorized (null). A proven identity
      // yields the repositories the user can access in the installation (the
      // authorized set the binding is scoped to) — all installation repos by default.
      if (code !== authorizationCodeFor(installationId)) return null;
      const installation = byId.get(installationId);
      if (!installation || installation.missing) return null;
      return installation.userRepositories ?? installation.repositories.map((repository) => repository.full_name);
    },
    async verifyInstallationForUserToken(installationId: number, userAccessToken: string) {
      // Record only that the proof seam ran. The transient user credential is
      // deliberately excluded from test call ledgers, mirroring production.
      calls.push({ op: "verifyInstallationForUserToken", installationId });
      if (userAccessToken !== userAccessTokenFor(installationId)) return null;
      const installation = byId.get(installationId);
      if (!installation || installation.missing) return null;
      return installation.userRepositories ?? installation.repositories.map((repository) => repository.full_name);
    }
  };
  return { client, calls, mintedToken };
}

export interface BrokerHarness {
  url: string;
  server: Server;
  licenseStore: LicenseStore;
  calls: FakeGitHubCall[];
  mintedToken: string;
  close(): void;
}

export async function startBroker(
  options: {
    installations?: FakeInstallation[];
    now?: Date;
    /** Mutable clock override for expiry/renewal tests; wins over `now`. */
    clock?: () => Date;
    fake?: ReturnType<typeof fakeGitHubClient>;
    /** A pre-built broker store so a test can inspect the decision ledger. */
    store?: unknown;
    /** Entitlement authority for private/internal issuance (#614 fixtures). */
    resolveEntitlement?: unknown;
    /** Optional production license store for end-to-end entitlement wiring tests. */
    licenseStore?: LicenseStore;
    deviceRegisterRateLimiter?: RateLimiter;
    tokenRateLimiter?: RateLimiter;
    connectRateLimiter?: RateLimiter;
  } = {}
): Promise<BrokerHarness> {
  const licenseStore = options.licenseStore ?? new LicenseStore(":memory:");
  const fake = options.fake ?? fakeGitHubClient(options.installations ?? []);
  const nowFn = options.clock ?? (() => options.now ?? FIXED_NOW);
  const started = await startLicenseServer({
    store: licenseStore,
    now: nowFn,
    // Passing a db path (not a store instance) keeps this harness free of broker
    // imports; a test may instead pass its own `store` to read the ledger.
    githubBroker: {
      ...(options.store ? { store: options.store } : { dbPath: ":memory:" }),
      githubClient: fake.client,
      installBaseUrl: INSTALL_BASE_URL,
      ...(options.resolveEntitlement ? { resolveEntitlement: options.resolveEntitlement } : {}),
      now: nowFn,
      deviceRegisterRateLimiter: options.deviceRegisterRateLimiter,
      tokenRateLimiter: options.tokenRateLimiter,
      connectRateLimiter: options.connectRateLimiter
    }
  } as never);
  return {
    url: started.url,
    server: started.server,
    licenseStore,
    calls: fake.calls,
    mintedToken: fake.mintedToken,
    close(): void {
      started.server.close();
      licenseStore.close();
    }
  };
}

export async function post(
  url: string,
  path: string,
  body: unknown,
  headers: Record<string, string> = {}
): Promise<{ status: number; json: any; text: string }> {
  const res = await fetch(`${url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body)
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : {}, text };
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/** Register a device and return its authorization header helper. */
export async function registerDevice(
  url: string,
  device: TestDevice
): Promise<{ status: number; json: any }> {
  return post(url, "/device/register", { publicKeyJwk: device.publicJwk });
}

/**
 * Drive connect start -> callback -> complete for a device and installation,
 * returning the state used. Assumes the broker is wired (used by GREEN tests).
 */
export async function connectInstallation(
  url: string,
  device: TestDevice,
  installationId: number
): Promise<{ state: string; callbackStatus: number; completeStatus: number }> {
  const start = await post(url, "/github/connect/start", {}, bearer(await device.sign()));
  const state = start.json.state as string;
  const callback = await fetch(
    `${url}/github/connect/callback?installation_id=${installationId}&state=${encodeURIComponent(state)}&code=${encodeURIComponent(authorizationCodeFor(installationId))}`,
    { redirect: "manual" }
  );
  const complete = await post(url, "/github/connect/complete", { state }, bearer(await device.sign()));
  return { state, callbackStatus: callback.status, completeStatus: complete.status };
}
