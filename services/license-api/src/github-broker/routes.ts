import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimiter } from "../service.js";
import { BrokerError } from "./errors.js";
import type { GitHubInstallationClient } from "./github-app.js";
import { GitHubBrokerService, type EntitlementResolver } from "./service.js";
import { GitHubBrokerStore } from "./store.js";

const MAX_BODY_BYTES = 16 * 1024;
const BROKER_PATHS = new Set([
  "/device/register",
  "/github/connect/start",
  "/github/connect/callback",
  "/github/connect/authorize-existing",
  "/github/connect/complete",
  "/github/repositories",
  "/github/token"
]);

class BrokerBodyTooLargeError extends Error {}

/**
 * Dependencies for wiring the broker into the license HTTP listener. Either a
 * ready `store` or a `dbPath` (from which the listener constructs a store once)
 * is provided. Tests pass a `dbPath` plus an in-memory `githubClient`.
 */
export interface GitHubBrokerDeps {
  store?: GitHubBrokerStore;
  dbPath?: string;
  githubClient: GitHubInstallationClient;
  installBaseUrl: string;
  resolveEntitlement?: EntitlementResolver;
  now?: () => Date;
  deviceRegisterRateLimiter?: RateLimiter;
  connectRateLimiter?: RateLimiter;
  tokenRateLimiter?: RateLimiter;
}

export function isGitHubBrokerPath(path: string | undefined): boolean {
  return path !== undefined && BROKER_PATHS.has(path);
}

/** Build the broker service once, constructing its store from `dbPath` if needed. */
export function createGitHubBrokerService(deps: GitHubBrokerDeps): GitHubBrokerService {
  const store = deps.store ?? new GitHubBrokerStore(deps.dbPath ?? ":memory:");
  return new GitHubBrokerService({
    store,
    githubClient: deps.githubClient,
    installBaseUrl: deps.installBaseUrl,
    resolveEntitlement: deps.resolveEntitlement,
    now: deps.now,
    deviceRegisterRateLimiter: deps.deviceRegisterRateLimiter,
    connectRateLimiter: deps.connectRateLimiter,
    tokenRateLimiter: deps.tokenRateLimiter
  });
}

export async function handleGitHubBrokerRequest(
  service: GitHubBrokerService,
  req: IncomingMessage,
  res: ServerResponse,
  context: { sourceAddress: string }
): Promise<void> {
  const [path, rawQuery] = (req.url ?? "").split("?");
  try {
    if (req.method === "POST" && path === "/device/register") {
      return writeJson(res, 200, await service.registerDevice(await readBody(req), context.sourceAddress));
    }
    if (req.method === "POST" && path === "/github/connect/start") {
      return writeJson(res, 200, await service.connectStart(req.headers.authorization));
    }
    if (req.method === "GET" && path === "/github/connect/callback") {
      const { html } = await service.connectCallback(new URLSearchParams(rawQuery ?? ""));
      return writeHtml(res, 200, html);
    }
    if (req.method === "POST" && path === "/github/connect/authorize-existing") {
      return writeJson(
        res,
        200,
        await service.connectAuthorizeExisting(req.headers.authorization, await readBody(req))
      );
    }
    if (req.method === "POST" && path === "/github/connect/complete") {
      return writeJson(res, 200, await service.connectComplete(req.headers.authorization, await readBody(req)));
    }
    if (req.method === "POST" && path === "/github/repositories") {
      return writeJson(res, 200, await service.listRepositories(req.headers.authorization, await readBody(req)));
    }
    if (req.method === "POST" && path === "/github/token") {
      return writeJson(res, 200, await service.issueToken(req.headers.authorization, await readBody(req)));
    }
    return writeJson(res, 404, { status: "error", reason: "invalid_request", detail: "unknown broker route" });
  } catch (error) {
    if (error instanceof BrokerError) {
      return writeJson(res, error.httpStatus, error.body());
    }
    if (error instanceof BrokerBodyTooLargeError) {
      return writeJson(res, 413, { status: "error", reason: "invalid_request", detail: "request body too large" });
    }
    // Never surface internal error text (redaction discipline) → generic 500.
    return writeJson(res, 500, { status: "error", reason: "broker_unavailable", detail: "internal error" });
  }
}

function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let size = 0;
    let tooLarge = false;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      if (tooLarge) return;
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        tooLarge = true;
        chunks.length = 0;
        reject(new BrokerBodyTooLargeError("request body too large"));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (tooLarge) return;
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new BrokerError("invalid_request", "request body must be valid JSON"));
      }
    });
    req.on("error", (error) => {
      if (!tooLarge) reject(error);
    });
  });
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(payload);
}

function writeHtml(res: ServerResponse, status: number, html: string): void {
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}
