import type { IncomingMessage, ServerResponse } from "node:http";
import type { RateLimiter } from "../service.js";
import { BrokerError } from "../github-broker/errors.js";
import { GitHubBrokerStore } from "../github-broker/store.js";
import {
  AccountLinkService,
  type AccountAuthority
} from "./service.js";

const MAX_BODY_BYTES = 16 * 1024;
const PATHS = new Set([
  "/account/device/register",
  "/account/device/introspect",
  "/account/connect/start",
  "/account/connect/complete",
  "/account/workspaces"
]);

class BodyTooLargeError extends Error {}

export interface AccountLinkDeps {
  store?: GitHubBrokerStore;
  dbPath?: string;
  authority: AccountAuthority;
  now?: () => Date;
  registerRateLimiter?: RateLimiter;
  connectRateLimiter?: RateLimiter;
  completeRateLimiter?: RateLimiter;
  workspaceRateLimiter?: RateLimiter;
}

export function isAccountLinkPath(path: string | undefined): boolean {
  return path !== undefined && PATHS.has(path);
}

export function createAccountLinkService(deps: AccountLinkDeps): AccountLinkService {
  const store = deps.store ?? new GitHubBrokerStore(deps.dbPath ?? ":memory:");
  return new AccountLinkService({
    store,
    authority: deps.authority,
    now: deps.now,
    registerRateLimiter: deps.registerRateLimiter,
    connectRateLimiter: deps.connectRateLimiter,
    completeRateLimiter: deps.completeRateLimiter,
    workspaceRateLimiter: deps.workspaceRateLimiter
  });
}

export async function handleAccountLinkRequest(
  service: AccountLinkService,
  req: IncomingMessage,
  res: ServerResponse,
  context: { sourceAddress: string }
): Promise<void> {
  const path = req.url?.split("?")[0];
  const corsHeaders = accountCorsHeaders(req, service.connectOrigin);
  if (req.headers.origin && !corsHeaders) {
    return writeJson(res, 403, {
      status: "error",
      reason: "invalid_request",
      detail: "origin is not allowed"
    });
  }
  if (req.method === "OPTIONS") {
    if (!corsHeaders || !validPreflight(req)) {
      return writeJson(res, 403, {
        status: "error",
        reason: "invalid_request",
        detail: "preflight is not allowed"
      });
    }
    res.writeHead(204, corsHeaders);
    res.end();
    return;
  }
  try {
    if (req.method === "POST" && path === "/account/device/register") {
      return writeJson(res, 200, await service.registerDevice(await readBody(req), context.sourceAddress), corsHeaders);
    }
    if (req.method === "POST" && path === "/account/device/introspect") {
      return writeJson(res, 200, await service.introspectDevice(req.headers.authorization), corsHeaders);
    }
    if (req.method === "POST" && path === "/account/connect/start") {
      return writeJson(res, 200, await service.connectStart(req.headers.authorization), corsHeaders);
    }
    if (req.method === "POST" && path === "/account/connect/complete") {
      return writeJson(
        res,
        200,
        await service.connectComplete(req.headers.authorization, await readBody(req)),
        corsHeaders
      );
    }
    if (req.method === "POST" && path === "/account/workspaces") {
      return writeJson(
        res,
        200,
        await service.workspaces(req.headers.authorization, await readBody(req)),
        corsHeaders
      );
    }
    return writeJson(res, 404, { status: "error", reason: "invalid_request", detail: "unknown account route" }, corsHeaders);
  } catch (error) {
    if (error instanceof BrokerError) return writeJson(res, error.httpStatus, error.body(), corsHeaders);
    if (error instanceof BodyTooLargeError) {
      return writeJson(res, 413, { status: "error", reason: "invalid_request", detail: "request body too large" }, corsHeaders);
    }
    return writeJson(res, 500, {
      status: "error",
      reason: "account_authority_unavailable",
      detail: "internal error"
    }, corsHeaders);
  }
}

function accountCorsHeaders(
  req: IncomingMessage,
  connectOrigin: string
): Record<string, string> | undefined {
  const requestOrigin = req.headers.origin;
  if (!requestOrigin) return {};
  if (requestOrigin !== new URL(connectOrigin).origin) return undefined;
  return {
    "Access-Control-Allow-Origin": requestOrigin,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "600",
    Vary: "Origin"
  };
}

function validPreflight(req: IncomingMessage): boolean {
  if (req.headers["access-control-request-method"] !== "POST") return false;
  const requested = String(req.headers["access-control-request-headers"] ?? "")
    .split(",")
    .map((header) => header.trim().toLowerCase())
    .filter(Boolean);
  return requested.every((header) => header === "authorization" || header === "content-type");
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
        reject(new BodyTooLargeError("request body too large"));
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

function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {}
): void {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    ...headers
  });
  res.end(JSON.stringify(body));
}
